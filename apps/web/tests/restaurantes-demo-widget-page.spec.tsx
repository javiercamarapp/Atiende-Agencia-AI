// @vitest-environment jsdom
//
// R-19: pagina publica /demo/:orgSlug. Estados honestos (sin agente / sin demo) y el chat real: cada mensaje llama al
// endpoint, el pedido y el handoff que reporta el servidor se muestran, y un error devuelve el mensaje al cuadro.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoWhatsAppPage, iniciales } from "../src/verticals/restaurantes/demo/DemoWhatsAppPage.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}
const ESTADO_OK = { disponible: true, motivo: null, mensaje: null, restaurante: { slug: "los-taquitos-de-pm", nombre: "Los Taquitos de PM" }, sucursales: [{ slug: "t1", nombre: "Prolongación Montejo" }], limites: { mensajes_por_sesion: 40, caracteres_por_mensaje: 600 } };

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(texto));
const campo = () => rendered!.container.querySelector("#demo-mensaje") as HTMLInputElement;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("iniciales", () => {
  it("ignora articulos y toma hasta dos palabras", () => {
    expect(iniciales("Los Taquitos de PM")).toBe("TP");
    expect(iniciales("")).toBe("R");
  });
});

describe("DemoWhatsAppPage", () => {
  it("sin agente: muestra el estado honesto y NO muestra el chat", async () => {
    fetchMock.mockResolvedValue(json({ ...ESTADO_OK, disponible: false, motivo: "sin_agente", mensaje: "Agente no disponible: requiere OPENROUTER_API_KEY (o la llave de otro proveedor LLM) configurada en el servidor." }));
    rendered = renderComponent(<DemoWhatsAppPage apiBaseUrl="https://api.test" orgSlug="los-taquitos-de-pm" />);
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Demo no disponible");
    expect(t).toContain("requiere OPENROUTER_API_KEY");
    expect(campo()).toBeNull();
  });

  it("falla de red al consultar el estado: error con reintento", async () => {
    fetchMock.mockRejectedValue(new Error("sin conexion"));
    rendered = renderComponent(<DemoWhatsAppPage apiBaseUrl="https://api.test" orgSlug="x" />);
    await esperar();
    expect(rendered.container.textContent).toContain("sin conexion");
  });

  it("chat: envia el mensaje, muestra la respuesta del agente, el pedido registrado y el aviso de handoff", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/estado")) return json(ESTADO_OK);
      const cuerpo = JSON.parse(String(init?.body));
      expect(cuerpo.session_id).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
      return json({ tipo: "respuesta", respuesta: "Listo, su pedido ya está en cocina.", escalado: true, pedido: { id: "p-1", total: 90, estado: "pending" } });
    });
    rendered = renderComponent(<DemoWhatsAppPage apiBaseUrl="https://api.test" orgSlug="los-taquitos-de-pm" />);
    await esperar();
    expect(rendered.container.textContent).toContain("Los Taquitos de PM");
    await act(async () => changeValue(campo(), "Quiero 2 coca colas"));
    await act(async () => click(boton("Enviar")!));
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Quiero 2 coca colas");
    expect(t).toContain("Listo, su pedido ya está en cocina.");
    expect(t).toContain("Pedido registrado por");
    expect(t).toContain("Se avisó a una persona del equipo");
    expect(t).toContain("Mensajes restantes en esta conversación: 39.");
    const envio = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/mensaje"))!;
    expect(JSON.parse(String((envio[1] as RequestInit).body))).toMatchObject({ mensaje: "Quiero 2 coca colas" });
  });

  it("error del servidor: muestra el aviso y devuelve el mensaje al cuadro para reenviarlo (no se pierde)", async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith("/estado") ? json(ESTADO_OK) : json({ code: "demo_sesion_tope", message: "Esta conversación alcanzó su tope de mensajes." }, 429)));
    rendered = renderComponent(<DemoWhatsAppPage apiBaseUrl="https://api.test" orgSlug="los-taquitos-de-pm" />);
    await esperar();
    await act(async () => changeValue(campo(), "Hola"));
    await act(async () => click(boton("Enviar")!));
    await esperar();
    expect(rendered.container.textContent).toContain("Esta conversación alcanzó su tope de mensajes.");
    expect(campo().value).toBe("Hola");
  });

  it("Nueva conversación limpia el chat y genera otra sesion", async () => {
    const sesiones: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/estado")) return json(ESTADO_OK);
      sesiones.push(JSON.parse(String(init?.body)).session_id);
      return json({ tipo: "respuesta", respuesta: "Hola", escalado: false, pedido: null });
    });
    rendered = renderComponent(<DemoWhatsAppPage apiBaseUrl="https://api.test" orgSlug="los-taquitos-de-pm" />);
    await esperar();
    await act(async () => changeValue(campo(), "uno"));
    await act(async () => click(boton("Enviar")!));
    await esperar();
    await act(async () => click(boton("Nueva conversación")!));
    await esperar();
    expect(rendered.container.textContent).not.toContain("uno");
    await act(async () => changeValue(campo(), "dos"));
    await act(async () => click(boton("Enviar")!));
    await esperar();
    expect(sesiones).toHaveLength(2);
    expect(sesiones[0]).not.toBe(sesiones[1]);
  });
});

// @vitest-environment jsdom
//
// «Probar agente»: conversa con el agente real en modo preview. Se afirma lo que ve el dueno y lo que viaja a la API: historial,
// tarjeta PRUEBA, estado honesto sin proveedor de IA, reinicio (sesion nueva), cliente simulado y borrador sin guardar.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProbarAgente } from "../src/verticals/restaurantes/preview/ProbarAgente.tsx";
import { formDesdeWire } from "../src/verticals/restaurantes/lib/agente-whatsapp-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
let envios: Record<string, unknown>[];

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const boton = (texto: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(texto));
const caja = () => rendered!.container.querySelector('input[aria-label="Mensaje de prueba"]') as HTMLInputElement;

const PEDIDO = { id: "PRUEBA-AB12", branch: "Francisco de Montejo", total: 90, status: "simulado", payment_method: "efectivo", simulado: true, items: [{ name: "Coca-Cola", quantity: 2, price: 45 }] };

function montar(responder: (cuerpo: Record<string, unknown>) => Response) {
  envios = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/admin/customers")) return json({ customers: [{ id: "c1", name: "Beto", phone: "9992222222", orderCount: 3 }], nextCursor: null });
    if (u.endsWith("/preview/mensaje")) {
      const cuerpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
      envios.push(cuerpo);
      return responder(cuerpo);
    }
    return json({});
  });
  rendered = renderComponent(<ProbarAgente apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" borrador={formDesdeWire(null)} />);
}
async function abrirYEscribir(texto: string) {
  click(boton("Abrir prueba")!);
  await esperar();
  await act(async () => changeValue(caja(), texto));
  await act(async () => {
    await submitForm(rendered!.container.querySelector("form")!);
  });
  await esperar();
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

describe("<ProbarAgente />", () => {
  it("cerrado muestra solo la invitacion con la etiqueta de que no se crean pedidos; abierto, la conversacion y la tarjeta PRUEBA", async () => {
    montar(() => json({ respuesta: "Listo, su pedido de prueba.", escalado: false, pedidoSimulado: PEDIDO }));
    expect(rendered!.container.textContent).toContain("Prueba: no se crean pedidos ni se avisa a nadie.");
    expect(rendered!.container.querySelector('[data-testid="probar-agente"]')).toBeNull();
    await abrirYEscribir("quiero 2 cocas");
    expect(rendered!.container.textContent).toContain("quiero 2 cocas");
    expect(rendered!.container.textContent).toContain("Listo, su pedido de prueba.");
    const tarjeta = rendered!.container.querySelector('[data-testid="tarjeta-pedido-simulado"]');
    expect(tarjeta?.textContent).toContain("PRUEBA-AB12");
    expect(tarjeta?.textContent).toContain("$90.00");
    expect(envios[0]).toMatchObject({ mensajes: [{ rol: "usuario", texto: "quiero 2 cocas" }] });
    expect(typeof envios[0]!.sesionId).toBe("string");
    expect(envios[0]!.borrador).toBeUndefined();
    expect(envios[0]!.clienteSimuladoId).toBeUndefined();
  });

  it("sin proveedor de IA (503) muestra el estado honesto 'requiere OPENROUTER_API_KEY', conserva el texto y no inventa respuesta", async () => {
    montar(() => json({ code: "agente_no_disponible", message: "No disponible: requiere OPENROUTER_API_KEY. Sin un proveedor de IA configurado el agente no puede responder." }, 503));
    await abrirYEscribir("hola");
    const aviso = rendered!.container.querySelector('[data-testid="error-prueba"]');
    expect(aviso?.textContent).toContain("requiere OPENROUTER_API_KEY");
    expect(rendered!.container.querySelector('[data-testid="tarjeta-pedido-simulado"]')).toBeNull();
    expect(caja().value).toBe("hola");
  });

  it("'Reiniciar conversacion' vacia el chat y usa una sesion nueva", async () => {
    montar(() => json({ respuesta: "Respuesta unica 77", escalado: false, pedidoSimulado: null }));
    await abrirYEscribir("hola");
    expect(rendered!.container.textContent).toContain("Respuesta unica 77");
    const primera = envios[0]!.sesionId;
    click(boton("Reiniciar conversación")!);
    await esperar();
    expect(rendered!.container.textContent).not.toContain("Respuesta unica 77");
    await act(async () => changeValue(caja(), "otra vez"));
    await act(async () => {
      await submitForm(rendered!.container.querySelector("form")!);
    });
    await esperar();
    expect(envios[1]!.sesionId).not.toBe(primera);
    expect((envios[1]!.mensajes as unknown[]).length).toBe(1);
  });

  it("cliente simulado y borrador sin guardar viajan solo cuando se eligen", async () => {
    montar(() => json({ respuesta: "Hola Beto", escalado: false, pedidoSimulado: null }));
    click(boton("Abrir prueba")!);
    await esperar();
    const select = rendered!.container.querySelector("select") as HTMLSelectElement;
    await act(async () => changeValue(select, "c1"));
    const check = rendered!.container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => click(check));
    await act(async () => changeValue(caja(), "hola"));
    await act(async () => {
      await submitForm(rendered!.container.querySelector("form")!);
    });
    await esperar();
    expect(envios[0]!.clienteSimuladoId).toBe("c1");
    expect(envios[0]!.borrador).toMatchObject({ perfil: "taqueria_pm" });
  });
});

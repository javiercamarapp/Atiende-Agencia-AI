// @vitest-environment jsdom
//
// Cola del encargado (panel movil del operador): carga real contra un fetch simulado, estados de carga/error/no disponible, boton grande
// por pedido con doble toque seguro, pestanas y alerta de pedido nuevo.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColaSalida, TarjetaPedido } from "@atiende/domain-restaurantes/operacion";
import { OperacionColaPage } from "../../src/verticals/restaurantes/pages/OperacionCola.tsx";
import type { RestaurantesShellContext } from "../../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.test", nombreSucursal: "Sucursal de prueba" };

function tarjeta(extra: Partial<TarjetaPedido> = {}): TarjetaPedido {
  return {
    id: "00000000-0000-4000-8000-000000000001", numero: 150, estado: "pending", canal: "domicilio", origen: "whatsapp", clienteNombre: "Cliente de prueba", resumenItems: "4 taquitos pastor", total: 708,
    creadoEn: new Date().toISOString(), aceptadoEn: null, listoAt: null, salioAt: null, minutos: 2, semaforo: "verde", repartidorId: null, sinAviso: false, accionesDisponibles: ["aceptar", "cancelar"], ...extra,
  };
}
function cola(pedidos: TarjetaPedido[]): ColaSalida {
  return { pedidos, conteos: {}, actualizadoEn: new Date().toISOString() };
}
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

let rendered: RenderedComponent | undefined;
async function montar(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  await act(async () => {
    rendered = renderComponent(
      <MemoryRouter>
        <OperacionColaPage {...CTX} />
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
/** Radix activa la pestana con mousedown (no con click). */
function tocarPestana(nombre: string): void {
  const el = document.querySelector(`[data-testid="pestana-${nombre}"]`) as HTMLElement;
  act(() => {
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  });
}
const textos = () => document.body.textContent ?? "";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Cola del encargado", () => {
  it("pide la cola del contrato y pinta la tarjeta con folio, canal, total, tiempo y boton grande", async () => {
    const f = vi.fn(async () => json(200, cola([tarjeta()])));
    await montar(f);
    const [url] = f.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.test/v1/restaurantes/prop-1/admin/operacion/cola?propertyId=prop-1");
    expect(textos()).toContain("#150");
    expect(textos()).toContain("Domicilio");
    expect(textos()).toContain("WhatsApp");
    expect(textos()).toContain("708.00");
    expect(textos()).toContain("Esperando");
    const boton = document.querySelector('button[aria-label="Aceptar pedido #150"]') as HTMLButtonElement;
    expect(boton).not.toBeNull();
    expect(boton.className).toContain("h-14");
  });

  it("501 del servidor: dice «No disponible aún» y no ofrece ningun control de pedido", async () => {
    await montar(vi.fn(async () => json(501, { code: "no_implementado", message: "No disponible aún: x" })));
    expect(textos()).toContain("No disponible aún");
    expect(document.querySelectorAll('button[aria-label^="Aceptar"]')).toHaveLength(0);
  });

  it("error del servidor: muestra el mensaje con Reintentar", async () => {
    await montar(vi.fn(async () => json(500, { code: "interno", message: "Falló el servidor." })));
    expect(textos()).toContain("Falló el servidor.");
    expect(Array.from(document.querySelectorAll("button")).some((b) => /reintentar/i.test(b.textContent ?? ""))).toBe(true);
  });

  it("sin pedidos en la pestana: estado vacio", async () => {
    await montar(vi.fn(async () => json(200, cola([]))));
    expect(textos()).toContain("Sin pedidos aquí");
  });

  it("un doble toque en Aceptar manda UNA sola escritura, con Idempotency-Key, y vuelve a consultar", async () => {
    let resolver: (r: Response) => void = () => undefined;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Promise<Response>((r) => (resolver = r));
      return json(200, cola([tarjeta()]));
    });
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    const boton = () => document.querySelector('button[aria-label="Aceptar pedido #150"]') as HTMLButtonElement;
    click(boton());
    click(boton());
    await act(async () => {
      await Promise.resolve();
    });
    const patches = f.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === "PATCH");
    expect(patches).toHaveLength(1);
    const init = patches[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ status: "preparando" });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toMatch(/.+/);
    expect(boton().disabled).toBe(true);
    const antes = f.mock.calls.length;
    await act(async () => {
      resolver(json(200, { yaAplicado: false }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(f.mock.calls.length).toBeGreaterThan(antes); // refresco tras la accion
  });

  it("un pedido en preparacion se ve en su pestana con el boton Listo; un domicilio listo manda a Viajes", async () => {
    const prep = tarjeta({ id: "00000000-0000-4000-8000-000000000002", numero: 151, estado: "preparando", accionesDisponibles: ["listo", "cancelar"] });
    const listo = tarjeta({ id: "00000000-0000-4000-8000-000000000003", numero: 152, estado: "preparando", listoAt: new Date().toISOString(), accionesDisponibles: ["salio", "cancelar"] });
    await montar(vi.fn(async () => json(200, cola([prep, listo]))));
    expect(textos()).not.toContain("#151");
    tocarPestana("preparacion");
    await act(async () => undefined);
    expect(document.querySelector('button[aria-label="Listo pedido #151"]')).not.toBeNull();
    tocarPestana("listos");
    await act(async () => undefined);
    const enlace = document.querySelector('a[aria-label="Despachar pedido #152 en Viajes"]') as HTMLAnchorElement;
    expect(enlace.getAttribute("href")).toBe("/restaurantes/demo/operacion/viajes");
  });

  it("alerta de pedido nuevo visible, aviso honesto de iOS y sonido apagado hasta que la persona lo active", async () => {
    await montar(vi.fn(async () => json(200, cola([tarjeta()]))));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Pedido nuevo #150");
    expect(textos()).toContain("Activar sonido y mantener pantalla encendida");
    expect(textos()).toContain("puede no sonar");
    // Tocar la tarjeta reconoce el pedido y quita la alerta.
    click(document.querySelector('[data-testid="tarjeta-pedido-150"]') as HTMLElement);
    await act(async () => undefined);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("marca los pedidos sin aviso al cliente con texto, no solo con color", async () => {
    await montar(vi.fn(async () => json(200, cola([tarjeta({ sinAviso: true })]))));
    expect(textos()).toContain("Sin aviso al cliente: llamar");
  });
});

// @vitest-environment jsdom
//
// Viajes del encargado: lote de hasta 6, chofer, «Salió» con confirmacion y UN solo POST de despacho (nunca PATCH), en camino con alerta a 90 min.
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TarjetaPedido, ViajesSalida } from "@atiende/domain-restaurantes/operacion";
import { OperacionViajesPage } from "../../src/verticals/restaurantes/pages/OperacionViajes.tsx";
import type { RestaurantesShellContext } from "../../src/verticals/restaurantes/RestaurantesShell.tsx";
import { notify } from "@atiende/ui";
import { click, renderComponent, type RenderedComponent } from "../test-utils/render.tsx";

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona de prueba", staffEmail: "persona@example.test", nombreSucursal: "Sucursal de prueba" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CHOFER = uuid(900);
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status, headers: { "content-type": "application/json" } });

function tarjeta(n: number, extra: Partial<TarjetaPedido> = {}): TarjetaPedido {
  return {
    id: uuid(n), numero: n, estado: "preparando", canal: "domicilio", origen: "whatsapp", clienteNombre: `Cliente ${n}`, resumenItems: "2 pastor", total: 100 + n, creadoEn: new Date().toISOString(),
    aceptadoEn: null, listoAt: new Date().toISOString(), salioAt: null, minutos: 5, semaforo: "verde", repartidorId: null, sinAviso: false, accionesDisponibles: ["salio"], ...extra,
  };
}
function viajes(porSalir: TarjetaPedido[], enCamino: TarjetaPedido[] = []): ViajesSalida {
  return { porSalir, enCamino, recientes: [], repartidores: [{ id: CHOFER, nombre: "Luis", activos: 1, disponible: true, sugerido: true }], actualizadoEn: new Date().toISOString() };
}

let rendered: RenderedComponent | undefined;
const esperar = (ms = 0) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function montar(f: ReturnType<typeof vi.fn>, ctx: RestaurantesShellContext = CTX) {
  vi.stubGlobal("fetch", f);
  await act(async () => {
    rendered = renderComponent(
      <MemoryRouter>
        <OperacionViajesPage {...ctx} />
      </MemoryRouter>,
    );
  });
  await esperar(10);
}
const boton = (re: RegExp) => Array.from(document.querySelectorAll("button")).find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement;
const fila = (n: number) => document.querySelector(`[data-testid="viaje-pedido-${n}"]`) as HTMLElement;
const textos = () => document.body.textContent ?? "";
const dispatches = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter((c) => String(c[0]).endsWith("/admin/orders/dispatch"));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("Viajes", () => {
  it("lista por salir y en camino; sin seleccion el boton Salió esta bloqueado; 90 min = alerta roja", async () => {
    const f = vi.fn(async () => json(200, viajes([tarjeta(146)], [tarjeta(141, { estado: "en_camino", minutos: 104, repartidorId: CHOFER, salioAt: new Date().toISOString() })])));
    await montar(f);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/operacion/viajes?propertyId=prop-1");
    expect(textos()).toContain("#146 · Cliente 146");
    expect(boton(/^Salió/).disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("más de 90 minutos");
    const camino = document.querySelector('[data-testid="en-camino-141"]')!;
    expect(camino.getAttribute("data-semaforo")).toBe("rojo");
    expect(camino.textContent).toContain("Chofer: Luis");
    expect(camino.textContent).toContain("Atrasado");
  });

  it("lote de 2: confirma y manda UN POST de despacho (sin PATCH) con Idempotency-Key", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(200, { resultados: [146, 147].map((n) => ({ pedidoId: uuid(n), resultado: "despachado", estado: "en_camino", salioAt: new Date().toISOString(), repartidorId: CHOFER, aviso: "encolado" })) });
      return json(200, viajes([tarjeta(146), tarjeta(147)]));
    });
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    click(fila(147));
    await esperar(0);
    expect(boton(/^Salió/).textContent).toContain("Salió (2 pedidos)");
    click(boton(/^Salió/));
    await esperar(0);
    expect(textos()).toContain("#146, #147");
    expect(dispatches(f as unknown as ReturnType<typeof vi.fn>)).toHaveLength(0); // aun no: falta confirmar
    click(boton(/^Sí, salió$/));
    await esperar(20);
    const d = dispatches(f as unknown as ReturnType<typeof vi.fn>);
    expect(d).toHaveLength(1);
    const init = d[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ pedidos: [uuid(146), uuid(147)], repartidorId: CHOFER, desdeEstado: "preparando", etaMin: 35 });
    expect((init.headers as Record<string, string>)["idempotency-key"]).toMatch(/.+/);
    expect(f.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === "PATCH")).toBe(false);
  });

  it("el septimo pedido no entra al lote y se avisa", async () => {
    const f = vi.fn(async () => json(200, viajes([1, 2, 3, 4, 5, 6, 7].map((n) => tarjeta(200 + n)))));
    await montar(f);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) click(fila(200 + n));
    await esperar(0);
    expect(boton(/^Salió/).textContent).toContain("Salió (6 pedidos)");
    expect(fila(207).getAttribute("aria-checked")).toBe("false");
    expect(textos()).toContain("máximo 6 pedidos");
  });

  it("chofer fuera de turno: pregunta y reenvia con forzar", async () => {
    let n = 0;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        n += 1;
        return n === 1 ? json(422, { code: "repartidor_no_disponible", message: "Fuera de turno" }) : json(200, { resultados: [{ pedidoId: uuid(146), resultado: "despachado", estado: "en_camino", salioAt: null, repartidorId: CHOFER, aviso: "omitido:sin_consentimiento" }] });
      }
      return json(200, viajes([tarjeta(146)]));
    });
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    await esperar(0);
    click(boton(/^Salió/));
    await esperar(0);
    click(boton(/^Sí, salió$/));
    await esperar(20);
    expect(textos()).toContain("Chofer fuera de turno");
    click(boton(/^Sí, despachar$/));
    await esperar(20);
    const d = dispatches(f as unknown as ReturnType<typeof vi.fn>);
    expect(d).toHaveLength(2);
    expect(JSON.parse(String((d[1]![1] as RequestInit).body)).forzar).toBe(true);
  });

  it("501: dice «No disponible aún» sin controles de despacho", async () => {
    await montar(vi.fn(async () => json(501, { code: "no_implementado", message: "x" })));
    expect(textos()).toContain("No disponible aún");
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
  });

  it("sin permiso de despachar (otro rol) la pantalla es solo de consulta: ni seleccion ni boton Salió", async () => {
    const f = vi.fn(async () => json(200, viajes([tarjeta(146)])));
    await montar(f, { ...CTX, role: "repartidor" });
    expect(textos()).toContain("#146 · Cliente 146");
    expect(textos()).toContain("Solo consulta");
    expect(document.querySelector('[role="checkbox"]')).toBeNull();
    expect(boton(/^Salió/)).toBeUndefined();
    expect(dispatches(f)).toHaveLength(0);
  });

  it("fallo parcial: no cuenta como salido lo que el servidor no confirmo y dice cual falto", async () => {
    const exito = vi.spyOn(notify, "success").mockImplementation(() => "x");
    const aviso = vi.spyOn(notify, "warning").mockImplementation(() => "x");
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(200, { resultados: [{ pedidoId: uuid(146), resultado: "despachado", estado: "en_camino", salioAt: null, repartidorId: CHOFER, aviso: "encolado" }] });
      return json(200, viajes([tarjeta(146), tarjeta(147)]));
    });
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    click(fila(147));
    await esperar(0);
    click(boton(/^Salió/));
    await esperar(0);
    click(boton(/^Sí, salió$/));
    await esperar(20);
    expect(exito).toHaveBeenCalledWith("El pedido #146 salió con Luis.");
    expect(aviso.mock.calls.map((c) => c[0]).join(" ")).toContain("#147");
    exito.mockRestore();
    aviso.mockRestore();
  });

  it("409 estado_cambio: avisa cual pedido cambio y no declara nada como salido", async () => {
    const exito = vi.spyOn(notify, "success").mockImplementation(() => "x");
    const aviso = vi.spyOn(notify, "warning").mockImplementation(() => "x");
    const f = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? json(409, { code: "estado_cambio", message: "cambio", details: { pedidoId: uuid(147) } }) : json(200, viajes([tarjeta(146), tarjeta(147)]))));
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    click(fila(147));
    await esperar(0);
    click(boton(/^Salió/));
    await esperar(0);
    click(boton(/^Sí, salió$/));
    await esperar(20);
    expect(exito).not.toHaveBeenCalled();
    expect(aviso.mock.calls.map((c) => c[0]).join(" ")).toContain("#147 ya cambió de estado");
    exito.mockRestore();
    aviso.mockRestore();
  });

  it("doble toque en «Sí, salió» manda UN solo despacho", async () => {
    let resolver: () => void = () => undefined;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        await new Promise<void>((r) => (resolver = r));
        return json(200, { resultados: [{ pedidoId: uuid(146), resultado: "despachado", estado: "en_camino", salioAt: null, repartidorId: CHOFER, aviso: "encolado" }] });
      }
      return json(200, viajes([tarjeta(146)]));
    });
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    await esperar(0);
    click(boton(/^Salió/));
    await esperar(0);
    const confirmar = boton(/^Sí, salió$/);
    click(confirmar);
    click(confirmar);
    await esperar(5);
    expect(dispatches(f as unknown as ReturnType<typeof vi.fn>)).toHaveLength(1);
    await act(async () => resolver());
    await esperar(10);
    expect(dispatches(f as unknown as ReturnType<typeof vi.fn>)).toHaveLength(1);
  });

  it("si un pedido ya no esta en preparando, no se manda desdeEstado", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, { resultados: [{ pedidoId: uuid(146), resultado: "despachado", estado: "en_camino", salioAt: null, repartidorId: CHOFER, aviso: "encolado" }] }) : json(200, viajes([tarjeta(146, { estado: "listo_para_recoger" })]))));
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    await esperar(0);
    click(boton(/^Salió/));
    await esperar(0);
    click(boton(/^Sí, salió$/));
    await esperar(20);
    const d = dispatches(f as unknown as ReturnType<typeof vi.fn>);
    expect(JSON.parse(String((d[0]![1] as RequestInit).body))).not.toHaveProperty("desdeEstado");
  });

  it("respuesta 200 malformada: mensaje honesto de respuesta inesperada, no «sin conexion» ni exito", async () => {
    const exito = vi.spyOn(notify, "success").mockImplementation(() => "x");
    const error = vi.spyOn(notify, "error").mockImplementation(() => "x");
    const f = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "POST" ? json(200, {}) : json(200, viajes([tarjeta(146)]))));
    await montar(f as unknown as ReturnType<typeof vi.fn>);
    click(fila(146));
    await esperar(0);
    click(boton(/^Salió/));
    await esperar(0);
    click(boton(/^Sí, salió$/));
    await esperar(20);
    expect(exito).not.toHaveBeenCalled();
    const textosError = error.mock.calls.map((c) => String(c[0])).join(" ");
    expect(textosError).toContain("Respuesta inesperada del servidor");
    expect(textosError).not.toContain("No hay conexión");
    exito.mockRestore();
    error.mockRestore();
  });
});

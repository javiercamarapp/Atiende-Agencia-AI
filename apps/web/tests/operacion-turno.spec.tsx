// @vitest-environment jsdom
//
// Pantalla Turno (paquete C2): cifras reales del contrato, «—» con motivo y nunca 0 inventado, alerta en rojo >90 min,
// estados de carga/error/no disponible, y el cambio de corte vuelve a consultar.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperacionTurnoPage } from "../src/verticals/restaurantes/pages/OperacionTurno.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"] }));
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "t", propertyId: "prop-1", orgSlug: "demo", role: "staff", staffFullName: "Persona", staffEmail: "p@example.test", nombreSucursal: "Sucursal de prueba" };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HOY = {
  corte: { desde: "2026-10-21T18:00:00.000Z", hasta: "2026-10-22T06:00:00.000Z" },
  pedidos: { total: 23, porEstado: { pending: 2, preparando: 5, en_camino: 3, entregado: 11, cancelado: 1, problema: 1 } },
  ventas: 16300, ticketPromedio: 708,
  puntuales: { pct: 91, evaluados: 20, umbralMin: { domicilio: 65, recoger: 35 } },
  tiempos: { preparacionMinProm: 14, entregaMinProm: 31, entregaMinP90: 48 },
  cancelados: { total: 1, porMotivo: { cliente_cancelo: 1 } },
  porCanal: { whatsapp: 9, voz: 4, llamada: 7, mostrador: 2, web: 1 },
  alertas: { sinAceptar: [{ pedidoId: U(1), numero: 150, minutos: 6 }], enCaminoMas90: [{ pedidoId: U(2), numero: 141, minutos: 104 }] },
  efectivoPorChofer: { disponible: true, choferes: [{ repartidorId: U(4), nombre: "Luis", entregas: 6, efectivoPorEntregar: 3120 }] },
  actualizadoEn: "2026-10-21T20:41:00.000Z",
};
const json = (status: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status });
async function esperar(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
}
function montar(respuesta: () => Response) {
  const f = vi.fn(async (..._a: unknown[]) => respuesta());
  vi.stubGlobal("fetch", f);
  rendered = renderComponent(<OperacionTurnoPage {...CTX} />);
  return f;
}
const texto = () => document.body.textContent ?? "";

describe("Turno de hoy", () => {
  it("pide el corte actual de su sucursal y pinta cifras, canales, alerta roja y efectivo por chofer", async () => {
    const f = montar(() => json(200, HOY));
    await esperar();
    expect(String(f.mock.calls[0]![0])).toBe("https://api.test/v1/restaurantes/prop-1/admin/operacion/hoy?propertyId=prop-1&turno=actual");
    for (const s of ["Pedidos", "$16,300.00", "$708.00", "91%", "31 min", "WhatsApp", "#141 lleva 104 min en camino", "Luis", "$3,120.00", "Chofer con más entregas"]) expect(texto()).toContain(s);
    expect(document.querySelector('[data-alerta="roja"]')).not.toBeNull();
  });

  it("falta de datos: «—» con motivo, sin 0 inventado, y avisa que base falta actualizar", async () => {
    montar(() => json(200, { ...HOY, tiempos: { preparacionMinProm: null, entregaMinProm: null, entregaMinP90: null }, efectivoPorChofer: { disponible: false, choferes: [] } }));
    await esperar();
    expect(texto()).toContain("falta registrar la hora de salida");
    expect(texto()).toContain("falta el registro de cobros por chofer");
    expect(document.querySelector('[aria-label="Entrega promedio: sin dato"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Hora pico: sin dato"]')).not.toBeNull();
  });

  it("501 o 404: estado «No disponible aún» sin controles de corte", async () => {
    montar(() => json(501, { code: "no_implementado", message: "x" }));
    await esperar();
    expect(texto()).toContain("No disponible aún");
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it("error 500: mensaje y Reintentar; reintentar recupera", async () => {
    let falla = true;
    montar(() => (falla ? json(500, { code: "internal", message: "Falla del servidor" }) : json(200, HOY)));
    await esperar();
    expect(texto()).toContain("Falla del servidor");
    falla = false;
    click([...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"))!);
    await esperar();
    expect(texto()).toContain("$16,300.00");
  });

  it("cambiar a «Todo el día» consulta turno=dia; el sondeo repite cada 15 s", async () => {
    const f = montar(() => json(200, HOY));
    await esperar();
    click([...document.querySelectorAll("input[type=radio]")].find((r) => (r as HTMLInputElement).value === "dia")!);
    await esperar();
    expect(f.mock.calls.some(([u]) => String(u).endsWith("turno=dia"))).toBe(true);
    const antes = f.mock.calls.length;
    await esperar(15_000);
    expect(f.mock.calls.length).toBe(antes + 1);
  });
});

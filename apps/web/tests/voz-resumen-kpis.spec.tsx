// @vitest-environment jsdom
//
// <ResumenKpisVoz />: pedidos completados / participacion / cancelacion de voz (kpis/channels) y llamadas + escalacion del mes (voz/kpi).
// Cubre cifras exactas, "—" sin pedidos (nunca 0 inventado), telemetria no activa («no disponible aun»), concurrencia siempre honesta y error con reintento.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumenKpisVoz } from "../src/verticals/restaurantes/voz/ResumenKpisVoz.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const CANALES = (voice: { orders: number; completed: number; cancelled: number }, total: number) => ({
  totalOrders: total,
  totalRevenue: 0,
  voice: { ...voice, revenue: 0 },
  whatsapp: { orders: 0, completed: 0, cancelled: 0, revenue: 0 },
  whatsappConversations: { total: 0, withOrder: 0, averageMessages: 0 },
  aiAdoptionPct: null,
  aiRevenuePct: null,
  estimatedHoursSaved: 0,
  periodo: { acotado: true, etiqueta: "Últimos 30 días" },
});
const KPI_VOZ = { disponible: true, mes: { llamadas: 7, llamadasCerradas: 6, escaladas: 1, tasaHandoffPct: 17 } };

function res(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
async function montar(rutas: { canales: () => Response; voz?: () => Response }) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/admin/kpis/channels")) return rutas.canales();
    if (url.endsWith("/admin/voz/kpi")) return (rutas.voz ?? (() => res(200, KPI_VOZ)))();
    throw new Error(`fetch inesperado: ${url}`);
  }) as unknown as typeof fetch;
  rendered = renderComponent(<ResumenKpisVoz apiBaseUrl="https://api.test" token="t" propertyId="prop-1" fetchImpl={fetchImpl} />);
  await act(async () => {
    for (let i = 0; i < 10; i++) await flushMicrotasks();
  });
  return fetchImpl;
}
const texto = () => rendered!.container.querySelector("[data-testid='resumen-kpis-voz']")?.textContent ?? rendered!.container.textContent ?? "";

describe("ResumenKpisVoz", () => {
  it("calcula completados, participacion y cancelacion con los pedidos reales y muestra llamadas y escalacion", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 20, completed: 18, cancelled: 1 }, 80)) });
    const t = texto();
    expect(t).toContain("90%");
    expect(t).toContain("18 de 20");
    expect(t).toContain("25%");
    expect(t).toContain("20 de 80 pedidos");
    expect(t).toContain("5%");
    expect(t).toContain("Llamadas del mes");
    expect(t).toContain("6 cerradas");
    expect(t).toContain("17%");
  });

  it("sin pedidos por voz muestra «—» y lo explica, sin 0% inventado", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 0, completed: 0, cancelled: 0 }, 0)) });
    const t = texto();
    expect(t).toContain("Aún no hay pedidos por voz");
    expect(t).not.toContain("0%");
  });

  it("sin telemetria de llamadas dice «no disponible aún» y la concurrencia siempre lo dice", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 2, completed: 2, cancelled: 0 }, 4)), voz: () => res(503) });
    const t = texto();
    expect(t).toContain("No disponible aún: requiere la telemetría de llamadas de voz");
    expect(t).toContain("No disponible aún: requiere leer la concurrencia del proveedor de voz");
  });

  it("si los canales fallan muestra el error y Reintentar vuelve a pedir", async () => {
    let n = 0;
    const f = await montar({ canales: () => (n++ === 0 ? res(500, { error: "boom" }) : res(200, CANALES({ orders: 1, completed: 1, cancelled: 0 }, 2))) });
    expect(rendered!.container.textContent).toContain("Reintentar");
    const boton = Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Reintentar"))!;
    click(boton);
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("100%");
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(2);
  });
});

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
async function montar(rutas: { canales: () => Response; voz?: () => Response }, role = "owner") {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/admin/kpis/channels")) return rutas.canales();
    if (url.endsWith("/admin/voz/kpi")) return (rutas.voz ?? (() => res(200, KPI_VOZ)))();
    throw new Error(`fetch inesperado: ${url}`);
  }) as unknown as typeof fetch;
  rendered = renderComponent(<ResumenKpisVoz apiBaseUrl="https://api.test" token="t" propertyId="prop-1" role={role} fetchImpl={fetchImpl} />);
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
    expect(t).toContain("90.0%");
    expect(t).toContain("18 de 20");
    expect(t).toContain("25.0%");
    expect(t).toContain("20 de 80 pedidos");
    expect(t).toContain("5.0%");
    expect(t).toContain("Llamadas del mes");
    expect(t).toContain("6 cerradas");
    expect(t).toContain("17.0%");
  });

  it("sin pedidos por voz muestra «—» y lo explica, sin 0% inventado", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 0, completed: 0, cancelled: 0 }, 0)) });
    const t = texto();
    expect(t).toContain("Aún no hay pedidos por voz");
    expect(t).toContain("—");
    expect(t).not.toContain("NaN");
    expect(t).not.toContain("Pedidos completados por voz0.0%");
  });

  it("sin telemetria de llamadas dice «no disponible aún» y la concurrencia siempre lo dice", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 2, completed: 2, cancelled: 0 }, 4)), voz: () => res(503) });
    const t = texto();
    expect(t).toContain("No disponible aún: requiere la telemetría de llamadas de voz");
    expect(t).toContain("No disponible aún: requiere leer la concurrencia del proveedor de voz");
  });

  it("singular: 1 llamada, 1 cerrada y 1 cancelado", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 4, completed: 3, cancelled: 1 }, 8)), voz: () => res(200, { disponible: true, mes: { llamadas: 1, llamadasCerradas: 1, escaladas: 1, tasaHandoffPct: 100 } }) });
    const t = texto();
    expect(t).toContain("1 cerrada");
    expect(t).not.toContain("1 cerradas");
    expect(t).toContain("1 llamada");
    expect(t).not.toContain("1 llamadas");
    expect(t).toContain("1 cancelado ·");
  });

  it("un 403 de voz/kpi (rol sin permiso) no se lee como telemetria apagada", async () => {
    await montar({ canales: () => res(200, CANALES({ orders: 2, completed: 2, cancelled: 0 }, 4)), voz: () => res(403, { error: "forbidden" }) });
    const t = texto();
    expect(t).toContain("No se pudieron cargar las llamadas del mes.");
    expect(t).not.toContain("requiere la telemetría de llamadas");
    expect(t).toContain("Reintentar");
  });

  it("staff: no se pide voz/kpi y dice que solo owner/admin ven las llamadas", async () => {
    const f = await montar({ canales: () => res(200, CANALES({ orders: 2, completed: 2, cancelled: 0 }, 4)) }, "staff");
    expect(texto()).toContain("Solo el dueño o un administrador ve las llamadas del mes.");
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) => String(c[0]).endsWith("/admin/voz/kpi"))).toBe(false);
  });

  it("un error de red en voz/kpi muestra el error con Reintentar y al reintentar recupera", async () => {
    let n = 0;
    await montar({
      canales: () => res(200, CANALES({ orders: 2, completed: 2, cancelled: 0 }, 4)),
      voz: () => {
        if (n++ === 0) throw new Error("Failed to fetch");
        return res(200, KPI_VOZ);
      },
    });
    expect(texto()).toContain("Failed to fetch");
    const boton = Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes("Reintentar"))!;
    click(boton);
    await act(async () => {
      for (let i = 0; i < 10; i++) await flushMicrotasks();
    });
    expect(texto()).toContain("6 cerradas");
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
    expect(texto()).toContain("100.0%");
    expect((f as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(2);
  });
});

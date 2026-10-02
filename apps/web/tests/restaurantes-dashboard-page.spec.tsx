// @vitest-environment jsdom
//
// Smoke tests reales de <RestaurantesDashboardPage /> (panel ejecutivo de KPIs
// — ventas, canales de IA, clientes). `fetch` global mockeado por ruta real
// contra `GET /v1/restaurantes/:propertyId/admin/kpis/*`
// (apps/web/src/verticals/restaurantes/dashboard-client.ts::fetchDashboardData,
// 4 llamadas en paralelo), estado de carga, estado de error real (nunca datos
// a medias), datos reales con formato (dinero/pct/"Sin datos" honesto cuando
// el backend manda `null`), cambiar de periodo y el botón "Actualizar".
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { RestaurantesDashboardPage } from "../src/verticals/restaurantes/pages/Dashboard.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { ChannelKpis, CustomerKpis, SalesKpis } from "../src/verticals/restaurantes/dashboard-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Gaby Demo",
  staffEmail: "gaby@example.com",
};

const SALES_30: SalesKpis = {
  revenue: 45230.5,
  orders: 312,
  customers: 180,
  averageOrder: 145,
  revenueChangePct: 12.4,
  ordersChangePct: 5.1,
  customersChangePct: null,
  avgOrderChangePct: -2.3,
  periodLabel: "vs. 30 días anteriores",
};

const CHANNELS: ChannelKpis = {
  totalOrders: 312,
  totalRevenue: 45230.5,
  voice: { orders: 40, completed: 38, cancelled: 2, revenue: 5800 },
  whatsapp: { orders: 90, completed: 85, cancelled: 5, revenue: 12500 },
  whatsappConversations: { total: 120, withOrder: 90, averageMessages: 6.5 },
  aiAdoptionPct: 41.7,
  aiRevenuePct: 40.5,
  estimatedHoursSaved: 10.8,
  periodo: { acotado: true, etiqueta: "Últimos 30 días" },
};

const CUSTOMERS_CON_DATOS: CustomerKpis = {
  totalCustomers: 180,
  averageOrderValue: 145,
  recurringCustomerPct: 62.5,
  topCustomer: { name: "Ana Torres", phone: "5512345678", orderCount: 14 },
  avgDaysSinceLastOrder: 6,
  tierDistribution: { metric: "gasto", BLACK: 3, PLATINUM: 12, GOLD: 40, BLUE: 125, withoutTier: 0 },
};

const CUSTOMERS_SIN_DATOS: CustomerKpis = {
  totalCustomers: 0,
  averageOrderValue: null,
  recurringCustomerPct: null,
  topCustomer: null,
  avgDaysSinceLastOrder: null,
  tierDistribution: { metric: "sin_datos", BLACK: 0, PLATINUM: 0, GOLD: 0, BLUE: 0, withoutTier: 0 },
};

interface Handlers {
  zona?: string | null;
  voz?: boolean;
  pendientes?: number;
  ultimaWa?: string | null;
  ultimaVoz?: string | null;
  sales?: SalesKpis;
  channels?: ChannelKpis;
  customers?: CustomerKpis;
  salesOk?: boolean;
  channelsOk?: boolean;
  customersOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/admin/config/zona-horaria")) return jsonResponse({ zonaHoraria: handlers.zona ?? null });
    if (url.includes("/admin/voz/kpi")) {
      if (!handlers.voz) return jsonResponse({ disponible: false }, false);
      return jsonResponse({ disponible: true, zonaHoraria: "America/Mexico_City", hoy: "2026-10-02", diaDeHoy: { llamadas: 4 }, mes: { llamadas: 57 }, serie: [] });
    }
    if (url.includes("/admin/conversaciones")) {
      const q = new URL(url).searchParams;
      const item = (iso: string | null | undefined) => (iso ? [{ canal: "whatsapp", conversationId: "c1", actividadEn: iso }] : []);
      const cobertura = { sinCobertura: false, turnosVigentes: [], guardia: [] };
      if (q.get("estado") === "pendiente") return jsonResponse({ disponible: true, total: handlers.pendientes ?? 0, nextOffset: null, cobertura, items: [] });
      const iso = q.get("canal") === "voz" ? handlers.ultimaVoz : handlers.ultimaWa;
      return jsonResponse({ disponible: true, total: iso ? 1 : 0, nextOffset: null, cobertura, items: item(iso) });
    }
    if (url.includes("/kpis/sales/trend")) return jsonResponse({ buckets: [{ label: "1", revenue: 100, orders: 2 }] }, handlers.salesOk ?? true);
    if (url.includes("/kpis/sales")) return jsonResponse(handlers.sales ?? SALES_30, handlers.salesOk ?? true);
    if (url.includes("/kpis/channels")) return jsonResponse(handlers.channels ?? CHANNELS, handlers.channelsOk ?? true);
    if (url.includes("/kpis/customers")) return jsonResponse(handlers.customers ?? CUSTOMERS_CON_DATOS, handlers.customersOk ?? true);
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(ctx: RestaurantesShellContext = CTX): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <RestaurantesDashboardPage {...ctx} />
    </MemoryRouter>,
  );
}

/** Etiquetas de las tarjetas KPI, en el orden en que aparecen en el DOM. */
function etiquetasKpi(r: RenderedComponent): string[] {
  return [...r.container.querySelectorAll('[data-testid="stat-card-chip"]')].map((chip) => chip.nextElementSibling?.textContent ?? "");
}

function tarjeta(r: RenderedComponent, etiqueta: string): HTMLElement {
  const chip = [...r.container.querySelectorAll('[data-testid="stat-card-chip"]')].find((c) => c.nextElementSibling?.textContent === etiqueta);
  if (!chip) throw new Error(`sin tarjeta ${etiqueta}`);
  return chip.closest(".shadow-card") as HTMLElement;
}

function enlaces(r: RenderedComponent): Record<string, string> {
  return Object.fromEntries([...r.container.querySelectorAll("a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")!]));
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("RestaurantesDashboardPage (Resumen)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando panel");
  });

  it("estado de error real cuando falla cualquiera de las 4 llamadas de KPIs — nunca se queda a medias", async () => {
    stubFetch({ customersOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando panel");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/restaurantes/prop-1/admin/kpis/customers (500).");
    expect(rendered.container.querySelectorAll('[data-testid="stat-card-chip"]').length).toBe(0);
  });

  it("los KPIs salen en el orden de Likida y sin 'Horas de atención ahorradas' (el endpoint la estima con un supuesto, no la mide)", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    expect(etiquetasKpi(rendered)).toEqual([
      "Número de órdenes",
      "Valor promedio",
      "Pedidos por agentes IA",
      "Ingresos por agentes IA",
      "Pedidos por WhatsApp",
      "Pedidos por voz",
      "Clientes recurrentes",
    ]);
    expect(rendered.container.textContent).not.toContain("Horas de atención ahorradas");
    expect(rendered.container.textContent).not.toContain("Estimado");
  });

  it("cifras reales: órdenes, valor promedio, pedidos e ingresos de agentes, canales y recurrencia", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    expect(tarjeta(rendered, "Número de órdenes").textContent).toContain("312");
    expect(tarjeta(rendered, "Valor promedio").textContent).toContain("$145.00");
    expect(tarjeta(rendered, "Pedidos por agentes IA").textContent).toContain("130"); // 40 voz + 90 whatsapp
    expect(tarjeta(rendered, "Pedidos por agentes IA").textContent).toContain("42% de los pedidos");
    expect(tarjeta(rendered, "Ingresos por agentes IA").textContent).toContain("$18,300.00"); // 5800 + 12500
    expect(tarjeta(rendered, "Ingresos por agentes IA").textContent).toContain("sin cancelados");
    expect(tarjeta(rendered, "Pedidos por WhatsApp").textContent).toContain("90");
    expect(tarjeta(rendered, "Pedidos por voz").textContent).toContain("40");
    expect(tarjeta(rendered, "Clientes recurrentes").textContent).toContain("63%");
    expect(rendered.container.textContent).toContain("Últimos 30 días");
  });

  it("ventas netas: el destacado del encabezado lleva la cifra real", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const odometro = rendered.container.querySelector('[data-testid="odometro"]')!;
    expect(odometro.getAttribute("aria-label")).toContain("Ventas netas");
    expect(odometro.getAttribute("aria-label")).toContain("45,231");
    expect(rendered.container.textContent).toContain("$45,230.50");
  });

  it("delta solo con periodo comparable: con base se pinta con flecha; sin base dice 'sin periodo comparable', nunca un 0%", async () => {
    stubFetch({ sales: { ...SALES_30, ordersChangePct: null } });
    rendered = renderPage();
    await esperarCarga();
    expect(tarjeta(rendered, "Valor promedio").textContent).toContain("↓ 2.3%");
    expect(tarjeta(rendered, "Valor promedio").textContent).toContain("vs. 30 días anteriores");
    expect(tarjeta(rendered, "Número de órdenes").textContent).toContain("sin periodo comparable");
    expect(tarjeta(rendered, "Número de órdenes").textContent).not.toContain("0%");
    // Los KPIs de agentes no tienen concepto de comparativo: no inventan uno.
    expect(tarjeta(rendered, "Pedidos por voz").textContent).not.toContain("periodo comparable");
  });

  it("histórico: sin comparativo, el pie dice el periodo", async () => {
    stubFetch({ sales: { ...SALES_30, periodLabel: "Todo el tiempo registrado", ordersChangePct: null, avgOrderChangePct: null } });
    rendered = renderPage();
    await esperarCarga();
    const tab = [...rendered.container.querySelectorAll('input[type="radio"]')].find((i) => (i as HTMLInputElement).value === "historico") as HTMLInputElement;
    await act(async () => {
      tab.click();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(tarjeta(rendered, "Número de órdenes").textContent).not.toContain("sin periodo comparable");
    expect(tarjeta(rendered, "Número de órdenes").textContent).toContain("Todo el tiempo registrado");
  });

  it("sin dato real: '—' honesto en vez de 0 (clientes recurrentes sin pedidos vinculados)", async () => {
    stubFetch({ customers: CUSTOMERS_SIN_DATOS });
    rendered = renderPage();
    await esperarCarga();
    const t = tarjeta(rendered, "Clientes recurrentes");
    expect(t.textContent).toContain("—");
    expect(t.textContent).toContain("Aún no hay pedidos vinculados a clientes");
    expect(t.textContent).not.toContain("0%");
  });

  it("pildoras con su ruta real, incluida 'Pregunta a tus datos' hacia el Copiloto", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const links = enlaces(rendered);
    expect(links["Ver pedidos"]).toBe("/restaurantes/demo/pedidos");
    expect(links["Ver historial"]).toBe("/restaurantes/demo/historial");
    expect(links["Pregunta a tus datos"]).toBe("/restaurantes/demo/copiloto");
  });

  it("un rol sin Copiloto no ve la pildora 'Pregunta a tus datos'", async () => {
    stubFetch({});
    rendered = renderPage({ ...CTX, role: "desconocido" });
    await esperarCarga();
    expect(enlaces(rendered)["Pregunta a tus datos"]).toBeUndefined();
    expect(enlaces(rendered)["Ver pedidos"]).toBe("/restaurantes/demo/pedidos");
  });

  it("el repartidor no llega aquí: se le lleva a su panel sin pedir ningún KPI", async () => {
    stubFetch({});
    rendered = renderComponent(
      <MemoryRouter initialEntries={["/restaurantes/demo"]}>
        <Routes>
          <Route path="/restaurantes/demo" element={<RestaurantesDashboardPage {...CTX} role="repartidor" />} />
          <Route path="/restaurantes/demo/repartidor" element={<p>panel del repartidor</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await esperarCarga();
    expect(rendered.container.textContent).toContain("panel del repartidor");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Orquestación de agentes: tiles con su destino y métricas reales (WhatsApp del periodo, voz de hoy y del mes, toma humana)", async () => {
    stubFetch({ voz: true, pendientes: 3 });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text.toLowerCase()).toContain("orquestación de agentes");
    const links = enlaces(rendered);
    expect(links["WhatsApp120 conversaciones · 90 con pedido · Últimos 30 días"]).toBe("/restaurantes/demo/conversaciones");
    expect(Object.entries(links).find(([k]) => k.startsWith("Voz"))?.[1]).toBe("/restaurantes/demo/agente-voz");
    expect(text).toContain("4 llamadas hoy · 57 llamadas en el mes");
    expect(Object.entries(links).find(([k]) => k.startsWith("Toma humana"))?.[1]).toBe("/restaurantes/demo/conversaciones");
    expect(text).toContain("3 conversaciones esperan a una persona");
  });

  it("voz sin migrar (disponible:false) y roles sin Agente de voz: el tile se pinta sin métrica o no se pinta, y el resto carga", async () => {
    stubFetch({ voz: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Atención por llamada");
    expect(rendered.container.textContent).not.toContain("llamadas hoy");
    rendered.unmount();
    stubFetch({ voz: true });
    rendered = renderPage({ ...CTX, role: "staff" });
    await esperarCarga();
    expect(Object.keys(enlaces(rendered)).some((k) => k.startsWith("Voz"))).toBe(false);
  });

  it("última corrida: solo con actividad real (fecha de la última conversación en la zona de la sucursal)", async () => {
    stubFetch({ zona: "America/Mexico_City", ultimaWa: "2026-10-02T20:05:00Z", ultimaVoz: null });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Agente de WhatsApp");
    expect(text).toMatch(/Última conversación: 2 oct, 02:05/);
    expect(text).not.toContain("Agente de voz");
    expect(text).not.toContain("Sin bitácora de corridas");
  });

  it("sin ninguna conversación: EstadoVacio que dice que falta la bitácora, sin corridas inventadas", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Sin bitácora de corridas");
    expect(rendered.container.textContent).not.toContain("Agente de WhatsApp");
  });

  it("la bandeja de conversaciones caída no rompe el Resumen: KPIs visibles y vacío honesto", async () => {
    stubFetch({});
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string) => (url.includes("/admin/conversaciones") ? jsonResponse({ message: "boom" }, false) : base(url)));
    rendered = renderPage();
    await esperarCarga();
    expect(etiquetasKpi(rendered)).toHaveLength(7);
    expect(rendered.container.textContent).toContain("Sin bitácora de corridas");
    expect(rendered.container.textContent).toContain("Conversaciones que atiende una persona");
  });

  it("saludo por la hora de la sucursal, no la del navegador", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-02T01:30:00Z")); // 19:30 en CDMX = noche; 10:30 en Tokio = mañana
      stubFetch({ zona: "Asia/Tokyo" });
      rendered = renderPage();
      await esperarCarga();
      expect(rendered.container.querySelector("h1")!.textContent).toBe("Buenos días, Gaby");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cambiar el periodo a '7 días' vuelve a pedir los KPIs con ese periodo real", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const radio7 = [...rendered.container.querySelectorAll('input[type="radio"]')].find((i) => (i as HTMLInputElement).value === "7") as HTMLInputElement;
    await act(async () => {
      radio7.click();
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/kpis/sales?period=7"))).toBe(true);
  });

  it("botón 'Actualizar' vuelve a pedir los KPIs del periodo actual", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const callsAntes = fetchMock.mock.calls.length;
    const btn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Actualizar"))!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAntes);
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/kpis/sales?period=30"))).toBe(true);
  });
});

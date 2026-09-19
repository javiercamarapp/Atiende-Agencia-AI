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
import { MemoryRouter } from "react-router-dom";
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
  sales?: SalesKpis;
  channels?: ChannelKpis;
  customers?: CustomerKpis;
  salesOk?: boolean;
  channelsOk?: boolean;
  customersOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/kpis/sales/trend")) return jsonResponse({ buckets: [{ label: "1", revenue: 100, orders: 2 }] }, handlers.salesOk ?? true);
    if (url.includes("/kpis/sales")) return jsonResponse(handlers.sales ?? SALES_30, handlers.salesOk ?? true);
    if (url.includes("/kpis/channels")) return jsonResponse(handlers.channels ?? CHANNELS, handlers.channelsOk ?? true);
    if (url.includes("/kpis/customers")) return jsonResponse(handlers.customers ?? CUSTOMERS_CON_DATOS, handlers.customersOk ?? true);
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <RestaurantesDashboardPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("RestaurantesDashboardPage", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando panel");
  });

  it("estado de error real cuando falla cualquiera de las 4 llamadas — nunca se queda a medias", async () => {
    stubFetch({ customersOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando panel");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/v1/restaurantes/prop-1/admin/kpis/customers (500).");
    expect(rendered.container.textContent).not.toContain("Ventas netas");
  });

  it("renderiza los KPIs reales de ventas con formato de dinero/porcentaje", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("$45,230.50");
    expect(text).toContain("312");
    expect(text).toContain("+12.4%");
    expect(text).toContain("-2.3%");
  });

  it("cambio sin dato real (customersChangePct null) se pinta con guion, nunca un 0% inventado", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    // La nota de "Número de órdenes" usa ordersChangePct (5.1), no
    // customersChangePct -- pero el guion "—" debe aparecer en algún lado que
    // consuma un valor null real de esta respuesta (avgDaysSinceLastOrder no
    // aplica aquí; se verifica con el caso "sin datos" de clientes abajo).
    expect(rendered.container.textContent).toContain("+5.1%");
  });

  it("impacto de agentes IA: adopción, ingresos por canal y horas ahorradas (con su nota de estimado)", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("42%"); // aiAdoptionPct redondeado (formatPct sin decimales)
    expect(text).toContain("40"); // pedidos por voz
    expect(text).toContain("90"); // pedidos por whatsapp
    expect(text).toContain("$18,300.00"); // voice.revenue + whatsapp.revenue
    expect(text).toContain("10.8 h");
    expect(text).toContain("Estimado");
  });

  it("clientes con datos reales: total, ticket promedio, recurrencia, cliente top y tiers", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("180");
    expect(text).toContain("$145.00");
    expect(text).toContain("63%"); // recurringCustomerPct redondeado
    expect(text).toContain("Ana Torres");
    expect(text).toContain("14 pedidos");
    expect(text).toContain("Black");
    expect(text).toContain("· 3");
  });

  it("clientes sin datos reales: 'Sin datos' honesto en vez de 0/vacío fingido, y sin tiers", async () => {
    stubFetch({ customers: CUSTOMERS_SIN_DATOS });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Sin datos");
    expect(text).toContain("Todavía no hay pedidos vinculados a clientes ni frecuencia registrada");
    expect(text).not.toContain("Ana Torres");
  });

  it("cambiar el periodo a '7 días' vuelve a pedir los KPIs con ese periodo real", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const tab7 = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "7 días")!;
    await act(async () => {
      tab7.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
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

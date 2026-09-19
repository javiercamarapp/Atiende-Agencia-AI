// @vitest-environment jsdom
//
// Smoke tests reales de <PlPage /> (P&L USALI back-office — dinero real, el
// estado de resultados completo del hotel). Mismo patrón que
// hoteles-cfdi-page.spec.tsx: `fetch` global mockeado por ruta real contra
// apps/api/src/routes/verticals/hoteles/pl.ts, reloj falso (el rango de fechas
// se calcula con `new Date()` — `rangeForDays`), estados de carga/error/vacío,
// datos reales del Summary Operating Statement, cambio de periodo (7/30/90
// días) y registrar un gasto verificando POST .../pl/gastos con cuerpo exacto.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { PlPage } from "../src/verticals/hoteles/pages/Pl.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { PlExpenseEntry, PlFullResponse } from "../src/verticals/hoteles/lib/pl-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

// "hoy" fijo = 2026-09-19T12:00:00Z; 30 días atrás (inclusive) = 2026-08-21.
const PL_30: PlFullResponse = {
  periodo: { desde: "2026-08-21", hasta: "2026-09-19" },
  total: {
    departamentos: [
      { department: "rooms", revenue: 100000, costOfSales: 5000, payroll: 20000, otherExpenses: 3000, totalExpenses: 28000, departmentalProfit: 72000, profitMarginPct: 72 },
      { department: "food_beverage", revenue: 30000, costOfSales: 12000, payroll: 8000, otherExpenses: 2000, totalExpenses: 22000, departmentalProfit: 8000, profitMarginPct: 26.7 },
      { department: "otros_departamentos", revenue: 0, costOfSales: 0, payroll: 0, otherExpenses: 0, totalExpenses: 0, departmentalProfit: 0, profitMarginPct: null },
    ],
    ingresosTotales: 130000,
    utilidadDepartamentalTotal: 80000,
    gastosNoDistribuidos: [
      { department: "admin_general", amount: 10000 },
      { department: "ventas_marketing", amount: 5000 },
      { department: "operacion_mantenimiento", amount: 4000 },
      { department: "utilities", amount: 6000 },
    ],
    totalGastosNoDistribuidos: 25000,
    gop: 55000,
    gopMarginPct: 42.3,
    cuotaAdministracion: 5000,
    ebitda: 50000,
    gastosNoOperativos: 8000,
    utilidadNeta: 42000,
  },
  kpis: { adr: 1200, revpar: 900, occupancyPct: 75, occupiedRoomNights: 300, availableRoomNights: 400 },
  puntoEquilibrio: { fixedCostsNetOfOtherDepartments: 30000, contributionMarginPerRoom: 500, breakevenOccupiedRoomNights: 60, breakevenOccupancyPct: 20, actualOccupancyPct: 75, occupancyGapPct: 55 },
  ownersReport: { porEncimaDePuntoDeEquilibrio: true, alertas: [] },
  alcance: { pendiente: [] },
};

const GASTO_1: PlExpenseEntry = { id: "exp-1", departamento: "utilities", categoria: "otros_gastos", descripcion: "Luz de agosto", monto: 3500, fecha: "2026-09-01", creadoPor: "gm@example.com", creadoEn: "2026-09-01T10:00:00.000Z" };

interface Handlers {
  pl?: PlFullResponse | (() => PlFullResponse);
  plOk?: boolean;
  expenses?: readonly PlExpenseEntry[] | (() => readonly PlExpenseEntry[]);
  expensesOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/pl?")) {
      const pl = typeof handlers.pl === "function" ? handlers.pl() : (handlers.pl ?? PL_30);
      return jsonResponse(pl, handlers.plOk ?? true);
    }
    if (method === "GET" && url.startsWith("https://api.test/hoteles/prop-1/pl/gastos?")) {
      const expenses = typeof handlers.expenses === "function" ? handlers.expenses() : (handlers.expenses ?? [GASTO_1]);
      return jsonResponse(expenses, handlers.expensesOk ?? true);
    }
    if (method === "POST" && url === "https://api.test/hoteles/prop-1/pl/gastos") {
      return jsonResponse({ id: "exp-nuevo", ...(JSON.parse(init!.body as string) as object) });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <PlPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("PlPage (hoteles)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({});
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando P&L");
  });

  it("pide el periodo de 30 días por defecto con el rango real calculado a partir de 'hoy'", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const call = fetchMock.mock.calls.find(([url]) => url.startsWith("https://api.test/hoteles/prop-1/pl?"));
    expect(call![0]).toBe("https://api.test/hoteles/prop-1/pl?desde=2026-08-21&hasta=2026-09-19");
  });

  it("estado de error real cuando falla el P&L — nunca se queda atorado en 'Cargando' ni inventa datos", async () => {
    stubFetch({ plOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando P&L");
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/hoteles/prop-1/pl");
    expect(rendered.container.textContent).not.toContain("GOP (Gross Operating Profit)");
  });

  it("renderiza el Summary Operating Statement real: por departamento, GOP, EBITDA y utilidad neta", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Habitaciones (Rooms)");
    expect(text).toContain("$100,000.00");
    expect(text).toContain("Alimentos y Bebidas");
    expect(text).toContain("GOP (Gross Operating Profit)");
    expect(text).toContain("$55,000.00");
    expect(text).toContain("EBITDA");
    expect(text).toContain("$50,000.00");
    expect(text).toContain("Utilidad neta");
    expect(text).toContain("$42,000.00");
  });

  it("punto de equilibrio dinámico: ocupación real/de equilibrio/brecha y margen de contribución", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Punto de equilibrio dinámico");
    expect(text).toContain("75.0%");
    expect(text).toContain("20.0%");
    expect(text).toContain("+55.0 pp");
  });

  it("owner's report: muestra las alertas reales cuando existen", async () => {
    stubFetch({ pl: { ...PL_30, ownersReport: { porEncimaDePuntoDeEquilibrio: false, alertas: ["Ocupación por debajo del punto de equilibrio este periodo."] } } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Ocupación por debajo del punto de equilibrio este periodo.");
  });

  it("cambiar el periodo a 7 días vuelve a pedir el P&L y los gastos con el rango real nuevo", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const tab7 = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "7 días")!;
    // Radix Tabs activa la pestaña en `onMouseDown` (button===0), NO en
    // `onClick` (ver @radix-ui/react-tabs) — mismo criterio ya usado en
    // superadmin-break-glass-page.spec.tsx.
    await act(async () => {
      tab7.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const plCall = fetchMock.mock.calls.filter(([url]) => url.startsWith("https://api.test/hoteles/prop-1/pl?")).at(-1)!;
    expect(plCall[0]).toBe("https://api.test/hoteles/prop-1/pl?desde=2026-09-13&hasta=2026-09-19");
    const gastosCall = fetchMock.mock.calls.filter(([url]) => url.startsWith("https://api.test/hoteles/prop-1/pl/gastos?")).at(-1)!;
    expect(gastosCall[0]).toBe("https://api.test/hoteles/prop-1/pl/gastos?desde=2026-09-13&hasta=2026-09-19");
  });

  it("historial de gastos: carga, vacío honesto y error, cada uno con su propio estado", async () => {
    stubFetch({ expenses: [] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Sin gastos registrados en este periodo.");
    rendered.unmount();

    stubFetch({ expensesOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No se pudo cargar https://api.test/hoteles/prop-1/pl/gastos");
  });

  it("historial de gastos con datos reales: fecha, departamento, categoría, descripción y monto", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("2026-09-01");
    expect(text).toContain("Servicios (Utilities)");
    expect(text).toContain("Otros gastos");
    expect(text).toContain("Luz de agosto");
    expect(text).toContain("$3,500.00");
  });

  it("registrar gasto: validación real (descripción/monto/fecha) sin llamar a la API con datos inválidos", async () => {
    stubFetch({});
    rendered = renderPage();
    await esperarCarga();

    const toggle = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Registrar gasto"))!;
    await act(async () => {
      click(toggle);
    });

    changeValue(rendered.container.querySelector("#pl-monto") as HTMLInputElement, "-5");
    const form = [...rendered.container.querySelectorAll("form")].find((f) => f.textContent?.includes("Registrar gasto"))!;
    const callsAntes = fetchMock.mock.calls.length;
    await submitForm(form);

    expect(rendered.container.textContent).toContain("Descripción requerida.");
    expect(fetchMock.mock.calls.length).toBe(callsAntes);
  });

  it("registrar gasto real: POST .../pl/gastos con departamento/categoria/descripcion/monto/fecha exactos, cierra el formulario y recarga", async () => {
    let expensesActuales: readonly PlExpenseEntry[] = [GASTO_1];
    stubFetch({ expenses: () => expensesActuales });
    rendered = renderPage();
    await esperarCarga();

    const toggle = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Registrar gasto"))!;
    await act(async () => {
      click(toggle);
    });

    const root = rendered.container;
    changeValue(root.querySelector("#pl-departamento") as HTMLSelectElement, "food_beverage");
    changeValue(root.querySelector("#pl-categoria") as HTMLSelectElement, "costo_ventas");
    changeValue(root.querySelector("#pl-fecha") as HTMLInputElement, "2026-09-15");
    changeValue(root.querySelector("#pl-descripcion") as HTMLInputElement, "Compra de camarón");
    changeValue(root.querySelector("#pl-monto") as HTMLInputElement, "1250.50");

    expensesActuales = [GASTO_1, { id: "exp-nuevo", departamento: "food_beverage", categoria: "costo_ventas", descripcion: "Compra de camarón", monto: 1250.5, fecha: "2026-09-15", creadoPor: "gm@example.com", creadoEn: "2026-09-19T12:00:00.000Z" }];

    const form = [...root.querySelectorAll("form")].find((f) => f.textContent?.includes("Registrar gasto") && f.querySelector("#pl-descripcion"))!;
    await submitForm(form);
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/hoteles/prop-1/pl/gastos" && init?.method === "POST");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ departamento: "food_beverage", categoria: "costo_ventas", descripcion: "Compra de camarón", monto: 1250.5, fecha: "2026-09-15" });
    // El formulario se cierra tras registrar con éxito.
    expect(root.querySelector("#pl-descripcion")).toBeNull();
    expect(root.textContent).toContain("Compra de camarón");
  });
});

// @vitest-environment jsdom
//
// R-11 -- pestana "Programados" y tiempo real de <PedidosPage />: lista de programados, base sin migrar,
// adelantar/cancelar, y el sondeo (backoff ante fallos, pausa con la pestana oculta, un pedido nuevo recarga y
// avisa). Reloj falso solo para setTimeout/Date (nunca setInterval).
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-02T18:00:00Z"));
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const jsonResponse = (body: unknown, ok = true): Response => ({ ok, status: ok ? 200 : 500, json: async () => body }) as unknown as Response;

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Manager Demo",
  staffEmail: "manager@example.com",
};

function pedido(id: string, extra: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id,
    propertyId: "prop-1",
    branch: "Centro",
    customerId: null,
    customerName: `Cliente ${id}`,
    customerPhone: "5511112222",
    customerAddress: null,
    total: 100,
    status: "pending",
    items: [{ id: "it", name: "Tacos", price: 50, quantity: 2 }],
    source: "web",
    notes: null,
    paymentMethod: null,
    createdAt: "2026-10-02T17:00:00.000Z",
    assignedRepartidorId: null,
    estimatedDeliveryAt: null,
    incidentNote: null,
    ...extra,
  };
}

interface Estado {
  pending: OrderSummary[];
  programados: OrderSummary[];
  programadosDisponible: boolean;
  fallar: boolean;
}

function stubFetch(estado: Estado) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/admin/staff/repartidores")) return jsonResponse({ repartidores: [] });
    if (method === "GET" && url.includes("/admin/scheduled-orders")) {
      return jsonResponse({ disponible: estado.programadosDisponible, orders: estado.programadosDisponible ? estado.programados : [], promovidos: [], serverNow: new Date().toISOString() });
    }
    if (method === "GET" && url.includes("/admin/orders")) {
      if (estado.fallar) return jsonResponse({}, false);
      const status = new URL(url).searchParams.get("status");
      return jsonResponse({ orders: status === "pending" ? estado.pending : [], nextCursor: null });
    }
    if (method === "PATCH" && url.endsWith("/status")) return jsonResponse({ order: pedido("x") });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function asentar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await flushMicrotasks();
  });
}

async function avanzar(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await asentar();
}

function abrirPestana(nombre: string): void {
  // «Programados» es la pildora «Órdenes programadas» del tablero.
  const etiqueta = nombre === "Programados" ? "Órdenes programadas" : nombre;
  const tab = [...rendered!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === etiqueta)!;
  act(() => {
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

const llamadasPending = () => fetchMock.mock.calls.filter(([u]) => String(u).includes("/admin/orders?") && String(u).includes("status=pending")).length;

describe("pestana Programados", () => {
  it("lista los programados con su hora, la cuenta regresiva y a que hora entran a cocina", async () => {
    const programados = [pedido("p1", { status: "programado", programadoPara: "2026-10-02T20:00:00.000Z", canal: "recoger" })];
    stubFetch({ pending: [], programados, programadosDisponible: true, fallar: false });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    abrirPestana("Programados");
    await asentar();
    const text = rendered.container.textContent!;
    expect(text).toContain("Cliente p1");
    expect(text).toContain("en 2 h");
    expect(text).toContain("entra a cocina a las");
    expect(text).toContain("Programado");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/admin/scheduled-orders"))).toBe(true);
  });

  it("estado vacio explicito y, si la base no esta migrada, un mensaje honesto (nunca un error)", async () => {
    stubFetch({ pending: [], programados: [], programadosDisponible: true, fallar: false });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    abrirPestana("Programados");
    await asentar();
    expect(rendered.container.textContent).toContain("No hay pedidos programados");
    rendered.unmount();

    stubFetch({ pending: [], programados: [], programadosDisponible: false, fallar: false });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    abrirPestana("Programados");
    await asentar();
    expect(rendered.container.textContent).toContain("todavía no están disponibles");
  });

  it("'Enviar a cocina ahora' manda PATCH status:'pending'", async () => {
    stubFetch({ pending: [], programados: [pedido("p1", { status: "programado", programadoPara: "2026-10-02T20:00:00.000Z" })], programadosDisponible: true, fallar: false });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    abrirPestana("Programados");
    await asentar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enviar a cocina ahora"))!;
    await act(async () => {
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/admin/orders/p1/status") && i?.method === "PATCH");
    expect(JSON.parse(call![1].body as string)).toEqual({ status: "pending" });
  });

  it("'Cancelar pedido' pide confirmacion antes de llamar a la API", async () => {
    stubFetch({ pending: [], programados: [pedido("p1", { status: "programado", programadoPara: "2026-10-02T20:00:00.000Z" })], programadosDisponible: true, fallar: false });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    abrirPestana("Programados");
    await asentar();
    const boton = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Cancelar pedido")!;
    await act(async () => {
      boton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(false);
    expect(document.body.textContent).toContain("¿Cancelar este pedido?");
    expect(document.body.textContent).toContain("Cliente p1");
  });
});

describe("sondeo de pedidos nuevos", () => {
  it("consulta cada 20 s solo los pendientes; un pedido nuevo recarga la lista y muestra el aviso (el primero NO avisa)", async () => {
    const estado: Estado = { pending: [pedido("a")], programados: [], programadosDisponible: true, fallar: false };
    stubFetch(estado);
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    const base = llamadasPending();
    await avanzar(20_000); // primera consulta del sondeo: fija la linea base, sin aviso
    expect(rendered.container.querySelector('[data-testid="aviso-nuevos"]')).toBeNull();
    estado.pending = [pedido("b"), pedido("a")];
    await avanzar(20_000);
    expect(rendered.container.querySelector('[data-testid="aviso-nuevos"]')?.textContent).toContain("1 pedido nuevo");
    expect(rendered.container.textContent).toContain("Cliente b");
    expect(llamadasPending()).toBeGreaterThan(base);
  });

  it("backoff: tras un fallo espera el doble y lo muestra; al recuperarse vuelve al intervalo base", async () => {
    const estado: Estado = { pending: [], programados: [], programadosDisponible: true, fallar: false };
    stubFetch(estado);
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    estado.fallar = true;
    await avanzar(20_000);
    expect(rendered.container.querySelector('[data-testid="indicador-actualizacion"]')?.textContent).toContain("reintentando en 40 s");
    const n = fetchMock.mock.calls.length;
    await avanzar(30_000); // 30 s < 40 s: todavia no consulta
    expect(fetchMock.mock.calls.length).toBe(n);
    estado.fallar = false;
    await avanzar(10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(n);
    expect(rendered.container.querySelector('[data-testid="indicador-actualizacion"]')?.textContent).not.toContain("reintentando");
  });

  it("con la pestana oculta no consulta; al volver visible consulta de inmediato", async () => {
    stubFetch({ pending: [], programados: [], programadosDisponible: true, fallar: false });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await asentar();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const n = fetchMock.mock.calls.length;
    await avanzar(120_000);
    expect(fetchMock.mock.calls.length).toBe(n);
    expect(rendered.container.querySelector('[data-testid="indicador-actualizacion"]')?.textContent).toContain("En pausa");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await flushMicrotasks();
    });
    await asentar();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(n);
  });
});

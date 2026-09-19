// @vitest-environment jsdom
//
// Smoke tests reales de <PedidosPage /> (operación de restaurantes — donde el
// staff cambia el estado real de un pedido y asigna repartidor; dinero/logística
// real). Mismo patrón que hoteles-reservas-page.spec.tsx: `fetch` global mockeado
// por ruta real contra orders-client.ts/staff-client.ts (nunca se mockea el módulo
// completo), estados de carga/vacío/error, datos reales, y la interacción
// principal (transicionar estado y asignar repartidor) verificando método/ruta/
// cuerpo reales de la llamada a la API.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { changeValue, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

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
  staffFullName: "Manager Demo",
  staffEmail: "manager@example.com",
};

const PEDIDO_PENDING: OrderSummary = {
  id: "ord-1",
  propertyId: "prop-1",
  branch: "Centro",
  customerId: "cust-1",
  customerName: "Juan Pérez",
  customerPhone: "5511112222",
  customerAddress: "Calle Falsa 123",
  total: 345.5,
  status: "pending",
  items: [{ id: "it-1", name: "Tacos al pastor", price: 115, quantity: 3 }],
  source: "web",
  notes: null,
  paymentMethod: "efectivo",
  createdAt: "2026-09-19T10:00:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
};

const REPARTIDOR = { id: "rep-1", email: "rep@example.com", fullName: "Repartidor Uno", propertyIds: null };

interface Handlers {
  byStatus?: Partial<Record<string, readonly OrderSummary[]>>;
  ordersOk?: boolean;
  repartidores?: readonly typeof REPARTIDOR[];
  repartidoresOk?: boolean;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/admin/staff/repartidores")) {
      return jsonResponse({ repartidores: handlers.repartidores ?? [] }, handlers.repartidoresOk ?? true);
    }
    if (method === "GET" && url.includes("/admin/orders")) {
      const statusParam = new URL(url).searchParams.get("status") ?? "";
      const orders = handlers.byStatus?.[statusParam] ?? [];
      return jsonResponse({ orders, nextCursor: null }, handlers.ordersOk ?? true);
    }
    if (method === "PATCH" && url.endsWith("/status")) {
      return jsonResponse({ order: { ...PEDIDO_PENDING, status: "preparando" } });
    }
    if (method === "PATCH" && url.endsWith("/assign-repartidor")) {
      return jsonResponse({ order: { ...PEDIDO_PENDING, assignedRepartidorId: "rep-1" } });
    }
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<PedidosPage {...CTX} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("PedidosPage (restaurantes)", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ byStatus: {} });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando pedidos");
  });

  it("estado vacío explícito cuando ningún estado operativo tiene pedidos — nunca un error", async () => {
    stubFetch({ byStatus: {} });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay pedidos en este filtro");
  });

  it("estado de error real cuando el fetch de pedidos falla — nunca se queda atorado en 'Cargando'", async () => {
    stubFetch({ byStatus: {}, ordersOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).not.toContain("Cargando pedidos");
    expect(rendered.container.textContent).toContain("No se pudo cargar");
  });

  it("el fallo de repartidores nunca tumba la lista de pedidos (estados independientes) — solo muestra su propio error", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] }, repartidoresOk: false });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Juan Pérez"); // la lista de pedidos SÍ cargó
    expect(rendered.container.textContent).toContain("No se pudo cargar la lista de repartidores");
  });

  it("renderiza un pedido real: cliente, monto, items y estado", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(text).toContain("Juan Pérez");
    expect(text).toContain("$345.50");
    expect(text).toContain("3× Tacos al pastor");
    expect(text).toContain("Recibido");
  });

  it("'Marcar Preparando' llama PATCH .../orders/ord-1/status con {status:'preparando'} y recarga", async () => {
    // `byStatus` mutable (no un objeto literal fijo): `stubFetch` lee esta
    // MISMA referencia en cada fetch, así que cambiarla entre el click y la
    // aserción simula la recarga real -- criterio ya usado en
    // despachos-cobranza-page.spec.tsx con `current`.
    const byStatus: Partial<Record<string, readonly OrderSummary[]>> = { pending: [PEDIDO_PENDING] };
    stubFetch({ byStatus });
    rendered = renderPage();
    await esperarCarga();

    const marcarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar Preparando"))!;
    byStatus.pending = [];
    byStatus.preparando = [{ ...PEDIDO_PENDING, status: "preparando" }];
    await act(async () => {
      marcarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/orders/ord-1/status" && init?.method === "PATCH");
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(JSON.parse(init.body as string)).toEqual({ status: "preparando" });
    // La recarga real: el filtro por default es "todos" (las 4 pestañas
    // operativas en paralelo), así que tras recargar el pedido ya viene con
    // estado `preparando` real. OJO: "Preparando" por sí solo NO sirve de
    // prueba -- ya aparece siempre en el label de la pestaña de filtro,
    // exista o no un pedido en ese estado (mismo error que se corrige aquí).
    // Lo que sí prueba la recarga: "Marcar Preparando" (label del botón que
    // YA existía antes del click) desaparece, y aparece el de la SIGUIENTE
    // transición real (NEXT_STATUSES.preparando incluye "en_camino").
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Marcar Preparando"))).toBe(false);
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Marcar En camino"))).toBe(true);
  });

  it("'Marcar Cancelado' abre el AlertDialog (no cancela de inmediato) y solo al confirmar llama la API con status:'cancelado'", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();

    const cancelarBtn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Marcar Cancelado"))!;
    await act(async () => {
      cancelarBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(fetchMock.mock.calls.some(([url, init]) => url.endsWith("/status") && init?.method === "PATCH")).toBe(false);
    expect(document.body.textContent).toContain("¿Cancelar el pedido de Juan Pérez?");

    const confirmBtn = [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Cancelar el pedido")!;
    await act(async () => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const call = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/status") && init?.method === "PATCH");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ status: "cancelado" });
  });

  it("asignar repartidor: elegir uno en el <select> llama PATCH .../assign-repartidor con {repartidorId} real", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();

    const select = rendered.container.querySelector("#repartidor-ord-1") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    changeValue(select, "rep-1");
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url, init]) => url === "https://api.test/v1/restaurantes/prop-1/admin/orders/ord-1/assign-repartidor" && init?.method === "PATCH");
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body as string)).toEqual({ repartidorId: "rep-1" });
  });
});

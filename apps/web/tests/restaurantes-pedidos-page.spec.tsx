// @vitest-environment jsdom
//
// <PedidosPage /> (UNI-R1): el tablero de despacho del repo suelto sobre las llamadas REALES del monorepo. `fetch` global mockeado por ruta contra
// orders-client.ts/staff-client.ts/branches-client.ts (nunca se mockea el modulo completo); reloj fijo (solo `Date`) para las horas, el ETA y
// «Demorado». Se afirma la peticion exacta (metodo, ruta, cuerpo) y el efecto en pantalla.
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { changeValue, click, esperarHasta, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

import { elegirValor, prepararJsdomParaRadix, valorDe } from "./test-utils/seleccionar.tsx";

beforeAll(prepararJsdomParaRadix);

vi.mock("leaflet", () => {
  const capa = { addTo: () => capa, bindTooltip: () => capa, remove: () => undefined, setLatLng: () => undefined };
  const mapa = { setView: () => mapa, fitBounds: () => undefined, stop: () => undefined, remove: () => undefined };
  return { default: { map: () => mapa, tileLayer: () => capa, divIcon: () => ({}), marker: () => capa, latLngBounds: () => ({}) } };
});

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
const AHORA = new Date("2026-10-08T20:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AHORA);
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const CTX: RestaurantesShellContext = { apiBaseUrl: "https://api.test", token: "tok-123", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "Manager Demo", staffEmail: "manager@example.com" };

const PEDIDO_PENDING: OrderSummary = {
  id: "ord-1",
  orderNumber: 1001,
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
  createdAt: "2026-10-08T19:30:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  canal: "domicilio",
};

const REPARTIDOR = { id: "rep-1", email: "rep@example.com", fullName: "Repartidor Uno", propertyIds: null };
const SUCURSAL = { propertyId: "prop-1", name: "Centro", slug: "centro", status: "active", phone: null, address: null, lat: 20.9671, lng: -89.6237 };

interface Handlers {
  byStatus?: Partial<Record<string, readonly OrderSummary[]>>;
  ordersOk?: boolean;
  repartidores?: readonly (typeof REPARTIDOR)[];
  repartidoresOk?: boolean;
  sugerencias?: Record<string, { repartidorId: string; nombre: string; enCamino: number }>;
  sugerenciasOk?: boolean;
  programados?: readonly OrderSummary[];
  sucursales?: readonly (typeof SUCURSAL)[];
  /** Pedido que devuelve GET .../admin/orders/:id (detalle). */
  porId?: OrderSummary;
}

function stubFetch(handlers: Handlers) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/admin/staff/repartidores")) return jsonResponse({ repartidores: handlers.repartidores ?? [] }, handlers.repartidoresOk ?? true);
    if (method === "GET" && url.includes("/admin/sucursales")) return jsonResponse({ branches: handlers.sucursales ?? [SUCURSAL] });
    if (method === "GET" && url.includes("/admin/repartidor-sugerido")) return jsonResponse({ sugerencias: handlers.sugerencias ?? {} }, handlers.sugerenciasOk ?? true);
    if (method === "GET" && url.includes("/admin/scheduled-orders")) return jsonResponse({ disponible: true, orders: handlers.programados ?? [], promovidos: [], serverNow: AHORA.toISOString() });
    if (method === "GET" && /\/admin\/orders\/[^/?]+$/.test(url)) return handlers.porId ? jsonResponse({ order: handlers.porId }) : jsonResponse({ message: "Pedido no encontrado." }, false, 404);
    if (method === "GET" && url.includes("/admin/orders")) {
      const statusParam = new URL(url).searchParams.get("status") ?? "";
      const orders = handlers.byStatus?.[statusParam] ?? [];
      return jsonResponse({ orders, nextCursor: null }, handlers.ordersOk ?? true);
    }
    if (method === "PATCH" && url.endsWith("/status")) return jsonResponse({ order: { ...PEDIDO_PENDING, status: "preparando" } });
    if (method === "PATCH" && url.endsWith("/assign-repartidor")) return jsonResponse({ order: { ...PEDIDO_PENDING, assignedRepartidorId: "rep-1" } });
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(ctx: RestaurantesShellContext = CTX): RenderedComponent {
  return renderComponent(<PedidosPage {...ctx} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await flushMicrotasks();
  });
}

const botones = () => [...document.body.querySelectorAll("button")] as HTMLButtonElement[];
const boton = (texto: string) => botones().find((b) => b.textContent?.trim() === texto || b.getAttribute("aria-label") === texto);
/** Boton dentro de la fila de un pedido (el chip de filtro «Incidencia» comparte nombre con el boton de la fila). */
const botonFila = (id: string, texto: string) => [...document.body.querySelectorAll(`[data-testid="pedido-${id}"] button`)].find((b) => b.textContent?.trim() === texto || b.getAttribute("aria-label") === texto) as HTMLButtonElement | undefined;
const pestana = (texto: string) => [...document.body.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.trim() === texto) as HTMLElement;
const llamadas = (metodo: string, fin: string) => fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith(fin) && ((init as RequestInit | undefined)?.method ?? "GET") === metodo);
const cuerpoDe = (llamada: unknown[]) => JSON.parse(String((llamada[1] as RequestInit).body));

describe("PedidosPage: marco y estados", () => {
  it("muestra el estado de carga primero", async () => {
    stubFetch({ byStatus: {} });
    rendered = renderPage();
    expect(rendered.container.textContent).toContain("Cargando pedidos");
  });

  it("estado vacio con el texto del original y un contador «0 en total» — nunca un error", async () => {
    stubFetch({ byStatus: {} });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay pedidos por despachar");
    expect(rendered.container.querySelector('[data-testid="total-pedidos"]')?.textContent).toBe("0 en total");
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
    expect(rendered.container.textContent).toContain("Juan Pérez");
    expect(rendered.container.textContent).toContain("No se pudo cargar la lista de repartidores");
  });

  it("las tres pildoras del original, con «Órdenes recibidas» activa", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    const nombres = [...document.body.querySelectorAll('[role="tab"]')].map((t) => t.textContent?.trim());
    expect(nombres).toEqual(["Órdenes recibidas", "Órdenes enviadas", "Órdenes programadas"]);
    expect(pestana("Órdenes recibidas").getAttribute("aria-selected")).toBe("true");
    expect(pestana("Órdenes enviadas").getAttribute("aria-selected")).toBe("false");
  });
});

describe("PedidosPage: fila de pedido", () => {
  it("replica la fila del original: nombre, «PEDIDO #ID · VENTA nnnn», direccion, sucursal, monto sin decimales enteros y fecha corta", async () => {
    stubFetch({ byStatus: { pending: [{ ...PEDIDO_PENDING, id: "a1b2c3d4-0000-4000-8000-000000000000", total: 286 }] } });
    rendered = renderPage();
    await esperarCarga();
    const fila = rendered.container.querySelector('[data-testid^="pedido-"]')!;
    const texto = fila.textContent!;
    expect(texto).toContain("Juan Pérez");
    expect(texto).toContain("Pedido #a1b2c3d4 · Venta 1001");
    expect(texto).toContain("Calle Falsa 123");
    expect(texto).toContain("Centro");
    expect(texto).toContain("$286");
    expect(texto).not.toContain("$286.00");
    // 19:30 UTC = 13:30 en America/Mexico_City.
    expect(texto).toContain("8 oct, 13:30");
    expect(rendered.container.querySelector('[data-testid="total-pedidos"]')?.textContent).toBe("1 en total");
  });

  it("un monto con centavos conserva los centavos (nunca redondea dinero)", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("$345.50");
  });

  it("sin folio (API vieja) la fila sigue mostrando el id corto y no inventa una «Venta»", async () => {
    stubFetch({ byStatus: { pending: [{ ...PEDIDO_PENDING, orderNumber: null }] } });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Pedido #ord-1");
    expect(rendered.container.textContent).not.toContain("Venta");
  });

  it("«Todos» junta Recibido, Preparando, Listo para recoger, No recogido e Incidencia; En camino no (esta en Enviadas)", async () => {
    stubFetch({
      byStatus: {
        pending: [PEDIDO_PENDING],
        preparando: [{ ...PEDIDO_PENDING, id: "ord-2", customerName: "Ana Prep", status: "preparando" }],
        no_recogido: [{ ...PEDIDO_PENDING, id: "ord-3", customerName: "Beto NoRec", status: "no_recogido", canal: "recoger" }],
        problema: [{ ...PEDIDO_PENDING, id: "ord-4", customerName: "Cata Inc", status: "problema", incidentNote: "No contesta" }],
        en_camino: [{ ...PEDIDO_PENDING, id: "ord-5", customerName: "Dani Camino", status: "en_camino" }],
      },
    });
    rendered = renderPage();
    await esperarCarga();
    const t = rendered.container.textContent!;
    for (const n of ["Juan Pérez", "Ana Prep", "Beto NoRec", "Cata Inc"]) expect(t).toContain(n);
    expect(t).not.toContain("Dani Camino");
    expect(t).toContain("No contesta");
    expect(rendered.container.querySelector('[data-testid="estado-ord-4"]')?.textContent).toBe("Incidencia");
    expect(rendered.container.querySelector('[data-testid="estado-ord-1"]')).toBeNull(); // Recibido no lleva chip: es el estado «normal» del original
    expect(rendered.container.querySelector('[data-testid="total-pedidos"]')?.textContent).toBe("4 en total");
  });

  it("los chips de estado filtran dentro de «Órdenes recibidas» y piden solo ese estado", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING], preparando: [{ ...PEDIDO_PENDING, id: "ord-2", customerName: "Ana Prep", status: "preparando" }] } });
    rendered = renderPage();
    await esperarCarga();
    fetchMock.mockClear();
    click(boton("Preparando")!);
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Ana Prep");
    expect(rendered.container.textContent).not.toContain("Juan Pérez");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("status=preparando"))).toBe(true);
    click(boton("No recogido")!);
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay pedidos en este filtro");
  });
});

describe("PedidosPage: despacho (Asignar repartidor -> Confirmar envio)", () => {
  it("un pedido en preparando: Asignar repartidor -> elegir -> «Confirmar envío» asigna con ETA +35 min Y lo pasa a en_camino (maquina de estados real)", async () => {
    const PREPARANDO: OrderSummary = { ...PEDIDO_PENDING, status: "preparando" };
    stubFetch({ byStatus: { preparando: [PREPARANDO] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Asignar repartidor")!);
    await esperarCarga();
    elegirValor(document.querySelector("#repartidor-ord-1"), "rep-1");
    await esperarCarga();
    click(boton("Confirmar envío")!);
    await esperarCarga();
    const asignar = llamadas("PATCH", "/orders/ord-1/assign-repartidor");
    expect(asignar).toHaveLength(1);
    expect(cuerpoDe(asignar[0]!)).toEqual({ repartidorId: "rep-1", estimatedDeliveryAt: "2026-10-08T20:35:00.000Z" });
    const estado = llamadas("PATCH", "/orders/ord-1/status");
    expect(estado).toHaveLength(1);
    expect(cuerpoDe(estado[0]!)).toEqual({ status: "en_camino" });
    // Tras confirmar, cambia a «Órdenes enviadas».
    expect(pestana("Órdenes enviadas").getAttribute("aria-selected")).toBe("true");
  });

  it("«Confirmar envío» NO salta cocina: un pedido recien recibido (pending) solo asigna repartidor, sin cambiar de estado", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Asignar repartidor")!);
    await esperarCarga();
    expect(boton("Confirmar envío")).toBeUndefined();
    elegirValor(document.querySelector("#repartidor-ord-1"), "rep-1");
    await esperarCarga();
    click(boton("Asignar")!);
    await esperarCarga();
    const asignar = llamadas("PATCH", "/orders/ord-1/assign-repartidor");
    expect(asignar).toHaveLength(1);
    expect(cuerpoDe(asignar[0]!)).toEqual({ repartidorId: "rep-1" });
    expect(llamadas("PATCH", "/status")).toHaveLength(0);
  });

  it("sin repartidores registrados el select lo dice y no se puede confirmar", async () => {
    stubFetch({ byStatus: { preparando: [{ ...PEDIDO_PENDING, status: "preparando" }] }, repartidores: [] });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Asignar repartidor")!);
    await esperarCarga();
    expect(document.querySelector("#repartidor-ord-1")!.textContent).toContain("Sin repartidores registrados");
    expect(boton("Confirmar envío")!.disabled).toBe(true);
  });

  it("con repartidor sugerido por el autopiloto: se muestra «Sugerido» y viene preseleccionado; solo se asigna al confirmar", async () => {
    const PREPARANDO: OrderSummary = { ...PEDIDO_PENDING, id: "ord-9", status: "preparando" };
    stubFetch({ byStatus: { preparando: [PREPARANDO] }, repartidores: [REPARTIDOR], sugerencias: { "ord-9": { repartidorId: "rep-1", nombre: "Repartidor Uno", enCamino: 0 } } });
    rendered = renderPage();
    await esperarCarga();
    const consulta = fetchMock.mock.calls.find(([url]) => String(url).includes("/admin/repartidor-sugerido"));
    expect(consulta![0]).toBe("https://api.test/v1/restaurantes/prop-1/admin/repartidor-sugerido?orderIds=ord-9");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "PATCH")).toBe(false);
    click(boton("Asignar repartidor")!);
    await esperarCarga();
    expect(valorDe(document.querySelector("#repartidor-ord-9"))).toBe("rep-1");
    expect(document.querySelector('[data-testid="sugerido-ord-9"]')!.textContent).toContain("Sugerido: Repartidor Uno");
    click(boton("Confirmar envío")!);
    await esperarCarga();
    expect(cuerpoDe(llamadas("PATCH", "/orders/ord-9/assign-repartidor")[0]!)).toMatchObject({ repartidorId: "rep-1" });
  });

  it("sin sugerencia (o con error) no hay «Sugerido» y la lista sigue intacta; a recoger y ya asignados ni la consultan", async () => {
    const PREPARANDO: OrderSummary = { ...PEDIDO_PENDING, id: "ord-9", status: "preparando" };
    stubFetch({ byStatus: { preparando: [PREPARANDO] }, repartidores: [REPARTIDOR], sugerenciasOk: false });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Asignar repartidor")!);
    await esperarCarga();
    expect(document.querySelector('[data-testid="sugerido-ord-9"]')).toBeNull();
    expect(rendered.container.textContent).toContain("Juan Pérez");
    rendered.unmount();

    const recoger: OrderSummary = { ...PREPARANDO, id: "ord-10", canal: "recoger" };
    const asignado: OrderSummary = { ...PREPARANDO, id: "ord-11", assignedRepartidorId: "rep-1" };
    stubFetch({ byStatus: { preparando: [recoger, asignado] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/admin/repartidor-sugerido"))).toBe(false);
  });

  it("«Marcar Preparando» llama PATCH .../status con {status:'preparando'} y recarga: el boton desaparece", async () => {
    const byStatus: Partial<Record<string, readonly OrderSummary[]>> = { pending: [PEDIDO_PENDING] };
    stubFetch({ byStatus });
    rendered = renderPage();
    await esperarCarga();
    byStatus.pending = [];
    byStatus.preparando = [{ ...PEDIDO_PENDING, status: "preparando" }];
    click(boton("Marcar Preparando")!);
    await esperarCarga();
    expect(cuerpoDe(llamadas("PATCH", "/orders/ord-1/status")[0]!)).toEqual({ status: "preparando" });
    expect(boton("Marcar Preparando")).toBeUndefined();
    expect(rendered.container.querySelector('[data-testid="estado-ord-1"]')?.textContent).toBe("Preparando");
  });
});

describe("PedidosPage: cancelar e incidencia", () => {
  it("«Cancelar pedido» abre «¿Cancelar este pedido?» (no cancela de inmediato) y solo al confirmar con un motivo llama PATCH {status:'cancelado', motivo}", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Cancelar pedido")!);
    await esperarCarga();
    expect(llamadas("PATCH", "/status")).toHaveLength(0);
    const dialogo = document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialogo.textContent).toContain("¿Cancelar este pedido?");
    expect(dialogo.textContent).toContain('#1001 — Juan Pérez pasará a "Cancelado" y saldrá de Recibidos. Sigue visible en Historial.');
    const confirmar = [...dialogo.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sí, cancelar pedido") as HTMLButtonElement;
    expect(confirmar.disabled).toBe(true);
    elegirValor(dialogo.querySelector('[role="combobox"]'), "otro");
    await esperarCarga();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Sí, cancelar pedido")!);
    await esperarCarga();
    expect(cuerpoDe(llamadas("PATCH", "/status")[0]!)).toEqual({ status: "cancelado", motivo: "otro" });
  });

  it("«Volver» en el dialogo de cancelar no llama al API", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Cancelar pedido")!);
    await esperarCarga();
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Volver")!);
    await esperarCarga();
    expect(llamadas("PATCH", "/status")).toHaveLength(0);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("«Incidencia» exige la nota: vacia no escribe y avisa; con nota manda PATCH {status:'problema', incidentNote}", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    click(botonFila("ord-1", "Incidencia")!);
    await esperarCarga();
    const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialogo().textContent).toContain("Reportar incidencia");
    expect(dialogo().textContent).toContain("#1001 — Juan Pérez");
    const reportar = () => [...dialogo().querySelectorAll("button")].find((b) => b.textContent?.trim() === "Reportar incidencia") as HTMLButtonElement;
    click(reportar());
    await esperarCarga();
    expect(llamadas("PATCH", "/status")).toHaveLength(0);
    expect(dialogo().textContent).toContain("Escribe qué pasó antes de reportar la incidencia.");
    const nota = dialogo().querySelector("textarea") as HTMLTextAreaElement;
    expect(nota.placeholder).toContain("dirección incorrecta");
    changeValue(nota, "   ");
    click(reportar());
    await esperarCarga();
    expect(llamadas("PATCH", "/status")).toHaveLength(0);
    changeValue(nota, "Cliente no contesta");
    click(reportar());
    await esperarCarga();
    expect(cuerpoDe(llamadas("PATCH", "/status")[0]!)).toEqual({ status: "problema", incidentNote: "Cliente no contesta" });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("un error del servidor al reportar deja el dialogo abierto con el mensaje", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    const base = fetchMock;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => (init?.method === "PATCH" ? jsonResponse({ message: "Transición no permitida" }, false, 409) : base(url, init))),
    );
    rendered = renderPage();
    await esperarCarga();
    click(botonFila("ord-1", "Incidencia")!);
    await esperarCarga();
    changeValue(document.body.querySelector('[role="dialog"] textarea') as HTMLTextAreaElement, "Falta producto");
    click([...document.body.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === "Reportar incidencia")!);
    await esperarCarga();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Transición no permitida");
  });
});

describe("PedidosPage: enviadas", () => {
  const EN_CAMINO: OrderSummary = { ...PEDIDO_PENDING, id: "ord-7", status: "en_camino", assignedRepartidorId: "rep-1", estimatedDeliveryAt: "2026-10-08T20:25:00.000Z" };

  it("«Órdenes enviadas» pide en_camino y muestra repartidor, «Llega HH:mm» y las acciones", async () => {
    stubFetch({ byStatus: { en_camino: [EN_CAMINO] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes enviadas"));
    await esperarCarga();
    const t = rendered.container.textContent!;
    expect(t).toContain("Repartidor Uno");
    expect(rendered.container.querySelector('[data-testid="eta-ord-7"]')?.textContent).toBe("Llega 14:25");
    expect(boton("Marcar entregado")).toBeDefined();
    expect(botonFila("ord-7", "Incidencia")).toBeDefined();
    expect(boton("Asignar repartidor")).toBeUndefined();
  });

  it("pasada la hora estimada se marca «Demorado — debía llegar HH:mm» en rojo", async () => {
    stubFetch({ byStatus: { en_camino: [{ ...EN_CAMINO, estimatedDeliveryAt: "2026-10-08T19:50:00.000Z" }] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes enviadas"));
    await esperarCarga();
    const eta = rendered.container.querySelector('[data-testid="eta-ord-7"]')!;
    expect(eta.textContent).toBe("Demorado — debía llegar 13:50");
    expect(eta.className).toContain("text-destructive");
  });

  it("«Marcar entregado» llama PATCH {status:'entregado'}", async () => {
    stubFetch({ byStatus: { en_camino: [EN_CAMINO] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes enviadas"));
    await esperarCarga();
    click(boton("Marcar entregado")!);
    await esperarCarga();
    expect(cuerpoDe(llamadas("PATCH", "/orders/ord-7/status")[0]!)).toEqual({ status: "entregado" });
  });

  it("vacio de enviadas: «No hay pedidos en camino»", async () => {
    stubFetch({ byStatus: {} });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes enviadas"));
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay pedidos en camino");
  });
});

describe("PedidosPage: programadas", () => {
  const PROGRAMADO: OrderSummary = { ...PEDIDO_PENDING, id: "ord-p1", customerName: "Pía Programada", status: "programado", programadoPara: "2026-10-08T23:00:00.000Z" };
  const YA_TOCA: OrderSummary = { ...PROGRAMADO, id: "ord-p2", customerName: "Quique YaToca", programadoPara: "2026-10-08T20:10:00.000Z" };

  it("pantalla completa sin mapa: caption de promocion, hora en el formato del original y «en X»; ordena por hora", async () => {
    stubFetch({ programados: [{ ...PROGRAMADO, id: "ord-p3", customerName: "Zoe Tarde", programadoPara: "2026-10-09T00:00:00.000Z" }, PROGRAMADO] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes programadas"));
    await esperarCarga();
    const t = rendered.container.textContent!;
    expect(t).toContain("Se promueven a Recibidas automáticamente 30 min antes de su hora");
    expect(rendered.container.querySelector('[data-testid="mapa-entrega"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="programado-para-ord-p1"]')?.textContent).toBe("8 oct, 17:00");
    expect(t).toContain("en 3 h");
    expect(t.indexOf("Pía Programada")).toBeLessThan(t.indexOf("Zoe Tarde"));
    expect(rendered.container.querySelector('[data-testid="total-pedidos"]')?.textContent).toBe("2 en total");
  });

  it("auto-promocion por horario: un programado que ya esta dentro de la ventana de cocina sale de la vista", async () => {
    stubFetch({ programados: [PROGRAMADO, YA_TOCA] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes programadas"));
    await esperarCarga();
    expect(rendered.container.textContent).toContain("Pía Programada");
    expect(rendered.container.textContent).not.toContain("Quique YaToca");
  });

  it("vacio: «No hay pedidos programados»; base sin la migracion: estado honesto", async () => {
    stubFetch({ programados: [] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes programadas"));
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No hay pedidos programados");
  });

  it("«Enviar a cocina ahora» pasa el programado a pending y «Cancelar pedido» pide motivo", async () => {
    stubFetch({ programados: [PROGRAMADO] });
    rendered = renderPage();
    await esperarCarga();
    click(pestana("Órdenes programadas"));
    await esperarCarga();
    click(boton("Enviar a cocina ahora")!);
    await esperarCarga();
    expect(cuerpoDe(llamadas("PATCH", "/orders/ord-p1/status")[0]!)).toEqual({ status: "pending" });
    click(boton("Cancelar pedido")!);
    await esperarCarga();
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("¿Cancelar este pedido?");
  });
});

describe("PedidosPage: mapa y detalle", () => {
  it("la columna derecha trae «Entrega en curso» con el primer pedido de la lista y la insignia «Simulado»", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    const mapa = rendered.container.querySelector('[data-testid="mapa-entrega"]')!;
    expect(mapa.textContent).toContain("Entrega en curso");
    expect(mapa.textContent).toContain("Simulado");
    expect(mapa.textContent).toContain("Juan Pérez");
    await esperarHasta(() => rendered!.container.querySelector('[data-testid="mapa-entrega-leaflet"]') !== null, "el mapa Leaflet carga bajo demanda");
  });

  it("una sucursal sin lat/lng muestra el estado vacio del mapa (sin marcadores inventados)", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] }, sucursales: [{ ...SUCURSAL, lat: null as unknown as number, lng: null as unknown as number }] });
    rendered = renderPage();
    await esperarCarga();
    expect(rendered.container.querySelector('[data-testid="mapa-sin-ubicacion"]')?.textContent).toContain("Esta sucursal aún no tiene ubicación en el mapa");
    expect(rendered.container.querySelector('[data-testid="mapa-entrega-leaflet"]')).toBeNull();
  });

  it("clic en una fila abre el detalle a pagina completa (GET .../orders/:id) y «Volver» regresa a la lista", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] }, porId: { ...PEDIDO_PENDING, propina: 20 } });
    rendered = renderPage();
    await esperarCarga();
    click(rendered.container.querySelector('[data-testid="pedido-ord-1"]')!);
    await esperarCarga();
    const detalle = rendered.container.querySelector('[data-testid="pedido-detalle"]')!;
    expect(detalle).not.toBeNull();
    expect(detalle.textContent).toContain("Venta 1001");
    expect(detalle.textContent).toContain("Tacos al pastor");
    expect(detalle.textContent).toContain("$345.50");
    expect(rendered.container.querySelector('[data-testid="mapa-entrega"]')).toBeNull();
    expect(llamadas("GET", "/admin/orders/ord-1")).toHaveLength(1);
    click(boton("Volver")!);
    await esperarCarga();
    expect(rendered.container.querySelector('[data-testid="pedido-detalle"]')).toBeNull();
    expect(rendered.container.querySelector('[data-testid="pedido-ord-1"]')).not.toBeNull();
  });

  it("los botones de la fila no abren el detalle (stopPropagation)", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] }, repartidores: [REPARTIDOR] });
    rendered = renderPage();
    await esperarCarga();
    click(boton("Asignar repartidor")!);
    await esperarCarga();
    expect(rendered.container.querySelector('[data-testid="pedido-detalle"]')).toBeNull();
    expect(llamadas("GET", "/admin/orders/ord-1")).toHaveLength(0);
  });
});

describe("PedidosPage: herramientas conservadas (compactas)", () => {
  it("sonido, auto-impresion y reglas del autopiloto viven en «Herramientas»; el staff de piso no ve las reglas", async () => {
    stubFetch({ byStatus: {} });
    rendered = renderPage();
    await esperarCarga();
    expect(document.body.textContent).not.toContain("Sonido al llegar un pedido nuevo");
    click(boton("Herramientas de pedidos")!);
    await esperarCarga();
    expect(document.body.textContent).toContain("Sonido al llegar un pedido nuevo");
    expect(document.body.textContent).toContain("Imprimir ticket de cocina automáticamente");
    expect(boton("Actualizar ahora")).toBeDefined();
    expect(boton("Reglas del autopiloto")).toBeDefined();
    rendered.unmount();
    stubFetch({ byStatus: {} });
    rendered = renderPage({ ...CTX, role: "staff" });
    await esperarCarga();
    click(boton("Herramientas de pedidos")!);
    await esperarCarga();
    expect(boton("Reglas del autopiloto")).toBeUndefined();
  });

  it("vista previa e historial del pedido siguen en la fila (botones de icono con nombre accesible)", async () => {
    stubFetch({ byStatus: { pending: [PEDIDO_PENDING] } });
    rendered = renderPage();
    await esperarCarga();
    expect(boton("Imprimir ticket")).toBeDefined();
    expect(boton("Vista previa")).toBeDefined();
    expect(boton("Historial")).toBeDefined();
  });
});

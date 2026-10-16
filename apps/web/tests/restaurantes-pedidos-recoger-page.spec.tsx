// @vitest-environment jsdom
//
// PM PR-3 (b)(d): <PedidosPage /> con pedidos para RECOGER -- estados "listo para recoger" / "no recogido",
// aviso OPCIONAL por WhatsApp, canal/propina/hora de recogida visibles y botones acordes al canal.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PedidosPage } from "../src/verticals/restaurantes/pages/Pedidos.tsx";
import type { RestaurantesShellContext } from "../src/verticals/restaurantes/RestaurantesShell.tsx";
import { nextStatusesForCanal } from "../src/verticals/restaurantes/lib/orders-client.ts";
import type { OrderSummary } from "../src/verticals/restaurantes/lib/orders-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const CTX: RestaurantesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Manager Demo",
  staffEmail: "manager@example.com",
};

const BASE: OrderSummary = {
  id: "ord-r1",
  propertyId: "prop-1",
  branch: "Centro",
  customerId: "cust-1",
  customerName: "Ana Recoge",
  customerPhone: "5511112222",
  customerAddress: null,
  total: 200,
  status: "preparando",
  items: [{ id: "it-1", name: "Nachos de pastor", price: 90, quantity: 1 }],
  source: "whatsapp",
  notes: null,
  paymentMethod: "tarjeta",
  createdAt: "2026-09-30T18:00:00.000Z",
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  canal: "recoger",
  propina: 15,
  horaRecogida: "2026-09-30T20:30:00-06:00",
};

function stubFetch(orders: Partial<Record<string, readonly OrderSummary[]>>) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/admin/staff/repartidores")) return { ok: true, status: 200, json: async () => ({ repartidores: [] }) } as unknown as Response;
    if (method === "GET" && url.includes("/admin/orders")) {
      const status = new URL(url).searchParams.get("status") ?? "";
      return { ok: true, status: 200, json: async () => ({ orders: orders[status] ?? [], nextCursor: null }) } as unknown as Response;
    }
    if (method === "PATCH" && url.endsWith("/status")) return { ok: true, status: 200, json: async () => ({ order: BASE }) } as unknown as Response;
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

const botones = (root: HTMLElement) => [...root.querySelectorAll("button")].map((b) => b.textContent ?? "");

describe("nextStatusesForCanal", () => {
  it("recoger: sin 'en_camino'; domicilio: sin los estados de recoger; canal desconocido: todos", () => {
    expect(nextStatusesForCanal("preparando", "recoger")).toEqual(["listo_para_recoger", "cancelado", "problema"]);
    expect(nextStatusesForCanal("preparando", "domicilio")).toEqual(["en_camino", "cancelado", "problema"]);
    expect(nextStatusesForCanal("preparando", null)).toEqual(["en_camino", "listo_para_recoger", "cancelado", "problema"]);
    expect(nextStatusesForCanal("listo_para_recoger", "recoger")).toEqual(["entregado", "no_recogido", "cancelado", "problema"]);
    expect(nextStatusesForCanal("no_recogido", "recoger")).toEqual(["preparando", "cancelado"]);
  });
});

describe("PedidosPage -- pedidos para recoger", () => {
  it("muestra canal, hora de recogida y propina, y NO ofrece repartidor ni 'En camino'", async () => {
    stubFetch({ preparando: [BASE] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    const text = rendered.container.textContent!;
    expect(rendered.container.querySelector('[data-testid="canal-ord-r1"]')?.textContent).toBe("Recoger");
    expect(rendered.container.querySelector('[data-testid="recoger-ord-r1"]')?.textContent).toBe("Recoge a las 20:30");
    // La propina ya no va en la fila (como el original): vive en el detalle del pedido.
    expect(text).not.toContain("Propina");
    expect(botones(rendered.container)).not.toContain("Asignar repartidor");
    expect(botones(rendered.container)).toContain("Marcar Listo para recoger");
    expect(botones(rendered.container)).not.toContain("Marcar En camino");
  });

  it("un pedido a domicilio conserva repartidor y 'En camino' y no ofrece los estados de recoger", async () => {
    stubFetch({ preparando: [{ ...BASE, canal: "domicilio", customerAddress: "Calle 5", propina: null, horaRecogida: null }] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    // «Asignar repartidor» -> «Confirmar envío» reemplaza al viejo «Marcar En camino» (el envio sigue siendo preparando -> en_camino).
    expect(botones(rendered.container)).toContain("Asignar repartidor");
    expect(botones(rendered.container)).not.toContain("Marcar En camino");
    expect(botones(rendered.container)).not.toContain("Marcar Listo para recoger");
  });

  it("un pedido historico sin canal se ve como siempre (sin badge de canal)", async () => {
    stubFetch({ preparando: [{ ...BASE, canal: null, propina: null, horaRecogida: null }] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    expect(rendered.container.querySelector('[data-testid="canal-ord-r1"]')).toBeNull();
    // Sin canal conocido se ofrecen ambos caminos (el servidor valida igual): despacho y «Marcar Listo para recoger».
    expect(botones(rendered.container)).toContain("Asignar repartidor");
    expect(botones(rendered.container)).toContain("Marcar Listo para recoger");
  });

  it("'Marcar Listo para recoger' avisa al cliente por defecto: PATCH {status} sin notifyCustomer", async () => {
    stubFetch({ preparando: [BASE] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    const btn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Marcar Listo para recoger")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/orders/ord-r1/status") && init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ status: "listo_para_recoger" });
  });

  it("aviso opcional: desmarcar 'Avisar al cliente' manda notifyCustomer:false", async () => {
    stubFetch({ preparando: [BASE] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    // Hay mas checkboxes en la pantalla (auto-impresion del ticket de cocina): se ubica el del aviso por su etiqueta.
    const etiqueta = [...rendered.container.querySelectorAll("label")].find((l) => l.textContent?.includes("Avisar al cliente por WhatsApp"))!;
    const check = etiqueta.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(check.checked).toBe(true);
    await act(async () => {
      check.click();
    });
    expect(check.checked).toBe(false);
    const btn = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent === "Marcar Listo para recoger")!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    const call = fetchMock.mock.calls.find(([url, init]) => url.endsWith("/orders/ord-r1/status") && init?.method === "PATCH")!;
    expect(JSON.parse(call[1].body as string)).toEqual({ status: "listo_para_recoger", notifyCustomer: false });
  });

  it("no recogido: aparece en su pestana, con la accion 'Marcar Preparando' (vuelve a cocina)", async () => {
    stubFetch({ no_recogido: [{ ...BASE, status: "no_recogido" }] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    expect(rendered.container.textContent).toContain("No recogido");
    expect(botones(rendered.container)).toContain("Marcar Preparando");
    expect(botones(rendered.container)).not.toContain("Marcar Entregado");
  });

  it("un pedido recogido en «Listo para recoger» se ve en Recibidas con su chip de estado y la accion «Marcar Entregado»", async () => {
    stubFetch({ listo_para_recoger: [{ ...BASE, status: "listo_para_recoger" }] });
    rendered = renderComponent(<PedidosPage {...CTX} />);
    await esperarCarga();
    expect(rendered.container.querySelector('[data-testid="estado-ord-r1"]')?.textContent).toBe("Listo para recoger");
    expect(botones(rendered.container)).toContain("Marcar Entregado");
    expect(botones(rendered.container)).toContain("Marcar No recogido");
  });
});

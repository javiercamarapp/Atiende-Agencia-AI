import { describe, expect, it, vi } from "vitest";
import { assignRepartidor, fetchOrders, NEXT_STATUSES, updateOrderStatus } from "../src/verticals/restaurantes/lib/orders-client.ts";

const ORDER_ROW = {
  id: "order-1",
  propertyId: "prop-1",
  branch: "Centro",
  customerId: "cust-1",
  customerName: "Ana",
  customerPhone: "9990000000",
  customerAddress: "Calle 1",
  total: 100,
  status: "pending",
  items: [{ id: "prod-1", name: "Tacos", price: 100, quantity: 1 }],
  source: "web",
  notes: null,
  paymentMethod: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("fetchOrders", () => {
  it("arma la query con status/fechas/cursor/limit", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/v1/restaurantes/prop-1/admin/orders");
      expect(parsed.searchParams.get("status")).toBe("pending");
      expect(parsed.searchParams.get("limit")).toBe("10");
      return new Response(JSON.stringify({ orders: [ORDER_ROW], nextCursor: "abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchOrders(fetchImpl, "http://api.local", "tok", "prop-1", { status: "pending", limit: 10 });
    expect(result.orders).toHaveLength(1);
    expect(result.nextCursor).toBe("abc");
  });
});

describe("updateOrderStatus", () => {
  it("hace PATCH real al endpoint de status", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/orders/order-1/status");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ status: "preparando" });
      return new Response(JSON.stringify({ order: { ...ORDER_ROW, status: "preparando" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updateOrderStatus(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "preparando");
    expect(result.status).toBe("preparando");
  });

  it("un salto inválido -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'No se puede cambiar un pedido de "pending" a "entregado".' }), { status: 409 })) as unknown as typeof fetch;
    await expect(updateOrderStatus(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "entregado")).rejects.toThrow(/no se puede cambiar/i);
  });
});

describe("NEXT_STATUSES", () => {
  it("cancelado y completado son terminales", () => {
    expect(NEXT_STATUSES.cancelado).toEqual([]);
    expect(NEXT_STATUSES.completado).toEqual([]);
  });
});

// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI"): cliente real de PATCH .../assign-repartidor (admin-orders.ts).
describe("assignRepartidor", () => {
  it("hace PATCH real al endpoint de assign-repartidor con el repartidorId elegido", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/admin/orders/order-1/assign-repartidor");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ repartidorId: "repartidor-1" });
      return new Response(JSON.stringify({ order: { ...ORDER_ROW, assignedRepartidorId: "repartidor-1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await assignRepartidor(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "repartidor-1");
    expect(result.assignedRepartidorId).toBe("repartidor-1");
  });

  it("incluye estimatedDeliveryAt solo cuando se pasa explícitamente", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ repartidorId: "repartidor-1", estimatedDeliveryAt: "2026-09-14T20:00:00.000Z" });
      return new Response(JSON.stringify({ order: ORDER_ROW }), { status: 200 });
    }) as unknown as typeof fetch;
    await assignRepartidor(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "repartidor-1", "2026-09-14T20:00:00.000Z");
  });

  it("un uuid que no es repartidor de esta organización -> error real (400 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "repartidorId no corresponde a un repartidor de esta organización." }), { status: 400 })) as unknown as typeof fetch;
    await expect(assignRepartidor(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "no-es-repartidor")).rejects.toThrow(/no corresponde a un repartidor/i);
  });
});

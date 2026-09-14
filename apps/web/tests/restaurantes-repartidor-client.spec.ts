import { describe, expect, it, vi } from "vitest";
import { fetchAssignedOrders, REPARTIDOR_NEXT_STATUS, updateAssignedOrderStatus } from "../src/verticals/restaurantes/lib/repartidor-client.ts";

const ORDER_ROW = {
  id: "order-1",
  propertyId: "prop-1",
  branch: "Centro",
  customerName: "Ana",
  customerPhone: "9990000000",
  customerAddress: "Calle 1",
  total: 100,
  status: "preparando",
  items: [{ id: "prod-1", name: "Tacos", price: 100, quantity: 1 }],
  notes: null,
  paymentMethod: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("fetchAssignedOrders", () => {
  it("pega al endpoint de repartidor (no admin) sin ningún filtro/paginación", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/repartidor/orders");
      return new Response(JSON.stringify({ orders: [ORDER_ROW] }), { status: 200 });
    }) as unknown as typeof fetch;
    const orders = await fetchAssignedOrders(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(orders).toHaveLength(1);
    expect(orders[0]?.id).toBe("order-1");
  });
});

describe("updateAssignedOrderStatus", () => {
  it("PATCH sin incidentNote cuando no se pasa", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/v1/restaurantes/prop-1/repartidor/orders/order-1/status");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ status: "en_camino" });
      return new Response(JSON.stringify({ order: { ...ORDER_ROW, status: "en_camino" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updateAssignedOrderStatus(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "en_camino");
    expect(result.status).toBe("en_camino");
  });

  it('PATCH con incidentNote real cuando status es "problema"', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string)).toEqual({ status: "problema", incidentNote: "El cliente no contesta." });
      return new Response(JSON.stringify({ order: { ...ORDER_ROW, status: "problema", incidentNote: "El cliente no contesta." } }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await updateAssignedOrderStatus(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "problema", "El cliente no contesta.");
    expect(result.incidentNote).toBe("El cliente no contesta.");
  });

  it("un salto no permitido para repartidor -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Un repartidor no puede cambiar un pedido a "preparando".' }), { status: 409 })) as unknown as typeof fetch;
    await expect(updateAssignedOrderStatus(fetchImpl, "http://api.local", "tok", "prop-1", "order-1", "preparando" as never)).rejects.toThrow(/no puede cambiar/i);
  });
});

describe("REPARTIDOR_NEXT_STATUS", () => {
  it("solo ofrece avance desde preparando/en_camino -- pending/entregado/problema no tienen botón de avance automático", () => {
    expect(REPARTIDOR_NEXT_STATUS.preparando).toBe("en_camino");
    expect(REPARTIDOR_NEXT_STATUS.en_camino).toBe("entregado");
    expect(REPARTIDOR_NEXT_STATUS.pending).toBeUndefined();
    expect(REPARTIDOR_NEXT_STATUS.entregado).toBeUndefined();
  });
});

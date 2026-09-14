import { describe, expect, it, vi } from "vitest";
import { cancelReservation, createReservation, fetchReservations, isCancellable, NEXT_GENERIC_STATUS, transitionReservation } from "../src/verticals/hoteles/lib/reservas-client.ts";

const RESERVATION_ROW = {
  id: "res-1",
  propertyId: "prop-1",
  roomTypeId: "room-1",
  guestId: null,
  checkInDate: "2026-12-01",
  checkOutDate: "2026-12-03",
  estado: "confirmada",
  montoTotal: 3000,
  penalizacionCancelacion: null,
  canceladaEn: null,
  creadaEn: "2026-01-01T00:00:00.000Z",
};

describe("fetchReservations", () => {
  it("pide GET /hoteles/:propertyId/reservas", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/reservas");
      return new Response(JSON.stringify([RESERVATION_ROW]), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchReservations(fetchImpl, "http://api.local", "tok", "prop-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.estado).toBe("confirmada");
  });
});

describe("createReservation", () => {
  it("hace POST real con el header Idempotency-Key", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/reservas");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
      expect(JSON.parse(init!.body as string)).toEqual({ roomTypeId: "room-1", checkInDate: "2026-12-01", checkOutDate: "2026-12-03" });
      return new Response(JSON.stringify(RESERVATION_ROW), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await createReservation(fetchImpl, "http://api.local", "tok", "prop-1", { roomTypeId: "room-1", checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }, "key-1");
    expect(result.id).toBe("res-1");
  });

  it("sin disponibilidad -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "sin_disponibilidad para esa noche." }), { status: 409 })) as unknown as typeof fetch;
    await expect(
      createReservation(fetchImpl, "http://api.local", "tok", "prop-1", { roomTypeId: "room-1", checkInDate: "2026-12-01", checkOutDate: "2026-12-03" }, "key-1"),
    ).rejects.toThrow(/sin_disponibilidad/);
  });
});

describe("transitionReservation", () => {
  it("hace PATCH real a .../transicion", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/reservas/res-1/transicion");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(init!.body as string)).toEqual({ toStatus: "check_in" });
      return new Response(JSON.stringify({ ...RESERVATION_ROW, estado: "check_in" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await transitionReservation(fetchImpl, "http://api.local", "tok", "prop-1", "res-1", "check_in");
    expect(result.estado).toBe("check_in");
  });
});

describe("cancelReservation", () => {
  it("hace POST real a .../cancelar", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/reservas/res-1/cancelar");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ ...RESERVATION_ROW, estado: "cancelada", canceladaEn: "2026-01-02T00:00:00.000Z" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await cancelReservation(fetchImpl, "http://api.local", "tok", "prop-1", "res-1");
    expect(result.estado).toBe("cancelada");
  });
});

describe("NEXT_GENERIC_STATUS/isCancellable", () => {
  it("cerrada/cancelada/no_show no tienen siguiente transición genérica", () => {
    expect(NEXT_GENERIC_STATUS.cerrada).toBeUndefined();
    expect(NEXT_GENERIC_STATUS.cancelada).toBeUndefined();
    expect(NEXT_GENERIC_STATUS.no_show).toBeUndefined();
  });

  it("solo cotizada/confirmada son cancelables", () => {
    expect(isCancellable("cotizada")).toBe(true);
    expect(isCancellable("confirmada")).toBe(true);
    expect(isCancellable("check_in")).toBe(false);
    expect(isCancellable("cerrada")).toBe(false);
  });
});

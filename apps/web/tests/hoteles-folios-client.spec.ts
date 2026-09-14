import { describe, expect, it, vi } from "vitest";
import { addCharge, addPayment, closeFolio, fetchFolio, reverseCharge } from "../src/verticals/hoteles/lib/folios-client.ts";

const FOLIO_ROW = {
  id: "folio-1",
  estado: "abierto",
  reservationId: "res-1",
  etiqueta: "Principal",
  esPrincipal: true,
  cerradoEn: null,
  motivoCierre: null,
  cargos: [],
  pagos: [],
  saldo: 0,
};

describe("fetchFolio", () => {
  it("pide GET /hoteles/:propertyId/folios/:folioId", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/folios/folio-1");
      return new Response(JSON.stringify(FOLIO_ROW), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await fetchFolio(fetchImpl, "http://api.local", "tok", "prop-1", "folio-1");
    expect(result.etiqueta).toBe("Principal");
  });
});

describe("addCharge", () => {
  it("hace POST real con Idempotency-Key y el concepto elegido", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/folios/folio-1/cargos");
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
      expect(JSON.parse(init!.body as string)).toEqual({ descripcion: "Minibar", monto: 200, concepto: "extras" });
      return new Response(JSON.stringify({ id: "charge-1", concepto: "extras", monto: 200, impuesto: 32 }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await addCharge(fetchImpl, "http://api.local", "tok", "prop-1", "folio-1", { descripcion: "Minibar", monto: 200, concepto: "extras" }, "key-1");
    expect(result.id).toBe("charge-1");
  });

  it("folio cerrado -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "El folio está cerrado: no admite nuevos cargos." }), { status: 409 })) as unknown as typeof fetch;
    await expect(addCharge(fetchImpl, "http://api.local", "tok", "prop-1", "folio-1", { descripcion: "x", monto: 1, concepto: "otro" }, "key-1")).rejects.toThrow(/cerrado/);
  });
});

describe("reverseCharge", () => {
  it("hace POST real a .../reverso con el motivo", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/folios/folio-1/cargos/charge-1/reverso");
      expect(JSON.parse(init!.body as string)).toEqual({ motivo: "Cobro duplicado" });
      return new Response(JSON.stringify({ id: "charge-2", reversaDe: "charge-1" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await reverseCharge(fetchImpl, "http://api.local", "tok", "prop-1", "folio-1", "charge-1", "Cobro duplicado", "key-1");
    expect(result.reversaDe).toBe("charge-1");
  });
});

describe("addPayment", () => {
  it("hace POST real con método efectivo/transferencia", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/folios/folio-1/pagos");
      expect(JSON.parse(init!.body as string)).toEqual({ monto: 500, metodo: "efectivo" });
      return new Response(JSON.stringify({ id: "pago-1", monto: 500, metodo: "efectivo", estado: "capturado" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await addPayment(fetchImpl, "http://api.local", "tok", "prop-1", "folio-1", { monto: 500, metodo: "efectivo" }, "key-1");
    expect(result.estado).toBe("capturado");
  });
});

describe("closeFolio", () => {
  it("hace POST real a .../cerrar sin exigir idempotency-key", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/hoteles/prop-1/folios/folio-1/cerrar");
      expect((init?.headers as Record<string, string>)["idempotency-key"]).toBeUndefined();
      return new Response(JSON.stringify({ id: "folio-1", estado: "cerrado", motivoCierre: "saldo_cero", saldo: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await closeFolio(fetchImpl, "http://api.local", "tok", "prop-1", "folio-1", "saldo_cero");
    expect(result.estado).toBe("cerrado");
  });
});

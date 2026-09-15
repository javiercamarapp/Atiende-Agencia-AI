import { describe, expect, it, vi } from "vitest";
import {
  fetchMovimiento,
  fetchOwnerStatementDetalle,
  fetchOwnerStatements,
  fetchPayoutDetalle,
  generarOwnerStatement,
  importarPayout,
  registrarMovimiento,
} from "../src/verticals/rentas/lib/finanzas-client.ts";

describe("registrarMovimiento", () => {
  it("hace POST real a .../reservas/:ocupacionId/movimiento", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/reservas/ocup-1/movimiento");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({
        moneda: "MXN",
        montoBrutoCentavos: 500000,
        comisionGestorBasisPoints: 1000,
        comisionGestorBase: "bruto",
        gastos: [],
        impuestos: [],
      });
      return new Response(
        JSON.stringify({
          id: "mov-1",
          ocupacionId: "ocup-1",
          creadoEn: "2026-01-01T00:00:00.000Z",
          moneda: "MXN",
          ingresoBrutoCentavos: 500000,
          montoRecibidoCentavos: 500000,
          comisionCanalCentavos: 0,
          comisionCanalFuente: "sin comisión configurada",
          comisionGestorCentavos: 50000,
          gastosCentavos: 0,
          impuestosCentavos: 0,
          netoCentavos: 450000,
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const result = await registrarMovimiento(fetchImpl, "http://api.local", "tok", "prop-1", "ocup-1", {
      moneda: "MXN",
      montoBrutoCentavos: 500000,
      comisionGestorBasisPoints: 1000,
      comisionGestorBase: "bruto",
      gastos: [],
      impuestos: [],
    });
    expect(result.id).toBe("mov-1");
    expect(result.netoCentavos).toBe(450000);
  });

  it("reserva ya con movimiento registrado -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Ya existe un movimiento financiero para esta reserva." }), { status: 409 })) as unknown as typeof fetch;
    await expect(
      registrarMovimiento(fetchImpl, "http://api.local", "tok", "prop-1", "ocup-1", {
        moneda: "MXN",
        montoBrutoCentavos: 100,
        comisionGestorBasisPoints: 0,
        comisionGestorBase: "bruto",
        gastos: [],
        impuestos: [],
      }),
    ).rejects.toThrow(/Ya existe un movimiento/);
  });
});

describe("fetchMovimiento", () => {
  it("hace GET real a .../reservas/:ocupacionId/movimiento", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/reservas/ocup-1/movimiento");
      return new Response(
        JSON.stringify({
          ocupacionId: "ocup-1",
          moneda: "MXN",
          ingresoBrutoCentavos: 500000,
          montoRecibidoCentavos: 500000,
          comisionCanalCentavos: 0,
          comisionCanalFuente: "sin comisión configurada",
          comisionGestorCentavos: 50000,
          gastosCentavos: 0,
          impuestosCentavos: 0,
          netoCentavos: 450000,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchMovimiento(fetchImpl, "http://api.local", "tok", "prop-1", "ocup-1");
    expect(result.netoCentavos).toBe(450000);
  });

  it("sin movimiento registrado -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "No hay movimiento financiero registrado para esta reserva." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchMovimiento(fetchImpl, "http://api.local", "tok", "prop-1", "ocup-1")).rejects.toThrow(/No hay movimiento financiero/);
  });
});

describe("generarOwnerStatement", () => {
  it("hace POST real a .../owners/:ownerId/statements", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/owners/owner-1/statements");
      expect(JSON.parse(init!.body as string)).toEqual({ periodoInicio: "2026-01-01", periodoFin: "2026-02-01", motivoVersion: undefined });
      return new Response(JSON.stringify({ id: "st-1", version: 1, creado: true, generadoEn: "2026-02-01T00:00:00.000Z", totales: { ingresosBrutosCentavos: 100, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 100 } }), {
        status: 201,
      });
    }) as unknown as typeof fetch;
    const result = await generarOwnerStatement(fetchImpl, "http://api.local", "tok", "prop-1", "owner-1", { periodoInicio: "2026-01-01", periodoFin: "2026-02-01" });
    expect(result.creado).toBe(true);
    expect(result.version).toBe(1);
  });

  it("mismo contenido que la última versión -> 200 idempotente, creado:false", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "st-1", version: 1, creado: false }), { status: 200 })) as unknown as typeof fetch;
    const result = await generarOwnerStatement(fetchImpl, "http://api.local", "tok", "prop-1", "owner-1", { periodoInicio: "2026-01-01", periodoFin: "2026-02-01" });
    expect(result.creado).toBe(false);
    expect(result.totales).toBeUndefined();
  });

  it("nueva versión sin motivoVersion -> error real (400 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "motivoVersion es obligatorio al generar una nueva versión de un statement ya existente." }), { status: 400 })) as unknown as typeof fetch;
    await expect(generarOwnerStatement(fetchImpl, "http://api.local", "tok", "prop-1", "owner-1", { periodoInicio: "2026-01-01", periodoFin: "2026-02-01" })).rejects.toThrow(/motivoVersion es obligatorio/);
  });
});

describe("fetchOwnerStatements / fetchOwnerStatementDetalle", () => {
  it("lista statements de un owner", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/owners/owner-1/statements");
      return new Response(
        JSON.stringify({
          ownerId: "owner-1",
          statements: [{ id: "st-1", ownerId: "owner-1", propertyId: "prop-1", periodo: { inicio: "2026-01-01", fin: "2026-02-01" }, version: 1, moneda: "MXN", netoCentavos: 100, generadoEn: "2026-02-01T00:00:00.000Z" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchOwnerStatements(fetchImpl, "http://api.local", "tok", "prop-1", "owner-1");
    expect(result).toHaveLength(1);
    expect(result[0]!.version).toBe(1);
  });

  it("hace GET real al detalle de un statement por id", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/statements/st-1");
      return new Response(
        JSON.stringify({
          id: "st-1",
          ownerId: "owner-1",
          propertyId: "prop-1",
          periodo: { inicio: "2026-01-01", fin: "2026-02-01" },
          version: 1,
          moneda: "MXN",
          netoCentavos: 100,
          generadoEn: "2026-02-01T00:00:00.000Z",
          totales: { ingresosBrutosCentavos: 100, comisionCanalCentavos: 0, comisionGestorCentavos: 0, gastosCentavos: 0, impuestosCentavos: 0, netoCentavos: 100 },
          lineas: [{ ocupacionId: "ocup-1", tipo: "ingreso", descripcion: "Ingreso bruto — reserva ocup-1", montoCentavos: 100 }],
          motivoVersion: null,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchOwnerStatementDetalle(fetchImpl, "http://api.local", "tok", "prop-1", "st-1");
    expect(result.lineas).toHaveLength(1);
    expect(result.motivoVersion).toBeNull();
  });
});

describe("importarPayout / fetchPayoutDetalle", () => {
  it("hace POST real a .../payouts", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/payouts");
      expect(JSON.parse(init!.body as string)).toEqual({
        canalCodigo: "airbnb",
        moneda: "MXN",
        fechaPayout: "2026-02-01",
        referenciaExterna: null,
        lineas: [{ referenciaExternaReserva: "ext-1", montoCentavos: 100000 }],
      });
      return new Response(
        JSON.stringify({
          id: "payout-1",
          creadoEn: "2026-02-01T00:00:00.000Z",
          canalCodigo: "airbnb",
          moneda: "MXN",
          montoTotalCentavos: 100000,
          fechaPayout: "2026-02-01",
          resumen: { conciliadas: 1, pendientes: 0, discrepancias: 0 },
          lineas: [{ ocupacionId: "ocup-1", referenciaExternaReserva: "ext-1", montoCentavos: 100000, montoEsperadoCentavos: 100000, estado: "conciliado" }],
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const result = await importarPayout(fetchImpl, "http://api.local", "tok", "prop-1", {
      canalCodigo: "airbnb",
      moneda: "MXN",
      fechaPayout: "2026-02-01",
      referenciaExterna: null,
      lineas: [{ referenciaExternaReserva: "ext-1", montoCentavos: 100000 }],
    });
    expect(result.id).toBe("payout-1");
    expect(result.resumen.conciliadas).toBe(1);
  });

  it("canal inexistente en el catálogo -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Canal "no-existe" no existe en el catálogo.' }), { status: 404 })) as unknown as typeof fetch;
    await expect(
      importarPayout(fetchImpl, "http://api.local", "tok", "prop-1", { canalCodigo: "no-existe", moneda: "MXN", fechaPayout: "2026-02-01", lineas: [{ referenciaExternaReserva: null, montoCentavos: 100 }] }),
    ).rejects.toThrow(/no existe en el catálogo/);
  });

  it("hace GET real al detalle de un payout por id", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/payouts/payout-1");
      return new Response(
        JSON.stringify({
          id: "payout-1",
          propertyId: "prop-1",
          canalCodigo: "airbnb",
          moneda: "MXN",
          montoTotalCentavos: 100000,
          fechaPayout: "2026-02-01",
          referenciaExterna: null,
          resumen: { conciliadas: 1, pendientes: 0, discrepancias: 0 },
          lineas: [{ ocupacionId: "ocup-1", referenciaExternaReserva: "ext-1", montoCentavos: 100000, montoEsperadoCentavos: 100000, estado: "conciliado" }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchPayoutDetalle(fetchImpl, "http://api.local", "tok", "prop-1", "payout-1");
    expect(result.canalCodigo).toBe("airbnb");
  });

  it("payout no encontrado -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Payout no encontrado en esta property." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchPayoutDetalle(fetchImpl, "http://api.local", "tok", "prop-1", "payout-x")).rejects.toThrow(/Payout no encontrado/);
  });
});

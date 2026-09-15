import { describe, expect, it, vi } from "vitest";
import {
  basisPointsAPorcentaje,
  centavosAPesos,
  crearDescuentoDuracion,
  crearReglaCanal,
  crearReglaMinStay,
  crearTarifaBase,
  crearTemporada,
  fetchCotizacion,
  pesosACentavos,
  porcentajeABasisPoints,
} from "../src/verticals/rentas/lib/pricing-client.ts";

describe("fetchCotizacion", () => {
  it("pide GET .../cotizacion con checkIn/checkOut y regresa el resultado", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/cotizacion?checkIn=2026-12-01&checkOut=2026-12-04");
      return new Response(
        JSON.stringify({
          unidadId: "unidad-1",
          moneda: "MXN",
          noches: 3,
          desgloseNoches: [{ fecha: "2026-12-01", precioCentavos: 100000, origen: "base" }],
          subtotalAntesDescuentoCentavos: 300000,
          descuentoAplicado: null,
          subtotalConDescuentoCentavos: 300000,
          markupCanalCentavos: 0,
          totalCentavos: 300000,
          violacionesMinStay: [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchCotizacion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { inicio: "2026-12-01", fin: "2026-12-04" });
    expect(result.totalCentavos).toBe(300000);
    expect(result.noches).toBe(3);
  });

  it("agrega ?canal cuando se pide cotización para un canal específico", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/cotizacion?checkIn=2026-12-01&checkOut=2026-12-04&canal=airbnb");
      return new Response(
        JSON.stringify({
          unidadId: "unidad-1",
          moneda: "MXN",
          noches: 3,
          desgloseNoches: [],
          subtotalAntesDescuentoCentavos: 300000,
          descuentoAplicado: null,
          subtotalConDescuentoCentavos: 300000,
          markupCanalCentavos: 45000,
          totalCentavos: 345000,
          violacionesMinStay: [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const result = await fetchCotizacion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { inicio: "2026-12-01", fin: "2026-12-04" }, "airbnb");
    expect(result.markupCanalCentavos).toBe(45000);
  });

  it("unidad sin tarifa base -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Unidad no encontrada en esta property, o sin tarifa base configurada." }), { status: 404 })) as unknown as typeof fetch;
    await expect(fetchCotizacion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { inicio: "2026-12-01", fin: "2026-12-04" })).rejects.toThrow(/sin tarifa base/);
  });
});

describe("crearTarifaBase", () => {
  it("hace POST real a .../tarifa-base", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/tarifa-base");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ precioNocheCentavos: 100000, moneda: "MXN", vigenteDesde: "2026-12-01" });
      return new Response(JSON.stringify({ id: "tb-1", unidadId: "unidad-1", precioNocheCentavos: 100000, moneda: "MXN", vigenteDesde: "2026-12-01" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearTarifaBase(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { precioNocheCentavos: 100000, moneda: "MXN", vigenteDesde: "2026-12-01" });
    expect(result.id).toBe("tb-1");
  });

  it("moneda inconsistente con la unidad -> error real (400 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'La unidad ya tiene tarifas en "MXN"; no se mezclan monedas por unidad.' }), { status: 400 })) as unknown as typeof fetch;
    await expect(crearTarifaBase(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { precioNocheCentavos: 100000, moneda: "USD" })).rejects.toThrow(/no se mezclan monedas/);
  });
});

describe("crearTemporada", () => {
  it("hace POST real a .../temporadas", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/temporadas");
      expect(JSON.parse(init!.body as string)).toEqual({ nombre: "Semana Santa", rango: { inicio: "2026-04-01", fin: "2026-04-08" }, precioNocheCentavos: 200000, moneda: "MXN" });
      return new Response(JSON.stringify({ id: "temp-1", unidadId: "unidad-1", nombre: "Semana Santa", rango: { inicio: "2026-04-01", fin: "2026-04-08" }, precioNocheCentavos: 200000, moneda: "MXN" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearTemporada(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", {
      nombre: "Semana Santa",
      rango: { inicio: "2026-04-01", fin: "2026-04-08" },
      precioNocheCentavos: 200000,
      moneda: "MXN",
    });
    expect(result.id).toBe("temp-1");
  });

  it("temporada traslapada con otra existente -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Se traslapa con "Verano" (2026-04-01..2026-04-08).' }), { status: 409 })) as unknown as typeof fetch;
    await expect(
      crearTemporada(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { nombre: "X", rango: { inicio: "2026-04-02", fin: "2026-04-05" }, precioNocheCentavos: 1, moneda: "MXN" }),
    ).rejects.toThrow(/traslapa/);
  });
});

describe("crearDescuentoDuracion", () => {
  it("hace POST real a .../descuentos-duracion", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/descuentos-duracion");
      expect(JSON.parse(init!.body as string)).toEqual({ nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "Promoción semanal" });
      return new Response(JSON.stringify({ id: "desc-1", unidadId: "unidad-1", nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "Promoción semanal" }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearDescuentoDuracion(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000, fuente: "Promoción semanal" });
    expect(result.id).toBe("desc-1");
  });
});

describe("crearReglaMinStay", () => {
  it("hace POST real a .../min-stay", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/min-stay");
      expect(JSON.parse(init!.body as string)).toEqual({ rango: { inicio: "2026-12-01", fin: "2027-01-01" }, diaSemanaCheckIn: 6, nochesMinimas: 3 });
      return new Response(JSON.stringify({ id: "ms-1", unidadId: "unidad-1", rango: { inicio: "2026-12-01", fin: "2027-01-01" }, diaSemanaCheckIn: 6, nochesMinimas: 3 }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearReglaMinStay(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { rango: { inicio: "2026-12-01", fin: "2027-01-01" }, diaSemanaCheckIn: 6, nochesMinimas: 3 });
    expect(result.id).toBe("ms-1");
  });

  it("regla min-stay traslapada -> error real (409 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Se traslapa con \"regla min-stay existente (día todos)\" (2026-12-01..2027-01-01)." }), { status: 409 })) as unknown as typeof fetch;
    await expect(
      crearReglaMinStay(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { rango: { inicio: "2026-12-05", fin: "2026-12-10" }, diaSemanaCheckIn: null, nochesMinimas: 2 }),
    ).rejects.toThrow(/traslapa/);
  });
});

describe("crearReglaCanal", () => {
  it("hace POST real a .../reglas-canal", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://api.local/rentas/prop-1/unidades/unidad-1/reglas-canal");
      expect(JSON.parse(init!.body as string)).toEqual({ canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true });
      return new Response(JSON.stringify({ id: "rc-1", unidadId: "unidad-1", canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true }), { status: 201 });
    }) as unknown as typeof fetch;
    const result = await crearReglaCanal(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true });
    expect(result.activo).toBe(true);
  });

  it("canal inexistente en el catálogo -> error real (404 del servidor)", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Canal "no-existe" no existe en el catálogo.' }), { status: 404 })) as unknown as typeof fetch;
    await expect(crearReglaCanal(fetchImpl, "http://api.local", "tok", "prop-1", "unidad-1", { canalCodigo: "no-existe", markupBasisPoints: 0, activo: false })).rejects.toThrow(/no existe en el catálogo/);
  });
});

describe("conversiones pesos/centavos y porcentaje/basis points", () => {
  it("pesosACentavos redondea a centavos enteros", () => {
    expect(pesosACentavos(1000)).toBe(100000);
    expect(pesosACentavos(19.999)).toBe(2000);
  });

  it("centavosAPesos formatea 2 decimales", () => {
    expect(centavosAPesos(100000)).toBe("1000.00");
    expect(centavosAPesos(50)).toBe("0.50");
  });

  it("porcentajeABasisPoints y basisPointsAPorcentaje son inversas", () => {
    expect(porcentajeABasisPoints(10)).toBe(1000);
    expect(porcentajeABasisPoints(15.5)).toBe(1550);
    expect(basisPointsAPorcentaje(1000)).toBe("10.00");
  });
});

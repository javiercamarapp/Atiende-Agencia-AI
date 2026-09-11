import { describe, expect, it } from "vitest";
import { aplicarPorcentaje, centavosDesdeDecimal, decimalDesdeCentavos, restarCentavos, sumarCentavos } from "../src/finanzas/redondeo.ts";
import { calcularMovimientoReserva } from "../src/finanzas/movimiento.ts";

describe("centavosDesdeDecimal", () => {
  it("convierte un decimal simple", () => {
    expect(centavosDesdeDecimal("1234.56")).toBe(123456);
  });
  it("redondea half-up el caso límite x.xx5", () => {
    expect(centavosDesdeDecimal("10.005")).toBe(1001); // 1000.5 -> sube a 1001
  });
  it("maneja negativos", () => {
    expect(centavosDesdeDecimal("-10.50")).toBe(-1050);
  });
  it("nunca usa parseFloat -- rechaza formato inválido en vez de adivinar", () => {
    expect(() => centavosDesdeDecimal("10,50")).toThrow();
    expect(() => centavosDesdeDecimal("abc")).toThrow();
  });
});

describe("decimalDesdeCentavos", () => {
  it("formatea con 2 decimales fijos", () => {
    expect(decimalDesdeCentavos(123456)).toBe("1234.56");
  });
  it("nunca inventa un centavo: trunca (no redondea) un valor no entero recibido por defensa", () => {
    // Guarda de idempotencia, no una decisión de redondeo (ver comentario del
    // archivo fuente): 1000.7 centavos truncados son 1000 centavos = "10.00", nunca
    // "10.01" a favor de ninguna de las partes.
    expect(decimalDesdeCentavos(1000.7)).toBe("10.00");
  });
  it("formatea negativos con signo antes del número", () => {
    expect(decimalDesdeCentavos(-1050)).toBe("-10.50");
  });
});

describe("aplicarPorcentaje", () => {
  it("16% de 10000 centavos = 1600 centavos", () => {
    expect(aplicarPorcentaje(10000, 1600)).toBe(1600);
  });
  it("redondea half-up, nunca banker's rounding", () => {
    // 100 centavos * 0.5% = 0.5 centavos -> sube a 1
    expect(aplicarPorcentaje(100, 50)).toBe(1);
  });
  it("rechaza basis points negativos", () => {
    expect(() => aplicarPorcentaje(100, -1)).toThrow();
  });
});

describe("sumarCentavos / restarCentavos", () => {
  it("suma sin pasar por decimal intermedio", () => {
    expect(sumarCentavos(100, 200, 300)).toBe(600);
  });
  it("resta múltiples valores del base", () => {
    expect(restarCentavos(1000, 100, 200)).toBe(700);
  });
});

describe("calcularMovimientoReserva -- Finanzas-1 (nunca doble descuento de comisión de canal)", () => {
  it("si el canal YA entrega neto de comisión (Airbnb), la comisión de canal se reporta en 0 y NUNCA se resta del bruto", () => {
    const resultado = calcularMovimientoReserva({
      ocupacionUnidadId: "ocup-1",
      moneda: "MXN",
      montoBrutoCentavos: 100000, // $1,000.00 -- ya neto de la comisión de Airbnb
      comisionCanal: { yaNetoDeComision: true, comisionBasisPoints: 1600, fuente: "Airbnb: fee deducted from host payout" },
      comisionGestor: { basisPoints: 2000, base: "neto_de_canal" },
      gastos: [],
      impuestos: [],
    });
    expect(resultado.comisionCanalCentavos).toBe(0);
    expect(resultado.montoRecibidoCentavos).toBe(100000);
    expect(resultado.comisionGestorCentavos).toBe(20000); // 20% de 100000
    expect(resultado.netoCentavos).toBe(80000);
  });

  it("si el canal entrega bruto (Booking/Vrbo), SÍ se calcula y resta la comisión de canal", () => {
    const resultado = calcularMovimientoReserva({
      ocupacionUnidadId: "ocup-2",
      moneda: "MXN",
      montoBrutoCentavos: 100000,
      comisionCanal: { yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "Booking.com: comisión estándar sin confirmar oficialmente" },
      comisionGestor: { basisPoints: 2000, base: "neto_de_canal" },
      gastos: [],
      impuestos: [],
    });
    expect(resultado.comisionCanalCentavos).toBe(15000);
    expect(resultado.montoRecibidoCentavos).toBe(85000);
    expect(resultado.comisionGestorCentavos).toBe(17000); // 20% de 85000
    expect(resultado.netoCentavos).toBe(68000);
  });

  it("la comisión del gestor sobre base 'bruto' se calcula sobre el ingreso bruto, no sobre el neto de canal", () => {
    const resultado = calcularMovimientoReserva({
      ocupacionUnidadId: "ocup-3",
      moneda: "MXN",
      montoBrutoCentavos: 100000,
      comisionCanal: { yaNetoDeComision: false, comisionBasisPoints: 1000, fuente: "test" },
      comisionGestor: { basisPoints: 1000, base: "bruto" },
      gastos: [],
      impuestos: [],
    });
    expect(resultado.comisionGestorCentavos).toBe(10000); // 10% de 100000, NO de 90000
  });

  it("resta gastos e impuestos del neto, y nunca modifica ingresoBrutoCentavos", () => {
    const resultado = calcularMovimientoReserva({
      ocupacionUnidadId: "ocup-4",
      moneda: "MXN",
      montoBrutoCentavos: 100000,
      comisionCanal: { yaNetoDeComision: true, comisionBasisPoints: 0, fuente: "Airbnb" },
      comisionGestor: { basisPoints: 0, base: "neto_de_canal" },
      gastos: [{ tipo: "limpieza", montoCentavos: 5000 }],
      impuestos: [{ tipo: "isr_retencion", montoCentavos: 2000 }],
    });
    expect(resultado.ingresoBrutoCentavos).toBe(100000);
    expect(resultado.gastosCentavos).toBe(5000);
    expect(resultado.impuestosCentavos).toBe(2000);
    expect(resultado.netoCentavos).toBe(93000);
  });

  it("rechaza un monto bruto negativo", () => {
    expect(() =>
      calcularMovimientoReserva({
        ocupacionUnidadId: "ocup-5",
        moneda: "MXN",
        montoBrutoCentavos: -1,
        comisionCanal: { yaNetoDeComision: true, comisionBasisPoints: 0, fuente: "x" },
        comisionGestor: { basisPoints: 0, base: "bruto" },
        gastos: [],
        impuestos: [],
      }),
    ).toThrow(/negativo/);
  });
});

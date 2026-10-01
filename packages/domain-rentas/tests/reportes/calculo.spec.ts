import { describe, expect, it } from "vitest";
import { generarReporteOcupacionIngresos, mesCalendarioDe, repartirCentavos } from "../../src/reportes/index.ts";
import type { FinancieroReservaReporte, ReservaParaReporte, UnidadParaReporte } from "../../src/reportes/index.ts";

const U1: UnidadParaReporte = { id: "u1", nombre: "Casa Mar", ownerId: "o1", ownerNombre: "Ana" };
const U2: UnidadParaReporte = { id: "u2", nombre: "Casa Sol", ownerId: null, ownerNombre: null };

const fin = (bruto: number, extra: Partial<FinancieroReservaReporte> = {}): FinancieroReservaReporte => ({
  moneda: "MXN",
  brutoCentavos: bruto,
  comisionCanalCentavos: 0,
  comisionGestorCentavos: 0,
  gastosCentavos: 0,
  impuestosCentavos: 0,
  netoCentavos: bruto,
  ...extra,
});

let n = 0;
const res = (unidadId: string, inicio: string, finFecha: string, financiero: FinancieroReservaReporte | null, canal = "airbnb", id?: string): ReservaParaReporte => ({
  ocupacionId: id ?? `r${++n}`,
  unidadId,
  canal,
  inicio,
  fin: finFecha,
  creadaEn: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
  financiero,
});

describe("repartirCentavos", () => {
  it("la suma de las partes es siempre el total, incluso con resto y negativos", () => {
    for (const [total, partes] of [[10000, 3], [1, 5], [99999, 7], [-1001, 4], [0, 3]] as const) {
      const r = repartirCentavos(total, partes);
      expect(r).toHaveLength(partes);
      expect(r.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
  it("rechaza entradas no enteras o sin partes", () => {
    expect(() => repartirCentavos(1.5, 2)).toThrow();
    expect(() => repartirCentavos(10, 0)).toThrow();
  });
});

describe("generarReporteOcupacionIngresos", () => {
  const periodo = { inicio: "2026-03-01", fin: "2026-05-01" };

  it("una reserva que cruza meses se prorratea por noche y los totales no la cuentan dos veces", () => {
    // 28-mar a 3-abr = 6 noches (28,29,30,31 mar + 1,2 abr); 3 centavos no divisibles a propósito.
    const r = res("u1", "2026-03-28", "2026-04-03", fin(100003, { comisionCanalCentavos: 16000, netoCentavos: 84003 }));
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [r] });
    expect(rep.totales.nochesOcupadas).toBe(6);
    expect(rep.totales.ingresoBrutoCentavos).toBe(100003);
    expect(rep.totales.comisionCanalCentavos).toBe(16000);
    expect(rep.totales.netoCentavos).toBe(84003);
    expect(rep.totales.llegadas).toBe(1);
    const mar = rep.porMes.find((m) => m.clave === "2026-03")!;
    const abr = rep.porMes.find((m) => m.clave === "2026-04")!;
    expect(mar.nochesOcupadas).toBe(4);
    expect(abr.nochesOcupadas).toBe(2);
    expect(mar.ingresoBrutoCentavos + abr.ingresoBrutoCentavos).toBe(100003);
    // la llegada cuenta solo en el mes de check-in
    expect(mar.llegadas).toBe(1);
    expect(abr.llegadas).toBe(0);
    // por unidad y por canal es UNA reserva, no dos
    expect(rep.porUnidad[0]!.llegadas).toBe(1);
    expect(rep.porCanal).toHaveLength(1);
    expect(rep.porCanal[0]!.ingresoBrutoCentavos).toBe(100003);
  });

  it("solo cuenta las noches dentro del periodo (reserva que empieza antes del periodo)", () => {
    const r = res("u1", "2026-02-27", "2026-03-03", fin(40000)); // 4 noches: 27,28 feb | 1,2 mar
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [r] });
    expect(rep.totales.nochesOcupadas).toBe(2);
    expect(rep.totales.ingresoBrutoCentavos).toBe(20000);
    expect(rep.totales.llegadas).toBe(0); // el check-in fue fuera del periodo
  });

  it("febrero bisiesto vs no bisiesto: 29-feb existe solo en 2028", () => {
    const r = generarReporteOcupacionIngresos({ periodo: { inicio: "2028-02-01", fin: "2028-03-01" }, moneda: "MXN", unidades: [U1], reservas: [] });
    expect(r.totales.nochesDisponibles).toBe(29);
    const r2 = generarReporteOcupacionIngresos({ periodo: { inicio: "2026-02-01", fin: "2026-03-01" }, moneda: "MXN", unidades: [U1], reservas: [] });
    expect(r2.totales.nochesDisponibles).toBe(28);
  });

  it("cruce de año: 30-dic a 3-ene reparte entre dos meses de años distintos", () => {
    const rep = generarReporteOcupacionIngresos({
      periodo: { inicio: "2026-12-01", fin: "2027-02-01" },
      moneda: "MXN",
      unidades: [U1],
      reservas: [res("u1", "2026-12-30", "2027-01-03", fin(40000))],
    });
    expect(rep.porMes.map((m) => [m.clave, m.nochesOcupadas])).toEqual([["2026-12", 2], ["2027-01", 2]]);
  });

  it("la misma estancia llegada por dos canales (noches solapadas) cuenta una sola vez", () => {
    const a = res("u1", "2026-03-10", "2026-03-14", fin(40000), "airbnb", "a");
    const b = res("u1", "2026-03-10", "2026-03-14", fin(40000), "booking", "b");
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [b, a] });
    expect(rep.totales.nochesOcupadas).toBe(4);
    expect(rep.totales.ingresoBrutoCentavos).toBe(40000);
    expect(rep.totales.llegadas).toBe(1);
    expect(rep.advertencias.nochesSolapadasOmitidas).toBe(4);
    // gana la de creación más antigua (a), independiente del orden de entrada
    expect(rep.porCanal.map((c) => c.clave)).toEqual(["airbnb"]);
  });

  it("el mismo ocupacion_id repetido (JOIN duplicado) cuenta una vez", () => {
    const a = res("u1", "2026-03-10", "2026-03-12", fin(20000), "airbnb", "dup");
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [a, { ...a }] });
    expect(rep.totales.ingresoBrutoCentavos).toBe(20000);
    expect(rep.advertencias.reservasDuplicadasOmitidas).toBe(1);
  });

  it("reservas contiguas (checkout = checkin) no se solapan", () => {
    const rep = generarReporteOcupacionIngresos({
      periodo,
      moneda: "MXN",
      unidades: [U1],
      reservas: [res("u1", "2026-03-10", "2026-03-12", fin(20000)), res("u1", "2026-03-12", "2026-03-14", fin(30000), "booking")],
    });
    expect(rep.totales.nochesOcupadas).toBe(4);
    expect(rep.advertencias.nochesSolapadasOmitidas).toBe(0);
    expect(rep.totales.ingresoBrutoCentavos).toBe(50000);
  });

  it("ocupación en basis points, ADR half-up y propietario sin asignar", () => {
    const rep = generarReporteOcupacionIngresos({
      periodo: { inicio: "2026-03-01", fin: "2026-03-11" }, // 10 noches
      moneda: "MXN",
      unidades: [U1, U2],
      reservas: [res("u1", "2026-03-01", "2026-03-04", fin(10001)), res("u2", "2026-03-05", "2026-03-07", fin(5000), "manual")],
    });
    expect(rep.totales.nochesDisponibles).toBe(20);
    expect(rep.totales.nochesOcupadas).toBe(5);
    expect(rep.totales.ocupacionBasisPoints).toBe(2500);
    const u1 = rep.porUnidad.find((u) => u.clave === "u1")!;
    expect(u1.ocupacionBasisPoints).toBe(3000);
    expect(u1.adrCentavos).toBe(3334); // 10001/3 = 3333.67 -> 3334
    expect(rep.porPropietario.map((p) => p.etiqueta).sort()).toEqual(["Ana", "Sin propietario"]);
    expect(rep.porCanal.every((c) => c.nochesDisponibles === null && c.ocupacionBasisPoints === null)).toBe(true);
  });

  it("una reserva sin movimiento financiero aporta noches pero no dinero, y se advierte", () => {
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [res("u1", "2026-03-10", "2026-03-12", null)] });
    expect(rep.totales.nochesOcupadas).toBe(2);
    expect(rep.totales.ingresoBrutoCentavos).toBe(0);
    expect(rep.advertencias.reservasSinMovimientoFinanciero).toBe(1);
  });

  it("nunca convierte moneda: un movimiento en USD no suma al reporte MXN", () => {
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [res("u1", "2026-03-10", "2026-03-12", fin(99900, { moneda: "USD" }))] });
    expect(rep.totales.nochesOcupadas).toBe(2);
    expect(rep.totales.ingresoBrutoCentavos).toBe(0);
    expect(rep.advertencias.reservasMonedaDistinta).toBe(1);
  });

  it("ignora reservas de unidades fuera del alcance y rechaza periodos inválidos o enormes", () => {
    const rep = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1], reservas: [res("uX", "2026-03-10", "2026-03-12", fin(1000))] });
    expect(rep.totales.nochesOcupadas).toBe(0);
    expect(() => generarReporteOcupacionIngresos({ periodo: { inicio: "2026-03-05", fin: "2026-03-05" }, moneda: "MXN", unidades: [], reservas: [] })).toThrow(/inválido/);
    expect(() => generarReporteOcupacionIngresos({ periodo: { inicio: "2020-01-01", fin: "2026-01-01" }, moneda: "MXN", unidades: [], reservas: [] })).toThrow(/excede/);
  });

  it("es determinista: el orden de entrada no cambia el resultado", () => {
    const rs = [res("u1", "2026-03-10", "2026-03-12", fin(20000), "airbnb", "x1"), res("u2", "2026-03-11", "2026-03-15", fin(33333), "booking", "x2"), res("u1", "2026-04-01", "2026-04-04", fin(9999), "manual", "x3")];
    const a = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U1, U2], reservas: rs });
    const b = generarReporteOcupacionIngresos({ periodo, moneda: "MXN", unidades: [U2, U1], reservas: [...rs].reverse() });
    expect(b).toEqual(a);
  });
});

describe("mesCalendarioDe", () => {
  it("devuelve [primer día del mes, primer día del siguiente) incluso en diciembre", () => {
    expect(mesCalendarioDe("2026-03-15")).toEqual({ inicio: "2026-03-01", fin: "2026-04-01" });
    expect(mesCalendarioDe("2026-12-31")).toEqual({ inicio: "2026-12-01", fin: "2027-01-01" });
    expect(mesCalendarioDe("2028-02-29")).toEqual({ inicio: "2028-02-01", fin: "2028-03-01" });
  });
});

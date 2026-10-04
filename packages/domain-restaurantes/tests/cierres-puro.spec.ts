// R-42: calculos puros del cierre (fechas de negocio, periodos que el barrido debe asegurar, lectura del JSON de la base).
import { describe, expect, it } from "vitest";
import { diaSemanaIso, fechaNegocioValida, leerCierreDatos, lunesDeSemana, periodosACerrar, pesosEnteros, sumarDiasFecha, variacionPct } from "../src/cierres/index.ts";

describe("fechas de negocio", () => {
  it("valida YYYY-MM-DD reales y rechaza inexistentes", () => {
    expect(fechaNegocioValida("2026-03-10")).toBe(true);
    expect(fechaNegocioValida("2026-02-30")).toBe(false);
    expect(fechaNegocioValida("2026-3-1")).toBe(false);
    expect(fechaNegocioValida("")).toBe(false);
  });
  it("suma dias cruzando mes, anio y bisiesto", () => {
    expect(sumarDiasFecha("2026-03-01", -1)).toBe("2026-02-28");
    expect(sumarDiasFecha("2028-03-01", -1)).toBe("2028-02-29");
    expect(sumarDiasFecha("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("dia ISO y lunes de la semana (2026-03-15 es domingo)", () => {
    expect(diaSemanaIso("2026-03-09")).toBe(1);
    expect(diaSemanaIso("2026-03-15")).toBe(7);
    expect(lunesDeSemana("2026-03-15")).toBe("2026-03-09");
    expect(lunesDeSemana("2026-03-09")).toBe("2026-03-09");
    expect(lunesDeSemana("2026-03-12")).toBe("2026-03-09");
  });
});

describe("periodosACerrar", () => {
  it("nunca incluye hoy y va del mas viejo al mas nuevo", () => {
    // hoy lunes 2026-03-16: ayer domingo 15 => dia 15 y la semana 9..15
    const p = periodosACerrar("2026-03-16", 1);
    expect(p).toEqual([
      { tipo: "dia", fechaInicio: "2026-03-15" },
      { tipo: "semana", fechaInicio: "2026-03-09" },
    ]);
  });
  it("entre semana solo hay dias", () => {
    expect(periodosACerrar("2026-03-12", 2)).toEqual([
      { tipo: "dia", fechaInicio: "2026-03-10" },
      { tipo: "dia", fechaInicio: "2026-03-11" },
    ]);
  });
  it("una ventana de varios dias incluye la semana cuyo domingo cae dentro", () => {
    const p = periodosACerrar("2026-03-18", 5); // 13,14,15,16,17
    expect(p.filter((x) => x.tipo === "semana")).toEqual([{ tipo: "semana", fechaInicio: "2026-03-09" }]);
    expect(p.filter((x) => x.tipo === "dia").map((x) => x.fechaInicio)).toEqual(["2026-03-13", "2026-03-14", "2026-03-15", "2026-03-16", "2026-03-17"]);
  });
  it("acota los dias entre 1 y 14", () => {
    expect(periodosACerrar("2026-03-12", 0).filter((x) => x.tipo === "dia")).toHaveLength(1);
    expect(periodosACerrar("2026-03-12", 999).filter((x) => x.tipo === "dia")).toHaveLength(14);
  });
});

describe("variacionPct y pesosEnteros", () => {
  it("un decimal y null sin base", () => {
    expect(variacionPct(150, 100)).toBe(50);
    expect(variacionPct(80, 100)).toBe(-20);
    expect(variacionPct(10, 0)).toBeNull();
  });
  it("redondea centavos a pesos", () => {
    expect(pesosEnteros(38575)).toBe(386);
    expect(pesosEnteros(0)).toBe(0);
  });
});

describe("leerCierreDatos", () => {
  it("mapea el jsonb de la base y completa los 4 canales", () => {
    const d = leerCierreDatos({
      pedidos: 5, ventas_centavos: 38575, ticket_promedio_centavos: 7715, con_problema: 0, cancelados: 1, cancelados_centavos: 8000,
      no_recogidos: 1, cancelacion_pct: 16.7,
      por_canal: [{ canal: "whatsapp", pedidos: 2, ventas_centavos: 30050, cancelados: 0 }],
      tiempos: { entregados: 2, promedio_min: 45, mediana_min: 45, p90_min: 57 },
      comparativo: { fecha_inicio: "2026-03-03", fecha_fin: "2026-03-03", pedidos: 1, ventas_centavos: 7000 },
    });
    expect(d.pedidos).toBe(5);
    expect(d.porCanal.map((c) => c.canal)).toEqual(["web", "whatsapp", "voice", "admin"]);
    expect(d.porCanal[1]).toEqual({ canal: "whatsapp", pedidos: 2, ventasCentavos: 30050, cancelados: 0 });
    expect(d.porCanal[0]!.pedidos).toBe(0);
    expect(d.tiempos).toEqual({ entregados: 2, promedioMin: 45, medianaMin: 45, p90Min: 57 });
    expect(d.comparativo).toEqual({ fechaInicio: "2026-03-03", fechaFin: "2026-03-03", pedidos: 1, ventasCentavos: 7000 });
    expect(d.porDia).toBeNull();
  });
  it("tolera basura sin reventar: faltantes son 0 y los opcionales null", () => {
    const d = leerCierreDatos(null);
    expect(d.pedidos).toBe(0);
    expect(d.ticketPromedioCentavos).toBeNull();
    expect(d.cancelacionPct).toBeNull();
    expect(d.tiempos.promedioMin).toBeNull();
    expect(d.comparativo).toBeNull();
  });
  it("lee por_dia de la semana", () => {
    const d = leerCierreDatos({ por_dia: [{ fecha: "2026-03-09", pedidos: 2, ventas_centavos: 100 }] });
    expect(d.porDia).toEqual([{ fecha: "2026-03-09", pedidos: 2, ventasCentavos: 100 }]);
  });
});

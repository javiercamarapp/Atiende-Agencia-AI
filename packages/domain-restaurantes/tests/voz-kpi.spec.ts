// Capa pura de KPI/alertas de voz (R-13): totales, porcentajes con denominador cero, costo sin tipo de cambio,
// dia local (cruce de medianoche con zona horaria), rango del mes, validacion de umbrales y evaluacion de alertas.
import { describe, expect, it } from "vitest";
import { InMemoryVozKpiRepository, diaVacio, evaluarAlertasDia, diaLocalSucursal, rangoDelMes, resumirKpis, totalizarDias, validarUmbrales, VOZ_UMBRALES_POR_DEFECTO, VozNoDisponibleError } from "../src/index.ts";
import type { VozKpiDia } from "../src/index.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";

function dia(fecha: string, parcial: Partial<VozKpiDia> = {}): VozKpiDia {
  return { ...diaVacio(fecha), ...parcial };
}

describe("totalizarDias", () => {
  it("sin datos: ceros honestos, porcentajes null (nunca 0%), p95 null", () => {
    const t = totalizarDias([diaVacio("2026-03-09"), diaVacio("2026-03-10")]);
    expect(t).toMatchObject({ llamadas: 0, tasaResolucionPct: null, tasaHandoffPct: null, tasaAbandonoPct: null, tasaErrorPct: null, duracionPromedioS: null, toolP95PeorDiaMs: null, costoCentavosMxn: 0, costoCompleto: true, costoPorLlamadaCentavosMxn: null });
  });

  it("suma dias y calcula resolucion / handoff / abandono sobre llamadas CERRADAS", () => {
    const t = totalizarDias([
      dia("2026-03-10", { llamadas: 5, llamadasCerradas: 4, pedidosVoz: 2, escaladas: 1, abandonadas: 1, duracionTotalS: 400, toolP95Ms: 300, toolCalls: 10 }),
      dia("2026-03-11", { llamadas: 1, llamadasCerradas: 1, pedidosVoz: 1, duracionTotalS: 60, toolP95Ms: 900, toolCalls: 2 }),
    ]);
    expect(t.llamadas).toBe(6);
    expect(t.tasaResolucionPct).toBe(60); // 3 / 5
    expect(t.tasaHandoffPct).toBe(20); // 1 / 5
    expect(t.tasaAbandonoPct).toBe(20);
    expect(t.duracionPromedioS).toBe(92); // 460 / 5 = 92
    expect(t.toolP95PeorDiaMs).toBe(900);
    expect(t.toolCalls).toBe(12);
  });

  it("tasa de error: errores / llamadas con tope 100", () => {
    expect(totalizarDias([dia("2026-03-10", { llamadas: 4, erroresProveedor: 1 })]).tasaErrorPct).toBe(25);
    expect(totalizarDias([dia("2026-03-10", { llamadas: 2, erroresProveedor: 9 })]).tasaErrorPct).toBe(100);
    expect(totalizarDias([dia("2026-03-10", { llamadas: 0, erroresProveedor: 3 })]).tasaErrorPct).toBeNull();
  });

  it("costo en centavos enteros: suma los dias con tipo de cambio y marca incompleto si falta alguno con gasto", () => {
    const completo = totalizarDias([
      dia("2026-03-10", { llamadas: 2, costoVozMicroUsd: 1_500_000, costoTelefoniaMicroUsd: 500_000, costoTotalCentavosMxn: 4000 }),
      dia("2026-03-11", { llamadas: 1, costoVozMicroUsd: 200_000, costoTotalCentavosMxn: 400 }),
    ]);
    expect(completo).toMatchObject({ costoCentavosMxn: 4400, costoCompleto: true, costoPorLlamadaCentavosMxn: 1467 });
    expect(Number.isInteger(completo.costoPorLlamadaCentavosMxn)).toBe(true);

    const faltaFx = totalizarDias([
      dia("2026-03-10", { llamadas: 2, costoVozMicroUsd: 1_500_000, costoTotalCentavosMxn: 3000 }),
      dia("2026-02-28", { llamadas: 1, costoVozMicroUsd: 200_000, costoTotalCentavosMxn: null }),
    ]);
    expect(faltaFx).toMatchObject({ costoCentavosMxn: 3000, costoCompleto: false });

    const sinFxNinguno = totalizarDias([dia("2026-02-28", { llamadas: 1, costoVozMicroUsd: 200_000, costoTotalCentavosMxn: null })]);
    expect(sinFxNinguno).toMatchObject({ costoCentavosMxn: null, costoCompleto: false });
  });

  it("LLM de la organizacion: null si ningun dia lo trae (sin alcance), suma si lo trae", () => {
    expect(totalizarDias([dia("2026-03-10")]).costoLlmOrgCentavosMxn).toBeNull();
    expect(totalizarDias([dia("2026-03-10", { costoLlmOrgMicroUsd: 3_000_000, costoLlmOrgCentavosMxn: 6000 }), dia("2026-03-11", { costoLlmOrgMicroUsd: 0, costoLlmOrgCentavosMxn: 0 })])).toMatchObject({ costoLlmOrgMicroUsd: 3_000_000, costoLlmOrgCentavosMxn: 6000 });
  });
});

describe("resumirKpis", () => {
  it("separa el dia de hoy del mes completo", () => {
    const r = resumirKpis([dia("2026-03-09", { llamadas: 3 }), dia("2026-03-10", { llamadas: 2 })], "2026-03-10", "America/Mexico_City");
    expect(r.diaDeHoy.llamadas).toBe(2);
    expect(r.mes.llamadas).toBe(5);
    expect(r.mes.dias).toBe(2);
  });
  it("hoy sin fila: el dia de hoy queda en ceros y no inventa llamadas", () => {
    const r = resumirKpis([dia("2026-03-09", { llamadas: 3 })], "2026-03-10", "America/Mexico_City");
    expect(r.diaDeHoy.dias).toBe(0);
    expect(r.diaDeHoy.llamadas).toBe(0);
  });
});

describe("diaLocalSucursal / rangoDelMes (dia de la sucursal, cruce de medianoche)", () => {
  it("el mismo instante cae en dias distintos segun la zona de la sucursal", () => {
    const instante = new Date("2026-03-11T05:30:00Z"); // 23:30 del dia 10 en Mexico (UTC-6)
    expect(diaLocalSucursal(instante, "America/Mexico_City").fecha).toBe("2026-03-10");
    expect(diaLocalSucursal(instante, "Pacific/Auckland").fecha).toBe("2026-03-11"); // 18:30 del dia 11 (UTC+13)
    expect(diaLocalSucursal(new Date("2026-03-11T06:00:00Z"), "America/Mexico_City").fecha).toBe("2026-03-11"); // 00:00 exacto
  });
  it("zona vacia o invalida cae a America/Mexico_City", () => {
    const instante = new Date("2026-03-11T05:30:00Z");
    expect(diaLocalSucursal(instante, null)).toEqual({ fecha: "2026-03-10", zonaHoraria: "America/Mexico_City" });
    expect(diaLocalSucursal(instante, "Marte/Fobos")).toEqual({ fecha: "2026-03-10", zonaHoraria: "America/Mexico_City" });
  });
  it("el rango del mes va del dia 1 a hoy", () => {
    expect(rangoDelMes("2026-03-10")).toEqual({ desde: "2026-03-01", hasta: "2026-03-10" });
    expect(rangoDelMes("2026-12-31")).toEqual({ desde: "2026-12-01", hasta: "2026-12-31" });
  });
});

describe("evaluarAlertasDia", () => {
  const umbrales = { umbralCostoDiaCentavosMxn: 8000, umbralTasaErrorPct: 40, minLlamadasTasaError: 5 };
  it("dispara por costo al llegar al umbral (>=) y solo con tipo de cambio", () => {
    expect(evaluarAlertasDia(umbrales, dia("2026-03-10", { costoTotalCentavosMxn: 8000 }))).toEqual([{ fecha: "2026-03-10", tipo: "costo_dia", valor: 8000, umbral: 8000 }]);
    expect(evaluarAlertasDia(umbrales, dia("2026-03-10", { costoTotalCentavosMxn: 7999 }))).toEqual([]);
    expect(evaluarAlertasDia(umbrales, dia("2026-03-10", { costoTotalCentavosMxn: null }))).toEqual([]);
  });
  it("dispara por tasa de error solo con el volumen minimo de llamadas", () => {
    expect(evaluarAlertasDia(umbrales, dia("2026-03-10", { llamadas: 4, erroresProveedor: 4 }))).toEqual([]);
    expect(evaluarAlertasDia(umbrales, dia("2026-03-10", { llamadas: 6, erroresProveedor: 3 }))).toEqual([{ fecha: "2026-03-10", tipo: "tasa_error", valor: 50, umbral: 40 }]);
    expect(evaluarAlertasDia(umbrales, dia("2026-03-10", { llamadas: 6, erroresProveedor: 2 }))).toEqual([]);
  });
  it("umbral null = alerta apagada", () => {
    expect(evaluarAlertasDia({ umbralCostoDiaCentavosMxn: null, umbralTasaErrorPct: null, minLlamadasTasaError: 1 }, dia("2026-03-10", { llamadas: 9, erroresProveedor: 9, costoTotalCentavosMxn: 99999 }))).toEqual([]);
  });
});

describe("validarUmbrales", () => {
  it("acepta valores validos y null", () => {
    expect(validarUmbrales({ umbralCostoDiaCentavosMxn: 5000, umbralTasaErrorPct: 30, minLlamadasTasaError: 5 })).toEqual([]);
    expect(validarUmbrales({ umbralCostoDiaCentavosMxn: null, umbralTasaErrorPct: null, minLlamadasTasaError: 1 })).toEqual([]);
  });
  it("rechaza decimales, cero, fuera de rango y tipos incorrectos", () => {
    expect(validarUmbrales({ umbralCostoDiaCentavosMxn: 10.5, umbralTasaErrorPct: 0, minLlamadasTasaError: 0 })).toHaveLength(3);
    expect(validarUmbrales({ umbralCostoDiaCentavosMxn: "100", umbralTasaErrorPct: 101, minLlamadasTasaError: 1001 })).toHaveLength(3);
    expect(validarUmbrales({ umbralCostoDiaCentavosMxn: undefined, umbralTasaErrorPct: undefined, minLlamadasTasaError: undefined })).toHaveLength(3);
  });
});

describe("InMemoryVozKpiRepository", () => {
  it("rellena con ceros los dias sin datos y no mezcla sucursales ni organizaciones", async () => {
    const repo = new InMemoryVozKpiRepository();
    repo.dias.set(`${ORG}:${PROP}`, [dia("2026-03-10", { llamadas: 3 })]);
    const propio = await repo.getKpisDiarios(ORG, PROP, "2026-03-09", "2026-03-11");
    expect(propio.valor.map((d) => d.llamadas)).toEqual([0, 3, 0]);
    const ajeno = await repo.getKpisDiarios("00000000-0000-4000-8000-0000000000b2", PROP, "2026-03-09", "2026-03-11");
    expect(ajeno.valor.map((d) => d.llamadas)).toEqual([0, 0, 0]);
  });

  it("evaluarAlertas: la primera vez la marca nueva y la segunda no la duplica", async () => {
    const repo = new InMemoryVozKpiRepository();
    repo.dias.set(`${ORG}:${PROP}`, [dia("2026-03-10", { llamadas: 6, erroresProveedor: 3, costoTotalCentavosMxn: 10000 })]);
    expect((await repo.evaluarAlertas(ORG, PROP)).valor).toEqual([]); // sin umbrales
    await repo.upsertUmbrales(ORG, PROP, ORG, { umbralCostoDiaCentavosMxn: 8000, umbralTasaErrorPct: 40, minLlamadasTasaError: 5 });
    const primera = (await repo.evaluarAlertas(ORG, PROP)).valor;
    expect(primera.map((a) => [a.tipo, a.nueva])).toEqual([["costo_dia", true], ["tasa_error", true]]);
    const segunda = (await repo.evaluarAlertas(ORG, PROP)).valor;
    expect(segunda.map((a) => [a.tipo, a.nueva])).toEqual([["costo_dia", false], ["tasa_error", false]]);
    expect((await repo.listAlertas(ORG, PROP, 10)).valor).toHaveLength(2);
  });

  it("base sin migrar: lecturas -> no disponible, escritura -> VozNoDisponibleError", async () => {
    const repo = new InMemoryVozKpiRepository();
    repo.disponible = false;
    expect(await repo.getKpisDiarios(ORG, PROP, "2026-03-10", "2026-03-10")).toEqual({ disponible: false, valor: [] });
    expect(await repo.getUmbrales(PROP)).toEqual({ disponible: false, valor: VOZ_UMBRALES_POR_DEFECTO });
    await expect(repo.upsertUmbrales(ORG, PROP, ORG, { umbralCostoDiaCentavosMxn: null, umbralTasaErrorPct: null, minLlamadasTasaError: 5 })).rejects.toBeInstanceOf(VozNoDisponibleError);
  });
});

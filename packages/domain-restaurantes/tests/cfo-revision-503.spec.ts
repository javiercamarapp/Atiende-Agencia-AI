// CFO-04 · correcciones de la revisión de #503: minutos con decimales, umbrales exactos (sin porcentajes redondeados),
// modo de comandas independiente del orden y límites varios (cobertura SR parcial, PII, topes, formato).
import { describe, expect, it } from "vitest";
import { consolidar, verificarAditividad } from "../src/cfo/consolidar.ts";
import { columnaDe, construirEstadoResultados } from "../src/cfo/estado-resultados.ts";
import { cuadreSr, entregaPromedioMin, minutosACapturaSr, sumarAgente, sumarComandas, sumarVentas } from "../src/cfo/formulas.ts";
import { detectarHallazgos, type EntradaHallazgos, type MetricasSucursalHallazgos } from "../src/cfo/hallazgos.ts";
import { narrarResumen, type KpisResumen } from "../src/cfo/narrativa.ts";
import { esColumnaPersonal, MAX_RENGLONES_SR, normalizarExportSr } from "../src/cfo/sr-normalizar.ts";
import { CFO_CONFIG_POR_DEFECTO as C, type FilaAgenteDiario, type FilaComandasPos, type FilaSrResumen, type FilaVentasDiarias } from "../src/cfo/tipos.ts";
import { centesimas, formatoCentavos, formatoPesos, numericoSql, sumaDecimal2 } from "../src/cfo/util.ts";
import { generarDatasetSintetico, mulberry32 } from "./fixtures/cfo-pm-sintetico.ts";

const A = "suc-a";
const B = "suc-b";
const CC = "suc-c";

function vf(p: Partial<FilaVentasDiarias> = {}): FilaVentasDiarias {
  return {
    propertyId: A, diaNegocio: "2026-09-15", canal: "domicilio", source: "voice", paymentMethod: "efectivo", pedidos: 100, brutaCentavos: 3_200_000, descPromoCentavos: 0, descCompCentavos: 0,
    netaCentavos: 3_200_000, propinaCentavos: 0, cancelados: 2, canceladosCentavos: 0, noRecogidos: 0, noRecogidosCentavos: 0, reposiciones: 0, reposicionUnidades: 0, entregados: 100,
    entregaMinSuma: 4000, entregaTarde: 5, ...p,
  };
}
function ag(p: Partial<FilaAgenteDiario> = {}): FilaAgenteDiario {
  return {
    propertyId: A, diaNegocio: "2026-09-15", waConversacionesNuevas: 10000, waConPedido: 5000, waConHandoff: 0, waHandoffs: 0, vozLlamadas: 0, vozPedidoCreado: 0, vozEscalado: 0, vozAbandonado: 0,
    costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoMetaMicroUsd: null, costoLlmMicroUsd: null, costoVozCentavos: 1, costoTelefoniaCentavos: 0, costoMetaCentavos: null, costoLlmCentavos: null, metaEventos: 0, mxnPorUsd: null, ...p,
  };
}
function sana(id = A, p: Partial<MetricasSucursalHallazgos> = {}): MetricasSucursalHallazgos {
  const v = sumarVentas([vf({ propertyId: id })]);
  const a = sumarAgente([ag({ propertyId: id })]);
  return {
    propertyId: id, actual: v, base4Semanas: v, anterior: v, cortesiasCentavos: 0, cortesiasBase4SemanasCentavos: 0, agente: a, agenteBase4Semanas: a, costoAgenteCentavos: 100,
    costoAgenteBase4SemanasCentavos: 100, descuentoPctP90Historico: null, entregaP90Min: 50, frecuentesDormidos: null, agotados: [], comandas: null, escalacionesPorFranja: [], cuadreSr: null, ...p,
  };
}
const entrada = (m: MetricasSucursalHallazgos[]): EntradaHallazgos => ({
  ahora: new Date("2026-09-15T18:00:00Z"), periodo: { desde: "2026-09-15", hasta: "2026-09-15" }, sucursales: [{ propertyId: A, nombre: "Altabrisa" }, { propertyId: B, nombre: "Pensiones" }, { propertyId: CC, nombre: "Victory Platz" }], metricas: m,
});
const tipos = (m: MetricasSucursalHallazgos[], id = A): string[] => detectarHallazgos(entrada(m), C).filter((h) => h.propertyId === id).map((h) => h.tipo);

describe("1. minutos con decimales (numeric con round(..., 2) de la SQL)", () => {
  it("promedio de entrega: 100.99 min en 3 entregas = 33.7 (antes truncaba a 33.3)", () => {
    expect(entregaPromedioMin({ entregaMinSuma: 100.99, entregados: 3 }).valor).toBe(33.7);
    expect(minutosACapturaSr({ minACapturaSuma: 100.99, capturadasConTiempo: 3 }).valor).toBe(33.7);
    expect(entregaPromedioMin({ entregaMinSuma: 0.05, entregados: 1 }).valor).toBe(0.1);
    expect(entregaPromedioMin({ entregaMinSuma: 10, entregados: 0 }).valor).toBeNull();
  });
  it("sumarVentas suma minutos sin error de flotante (0.1 + 0.2 = 0.3)", () => {
    expect(sumarVentas([vf({ entregaMinSuma: 0.1 }), vf({ entregaMinSuma: 0.2 })]).entregaMinSuma).toBe(0.3);
    expect(sumaDecimal2([0.1, 0.2, 0.3, null])).toBe(0.6);
    expect(centesimas(100.99)).toBe(10099);
  });
  it("consolidar y verificarAditividad con minutos decimales: ya no lanzan (antes 159 de 300 casos fallaban)", () => {
    const rnd = mulberry32(503);
    for (let caso = 0; caso < 300; caso++) {
      const filas = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => ({
        propertyId: rnd() < 0.15 ? null : `S${Math.floor(rnd() * 5)}`, entregaMinSuma: Math.round(rnd() * 100_000) / 100, entregados: Math.floor(rnd() * 50),
      }));
      const c = consolidar(filas, { propertyId: "propertyId" }, ["entregaMinSuma", "entregados"]);
      expect(() => verificarAditividad(c)).not.toThrow();
      expect(Math.round((c.total.valores.entregaMinSuma ?? 0) * 100)).toBe(filas.reduce((s, f) => s + Math.round(f.entregaMinSuma * 100), 0));
    }
  });
  it("el caso del revisor: total 7801.7 con sumandos que en flotante dan 7801.699999999999", () => {
    const filas = [{ propertyId: "A", m: 4000.1 }, { propertyId: "A", m: 1800.7 }, { propertyId: "B", m: 2000.9 }];
    const c = consolidar(filas, { propertyId: "propertyId" }, ["m"]);
    expect(c.total.valores.m).toBe(7801.7);
  });
  it("el dataset sintético ya trae minutos con decimales y se consolida exacto", () => {
    const d = generarDatasetSintetico();
    expect(d.ventasDiarias.some((f) => !Number.isInteger(f.entregaMinSuma))).toBe(true);
    const c = consolidar(d.ventasDiarias, { propertyId: "propertyId" }, ["entregaMinSuma", "entregados", "entregaTarde"]);
    expect(() => verificarAditividad(c)).not.toThrow();
    expect(sumarVentas(d.ventasDiarias).entregaMinSuma).toBe(c.total.valores.entregaMinSuma);
  });
  it("numericoSql convierte el string de node-postgres", () => {
    expect(numericoSql("100.99")).toBe(100.99);
    expect(numericoSql(null)).toBeNull();
    expect(numericoSql("")).toBeNull();
    expect(() => numericoSql("abc")).toThrow(TypeError);
  });
});

describe("2. umbrales exactos: nada se compara contra porcentajes ya redondeados a 1 decimal", () => {
  it("cierre_agente_bajo: 9.96 pp NO dispara; 10.00 pp sí", () => {
    const base = sumarAgente([ag({ waConversacionesNuevas: 10000, waConPedido: 5000 })]);
    const con = (n: number) => sana(A, { agenteBase4Semanas: base, agente: sumarAgente([ag({ waConversacionesNuevas: 10000, waConPedido: n })]) });
    expect(tipos([con(4004)])).not.toContain("cierre_agente_bajo"); // 40.04 %: Δ 9.96
    expect(tipos([con(4001)])).not.toContain("cierre_agente_bajo");
    expect(tipos([con(4000)])).toContain("cierre_agente_bajo"); // Δ 10.00
    expect(tipos([con(3999)])).toContain("cierre_agente_bajo");
  });
  it("participacion_cae: Δ 4.91 pp NO dispara; 5.00 pp sí", () => {
    const sucs = (actualA: number) => [
      sana(A, { actual: sumarVentas([vf({ propertyId: A, netaCentavos: actualA, brutaCentavos: actualA })]), anterior: sumarVentas([vf({ propertyId: A, netaCentavos: 3005, brutaCentavos: 3005 })]), base4Semanas: null }),
      sana(B, { actual: sumarVentas([vf({ propertyId: B, netaCentavos: 10000 - actualA, brutaCentavos: 10000 - actualA })]), anterior: sumarVentas([vf({ propertyId: B, netaCentavos: 6995, brutaCentavos: 6995 })]), base4Semanas: null }),
    ];
    expect(tipos(sucs(2514))).not.toContain("participacion_cae"); // 30.05 -> 25.14
    expect(tipos(sucs(2506))).not.toContain("participacion_cae"); // Δ 4.99
    expect(tipos(sucs(2505))).toContain("participacion_cae"); // Δ 5.00
    expect(tipos(sucs(2504))).toContain("participacion_cae");
  });
  it("comandas_sin_capturar: 94.95 % SÍ dispara (antes redondeaba a 95.0); 95.00 % no", () => {
    const cm = (cap: number): FilaComandasPos => ({
      propertyId: A, diaNegocio: "2026-09-15", modo: "sombra", encoladas: 2000, confirmadas: 0, capturadasManual: cap, capturaManualPendientes: 0, fallidas: 0, pendientesEnviadas: 0,
      minACapturaSuma: 0, capturadasConTiempo: 0, vencidasUmbral: 0, conFolioPos: 0, conFolioDeclarado: 0,
    });
    expect(tipos([sana(A, { comandas: sumarComandas([cm(1899)]) })])).toContain("comandas_sin_capturar");
    expect(tipos([sana(A, { comandas: sumarComandas([cm(1900)]) })])).not.toContain("comandas_sin_capturar");
    expect(tipos([sana(A, { comandas: sumarComandas([cm(1901)]) })])).not.toContain("comandas_sin_capturar");
  });
  it("cuadreSr: 1.04 % es ámbar (no verde); los bordes exactos y ±1 centavo", () => {
    const sem = (dif: number) => cuadreSr({ nuestroCentavos: 100_000 + dif, srCentavos: 100_000 }, C).semaforo;
    expect(sem(1040)).toBe("ambar");
    expect(sem(1000)).toBe("verde"); // 1.00 % y $10
    expect(sem(1001)).toBe("ambar");
    expect(sem(-1001)).toBe("ambar");
    expect(sem(3000)).toBe("ambar"); // 3.00 %
    expect(sem(3001)).toBe("rojo");
    // borde de $50: 1 % de $5,000.00 = $50.00
    const grande = (dif: number) => cuadreSr({ nuestroCentavos: 500_000 + dif, srCentavos: 500_000 }, C).semaforo;
    expect(grande(5000)).toBe("verde"); // 1.00 % exacto y $50.00
    expect(grande(5001)).toBe("ambar");
    expect(cuadreSr({ nuestroCentavos: 100_000, srCentavos: 101_040 }, C).diferenciaPct).toBe(1); // se muestra 1, pero el semáforo usa la fracción exacta
  });
  it("cancelacion_alta: 2 × la mediana exacta dispara aunque los % redondeados no lo parezcan", () => {
    const suc = (id: string, canc: number, ped: number) => sana(id, { actual: sumarVentas([vf({ propertyId: id, pedidos: ped, cancelados: canc })]), base4Semanas: null });
    // mediana = B = 4/101 (3.96 %); A = 8/101 = 2 × mediana EXACTA (7.92 % vs 2 × 3.96 = 7.92)
    expect(tipos([suc(A, 8, 93), suc(B, 4, 97), suc(CC, 2, 98)])).toContain("cancelacion_alta");
    expect(tipos([suc(A, 8, 94), suc(B, 4, 97), suc(CC, 2, 98)])).not.toContain("cancelacion_alta"); // 8/102 < 8/101
    expect(tipos([suc(A, 7, 94), suc(B, 4, 97), suc(CC, 2, 98)])).not.toContain("cancelacion_alta");
  });
  it("mediana de cancelación con número par de sucursales (promedio de las dos centrales)", () => {
    const suc = (id: string, canc: number, ped: number) => sana(id, { actual: sumarVentas([vf({ propertyId: id, pedidos: ped, cancelados: canc })]), base4Semanas: null });
    // fracciones: 2 %, 4 %, 6 %, 20 % -> mediana (4 + 6)/2 = 5 % ; umbral 10 %
    const m = [suc("s1", 2, 98), suc("s2", 4, 96), suc("s3", 6, 94), suc("s4", 10, 90)];
    expect(tipos(m, "s4")).toContain("cancelacion_alta"); // 10 % ≥ 2 × 5 %
    expect(tipos([suc("s1", 2, 98), suc("s2", 4, 96), suc("s3", 6, 94), suc("s4", 9, 91)], "s4")).not.toContain("cancelacion_alta");
  });
  it("descuento_fuera_rango: 8.001 % dispara y 8.000 % no; un p90 histórico de 0 no es un tope", () => {
    const con = (desc: number, extra: Partial<MetricasSucursalHallazgos> = {}) => sana(A, { actual: sumarVentas([vf({ brutaCentavos: 1_000_000, descPromoCentavos: desc, netaCentavos: 1_000_000 - desc })]), base4Semanas: null, ...extra });
    expect(tipos([con(80_000)])).not.toContain("descuento_fuera_rango");
    expect(tipos([con(80_010)])).toContain("descuento_fuera_rango");
    expect(detectarHallazgos(entrada([con(80_010)]), C).find((h) => h.tipo === "descuento_fuera_rango")!.impactoCentavos).toBe(10);
    expect(tipos([con(10_000, { descuentoPctP90Historico: 0 })])).not.toContain("descuento_fuera_rango");
  });
});

describe("3. el modo de las comandas no depende del orden de las filas", () => {
  const f = (modo: string, propertyId: string, enc: number, cap: number): FilaComandasPos => ({
    propertyId, diaNegocio: "2026-09-15", modo, encoladas: enc, confirmadas: 0, capturadasManual: cap, capturaManualPendientes: 0, fallidas: 0, pendientesEnviadas: 0, minACapturaSuma: 10.37,
    capturadasConTiempo: 1, vencidasUmbral: 0, conFolioPos: 0, conFolioDeclarado: 0,
  });
  const permutaciones = <T,>(xs: T[]): T[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutaciones([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])));
  it("las 6 permutaciones de [apagado, sombra, activo] dan lo mismo", () => {
    const filas = [f("apagado", "a", 0, 0), f("sombra", "b", 100, 90), f("activo", "c", 100, 100)];
    const ref = sumarComandas(filas);
    expect(ref.modo).toBe("activo");
    expect(ref.encoladas).toBe(200);
    expect(ref.sucursalesEncendidas).toBe(2);
    expect(ref.sucursalesTotal).toBe(3);
    for (const p of permutaciones(filas)) expect(sumarComandas(p)).toEqual(ref);
  });
  it("[apagado, sombra] y [sombra, apagado] coinciden (antes: null vs 100)", () => {
    const a = sumarComandas([f("apagado", "a", 0, 0), f("sombra", "b", 100, 100)]);
    const b = sumarComandas([f("sombra", "b", 100, 100), f("apagado", "a", 0, 0)]);
    expect(a).toEqual(b);
    expect(a.modo).toBe("sombra");
  });
  it("una fila apagada con datos residuales no contamina la tasa; todo apagado = apagado", () => {
    expect(sumarComandas([f("apagado", "a", 50, 0), f("sombra", "b", 100, 100)]).encoladas).toBe(100);
    const todo = sumarComandas([f("apagado", "a", 0, 0), f("apagado", "b", 0, 0)]);
    expect(todo.modo).toBe("apagado");
    expect(todo.sucursalesEncendidas).toBe(0);
    expect(sumarComandas([]).modo).toBe("apagado");
  });
  it("minutos a captura con decimales se suman exactos", () => {
    expect(sumarComandas([f("sombra", "a", 1, 1), f("sombra", "b", 1, 1), f("sombra", "c", 1, 1)]).minACapturaSuma).toBe(31.11);
  });
});

describe("no bloqueantes", () => {
  const kpis = (aporte: number): KpisResumen => ({
    titularOrigen: "agente", periodo: "los últimos 7 días", comparadoContra: "su promedio de las 4 semanas previas", ventasNetas: { cifra: { valor: 100, confianza: "medido", fuente: "t" }, tipo: "centavos" },
    variacionVentas: { cifra: { valor: -18, confianza: "medido", fuente: "t" }, tipo: "pct" }, mayorAporte: { sucursal: "Altabrisa", aportePct: { valor: aporte, confianza: "medido", fuente: "t" } },
  });
  it("narrativa: una sucursal que CRECIÓ (aporte < 0) no «explica la caída»", () => {
    const todas = { propertyIds: ["a", "b"], todas: true, organizacionCompleta: true };
    expect(narrarResumen(kpis(-40), [], todas).texto).not.toContain("explica");
    expect(narrarResumen(kpis(40), [], todas).texto).toContain("Altabrisa explica 40 % [mayor_aporte] de la caída.");
  });

  it("SR con cobertura parcial se rotula y no se vende como comparable con el agente", () => {
    const dias = ["2026-09-01", "2026-09-02", "2026-09-03"];
    const sr = (d: string): FilaSrResumen => ({ propertyId: A, diaNegocio: d, tipoServicio: "comedor", formaPago: "tarjeta", tickets: 1, brutaCentavos: 100, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: 10, ivaCentavos: null, netaCentavos: 100 });
    const er = construirEstadoResultados({
      ventas: dias.map((d) => vf({ diaNegocio: d })), cortesias: [], costosAgente: [], costosCapturados: [], config: C, srResumen: dias.slice(0, 2).map(sr), granularidad: "mes", rango: { desde: "2026-09-01", hasta: "2026-09-03" },
      alcance: { propertyIds: [A], todas: true, organizacionCompleta: true }, coberturaSrMinima: 0.5,
    });
    const col = columnaDe(er.acumulado, A)!;
    expect(col.titular.origen).toBe("softrestaurant");
    expect(col.titular.coberturaParcialSr).toEqual({ diasConDato: 2, diasPeriodo: 3 });
    expect(col.titular.nota).toContain("Cobertura parcial");
    expect(columnaDe(er.acumulado, "total")!.titular.coberturaParcialSr).toEqual({ diasConDato: 2, diasPeriodo: 3 });
    expect(col.memo.propinasTarjeta.valor).toBe(20); // solo propina de renglones de tarjeta
    // cobertura completa: sin rótulo
    const full = construirEstadoResultados({
      ventas: dias.map((d) => vf({ diaNegocio: d })), cortesias: [], costosAgente: [], costosCapturados: [], config: C, srResumen: dias.map(sr), granularidad: "mes", rango: { desde: "2026-09-01", hasta: "2026-09-03" },
      alcance: { propertyIds: [A], todas: true, organizacionCompleta: true },
    });
    expect(columnaDe(full.acumulado, A)!.titular.coberturaParcialSr).toBeNull();
  });

  it("propinas de SR: solo la de tarjeta; sin forma de pago en el archivo es sin dato", () => {
    const dia = "2026-09-01";
    const fila = (forma: string | null, prop: number): FilaSrResumen => ({ propertyId: A, diaNegocio: dia, tipoServicio: "comedor", formaPago: forma, tickets: 1, brutaCentavos: 100, descuentoCentavos: 0, canceladoCentavos: 0, propinaCentavos: prop, ivaCentavos: null, netaCentavos: 100 });
    const mk = (srs: FilaSrResumen[]) => columnaDe(construirEstadoResultados({
      ventas: [vf({ diaNegocio: dia })], cortesias: [], costosAgente: [], costosCapturados: [], config: C, srResumen: srs, granularidad: "dia", rango: { desde: dia, hasta: dia },
      alcance: { propertyIds: [A], todas: true, organizacionCompleta: true },
    }).acumulado, A)!;
    expect(mk([fila("tarjeta", 30), fila("efectivo", 70)]).memo.propinasTarjeta.valor).toBe(30);
    expect(mk([fila(null, 30)]).memo.propinasTarjeta.valor).toBeNull();
  });

  it.each(["Domicilio de entrega", "Telefono1", "Cel", "Razón social", "Cel2", "Teléfono celular", "Correo2", "Dirección fiscal", "Código postal"])("rechaza la columna personal «%s»", (h) => {
    expect(esColumnaPersonal(h)).toBe(true);
  });
  it.each(["Domicilio", "Tipo de servicio", "Total", "Forma de pago", "Cancelada", "Hora cierre"])("no rechaza «%s»", (h) => {
    expect(esColumnaPersonal(h)).toBe(false);
  });

  it("formatoCentavos con no enteros devuelve un guion (nunca «$0.12.7» ni «$NaN.NaN»)", () => {
    expect(formatoCentavos(12.7)).toBe("—");
    expect(formatoCentavos(Number.NaN)).toBe("—");
    expect(formatoCentavos(Infinity)).toBe("—");
    expect(formatoPesos(12.7)).toBe("—");
    expect(formatoCentavos(1270)).toBe("$12.70");
  });

  it("tope de renglones alineado con sr_importar (20,000 cuentas / 2,000 de resumen)", () => {
    expect(MAX_RENGLONES_SR).toEqual({ cuentas: 20000, resumen_servicio: 2000 });
    const cuentas = [["Folio", "Fecha", "Total"], ...Array.from({ length: 20001 }, (_, i) => [String(i), "14/09/2026", "10"])];
    const r = normalizarExportSr({ tabla: cuentas, corte: "01:00" });
    expect(r).toMatchObject({ ok: false, motivo: "demasiados_renglones", maximo: 20000, recibidos: 20001 });
    if (!r.ok && r.motivo === "demasiados_renglones") expect(r.mensaje).toContain("20000");
    expect(normalizarExportSr({ tabla: cuentas.slice(0, 20001), corte: "01:00" })).toMatchObject({ ok: true, aceptados: 20000 });
    const resumen = [["Fecha", "Servicio", "Cuentas", "Total"], ...Array.from({ length: 2001 }, () => ["14/09/2026", "Comedor", "1", "10"])];
    expect(normalizarExportSr({ tabla: resumen, corte: "01:00" })).toMatchObject({ ok: false, motivo: "demasiados_renglones", maximo: 2000 });
    expect(normalizarExportSr({ tabla: resumen.slice(0, 2001), corte: "01:00" })).toMatchObject({ ok: true });
  });
});

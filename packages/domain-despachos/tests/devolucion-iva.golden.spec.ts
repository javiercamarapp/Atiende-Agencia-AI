// Golden-set numérico (Fase 6 despachos, OBLIGATORIO) — compara byte a byte el
// output del motor Python REAL (`b2b_ai/features/devolucion_iva/service.py`,
// capturado en tests/fixtures/golden-devolucion-iva-output.json vía
// tests/fixtures/golden_gen_devolucion_iva.py, corrido contra
// `despachos/.venv/bin/python3`) contra el motor TS nuevo
// (`src/devolucion-iva/calculo.ts`).
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-devolucion-iva-output.json" with { type: "json" };
import {
  generarDiotDevolucionIva,
  ivaAcreditableEfectivamentePagado,
  conciliarFacturasDiot,
  conciliarDiotDeclaracion,
  conciliarDeclaracionSaldo,
  calcularSaldoFavor,
  calcularMontoDevolucion,
  validarCongruenciaDiotCfdiDeclaracion,
  validarClabe,
  sumarDiasHabiles,
  calcularFechaLimiteResolucion,
} from "../src/devolucion-iva/calculo.ts";
import type { DeclaracionMensualIva, DiotEntryIva, FacturaCfdiIva } from "../src/devolucion-iva/types.ts";

function factura(input: { uuid: string; rfcEmisor: string; subtotal: number; iva: number; proporcionalidad?: number; referenciaComplementoPago?: string | null; fecha?: string }): FacturaCfdiIva {
  return {
    uuid: input.uuid,
    rfcEmisor: input.rfcEmisor,
    nombreEmisor: "",
    rfcReceptor: "AAA010101AAA",
    fecha: input.fecha ?? "2026-01-15",
    subtotal: input.subtotal,
    iva: input.iva,
    total: input.subtotal + input.iva,
    tipo: "Ingreso",
    categoria: "acreditable_100",
    proporcionalidad: input.proporcionalidad ?? 1.0,
    referenciaComplementoPago: input.referenciaComplementoPago ?? null,
  };
}

describe("golden: generarDiotDevolucionIva (byte-exacto vs Python real)", () => {
  it("agrupa por rfcEmisor con prorrateo aplicado solo a ivaAcreditable", () => {
    const caso = golden.generar_diot_agrupado;
    const facturas = caso.entrada.map((e) => factura({ uuid: e.uuid, rfcEmisor: e.rfc_emisor, subtotal: e.subtotal, iva: e.iva, proporcionalidad: e.proporcionalidad }));
    const resultado = generarDiotDevolucionIva(facturas);
    expect(resultado.map((r) => ({ rfc_tercero: r.rfcTercero, tipo_operacion: r.tipoOperacion, monto_neto: r.montoNeto, iva_trasladado: r.ivaTrasladado, iva_acreditable: r.ivaAcreditable, folios_fiscales: r.foliosFiscales }))).toEqual(caso.resultado);
  });
});

describe("golden: ivaAcreditableEfectivamentePagado (LIVA Art. 5-III)", () => {
  it("sin REP -> 0", () => {
    const caso = golden.iva_efectivamente_pagado_sin_rep;
    const f = factura({ uuid: "x", rfcEmisor: "X", subtotal: 0, iva: caso.entrada.iva, proporcionalidad: caso.entrada.proporcionalidad, referenciaComplementoPago: caso.entrada.referencia_complemento_pago });
    expect(ivaAcreditableEfectivamentePagado(f)).toBe(caso.resultado);
  });
  it("con REP -> iva*proporcionalidad", () => {
    const caso = golden.iva_efectivamente_pagado_con_rep;
    const f = factura({ uuid: "x", rfcEmisor: "X", subtotal: 0, iva: caso.entrada.iva, proporcionalidad: caso.entrada.proporcionalidad, referenciaComplementoPago: caso.entrada.referencia_complemento_pago });
    expect(ivaAcreditableEfectivamentePagado(f)).toBe(caso.resultado);
  });
});

describe("golden: conciliarFacturasDiot (match/mismatch/missing)", () => {
  it("reproduce match/mismatch/missing del Python real", () => {
    const facturas = [
      factura({ uuid: "cccccccc-0000-0000-0000-000000000001", rfcEmisor: "P1", subtotal: 1000, iva: 160 }),
      factura({ uuid: "cccccccc-0000-0000-0000-000000000002", rfcEmisor: "P1", subtotal: 1000, iva: 160 }),
      factura({ uuid: "cccccccc-0000-0000-0000-000000000003", rfcEmisor: "P1", subtotal: 1000, iva: 160 }),
    ];
    const diot: DiotEntryIva[] = [
      { rfcTercero: "P1", nombre: "", tipoOperacion: "03", montoNeto: 1000, ivaTrasladado: 160, ivaAcreditable: 160, foliosFiscales: ["cccccccc-0000-0000-0000-000000000001"], facturasDetalle: [] },
      { rfcTercero: "P1", nombre: "", tipoOperacion: "03", montoNeto: 1000, ivaTrasladado: 160, ivaAcreditable: 100, foliosFiscales: ["cccccccc-0000-0000-0000-000000000002"], facturasDetalle: [] },
    ];
    const resultado = conciliarFacturasDiot(facturas, diot);
    expect(resultado.map((r) => ({ factura_uuid: r.facturaUuid, diot_match: r.diotMatch, status: r.status }))).toEqual(golden.conciliar_facturas_diot.resultado);
  });
});

describe("golden: conciliarDiotDeclaracion (tolerancia relativa 5%)", () => {
  it.each([
    ["match", 8000, [{ mes: 1, año: 2026, ivaPagado: 8000 }], golden.conciliar_diot_declaracion_match.resultado],
    ["mismatch", 8000, [{ mes: 1, año: 2026, ivaPagado: 5000 }], golden.conciliar_diot_declaracion_mismatch.resultado],
  ])("%s", (_nombre, ivaAcreditable, decls, esperado) => {
    const diot: DiotEntryIva[] = [{ rfcTercero: "P1", nombre: "", tipoOperacion: "03", montoNeto: 0, ivaTrasladado: 0, ivaAcreditable: ivaAcreditable as number, foliosFiscales: [], facturasDetalle: [] }];
    const declaraciones = (decls as { mes: number; año: number; ivaPagado: number }[]).map((d) => ({ mes: d.mes, año: d.año, ivaCobrado: 0, ivaPagado: d.ivaPagado, saldoFavor: 0, saldoContra: 0 }) satisfies DeclaracionMensualIva);
    const resultado = conciliarDiotDeclaracion(diot, declaraciones);
    expect(resultado.map((r) => ({ diot_iva_total: r.diotIvaTotal, declaracion_iva_acreditable: r.declaracionIvaAcreditable, diferencia: r.diferencia, status: r.status }))).toEqual(esperado);
  });

  it("ambos en cero -> match", () => {
    const declaraciones: DeclaracionMensualIva[] = [{ mes: 1, año: 2026, ivaCobrado: 0, ivaPagado: 0, saldoFavor: 0, saldoContra: 0 }];
    const resultado = conciliarDiotDeclaracion([], declaraciones);
    expect(resultado.map((r) => ({ status: r.status }))).toEqual(golden.conciliar_diot_declaracion_ambos_cero.resultado);
  });
});

interface ConciliacionSaldoGolden {
  readonly total_saldo_favor_declared: number;
  readonly total_saldo_contra_declared: number;
  readonly saldo_neto_declaraciones: number;
  readonly saldo_a_favor_solicitado: number;
  readonly diferencia: number;
  readonly consistente: boolean;
}

describe("golden: conciliarDeclaracionSaldo (tolerancia absoluta 0.01)", () => {
  it.each([
    ["consistente", 3000, [{ saldoFavor: 3000 }], golden.conciliar_declaracion_saldo_consistente],
    ["inconsistente", 5000, [{ saldoFavor: 3000 }], golden.conciliar_declaracion_saldo_inconsistente],
  ] satisfies ReadonlyArray<[string, number, { saldoFavor: number }[], ConciliacionSaldoGolden]>)("%s", (_nombre, saldoAFavor, declsRaw, esperado) => {
    const declaraciones = declsRaw.map((d) => ({ mes: 1, año: 2026, ivaCobrado: 0, ivaPagado: 0, saldoFavor: d.saldoFavor, saldoContra: 0 }) satisfies DeclaracionMensualIva);
    const resultado = conciliarDeclaracionSaldo(declaraciones, saldoAFavor);
    expect({
      totalSaldoFavorDeclared: resultado.totalSaldoFavorDeclared,
      totalSaldoContraDeclared: resultado.totalSaldoContraDeclared,
      saldoNetoDeclaraciones: resultado.saldoNetoDeclaraciones,
      saldoAFavorSolicitado: resultado.saldoAFavorSolicitado,
      diferencia: resultado.diferencia,
      consistente: resultado.consistente,
    }).toEqual({
      totalSaldoFavorDeclared: esperado.total_saldo_favor_declared,
      totalSaldoContraDeclared: esperado.total_saldo_contra_declared,
      saldoNetoDeclaraciones: esperado.saldo_neto_declaraciones,
      saldoAFavorSolicitado: esperado.saldo_a_favor_solicitado,
      diferencia: esperado.diferencia,
      consistente: esperado.consistente,
    });
  });
});

describe("golden: calcularSaldoFavor / calcularMontoDevolucion", () => {
  it("calcularSaldoFavor con múltiples declaraciones", () => {
    const declaraciones: DeclaracionMensualIva[] = [
      { mes: 1, año: 2026, ivaCobrado: 0, ivaPagado: 0, saldoFavor: 3000, saldoContra: 0 },
      { mes: 2, año: 2026, ivaCobrado: 0, ivaPagado: 0, saldoFavor: 2000, saldoContra: 0 },
      { mes: 3, año: 2025, ivaCobrado: 0, ivaPagado: 0, saldoFavor: 500, saldoContra: 0 },
    ];
    expect(calcularSaldoFavor(declaraciones)).toBe(golden.calcular_saldo_favor_multiple);

    // "periodo_mas_antiguo" del origen usa min(año) y min(mes) INDEPENDIENTES
    // (no del mismo registro) -- quirk real del Python, verificado con el
    // intérprete: para este set da "2025-01" (año de marzo/2025, mes de
    // enero/2026), una combinación que NO corresponde a ninguna declaración
    // real de la lista. Se replica tal cual (ver comentario de
    // `calcularMontoDevolucion` en calculo.ts).
    const monto = calcularMontoDevolucion(5500, declaraciones);
    expect(monto.periodoMasAntiguo).toBe(golden.calcular_monto_devolucion_multi_periodo.periodo_mas_antiguo);
    expect(monto.montoDevolucionSugerido).toBe(golden.calcular_monto_devolucion_multi_periodo.monto_devolucion_sugerido);
  });

  it("calcularMontoDevolucion de un solo periodo", () => {
    const declaraciones: DeclaracionMensualIva[] = [{ mes: 1, año: 2026, ivaCobrado: 0, ivaPagado: 0, saldoFavor: 10000, saldoContra: 0 }];
    const monto = calcularMontoDevolucion(10000, declaraciones);
    expect(monto.montoDevolucionSugerido).toBe(golden.calcular_monto_devolucion.monto_devolucion_sugerido);
    expect(monto.periodoMasAntiguo).toBe(golden.calcular_monto_devolucion.periodo_mas_antiguo);
    expect(monto.prescripcionVerificada).toBe(golden.calcular_monto_devolucion.prescripcion_verificada);
    expect(monto.factorActualizacion).toBe(golden.calcular_monto_devolucion.factor_actualizacion);
  });
});

interface CongruenciaGolden {
  readonly total_cfdi_iva_acreditable: number;
  readonly total_diot_iva_acreditable: number;
  readonly diferencia_maxima: number;
  readonly congruente: boolean;
  readonly diot_existe: boolean;
}

describe("golden: validarCongruenciaDiotCfdiDeclaracion (umbral $10,001, tolerancia $1.00)", () => {
  it.each([
    ["congruente", true, [{ mes: 3, año: 2026, ivaPagado: 160 }], golden.congruencia_congruente],
    ["sin diot", false, [{ mes: 3, año: 2026, ivaPagado: 160 }], golden.congruencia_sin_diot],
    ["incongruente", true, [{ mes: 3, año: 2026, ivaPagado: 500 }], golden.congruencia_incongruente],
  ] satisfies ReadonlyArray<[string, boolean, { mes: number; año: number; ivaPagado: number }[], CongruenciaGolden]>)("%s", (_nombre, conDiot, declsRaw, esperado) => {
    const facturas: FacturaCfdiIva[] = [factura({ uuid: "dddddddd-0000-0000-0000-000000000001", rfcEmisor: "P1", subtotal: 1000, iva: 160, fecha: "2026-03-10" })];
    const diot = conDiot ? generarDiotDevolucionIva(facturas) : [];
    const declaraciones = declsRaw.map((d) => ({ mes: d.mes, año: d.año, ivaCobrado: 0, ivaPagado: d.ivaPagado, saldoFavor: 0, saldoContra: 0 }) satisfies DeclaracionMensualIva);
    const resultado = validarCongruenciaDiotCfdiDeclaracion("2026-03", facturas, diot, declaraciones);
    expect(resultado.totalCfdiIvaAcreditable).toBe(esperado.total_cfdi_iva_acreditable);
    expect(resultado.totalDiotIvaAcreditable).toBe(esperado.total_diot_iva_acreditable);
    expect(resultado.diferenciaMaxima).toBe(esperado.diferencia_maxima);
    expect(resultado.congruente).toBe(esperado.congruente);
    expect(resultado.diotExiste).toBe(esperado.diot_existe);
  });
});

describe("golden: validarClabe (dígito verificador módulo 10, pesos 3-7-1)", () => {
  it.each([
    ["válida", golden.clabe_valida],
    ["dígito inválido", golden.clabe_digito_invalido],
    ["longitud inválida", golden.clabe_longitud_invalida],
    ["no numérica", golden.clabe_no_numerica],
  ])("%s", (_nombre, caso) => {
    expect(validarClabe(caso.clabe)).toBe(caso.error);
  });
});

describe("golden: días hábiles / Art. 22 CFF (plazo de resolución)", () => {
  it("sumarDiasHabiles desde jueves, 40 días", () => {
    expect(sumarDiasHabiles(golden.dias_habiles_desde_jueves.entrada.fecha_inicio, golden.dias_habiles_desde_jueves.entrada.dias)).toBe(golden.dias_habiles_desde_jueves.resultado);
  });
  it("calcularFechaLimiteResolucion sin dictamen (40 días hábiles)", () => {
    expect(calcularFechaLimiteResolucion(golden.fecha_limite_resolucion_sin_dictamen.entrada.fecha_presentacion, false)).toBe(golden.fecha_limite_resolucion_sin_dictamen.resultado);
  });
  it("calcularFechaLimiteResolucion con dictamen (20 días hábiles)", () => {
    expect(calcularFechaLimiteResolucion(golden.fecha_limite_resolucion_con_dictamen.entrada.fecha_presentacion, true)).toBe(golden.fecha_limite_resolucion_con_dictamen.resultado);
  });
  it("sumarDiasHabiles cruzando un feriado oficial (1-mayo)", () => {
    expect(sumarDiasHabiles(golden.dias_habiles_cruza_feriado.entrada.fecha_inicio, golden.dias_habiles_cruza_feriado.entrada.dias)).toBe(golden.dias_habiles_cruza_feriado.resultado);
  });
});

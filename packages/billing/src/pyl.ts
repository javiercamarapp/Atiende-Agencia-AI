// ═══════════════════════════════════════════════════════════════════════════
// P&L POR VERTICAL Y POR CLIENTE (SA-29, superadmin "CFO")
//
// Funciones PURAS: reciben lo ya calculado por `cost-margin.ts` / `cfo.ts` (ingreso esperado por
// plan, costo en micro-USD por categoria) mas la infraestructura capturada del mes, y devuelven el
// estado de resultados mensual. No leen ni escriben nada.
//
// REGLA DE LA CASA: nunca inventar una cifra. Una fuente faltante sale como `null` con su razon
// (`sin_plan`, `precio_no_configurado`, `sin_foto_del_mes`, `sin_tipo_de_cambio`,
// `sin_infra_capturada`), jamas como 0.
//
// Definiciones (una sola, documentada tambien en la pantalla):
//   * Ingreso reconocido = ingreso ESPERADO del mes segun el plan asignado (el mismo criterio
//     que el MRR del dashboard CFO: organizacion `active` con suscripcion no cancelada). Una
//     organizacion que no esta activa o cancelo su suscripcion reconoce 0 (dato conocido). NO es
//     lo cobrado por Stripe: no hay fuente de pagos (ver `caja` en el dashboard CFO).
//       - mes en curso: el plan vigente hoy; mes cerrado: la foto mensual guardada
//         (`core.billing_snapshot_monthly`); sin foto -> `sin_foto_del_mes` (null).
//   * COGS directo = LLM + voz + WhatsApp + telefonia + otros (SMS, correo, storage), convertido
//     a MXN con el tipo de cambio vigente del mes. Voz, WhatsApp y telefonia son estimados hasta
//     conciliar con la factura del proveedor.
//   * Infra prorrateada = infraestructura compartida capturada para el mes (core.infra_cost_monthly),
//     repartida entre las organizaciones en proporcion a su COGS directo (micro-USD). Reparto en
//     centavos enteros por resto mayor: la suma de las filas es EXACTAMENTE el total capturado.
//     Si el COGS directo del mes es 0 no hay base de reparto: la infra queda "sin asignar".
//   * Margen de contribucion = ingreso - COGS directo.
//   * Margen bruto = ingreso - COGS directo - infra prorrateada (null sin infra capturada).
//   * Los margenes de un agregado (vertical/total) se calculan SOLO sobre las organizaciones con
//     ingreso conocido (manzana con manzana); el costo de las que no tienen ingreso conocido se
//     informa aparte en `costoSinIngresoMxn`.
// ═══════════════════════════════════════════════════════════════════════════
import type { CostoMicroUsd, RazonIngresoNulo } from './cost-margin.ts';
import { microUsdAMxn } from './cost-margin.ts';
import type { FilaCfo, SnapshotMrr } from './cfo.ts';
import { calcularNrr } from './cfo.ts';
import type { NrrCfo } from './cfo.ts';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type RazonIngresoPyl = RazonIngresoNulo | 'sin_foto_del_mes';

/** Una organizacion tal como entra al P&L: ingreso ya resuelto y costo en micro-USD. */
export interface EntradaPylOrg {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  /** Ingreso reconocido del mes en MXN; `null` = no se sabe (ver `ingresoRazon`). */
  readonly ingresoMxn: number | null;
  readonly ingresoRazon: RazonIngresoPyl | null;
  readonly costo: CostoMicroUsd;
}

/** Foto mensual de una organizacion tal como la devuelve la base (con motivo de ingreso nulo). */
export interface FotoIngresoPyl {
  readonly organizationId: string;
  readonly orgStatus: string;
  readonly billingStatus: string | null;
  readonly mrrCentavos: number | null;
  readonly mrrRazon: RazonIngresoNulo | null;
}

/** Ingreso reconocido del mes EN CURSO: el plan vigente hoy. */
export function ingresoReconocidoVivo(f: FilaCfo): Pick<EntradaPylOrg, 'ingresoMxn' | 'ingresoRazon'> {
  if (f.fila.orgStatus !== 'active' || f.billingStatus === 'cancelada') return { ingresoMxn: 0, ingresoRazon: null };
  return { ingresoMxn: f.fila.ingresoMxn, ingresoRazon: f.fila.ingresoRazon };
}

/** Ingreso reconocido de un mes CERRADO: la foto guardada; sin foto no se inventa nada. */
export function ingresoReconocidoFoto(s: FotoIngresoPyl | undefined): Pick<EntradaPylOrg, 'ingresoMxn' | 'ingresoRazon'> {
  if (s === undefined) return { ingresoMxn: null, ingresoRazon: 'sin_foto_del_mes' };
  if (s.orgStatus !== 'active' || s.billingStatus === 'cancelada') return { ingresoMxn: 0, ingresoRazon: null };
  if (s.mrrCentavos === null) return { ingresoMxn: null, ingresoRazon: s.mrrRazon ?? 'precio_no_configurado' };
  return { ingresoMxn: round2(s.mrrCentavos / 100), ingresoRazon: null };
}

export interface CogsMxn {
  readonly llm: number;
  readonly voz: number;
  readonly whatsapp: number;
  readonly telefonia: number;
  readonly otros: number;
}

export interface FilaPyl {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly ingresoMxn: number | null;
  readonly ingresoRazon: RazonIngresoPyl | null;
  /** `null` sin tipo de cambio. */
  readonly cogs: CogsMxn | null;
  readonly cogsDirectoMxn: number | null;
  readonly cogsDirectoMicroUsd: number;
  /** Parte de la infra compartida que le toca; `null` si no se capturo infra del mes. */
  readonly infraMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
}

export interface AgregadoPyl {
  /** Vertical (o `total`). */
  readonly clave: string;
  readonly organizaciones: number;
  /** Organizaciones cuyo ingreso se conoce: solo ellas entran a los margenes. */
  readonly organizacionesConIngreso: number;
  readonly organizacionesSinIngreso: number;
  /** Suma del ingreso de las organizaciones con ingreso conocido. */
  readonly ingresoMxn: number;
  /** COGS directo de TODAS las organizaciones (`null` sin tipo de cambio). */
  readonly cogs: CogsMxn | null;
  readonly cogsDirectoMxn: number | null;
  /** Infra prorrateada de todas las organizaciones del agregado (`null` sin infra capturada). */
  readonly infraMxn: number | null;
  /** Costo (COGS directo + infra) de las organizaciones SIN ingreso conocido; no entra a los margenes. */
  readonly costoSinIngresoMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
}

export type InfraPyl =
  | {
      readonly disponible: true;
      readonly totalMxn: number;
      /** Parte que no se pudo repartir (COGS directo del mes = 0). */
      readonly sinAsignarMxn: number;
      readonly conceptos: readonly { readonly concepto: string; readonly montoMxn: number }[];
    }
  | { readonly disponible: false; readonly razon: 'sin_infra_capturada' };

export type PylMargenRazon = 'sin_tipo_de_cambio' | 'sin_infra_capturada';

export interface Pyl {
  readonly mes: string;
  readonly mxnPorUsd: number | null;
  readonly infra: InfraPyl;
  readonly total: AgregadoPyl;
  readonly porVertical: readonly AgregadoPyl[];
  readonly porCliente: readonly FilaPyl[];
}

export interface EntradaPyl {
  readonly mes: string;
  readonly orgs: readonly EntradaPylOrg[];
  readonly mxnPorUsd: number | null;
  /** Conceptos de infra capturados para el mes, en centavos MXN enteros; `null`/vacio = sin captura. */
  readonly infra: readonly { readonly concepto: string; readonly montoMxnCentavos: number }[] | null;
}

function totalMicro(c: CostoMicroUsd): number {
  return c.llm + c.voz + c.whatsapp + c.telefonia + c.otros;
}

function cogsMxn(c: CostoMicroUsd, fx: number | null): CogsMxn | null {
  if (fx === null) return null;
  const m = (v: number) => microUsdAMxn(v, fx) as number;
  return { llm: m(c.llm), voz: m(c.voz), whatsapp: m(c.whatsapp), telefonia: m(c.telefonia), otros: m(c.otros) };
}

function sumaCogs(lista: readonly CogsMxn[]): CogsMxn {
  const z = { llm: 0, voz: 0, whatsapp: 0, telefonia: 0, otros: 0 };
  for (const c of lista) {
    z.llm += c.llm;
    z.voz += c.voz;
    z.whatsapp += c.whatsapp;
    z.telefonia += c.telefonia;
    z.otros += c.otros;
  }
  return { llm: round2(z.llm), voz: round2(z.voz), whatsapp: round2(z.whatsapp), telefonia: round2(z.telefonia), otros: round2(z.otros) };
}

/**
 * Reparte `totalCentavos` en proporcion a `pesos` (enteros >= 0) por resto mayor: la suma es
 * exactamente `totalCentavos`. Pesos todos 0 -> `null` (no hay base de reparto). BigInt porque
 * micro-USD x centavos desborda 2^53.
 */
export function repartirCentavos(totalCentavos: number, pesos: readonly number[]): readonly number[] | null {
  if (!Number.isInteger(totalCentavos) || totalCentavos < 0) throw new Error(`totalCentavos invalido (${totalCentavos}).`);
  for (const p of pesos) if (!Number.isFinite(p) || p < 0) throw new Error(`peso de reparto invalido (${p}).`);
  const W = pesos.reduce((s, p) => s + BigInt(Math.round(p)), 0n);
  if (W === 0n) return null;
  const T = BigInt(totalCentavos);
  const base = pesos.map((p) => (T * BigInt(Math.round(p))) / W);
  const resto = pesos.map((p, i) => ({ i, r: (T * BigInt(Math.round(p))) % W }));
  const faltan = Number(T - base.reduce((s, b) => s + b, 0n));
  resto.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = base.map((b) => Number(b));
  for (let k = 0; k < faltan; k += 1) out[resto[k % resto.length]!.i]! += 1;
  return out;
}

function pct(parte: number | null, base: number | null): number | null {
  return parte !== null && base !== null && base > 0 ? round2((parte / base) * 100) : null;
}

function agregar(clave: string, filas: readonly FilaPyl[], infraDisponible: boolean, fx: number | null): AgregadoPyl {
  const conIngreso = filas.filter((f) => f.ingresoMxn !== null);
  const sinIngreso = filas.filter((f) => f.ingresoMxn === null);
  const ingreso = round2(conIngreso.reduce((s, f) => s + (f.ingresoMxn as number), 0));
  const cogs = fx === null ? null : sumaCogs(filas.map((f) => f.cogs as CogsMxn));
  const cogsDirecto = cogs === null ? null : round2(cogs.llm + cogs.voz + cogs.whatsapp + cogs.telefonia + cogs.otros);
  const infra = infraDisponible ? round2(filas.reduce((s, f) => s + (f.infraMxn ?? 0), 0)) : null;

  let contribucion: number | null = null;
  let margenBruto: number | null = null;
  let costoSinIngreso: number | null = null;
  if (fx !== null) {
    const cogsComparable = round2(conIngreso.reduce((s, f) => s + (f.cogsDirectoMxn as number), 0));
    const infraComparable = infraDisponible ? round2(conIngreso.reduce((s, f) => s + (f.infraMxn ?? 0), 0)) : null;
    if (conIngreso.length > 0) {
      contribucion = round2(ingreso - cogsComparable);
      margenBruto = infraComparable === null ? null : round2(ingreso - cogsComparable - infraComparable);
    }
    costoSinIngreso = round2(sinIngreso.reduce((s, f) => s + (f.cogsDirectoMxn as number) + (f.infraMxn ?? 0), 0));
  }
  return {
    clave,
    organizaciones: filas.length,
    organizacionesConIngreso: conIngreso.length,
    organizacionesSinIngreso: sinIngreso.length,
    ingresoMxn: ingreso,
    cogs,
    cogsDirectoMxn: cogsDirecto,
    infraMxn: infra,
    costoSinIngresoMxn: costoSinIngreso,
    contribucionMxn: contribucion,
    contribucionPct: pct(contribucion, ingreso),
    margenBrutoMxn: margenBruto,
    margenBrutoPct: pct(margenBruto, ingreso),
  };
}

export function armarPyl(e: EntradaPyl): Pyl {
  const fx = e.mxnPorUsd;
  if (fx !== null && (!Number.isFinite(fx) || fx <= 0)) throw new Error(`mxnPorUsd invalido (${fx}).`);
  // Solo entran organizaciones con algo que reportar: ingreso conocido o costo del mes.
  const orgs = e.orgs.filter((o) => (o.ingresoMxn ?? 0) > 0 || o.ingresoRazon !== null || totalMicro(o.costo) > 0);
  const infraCent = e.infra === null ? [] : e.infra.filter((c) => c.montoMxnCentavos > 0);
  const hayInfra = e.infra !== null && e.infra.length > 0;
  const totalInfraCent = infraCent.reduce((s, c) => s + c.montoMxnCentavos, 0);
  const reparto = hayInfra ? repartirCentavos(totalInfraCent, orgs.map((o) => totalMicro(o.costo))) : null;

  const filas: FilaPyl[] = orgs.map((o, i) => {
    const cogs = cogsMxn(o.costo, fx);
    const cogsDirecto = cogs === null ? null : round2(cogs.llm + cogs.voz + cogs.whatsapp + cogs.telefonia + cogs.otros);
    const infra = !hayInfra ? null : reparto === null ? 0 : round2((reparto[i] as number) / 100);
    const contribucion = o.ingresoMxn !== null && cogsDirecto !== null ? round2(o.ingresoMxn - cogsDirecto) : null;
    const margenBruto = contribucion !== null && infra !== null ? round2(contribucion - infra) : null;
    return {
      organizationId: o.organizationId,
      nombre: o.nombre,
      vertical: o.vertical,
      ingresoMxn: o.ingresoMxn,
      ingresoRazon: o.ingresoRazon,
      cogs,
      cogsDirectoMxn: cogsDirecto,
      cogsDirectoMicroUsd: totalMicro(o.costo),
      infraMxn: infra,
      contribucionMxn: contribucion,
      contribucionPct: pct(contribucion, o.ingresoMxn),
      margenBrutoMxn: margenBruto,
      margenBrutoPct: pct(margenBruto, o.ingresoMxn),
    };
  });

  const porVerticalMap = new Map<string, FilaPyl[]>();
  for (const f of filas) porVerticalMap.set(f.vertical, [...(porVerticalMap.get(f.vertical) ?? []), f]);
  const porVertical = [...porVerticalMap.entries()]
    .map(([v, fs]) => agregar(v, fs, hayInfra, fx))
    .sort((a, b) => b.ingresoMxn - a.ingresoMxn || a.clave.localeCompare(b.clave));
  const porCliente = [...filas].sort((a, b) => (b.ingresoMxn ?? -1) - (a.ingresoMxn ?? -1) || a.nombre.localeCompare(b.nombre) || a.organizationId.localeCompare(b.organizationId));

  const infra: InfraPyl = hayInfra
    ? {
        disponible: true,
        totalMxn: round2(totalInfraCent / 100),
        sinAsignarMxn: reparto === null ? round2(totalInfraCent / 100) : 0,
        conceptos: (e.infra as NonNullable<EntradaPyl['infra']>).map((c) => ({ concepto: c.concepto, montoMxn: round2(c.montoMxnCentavos / 100) })),
      }
    : { disponible: false, razon: 'sin_infra_capturada' };

  return { mes: e.mes, mxnPorUsd: fx, infra, total: agregar('total', filas, hayInfra, fx), porVertical, porCliente };
}

// ───────────────────────────── Comparativo mes contra mes ─────────────────────────────

export interface VariacionPyl {
  readonly actual: number | null;
  readonly previo: number | null;
  readonly deltaMxn: number | null;
  /** `null` si el previo no se conoce o es 0 (no hay base para un porcentaje). */
  readonly deltaPct: number | null;
}

export interface ComparativoAgregado {
  readonly clave: string;
  readonly ingreso: VariacionPyl;
  readonly cogsDirecto: VariacionPyl;
  readonly contribucion: VariacionPyl;
  readonly margenBruto: VariacionPyl;
}

export interface ComparativoPyl {
  readonly mes: string;
  readonly mesPrevio: string;
  readonly total: ComparativoAgregado;
  readonly porVertical: readonly ComparativoAgregado[];
}

function variacion(actual: number | null, previo: number | null): VariacionPyl {
  const delta = actual !== null && previo !== null ? round2(actual - previo) : null;
  return { actual, previo, deltaMxn: delta, deltaPct: delta !== null && previo !== null && previo !== 0 ? round2((delta / Math.abs(previo)) * 100) : null };
}

function compararAgregado(clave: string, a: AgregadoPyl | undefined, p: AgregadoPyl | undefined): ComparativoAgregado {
  return {
    clave,
    ingreso: variacion(a ? a.ingresoMxn : null, p ? p.ingresoMxn : null),
    cogsDirecto: variacion(a ? a.cogsDirectoMxn : null, p ? p.cogsDirectoMxn : null),
    contribucion: variacion(a ? a.contribucionMxn : null, p ? p.contribucionMxn : null),
    margenBruto: variacion(a ? a.margenBrutoMxn : null, p ? p.margenBrutoMxn : null),
  };
}

/** Compara dos P&L. Una vertical que existe en un solo mes tiene `null` del otro lado, jamas 0. */
export function compararPyl(actual: Pyl, previo: Pyl): ComparativoPyl {
  const claves = new Set([...actual.porVertical.map((v) => v.clave), ...previo.porVertical.map((v) => v.clave)]);
  const a = new Map(actual.porVertical.map((v) => [v.clave, v]));
  const p = new Map(previo.porVertical.map((v) => [v.clave, v]));
  return {
    mes: actual.mes,
    mesPrevio: previo.mes,
    total: compararAgregado('total', actual.total, previo.total),
    porVertical: [...claves].sort().map((k) => compararAgregado(k, a.get(k), p.get(k))),
  };
}

// ───────────────────────────── Movimiento de MRR por vertical (SA-05) ─────────────────────────────

export interface SnapshotConVertical extends SnapshotMrr {
  readonly vertical: string;
}

export interface MovimientoMrrVertical {
  readonly vertical: string;
  readonly nrr: NrrCfo;
}

/** NRR/expansion/contraccion/churn por vertical: la misma `calcularNrr` del dashboard, filtrada. */
export function movimientoMrrPorVertical(previo: readonly SnapshotConVertical[] | null, actual: readonly SnapshotConVertical[]): readonly MovimientoMrrVertical[] {
  const verticales = new Set([...actual.map((s) => s.vertical), ...(previo ?? []).map((s) => s.vertical)]);
  return [...verticales].sort().map((vertical) => ({
    vertical,
    nrr: calcularNrr(previo === null ? null : previo.filter((s) => s.vertical === vertical), actual.filter((s) => s.vertical === vertical)),
  }));
}

// ───────────────────────────── CSV ─────────────────────────────

export type NivelPylCsv = 'vertical' | 'cliente';

/** Neutraliza formulas de hoja de calculo (=, +, -, @, tab, CR) y escapa comillas/comas/saltos. */
export function celdaCsv(valor: string | number | null): string {
  if (valor === null) return '';
  let s = typeof valor === 'number' ? (Number.isFinite(valor) ? valor.toFixed(2) : '') : valor;
  if (typeof valor === 'string' && /^[=+\-@\t\r]/u.test(s)) s = `'${s}`;
  return /[",\n\r]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
}

const RAZONES: Readonly<Record<RazonIngresoPyl, string>> = {
  sin_plan: 'sin plan asignado',
  precio_no_configurado: 'plan sin precio configurado',
  sin_foto_del_mes: 'mes cerrado sin foto mensual de ingreso',
};

/**
 * CSV del P&L (UTF-8 con BOM para que Excel respete los acentos). Montos en MXN con 2 decimales;
 * una cifra sin fuente va VACIA (nunca 0) y la columna `nota` dice por que.
 */
export function pylACsv(pyl: Pyl, nivel: NivelPylCsv): string {
  const cab = nivel === 'vertical' ? ['mes', 'vertical', 'organizaciones'] : ['mes', 'organizacion_id', 'cliente', 'vertical'];
  const cols = ['ingreso_reconocido_mxn', 'cogs_llm_mxn', 'cogs_voz_mxn', 'cogs_whatsapp_mxn', 'cogs_telefonia_mxn', 'cogs_otros_mxn', 'cogs_directo_mxn', 'infra_prorrateada_mxn', 'contribucion_mxn', 'contribucion_pct', 'margen_bruto_mxn', 'margen_bruto_pct', 'nota'];
  const lineas: string[] = [[...cab, ...cols].map(celdaCsv).join(',')];
  const comunes = (x: { ingresoMxn: number | null; cogs: CogsMxn | null; cogsDirectoMxn: number | null; infraMxn: number | null; contribucionMxn: number | null; contribucionPct: number | null; margenBrutoMxn: number | null; margenBrutoPct: number | null }, nota: string[]): Array<string | number | null> => [
    x.ingresoMxn,
    x.cogs?.llm ?? null,
    x.cogs?.voz ?? null,
    x.cogs?.whatsapp ?? null,
    x.cogs?.telefonia ?? null,
    x.cogs?.otros ?? null,
    x.cogsDirectoMxn,
    x.infraMxn,
    x.contribucionMxn,
    x.contribucionPct,
    x.margenBrutoMxn,
    x.margenBrutoPct,
    nota.join('; '),
  ];
  const notaBase = (): string[] => {
    const n: string[] = [];
    if (pyl.mxnPorUsd === null) n.push('sin tipo de cambio: costo y margen no calculados');
    if (!pyl.infra.disponible) n.push('sin infra capturada: margen bruto no calculado');
    return n;
  };
  if (nivel === 'vertical') {
    for (const v of [...pyl.porVertical, pyl.total]) {
      const nota = notaBase();
      if (v.organizacionesSinIngreso > 0) nota.push(`${v.organizacionesSinIngreso} organizacion(es) sin ingreso conocido fuera del margen`);
      lineas.push([pyl.mes, v.clave, String(v.organizaciones), ...comunes(v, nota)].map(celdaCsv).join(','));
    }
  } else {
    for (const f of pyl.porCliente) {
      const nota = notaBase();
      if (f.ingresoRazon !== null) nota.push(`ingreso: ${RAZONES[f.ingresoRazon]}`);
      lineas.push([pyl.mes, f.organizationId, f.nombre, f.vertical, ...comunes(f, nota)].map(celdaCsv).join(','));
    }
  }
  return `﻿${lineas.join('\r\n')}\r\n`;
}

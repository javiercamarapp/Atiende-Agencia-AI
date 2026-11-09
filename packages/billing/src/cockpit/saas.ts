// ═══════════════════════════════════════════════════════════════════════════
// METRICAS SAAS de la plataforma (cockpit CFO del superadmin).
//
// Funciones PURAS sobre la historia de fotos mensuales de MRR (`core.billing_snapshot_monthly`,
// mas la foto en vivo del mes en curso), las filas de economia del mes y las capturas del dueño
// (gasto fijo, marketing, saldo de caja, presupuesto). Ninguna cifra inventada: lo que no tiene
// fuente sale `disponible: false` con su razon.
//
// Definiciones:
//   * MRR del mes = suma del MRR de las organizaciones que aportan (activas, no canceladas, MRR > 0).
//   * Puente de MRR (mes contra el anterior): nuevo, expansion, contraccion y churn, con el mismo
//     calculo que el NRR del dashboard (`calcularNrr`). NRR y GRR sobre el MRR inicial.
//   * Churn de logos = clientes que aportaban el mes anterior y ya no / clientes del mes anterior.
//   * ARPA = MRR / clientes que aportan.
//   * LTV = ARPA x margen bruto % / churn mensual de logos (promedio de hasta 6 meses). Sin churn
//     medido, la vida se topa en `ltv_meses_tope` y se marca `vidaTopada`.
//   * CAC = marketing capturado / clientes nuevos, ambos en los ultimos 3 meses (incluido el del
//     corte). Payback (meses) = CAC / (ARPA x margen bruto %).
//   * Resultado operativo del mes = ingreso - costo directo - infra - gasto fijo - marketing.
//     Burn neto = lo negativo de ese resultado; runway (meses) = ultimo saldo de caja / burn neto.
//     El ingreso es el RECONOCIDO por plan, no lo cobrado (no hay fuente de pagos).
//   * Cohorte = mes en que el cliente aporto MRR por primera vez dentro de la historia leida.
//   * Exposicion cambiaria = costo en USD convertido a MXN / ingreso MXN; sensibilidad = margen que
//     se pierde si el dolar sube 10 %.
// ═══════════════════════════════════════════════════════════════════════════
import type { SnapshotMrr } from '../cfo.ts';
import { aportaMrr, calcularNrr } from '../cfo.ts';
import type { FilaEconomia } from './economia.ts';
import { round2 } from './economia.ts';
import { total as totalEconomia } from './comparativos.ts';

export interface FotoCockpit extends SnapshotMrr {
  readonly vertical: string;
  readonly planId: string | null;
}

export interface FotosDelMes {
  /** `YYYY-MM`. */
  readonly mes: string;
  readonly fotos: readonly FotoCockpit[];
}

export interface Captura {
  /** `YYYY-MM-01`. */
  readonly mes: string;
  readonly tipo: 'gasto_fijo' | 'marketing' | 'saldo_caja' | 'presupuesto_ingreso' | 'presupuesto_costo';
  readonly montoMxnCentavos: number;
}

export interface PuntoSerie {
  readonly mes: string;
  readonly mrrMxn: number;
  readonly clientes: number;
  readonly arpaMxn: number | null;
  readonly nuevoMxn: number | null;
  readonly expansionMxn: number | null;
  readonly contraccionMxn: number | null;
  readonly churnMxn: number | null;
  readonly nrrPct: number | null;
  readonly grrPct: number | null;
  readonly clientesNuevos: number | null;
  readonly clientesPerdidos: number | null;
  readonly churnLogosPct: number | null;
}

const centavosAMxn = (c: number) => round2(c / 100);

function aportan(fotos: readonly FotoCockpit[]): FotoCockpit[] {
  return fotos.filter((f) => aportaMrr(f.orgStatus, f.billingStatus, f.mrrCentavos));
}

/** Serie mensual con el puente de MRR. Los meses deben venir en orden ascendente y consecutivos. */
export function serieMrr(historia: readonly FotosDelMes[]): readonly PuntoSerie[] {
  return historia.map((h, i) => {
    const activos = aportan(h.fotos);
    const mrr = centavosAMxn(activos.reduce((s, f) => s + (f.mrrCentavos as number), 0));
    const base = { mes: h.mes, mrrMxn: mrr, clientes: activos.length, arpaMxn: activos.length > 0 ? round2(mrr / activos.length) : null };
    const previo = i > 0 ? historia[i - 1]! : null;
    if (previo === null || previo.fotos.length === 0) {
      return { ...base, nuevoMxn: null, expansionMxn: null, contraccionMxn: null, churnMxn: null, nrrPct: null, grrPct: null, clientesNuevos: null, clientesPerdidos: null, churnLogosPct: null };
    }
    const nrr = calcularNrr(previo.fotos, h.fotos);
    const antes = new Set(aportan(previo.fotos).map((f) => f.organizationId));
    const ahora = new Set(activos.map((f) => f.organizationId));
    const perdidos = [...antes].filter((id) => !ahora.has(id)).length;
    const nuevos = [...ahora].filter((id) => !antes.has(id)).length;
    return {
      ...base,
      nuevoMxn: nrr.disponible ? nrr.nuevoMxn : centavosAMxn(activos.reduce((s, f) => s + (f.mrrCentavos as number), 0)),
      expansionMxn: nrr.disponible ? nrr.expansionMxn : 0,
      contraccionMxn: nrr.disponible ? nrr.contraccionMxn : 0,
      churnMxn: nrr.disponible ? nrr.churnMxn : 0,
      nrrPct: nrr.disponible ? nrr.nrrPct : null,
      grrPct: nrr.disponible ? nrr.grrPct : null,
      clientesNuevos: nuevos,
      clientesPerdidos: perdidos,
      churnLogosPct: antes.size > 0 ? round2((perdidos / antes.size) * 100) : null,
    };
  });
}

export interface FilaCohorte {
  readonly cohorte: string;
  readonly clientesIniciales: number;
  readonly mrrInicialMxn: number;
  /** Por mes desde el alta (0 = mes de alta): % de clientes que siguen aportando y % del MRR inicial. */
  readonly meses: ReadonlyArray<{ readonly mes: string; readonly logosPct: number; readonly mrrPct: number | null }>;
}

export function cohortes(historia: readonly FotosDelMes[]): readonly FilaCohorte[] {
  const primerMes = new Map<string, string>();
  for (const h of historia) for (const f of aportan(h.fotos)) if (!primerMes.has(f.organizationId)) primerMes.set(f.organizationId, h.mes);
  const porCohorte = new Map<string, string[]>();
  for (const [id, mes] of primerMes) porCohorte.set(mes, [...(porCohorte.get(mes) ?? []), id]);
  return [...porCohorte.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohorte, ids]) => {
      const inicio = historia.findIndex((h) => h.mes === cohorte);
      const inicial = historia[inicio]!.fotos.filter((f) => ids.includes(f.organizationId)).reduce((s, f) => s + (f.mrrCentavos ?? 0), 0);
      const meses = historia.slice(inicio).map((h) => {
        const vivos = aportan(h.fotos).filter((f) => ids.includes(f.organizationId));
        const mrr = vivos.reduce((s, f) => s + (f.mrrCentavos as number), 0);
        return { mes: h.mes, logosPct: round2((vivos.length / ids.length) * 100), mrrPct: inicial > 0 ? round2((mrr / inicial) * 100) : null };
      });
      return { cohorte, clientesIniciales: ids.length, mrrInicialMxn: centavosAMxn(inicial), meses };
    });
}

export interface Concentracion {
  readonly top1Pct: number | null;
  readonly top5Pct: number | null;
  /** Indice Herfindahl-Hirschman (0-10000) sobre la participacion en el ingreso. */
  readonly hhi: number | null;
  readonly top: ReadonlyArray<{ readonly organizationId: string; readonly nombre: string; readonly ingresoMxn: number; readonly participacionPct: number }>;
}

export function concentracion(filas: readonly FilaEconomia[]): Concentracion {
  const con = filas.filter((f) => f.ingresoMxn !== null && f.ingresoMxn > 0).sort((a, b) => (b.ingresoMxn as number) - (a.ingresoMxn as number) || a.nombre.localeCompare(b.nombre));
  const total = con.reduce((s, f) => s + (f.ingresoMxn as number), 0);
  if (total <= 0) return { top1Pct: null, top5Pct: null, hhi: null, top: [] };
  const part = con.map((f) => ((f.ingresoMxn as number) / total) * 100);
  return {
    top1Pct: round2(part[0]!),
    top5Pct: round2(part.slice(0, 5).reduce((s, p) => s + p, 0)),
    hhi: Math.round(part.reduce((s, p) => s + p * p, 0)),
    top: con.slice(0, 5).map((f, i) => ({ organizationId: f.organizationId, nombre: f.nombre, ingresoMxn: f.ingresoMxn as number, participacionPct: round2(part[i]!) })),
  };
}

export type Disponible<T> = ({ readonly disponible: true } & T) | { readonly disponible: false; readonly razon: string };

export interface Ltv {
  readonly arpaMxn: number;
  readonly margenBrutoPct: number;
  readonly churnMensualPct: number | null;
  readonly vidaMeses: number;
  readonly vidaTopada: boolean;
  readonly ltvMxn: number;
  readonly mesesConChurn: number;
}

export interface Cac {
  readonly marketingMxn: number;
  readonly clientesNuevos: number;
  readonly cacMxn: number | null;
  readonly paybackMeses: number | null;
  readonly ltvCac: number | null;
}

export interface Burn {
  readonly ingresoMxn: number;
  readonly costoDirectoMxn: number;
  readonly infraMxn: number;
  readonly gastoFijoMxn: number;
  readonly marketingMxn: number;
  readonly resultadoMxn: number;
  readonly burnNetoMxn: number;
  readonly saldoCajaMxn: number | null;
  readonly saldoCajaMes: string | null;
  /** `null` = no quema (resultado >= 0) o no hay saldo capturado. */
  readonly runwayMeses: number | null;
  readonly proyectado: boolean;
}

export interface Fx {
  readonly mxnPorUsd: number;
  readonly fecha: string | null;
  readonly fuente: string | null;
  readonly costoUsd: number;
  readonly costoUsdEnMxn: number;
  readonly ingresoMxn: number;
  readonly exposicionPct: number | null;
  readonly sensibilidad10PctMxn: number;
  readonly movimiento30dPct: number | null;
}

export interface PresupuestoMes {
  readonly mes: string;
  readonly ingresoPresupuestoMxn: number | null;
  readonly ingresoRealMxn: number | null;
  readonly costoPresupuestoMxn: number | null;
  readonly costoRealMxn: number | null;
}

export interface MetricasSaas {
  readonly mes: string;
  readonly mrrMxn: number;
  readonly arrMxn: number;
  readonly clientes: number;
  readonly arpaMxn: number | null;
  readonly serie: readonly PuntoSerie[];
  readonly margen: { readonly contribucionPct: number | null; readonly margenBrutoPct: number | null; readonly contribucionMxn: number | null; readonly margenBrutoMxn: number | null };
  readonly ltv: Disponible<Ltv>;
  readonly cac: Disponible<Cac>;
  readonly burn: Disponible<Burn>;
  readonly cohortes: readonly FilaCohorte[];
  readonly concentracion: Concentracion;
  readonly fx: Disponible<Fx>;
  readonly presupuesto: readonly PresupuestoMes[];
}

export interface EntradaSaas {
  /** `YYYY-MM` del corte. */
  readonly mes: string;
  /** Historia ascendente que TERMINA en el mes del corte (en curso: foto en vivo). */
  readonly historia: readonly FotosDelMes[];
  readonly economia: readonly FilaEconomia[];
  readonly capturas: readonly Captura[];
  readonly ltvMesesTope: number;
  /** Mes en curso: usar la proyeccion al cierre para el burn. */
  readonly enCurso: boolean;
  readonly fx: { readonly mxnPorUsd: number; readonly fecha: string | null; readonly fuente: string | null } | null;
  /** Tipo de cambio de hace ~30 dias (para el movimiento); `null` = no hay. */
  readonly fxHace30d: number | null;
  /** Costo real (MXN) por mes `YYYY-MM` para el presupuesto; `null` = sin dato. */
  readonly costoRealPorMes: ReadonlyMap<string, number | null>;
}

function sumaCaptura(capturas: readonly Captura[], tipo: Captura['tipo'], meses: readonly string[]): number {
  return capturas.filter((c) => c.tipo === tipo && meses.includes(c.mes.slice(0, 7))).reduce((s, c) => s + c.montoMxnCentavos, 0);
}

export function calcularMetricasSaas(e: EntradaSaas): MetricasSaas {
  const serie = serieMrr(e.historia);
  const ultimo = serie[serie.length - 1];
  const mrr = ultimo?.mrrMxn ?? 0;
  const clientes = ultimo?.clientes ?? 0;
  const arpa = ultimo?.arpaMxn ?? null;
  const agg = totalEconomia(e.economia);
  const gm = agg.margenBrutoPct ?? agg.contribucionPct;

  // LTV
  const churns = serie.slice(-6).map((p) => p.churnLogosPct).filter((x): x is number => x !== null);
  let ltv: Disponible<Ltv>;
  if (arpa === null) ltv = { disponible: false, razon: 'Sin clientes que aporten MRR.' };
  else if (gm === null) ltv = { disponible: false, razon: 'Sin margen calculable (falta tipo de cambio o costo).' };
  else {
    const churn = churns.length > 0 ? round2(churns.reduce((s, x) => s + x, 0) / churns.length) : null;
    const topada = churn === null || churn <= 0 || 100 / churn > e.ltvMesesTope;
    const vida = topada ? e.ltvMesesTope : round2(100 / (churn as number));
    ltv = { disponible: true, arpaMxn: arpa, margenBrutoPct: gm, churnMensualPct: churn, vidaMeses: vida, vidaTopada: topada, ltvMxn: round2(arpa * (gm / 100) * vida), mesesConChurn: churns.length };
  }

  // CAC: ventana de 3 meses que termina en el corte.
  const ventana = serie.slice(-3).map((p) => p.mes);
  const marketing = sumaCaptura(e.capturas, 'marketing', ventana);
  const hayMarketing = e.capturas.some((c) => c.tipo === 'marketing' && ventana.includes(c.mes.slice(0, 7)));
  let cac: Disponible<Cac>;
  if (!hayMarketing) cac = { disponible: false, razon: 'Captura el gasto de marketing de los últimos 3 meses para calcular el CAC.' };
  else {
    const nuevos = serie.slice(-3).reduce((s, p) => s + (p.clientesNuevos ?? 0), 0);
    const cacMxn = nuevos > 0 ? round2(marketing / 100 / nuevos) : null;
    const contribMensual = arpa !== null && gm !== null ? (arpa * gm) / 100 : null;
    cac = {
      disponible: true,
      marketingMxn: centavosAMxn(marketing),
      clientesNuevos: nuevos,
      cacMxn,
      paybackMeses: cacMxn !== null && contribMensual !== null && contribMensual > 0 ? round2(cacMxn / contribMensual) : null,
      ltvCac: cacMxn !== null && cacMxn > 0 && ltv.disponible ? round2(ltv.ltvMxn / cacMxn) : null,
    };
  }

  // Burn y runway
  let burn: Disponible<Burn>;
  const conCosto = e.economia.filter((f) => f.costoDirectoMxn !== null);
  if (e.fx === null) burn = { disponible: false, razon: 'Sin tipo de cambio: el costo en MXN no se calcula.' };
  else if (conCosto.length !== e.economia.length) burn = { disponible: false, razon: 'Hay clientes con costo sin dato (falta un costo unitario): el burn no se calcula para no subestimarlo.' };
  else {
    const ingreso = round2(e.economia.reduce((s, f) => s + ((e.enCurso ? f.proyeccion.ingresoMxn : f.ingresoMxn) ?? 0), 0));
    const directoProy = round2(e.economia.reduce((s, f) => s + ((e.enCurso ? (f.proyeccion.costoMxn ?? 0) - (f.infraMxn ?? 0) : (f.costoDirectoMxn as number))), 0));
    const infra = round2(e.economia.reduce((s, f) => s + (f.infraMxn ?? 0), 0));
    const fijo = centavosAMxn(sumaCaptura(e.capturas, 'gasto_fijo', [e.mes]));
    const mkt = centavosAMxn(sumaCaptura(e.capturas, 'marketing', [e.mes]));
    const resultado = round2(ingreso - directoProy - infra - fijo - mkt);
    const saldos = e.capturas.filter((c) => c.tipo === 'saldo_caja' && c.mes.slice(0, 7) <= e.mes).sort((a, b) => b.mes.localeCompare(a.mes));
    const ultimoMes = saldos[0]?.mes ?? null;
    const saldo = ultimoMes === null ? null : centavosAMxn(saldos.filter((c) => c.mes === ultimoMes).reduce((s, c) => s + c.montoMxnCentavos, 0));
    const burnNeto = resultado < 0 ? round2(-resultado) : 0;
    burn = {
      disponible: true,
      ingresoMxn: ingreso,
      costoDirectoMxn: directoProy,
      infraMxn: infra,
      gastoFijoMxn: fijo,
      marketingMxn: mkt,
      resultadoMxn: resultado,
      burnNetoMxn: burnNeto,
      saldoCajaMxn: saldo,
      saldoCajaMes: ultimoMes === null ? null : ultimoMes.slice(0, 7),
      runwayMeses: saldo !== null && burnNeto > 0 ? round2(saldo / burnNeto) : null,
      proyectado: e.enCurso,
    };
  }

  // FX
  let fx: Disponible<Fx>;
  if (e.fx === null) fx = { disponible: false, razon: 'Sin tipo de cambio capturado (Costos y margen).' };
  else {
    const costoUsd = round2(e.economia.reduce((s, f) => s + (f.costoDirectoUsd ?? 0), 0));
    const enMxn = round2(costoUsd * e.fx.mxnPorUsd);
    const ingreso = round2(e.economia.reduce((s, f) => s + (f.ingresoMxn ?? 0), 0));
    fx = {
      disponible: true,
      mxnPorUsd: e.fx.mxnPorUsd,
      fecha: e.fx.fecha,
      fuente: e.fx.fuente,
      costoUsd,
      costoUsdEnMxn: enMxn,
      ingresoMxn: ingreso,
      exposicionPct: ingreso > 0 ? round2((enMxn / ingreso) * 100) : null,
      sensibilidad10PctMxn: round2(enMxn * 0.1),
      movimiento30dPct: e.fxHace30d !== null && e.fxHace30d > 0 ? round2(((e.fx.mxnPorUsd - e.fxHace30d) / e.fxHace30d) * 100) : null,
    };
  }

  // Presupuesto contra real (solo meses con algo presupuestado).
  const mesesPresupuesto = [...new Set(e.capturas.filter((c) => c.tipo.startsWith('presupuesto_')).map((c) => c.mes.slice(0, 7)))].sort();
  const mrrPorMes = new Map(serie.map((p) => [p.mes, p.mrrMxn]));
  const presupuesto = mesesPresupuesto.map((m) => {
    const ing = e.capturas.filter((c) => c.tipo === 'presupuesto_ingreso' && c.mes.slice(0, 7) === m);
    const cos = e.capturas.filter((c) => c.tipo === 'presupuesto_costo' && c.mes.slice(0, 7) === m);
    return {
      mes: m,
      ingresoPresupuestoMxn: ing.length > 0 ? centavosAMxn(ing.reduce((s, c) => s + c.montoMxnCentavos, 0)) : null,
      ingresoRealMxn: mrrPorMes.get(m) ?? null,
      costoPresupuestoMxn: cos.length > 0 ? centavosAMxn(cos.reduce((s, c) => s + c.montoMxnCentavos, 0)) : null,
      costoRealMxn: e.costoRealPorMes.get(m) ?? null,
    };
  });

  return {
    mes: e.mes,
    mrrMxn: mrr,
    arrMxn: round2(mrr * 12),
    clientes,
    arpaMxn: arpa,
    serie,
    margen: { contribucionPct: agg.contribucionPct, margenBrutoPct: agg.margenBrutoPct, contribucionMxn: agg.contribucionMxn, margenBrutoMxn: agg.margenBrutoMxn },
    ltv,
    cac,
    burn,
    cohortes: cohortes(e.historia),
    concentracion: concentracion(e.economia),
    fx,
    presupuesto,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ECONOMIA POR CLIENTE del CFO de la plataforma (cockpit del superadmin).
//
// Funcion PURA: recibe las filas del dashboard CFO (`FilaCfo`: plan, ingreso esperado, costo
// medido por categoria, cobranza), el USO del mes y del mes anterior (`core.get_cfo_uso_*`, 0085),
// los supuestos de costo unitario, la infraestructura capturada y el tipo de cambio; devuelve una
// fila por cliente con ingreso, uso, costo real, margen, proyeccion al cierre, uso del pool y
// banderas. No lee ni escribe nada.
//
// REGLA DE LA CASA: ninguna cifra inventada. Un costo que depende de un supuesto inexistente sale
// `null` con fuente `sin_dato`; un mes sin infraestructura capturada no tiene margen bruto (si
// margen de contribucion); un cliente sin plan no tiene ingreso.
//
// Definiciones (una sola, la misma que la pantalla, el CSV y las recomendaciones):
//   * Costo por categoria: MEDIDO si hay eventos/uso de LLM de ese mes; si no, MODELADO con el
//     costo unitario (minutos x USD/min por proveedor, conversaciones x USD/conversacion); si el
//     costo unitario no existe, `sin_dato`. La tarifa de Meta y la telefonia sin capturar NO
//     bloquean el total: cuentan 0 con la fuente `no_configurado` y un aviso.
//   * Ingreso del mes = MRR (cuota recurrente del plan) + excedente estimado del plan medido.
//     Solo aporta un cliente activo con suscripcion no cancelada (mismo criterio que el MRR).
//   * Margen de contribucion = ingreso - costo directo. Margen bruto = contribucion - infra
//     prorrateada en proporcion al costo directo (mismo reparto que el P&L).
//   * Proyeccion al cierre (solo mes en curso): lo que depende del uso se extrapola linealmente
//     por dias transcurridos; la cuota recurrente y la infraestructura no.
// ═══════════════════════════════════════════════════════════════════════════
import type { FilaCfo } from '../cfo.ts';
import { aportaMrr } from '../cfo.ts';
import { repartirCentavos } from '../pyl.ts';
import type { Supuestos } from './supuestos.ts';
import { unitarioDe } from './supuestos.ts';

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Uso de una organizacion en un mes (forma de `core.get_cfo_uso_*`). */
export interface UsoMes {
  readonly organizationId: string;
  readonly mes: string;
  readonly vertical: string;
  readonly llmMicroUsd: number;
  readonly eventosMicroUsd: number;
  readonly llamadas: number | null;
  readonly segundosVoz: number | null;
  readonly segundosPorProveedor: Readonly<Record<string, number>> | null;
  readonly pedidos: number | null;
  readonly pedidosVoz: number | null;
  readonly pedidosWhatsapp: number | null;
  readonly conversacionesWa: number | null;
  readonly minutosFacturables: number | null;
  readonly plan: Readonly<Record<string, unknown>> | null;
}

export type FuenteCosto = 'medido' | 'modelado' | 'sin_uso' | 'no_configurado' | 'sin_dato';

export interface CostoCategoria {
  readonly usd: number | null;
  readonly fuente: FuenteCosto;
}

export type BanderaCliente = 'no_rentable' | 'margen_bajo' | 'sobre_el_tope' | 'cerca_del_tope' | 'anomalia_uso' | 'pico_costo' | 'pago_fallido';

export interface PoolCliente {
  readonly incluido: number;
  readonly usado: number;
  readonly pct: number | null;
  readonly pctProyectado: number | null;
}

export interface FilaEconomia {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly orgStatus: string;
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly modeloCobro: 'por_asiento' | 'medido' | null;
  readonly sucursales: number;
  readonly aportaMrr: boolean;
  /** Cuota recurrente del mes (MXN); `null` = sin plan o plan sin precio. */
  readonly mrrMxn: number | null;
  readonly excedenteMxn: number | null;
  readonly ingresoMxn: number | null;
  readonly uso: {
    readonly llamadas: number | null;
    readonly minutosVoz: number | null;
    readonly duracionPromedioMin: number | null;
    readonly conversacionesWa: number | null;
    readonly pedidos: number | null;
  };
  readonly costo: {
    readonly voz: CostoCategoria;
    readonly llm: CostoCategoria;
    readonly whatsapp: CostoCategoria;
    readonly telefonia: CostoCategoria;
    readonly otros: CostoCategoria;
  };
  readonly costoDirectoUsd: number | null;
  readonly costoDirectoMxn: number | null;
  /** Infra prorrateada (MXN); `null` = no hay infraestructura capturada para el mes. */
  readonly infraMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
  readonly proyeccion: { readonly ingresoMxn: number | null; readonly costoMxn: number | null; readonly margenMxn: number | null; readonly margenPct: number | null };
  readonly poolVoz: PoolCliente | null;
  readonly poolWa: PoolCliente | null;
  readonly billingStatus: string | null;
  readonly banderas: readonly BanderaCliente[];
  readonly avisos: readonly string[];
}

export interface EntradaEconomia {
  readonly filas: readonly FilaCfo[];
  readonly uso: readonly UsoMes[];
  readonly usoPrevio: readonly UsoMes[];
  readonly supuestos: Supuestos;
  readonly mxnPorUsd: number | null;
  /** Infraestructura compartida capturada para el mes, centavos MXN; `null` = sin captura. */
  readonly infraCentavos: number | null;
  readonly diasTranscurridos: number;
  readonly diasDelMes: number;
  readonly diasMesPrevio: number;
  /** Sucursales activas por organizacion (`core.cfo_org_rows.sucursales_activas`). */
  readonly sucursalesPorOrg: ReadonlyMap<string, number>;
}

const MICRO = 1_000_000;

function pct(parte: number | null, base: number | null): number | null {
  return parte !== null && base !== null && base > 0 ? round2((parte / base) * 100) : null;
}

function numero(plan: Readonly<Record<string, unknown>> | null, clave: string): number | null {
  const v = plan?.[clave];
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Costo de voz modelado: segundos por proveedor x USD/min; `null` si algun proveedor con uso no tiene costo unitario. */
function vozModelada(uso: UsoMes | undefined, s: Supuestos): CostoCategoria {
  const seg = uso?.segundosPorProveedor ?? null;
  if (seg === null) return { usd: 0, fuente: 'sin_uso' };
  let usd = 0;
  let hay = false;
  for (const [prov, segundos] of Object.entries(seg)) {
    if (!(segundos > 0)) continue;
    hay = true;
    const u = unitarioDe(s.vozUsdMinuto, prov);
    if (u === null) return { usd: null, fuente: 'sin_dato' };
    usd += (segundos / 60) * u.valor;
  }
  return hay ? { usd: round6(usd), fuente: 'modelado' } : { usd: 0, fuente: 'sin_uso' };
}

function round6(n: number): number {
  return Math.round(n * MICRO) / MICRO;
}

function costoCategorias(f: FilaCfo, uso: UsoMes | undefined, s: Supuestos): { costo: FilaEconomia['costo']; avisos: string[] } {
  const m = f.fila.costoMicroUsd;
  const avisos: string[] = [];
  const medido = (micro: number): CostoCategoria => ({ usd: round6(micro / MICRO), fuente: 'medido' });

  const voz = m.voz > 0 ? medido(m.voz) : vozModelada(uso, s);
  if (voz.fuente === 'sin_dato') avisos.push('Hay minutos de voz de un proveedor sin costo por minuto capturado.');

  const conv = uso?.conversacionesWa ?? null;
  let llm: CostoCategoria;
  if (m.llm > 0) llm = medido(m.llm);
  else if (conv !== null && conv > 0) llm = s.llmUsdConversacionWa ? { usd: round6(conv * s.llmUsdConversacionWa.valor), fuente: 'modelado' } : { usd: null, fuente: 'sin_dato' };
  else if (conv === null && (uso?.pedidosWhatsapp ?? 0) > 0) llm = { usd: null, fuente: 'sin_dato' };
  else llm = { usd: 0, fuente: 'sin_uso' };
  if (llm.fuente === 'sin_dato') avisos.push('Hay actividad de WhatsApp sin costo de LLM medido ni conversaciones contadas.');

  let whatsapp: CostoCategoria;
  if (m.whatsapp > 0) whatsapp = medido(m.whatsapp);
  else if (conv !== null && conv > 0) {
    if (s.whatsappUsdConversacion) whatsapp = { usd: round6(conv * s.whatsappUsdConversacion.valor), fuente: 'modelado' };
    else {
      whatsapp = { usd: 0, fuente: 'no_configurado' };
      avisos.push('La tarifa de Meta por conversación no está capturada: cuenta 0.');
    }
  } else whatsapp = { usd: 0, fuente: 'sin_uso' };

  let telefonia: CostoCategoria;
  const minutos = uso?.segundosVoz ?? null;
  if (m.telefonia > 0) telefonia = medido(m.telefonia);
  else if (minutos !== null && minutos > 0) {
    const tabla = s.telefoniaUsdMinuto;
    if (Object.keys(tabla).length === 0) {
      telefonia = { usd: 0, fuente: 'no_configurado' };
      avisos.push('El costo de telefonía por minuto no está capturado: cuenta 0.');
    } else {
      let usd = 0;
      let falta = false;
      for (const [prov, seg] of Object.entries(uso?.segundosPorProveedor ?? {})) {
        const u = unitarioDe(tabla, prov);
        if (u === null) falta = true;
        else usd += (seg / 60) * u.valor;
      }
      telefonia = falta ? { usd: null, fuente: 'sin_dato' } : { usd: round6(usd), fuente: 'modelado' };
    }
  } else telefonia = { usd: 0, fuente: 'sin_uso' };

  const otros: CostoCategoria = m.otros > 0 ? medido(m.otros) : { usd: 0, fuente: 'sin_uso' };
  return { costo: { voz, llm, whatsapp, telefonia, otros }, avisos };
}

interface PlanMedido {
  readonly cuotaCentavos: number;
  readonly precioSucursalCentavos: number | null;
  readonly sucursalesIncluidas: number;
  readonly minutosIncluidos: number;
  readonly precioMinutoCentavos: number | null;
  readonly convIncluidas: number;
  readonly precioConvCentavos: number | null;
  readonly usoJustoPct: number | null;
}

function planMedido(plan: Readonly<Record<string, unknown>> | null, sucursales: number): PlanMedido | null {
  if (plan === null || plan['modelo_cobro'] !== 'medido') return null;
  return {
    cuotaCentavos: numero(plan, 'precio_base_mxn_centavos') ?? 0,
    precioSucursalCentavos: numero(plan, 'precio_sucursal_mxn_centavos'),
    sucursalesIncluidas: numero(plan, 'sucursales_incluidas') ?? 0,
    minutosIncluidos: (numero(plan, 'minutos_voz_incluidos') ?? 0) + (numero(plan, 'minutos_voz_incluidos_por_sucursal') ?? 0) * sucursales,
    precioMinutoCentavos: numero(plan, 'precio_minuto_voz_excedente_mxn_centavos'),
    convIncluidas: (numero(plan, 'conversaciones_wa_incluidas') ?? 0) + (numero(plan, 'conversaciones_wa_incluidas_por_sucursal') ?? 0) * sucursales,
    precioConvCentavos: numero(plan, 'precio_conversacion_wa_excedente_mxn_centavos'),
    usoJustoPct: numero(plan, 'uso_justo_pct'),
  };
}

/** Excedente cobrable en centavos: arriba de lo incluido y, si hay tope de uso justo, solo hasta el tope. */
export function excedenteCentavos(usado: number, incluido: number, precioCentavos: number | null, usoJustoPct: number | null): number {
  if (precioCentavos === null || usado <= incluido) return 0;
  const tope = usoJustoPct === null ? Infinity : Math.floor((incluido * usoJustoPct) / 100);
  return Math.max(0, Math.min(usado, tope) - incluido) * precioCentavos;
}

function pool(usado: number | null, incluido: number, factor: number): PoolCliente | null {
  if (usado === null || incluido <= 0) return null;
  return { incluido, usado, pct: round2((usado / incluido) * 100), pctProyectado: round2(((usado * factor) / incluido) * 100) };
}

export function calcularEconomia(e: EntradaEconomia): readonly FilaEconomia[] {
  if (e.diasTranscurridos <= 0 || e.diasDelMes <= 0 || e.diasTranscurridos > e.diasDelMes) throw new Error('dias del mes invalidos');
  const fx = e.mxnPorUsd;
  const factor = e.diasDelMes / e.diasTranscurridos;
  const usoPorOrg = new Map(e.uso.map((u) => [u.organizationId, u]));
  const previoPorOrg = new Map(e.usoPrevio.map((u) => [u.organizationId, u]));
  const s = e.supuestos;

  const base = e.filas.map((f) => {
    const uso = usoPorOrg.get(f.fila.organizationId);
    const { costo, avisos } = costoCategorias(f, uso, s);
    const partes = [costo.voz, costo.llm, costo.whatsapp, costo.telefonia, costo.otros];
    const directoUsd = partes.some((p) => p.usd === null) ? null : round6(partes.reduce((acc, p) => acc + (p.usd as number), 0));
    return { f, uso, costo, avisos, directoUsd };
  });

  // Infra prorrateada en proporcion al costo directo conocido (mismo reparto que el P&L).
  const reparto = e.infraCentavos === null ? null : repartirCentavos(e.infraCentavos, base.map((b) => Math.round((b.directoUsd ?? 0) * MICRO)));

  return base.map(({ f, uso, costo, avisos, directoUsd }, i) => {
    const fila = f.fila;
    const plan = uso?.plan ?? null;
    const sucursales = e.sucursalesPorOrg.get(fila.organizationId) ?? 0;
    const medido = planMedido(plan, sucursales);
    const aporta = fila.orgStatus === 'active' && f.billingStatus !== 'cancelada';

    let mrrMxn: number | null;
    if (medido) {
      const extra = medido.precioSucursalCentavos === null ? 0 : Math.max(sucursales - medido.sucursalesIncluidas, 0) * medido.precioSucursalCentavos;
      mrrMxn = round2((medido.cuotaCentavos + extra) / 100);
    } else mrrMxn = fila.ingresoMxn;

    const minutos = uso?.minutosFacturables ?? (uso?.segundosVoz === null || uso?.segundosVoz === undefined ? null : Math.ceil(uso.segundosVoz / 60));
    const conv = uso?.conversacionesWa ?? null;
    let excedenteMxn: number | null = null;
    let excedenteProyMxn: number | null = null;
    if (medido) {
      const exc = (m: number, c: number) =>
        excedenteCentavos(m, medido.minutosIncluidos, medido.precioMinutoCentavos, medido.usoJustoPct) + excedenteCentavos(c, medido.convIncluidas, medido.precioConvCentavos, medido.usoJustoPct);
      excedenteMxn = round2(exc(minutos ?? 0, conv ?? 0) / 100);
      excedenteProyMxn = round2(exc(Math.round((minutos ?? 0) * factor), Math.round((conv ?? 0) * factor)) / 100);
    }

    const ingresoMxn = mrrMxn === null ? null : aporta && aportaMrr(fila.orgStatus, f.billingStatus, Math.round(mrrMxn * 100)) ? round2(mrrMxn + (excedenteMxn ?? 0)) : 0;
    const ingresoProy = mrrMxn === null ? null : ingresoMxn === 0 ? 0 : round2(mrrMxn + (excedenteProyMxn ?? 0));

    const directoMxn = directoUsd === null || fx === null ? null : round2(directoUsd * fx);
    const infraMxn = reparto === null ? null : round2(reparto[i]! / 100);
    const contribucion = ingresoMxn === null || directoMxn === null ? null : round2(ingresoMxn - directoMxn);
    const bruto = contribucion === null || infraMxn === null ? null : round2(contribucion - infraMxn);
    const costoProy = directoMxn === null ? null : round2(directoMxn * factor + (infraMxn ?? 0));
    const margenProy = ingresoProy === null || costoProy === null ? null : round2(ingresoProy - costoProy);

    const poolVoz = medido ? pool(minutos, medido.minutosIncluidos, factor) : null;
    const poolWa = medido ? pool(conv, medido.convIncluidas, factor) : null;

    const banderas: BanderaCliente[] = [];
    const margenRef = margenProy ?? bruto ?? contribucion;
    const margenRefPct = pct(margenProy, ingresoProy) ?? pct(bruto ?? contribucion, ingresoMxn);
    if (margenRef !== null && margenRef < 0) banderas.push('no_rentable');
    else if (margenRefPct !== null && margenRefPct < s.umbralMargenPct.valor) banderas.push('margen_bajo');
    const pools = [poolVoz, poolWa].filter((p): p is PoolCliente => p !== null);
    if (pools.some((p) => (p.pct ?? 0) > 100)) banderas.push('sobre_el_tope');
    else if (pools.some((p) => (p.pctProyectado ?? 0) >= s.umbralPoolPct.valor)) banderas.push('cerca_del_tope');

    const previo = previoPorOrg.get(fila.organizationId);
    const umbral = s.umbralPicoCostoPct.valor / 100;
    if (uso && previo && e.diasMesPrevio > 0) {
      const unidades = (u: UsoMes) => (u.llamadas ?? 0) + (u.conversacionesWa ?? u.pedidosWhatsapp ?? 0);
      const ritmo = unidades(uso) / e.diasTranscurridos;
      const ritmoPrevio = unidades(previo) / e.diasMesPrevio;
      if (ritmoPrevio > 0 && Math.abs(ritmo / ritmoPrevio - 1) > umbral) banderas.push('anomalia_uso');
      const costoDia = (uso.llmMicroUsd + uso.eventosMicroUsd) / e.diasTranscurridos;
      const costoDiaPrevio = (previo.llmMicroUsd + previo.eventosMicroUsd) / e.diasMesPrevio;
      if (costoDiaPrevio > 0 && costoDia > costoDiaPrevio * (1 + umbral)) banderas.push('pico_costo');
    }
    if (f.billingStatus === 'pago_pendiente') banderas.push('pago_fallido');

    const segundos = uso?.segundosVoz ?? null;
    const llamadas = uso?.llamadas ?? null;
    if (fx === null) avisos.push('Sin tipo de cambio para el mes: el costo en MXN y el margen no se calculan.');
    if (mrrMxn === null) avisos.push(fila.ingresoRazon === 'sin_plan' ? 'Sin plan asignado: no hay ingreso.' : 'Plan sin precio configurado: no hay ingreso.');

    return {
      organizationId: fila.organizationId,
      nombre: fila.nombre,
      vertical: fila.vertical,
      orgStatus: fila.orgStatus,
      planId: fila.planId,
      planNombre: fila.planNombre,
      modeloCobro: plan === null ? null : medido ? 'medido' : 'por_asiento',
      sucursales,
      aportaMrr: ingresoMxn !== null && ingresoMxn > 0,
      mrrMxn,
      excedenteMxn,
      ingresoMxn,
      uso: {
        llamadas,
        minutosVoz: segundos === null ? null : round2(segundos / 60),
        duracionPromedioMin: segundos === null || llamadas === null || llamadas === 0 ? null : round2(segundos / 60 / llamadas),
        conversacionesWa: conv,
        pedidos: uso?.pedidos ?? null,
      },
      costo,
      costoDirectoUsd: directoUsd === null ? null : round2(directoUsd),
      costoDirectoMxn: directoMxn,
      infraMxn,
      contribucionMxn: contribucion,
      contribucionPct: pct(contribucion, ingresoMxn),
      margenBrutoMxn: bruto,
      margenBrutoPct: pct(bruto, ingresoMxn),
      proyeccion: { ingresoMxn: ingresoProy, costoMxn: costoProy, margenMxn: margenProy, margenPct: pct(margenProy, ingresoProy) },
      poolVoz,
      poolWa,
      billingStatus: f.billingStatus,
      banderas,
      avisos,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// COSTO POR EVENTO, MARGEN Y LIMITES POR PLAN (superadmin "CFO", SA-02/SA-03)
//
// Funciones PURAS: reciben las cifras crudas que devuelve
// `core.get_cost_margin_report_for_superadmin` (costos en micro-USD enteros,
// precios del plan en centavos MXN enteros) y calculan ingreso esperado, costo
// en MXN, margen, alertas y consumo contra los limites del plan.
//
// REGLA DE LA CASA (heredada de Likida): NUNCA inventar una cifra. Si falta el
// plan, el precio del plan o el tipo de cambio, el campo es `null` y trae su
// razon (`ingresoRazon`, `costoMxnRazon`); jamas un 0 que confunda "no se sabe"
// con "no paga" o "no cuesta".
// ═══════════════════════════════════════════════════════════════════════════

export type CategoriaCosto = 'llm' | 'voz' | 'whatsapp' | 'telefonia' | 'otros';

export interface CostoMicroUsd {
  readonly llm: number;
  readonly voz: number;
  readonly whatsapp: number;
  readonly telefonia: number;
  readonly otros: number;
}

export type MetricaLimite = 'llm_costo_micro_usd_mes' | 'minutos_voz_mes' | 'mensajes_mes' | 'sucursales' | 'asientos';
export type AccionAlExceder = 'avisar' | 'cobrar' | 'pausar';

export interface LimitePlan {
  readonly metrica: MetricaLimite;
  readonly limite: number;
  readonly accion: AccionAlExceder;
}

export interface PlanPrecio {
  readonly id: string;
  readonly nombre: string;
  /** Centavos MXN; `null` = precio por configurar. */
  readonly precioBaseCentavos: number | null;
  readonly precioAsientoCentavos: number | null;
  readonly asientosIncluidos: number;
}

export interface EntradaCostoMargen {
  readonly organizationId: string;
  readonly nombre: string;
  readonly slug: string;
  readonly vertical: string;
  readonly orgStatus: string;
  readonly plan: PlanPrecio | null;
  readonly limites: readonly LimitePlan[];
  /** `organization_billing.status` (`null` si no hay fila). */
  readonly billingStatus: string | null;
  /** `organization_billing.seats`: cantidad que Stripe ya cobra (YA neta de incluidos). */
  readonly billingSeats: number | null;
  readonly sucursalesActivas: number;
  readonly costo: CostoMicroUsd;
  readonly eventosTotal: number;
  readonly eventosEstimados: number;
  readonly minutosVoz: number;
  readonly mensajes: number;
  readonly llmCapMicroUsd: number;
  readonly llmAlertPct: number;
}

export type SeveridadAlerta = 'alta' | 'media' | 'info';

export interface AlertaCosto {
  readonly codigo: 'margen_negativo' | 'margen_bajo' | 'tope_llm' | 'tope_llm_agotado' | 'sin_ingreso_con_costo' | 'limite_excedido' | 'limite_aviso';
  readonly severidad: SeveridadAlerta;
  readonly mensaje: string;
}

export type EstadoLimite = 'ok' | 'aviso' | 'excedido' | 'sin_dato';

export interface ConsumoLimite {
  readonly metrica: MetricaLimite;
  readonly limite: number;
  readonly accion: AccionAlExceder;
  /** `null` = no hay dato de uso para esa metrica (p. ej. asientos sin suscripcion). */
  readonly uso: number | null;
  readonly pct: number | null;
  readonly estado: EstadoLimite;
  /**
   * `true` solo cuando algo en el sistema REALMENTE corta al exceder: el tope LLM con
   * accion 'pausar' (se aplica a `core.llm_org_budget`, que el gateway ya hace cumplir).
   * Los demas limites se evaluan y se muestran, pero hoy no cortan nada por si solos.
   */
  readonly aplicadoPorSistema: boolean;
}

export type RazonIngresoNulo = 'sin_plan' | 'precio_no_configurado';
export type FuenteAsientos = 'billing' | 'sucursales' | 'ninguna';
export type Riesgo = 'alto' | 'medio' | 'bajo' | 'desconocido';

export interface FilaCostoMargen {
  readonly organizationId: string;
  readonly nombre: string;
  readonly slug: string;
  readonly vertical: string;
  readonly orgStatus: string;
  readonly planId: string | null;
  readonly planNombre: string | null;
  readonly costoMicroUsd: CostoMicroUsd & { readonly total: number };
  readonly costoUsd: number;
  /** `null` mientras no haya tipo de cambio configurado. */
  readonly costoMxn: number | null;
  readonly costoMxnPorCategoria: Readonly<Record<CategoriaCosto, number>> | null;
  readonly eventosTotal: number;
  /** Eventos cuyo costo es estimado (aun sin conciliar con la factura del proveedor). */
  readonly eventosEstimados: number;
  readonly minutosVoz: number;
  readonly mensajes: number;
  readonly ingresoMxn: number | null;
  readonly ingresoRazon: RazonIngresoNulo | null;
  readonly asientosFacturables: number;
  readonly fuenteAsientos: FuenteAsientos;
  readonly margenMxn: number | null;
  readonly margenPct: number | null;
  readonly llmUsoPct: number;
  readonly consumo: readonly ConsumoLimite[];
  readonly alertas: readonly AlertaCosto[];
  readonly riesgo: Riesgo;
}

export interface OpcionesCostoMargen {
  /** MXN por 1 USD; `null` si no hay tipo de cambio configurado. */
  readonly mxnPorUsd: number | null;
  /** Margen (%) por debajo del cual se alerta. Default 30 (mismo umbral que atiende.ai). */
  readonly umbralMargenPct?: number;
}

export const UMBRAL_MARGEN_PCT_DEFAULT = 30;
const AVISO_LIMITE_PCT = 80;
const MICRO = 1_000_000;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function finitoNoNegativo(n: number, campo: string): number {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${campo} invalido (${n}): se esperaba un numero finito >= 0.`);
  return n;
}

export function totalMicroUsd(c: CostoMicroUsd): number {
  return c.llm + c.voz + c.whatsapp + c.telefonia + c.otros;
}

/** Convierte micro-USD a MXN; `null` sin tipo de cambio (nunca un tipo de cambio asumido). */
export function microUsdAMxn(microUsd: number, mxnPorUsd: number | null): number | null {
  if (mxnPorUsd === null) return null;
  if (!Number.isFinite(mxnPorUsd) || mxnPorUsd <= 0) throw new Error(`mxnPorUsd invalido (${mxnPorUsd}).`);
  return round2((microUsd / MICRO) * mxnPorUsd);
}

export interface IngresoEsperado {
  readonly ingresoMxn: number | null;
  readonly razon: RazonIngresoNulo | null;
  readonly asientosFacturables: number;
  readonly fuente: FuenteAsientos;
}

/**
 * Ingreso mensual ESPERADO segun el plan asignado (el contrato interno, no la foto de Stripe):
 *   base + asientosFacturables x precioPorAsiento.
 * Asientos: si la organizacion tiene suscripcion `activa` con seats > 0, esos seats YA son
 * facturables (Stripe cobra la cantidad que calcula `calcularPerSeat`, neta de incluidos). Si
 * no, se cuentan las sucursales activas y se restan los asientos incluidos del plan.
 */
export function calcularIngresoEsperado(
  plan: PlanPrecio | null,
  billingStatus: string | null,
  billingSeats: number | null,
  sucursalesActivas: number,
): IngresoEsperado {
  if (plan === null) return { ingresoMxn: null, razon: 'sin_plan', asientosFacturables: 0, fuente: 'ninguna' };
  if (plan.precioBaseCentavos === null && plan.precioAsientoCentavos === null) {
    return { ingresoMxn: null, razon: 'precio_no_configurado', asientosFacturables: 0, fuente: 'ninguna' };
  }
  if (billingSeats !== null) finitoNoNegativo(billingSeats, 'billingSeats');
  const usarBilling = billingStatus === 'activa' && billingSeats !== null && billingSeats > 0;
  const asientosFacturables = usarBilling
    ? finitoNoNegativo(billingSeats, 'billingSeats')
    : Math.max(finitoNoNegativo(sucursalesActivas, 'sucursalesActivas') - plan.asientosIncluidos, 0);
  const centavos = (plan.precioBaseCentavos ?? 0) + asientosFacturables * (plan.precioAsientoCentavos ?? 0);
  return {
    ingresoMxn: round2(centavos / 100),
    razon: null,
    asientosFacturables,
    fuente: usarBilling ? 'billing' : 'sucursales',
  };
}

/** Evalua cada limite del plan contra el uso real del mes consultado. */
export function evaluarLimites(limites: readonly LimitePlan[], e: Pick<EntradaCostoMargen, 'costo' | 'minutosVoz' | 'mensajes' | 'sucursalesActivas' | 'billingSeats'>): readonly ConsumoLimite[] {
  return limites.map((l) => {
    let uso: number | null;
    switch (l.metrica) {
      case 'llm_costo_micro_usd_mes':
        uso = e.costo.llm;
        break;
      case 'minutos_voz_mes':
        uso = e.minutosVoz;
        break;
      case 'mensajes_mes':
        uso = e.mensajes;
        break;
      case 'sucursales':
        uso = e.sucursalesActivas;
        break;
      case 'asientos':
        uso = e.billingSeats;
        break;
    }
    const aplicadoPorSistema = l.metrica === 'llm_costo_micro_usd_mes' && l.accion === 'pausar';
    if (uso === null) return { metrica: l.metrica, limite: l.limite, accion: l.accion, uso: null, pct: null, estado: 'sin_dato' as const, aplicadoPorSistema };
    const pct = l.limite > 0 ? (uso / l.limite) * 100 : uso > 0 ? Infinity : 0;
    const estado: EstadoLimite = uso > l.limite ? 'excedido' : pct >= AVISO_LIMITE_PCT ? 'aviso' : 'ok';
    return {
      metrica: l.metrica,
      limite: l.limite,
      accion: l.accion,
      uso,
      pct: Number.isFinite(pct) ? round2(pct) : null,
      estado,
      aplicadoPorSistema,
    };
  });
}

const ETIQUETA_METRICA: Readonly<Record<MetricaLimite, string>> = {
  llm_costo_micro_usd_mes: 'costo de LLM del mes',
  minutos_voz_mes: 'minutos de voz del mes',
  mensajes_mes: 'mensajes del mes',
  sucursales: 'sucursales activas',
  asientos: 'asientos contratados',
};

export function calcularFilaCostoMargen(entrada: EntradaCostoMargen, opciones: OpcionesCostoMargen): FilaCostoMargen {
  const umbral = opciones.umbralMargenPct ?? UMBRAL_MARGEN_PCT_DEFAULT;
  const c = entrada.costo;
  for (const [k, v] of Object.entries(c)) finitoNoNegativo(v, `costo.${k}`);
  const total = totalMicroUsd(c);
  const costoMxn = microUsdAMxn(total, opciones.mxnPorUsd);
  const costoMxnPorCategoria =
    opciones.mxnPorUsd === null
      ? null
      : {
          llm: microUsdAMxn(c.llm, opciones.mxnPorUsd) as number,
          voz: microUsdAMxn(c.voz, opciones.mxnPorUsd) as number,
          whatsapp: microUsdAMxn(c.whatsapp, opciones.mxnPorUsd) as number,
          telefonia: microUsdAMxn(c.telefonia, opciones.mxnPorUsd) as number,
          otros: microUsdAMxn(c.otros, opciones.mxnPorUsd) as number,
        };

  const ingreso = calcularIngresoEsperado(entrada.plan, entrada.billingStatus, entrada.billingSeats, entrada.sucursalesActivas);
  const margenMxn = ingreso.ingresoMxn !== null && costoMxn !== null ? round2(ingreso.ingresoMxn - costoMxn) : null;
  const margenPct = margenMxn !== null && ingreso.ingresoMxn !== null && ingreso.ingresoMxn > 0 ? round2((margenMxn / ingreso.ingresoMxn) * 100) : null;

  const llmUsoPct = entrada.llmCapMicroUsd > 0 ? round2((c.llm / entrada.llmCapMicroUsd) * 100) : 0;
  const consumo = evaluarLimites(entrada.limites, entrada);

  const alertas: AlertaCosto[] = [];
  if (margenMxn !== null && margenMxn < 0) {
    alertas.push({ codigo: 'margen_negativo', severidad: 'alta', mensaje: `Pierde dinero este mes: margen de ${margenMxn.toFixed(2)} MXN.` });
  } else if (margenPct !== null && margenPct < umbral) {
    alertas.push({ codigo: 'margen_bajo', severidad: 'media', mensaje: `Margen de ${margenPct.toFixed(1)}%, por debajo del umbral de ${umbral}%.` });
  }
  if (ingreso.ingresoMxn === 0 && total > 0) {
    alertas.push({ codigo: 'sin_ingreso_con_costo', severidad: 'media', mensaje: 'Genera costo pero su plan no le cobra nada este mes.' });
  }
  if (llmUsoPct >= 100) {
    alertas.push({ codigo: 'tope_llm_agotado', severidad: 'alta', mensaje: `Tope mensual de LLM agotado (${llmUsoPct.toFixed(0)}%).` });
  } else if (llmUsoPct >= entrada.llmAlertPct) {
    alertas.push({ codigo: 'tope_llm', severidad: 'media', mensaje: `Va en ${llmUsoPct.toFixed(0)}% de su tope mensual de LLM (alerta al ${entrada.llmAlertPct}%).` });
  }
  for (const l of consumo) {
    if (l.estado === 'excedido') {
      alertas.push({ codigo: 'limite_excedido', severidad: 'alta', mensaje: `Excede el limite de su plan en ${ETIQUETA_METRICA[l.metrica]} (accion: ${l.accion}${l.aplicadoPorSistema ? '' : '; hoy solo se avisa, no se corta'}).` });
    } else if (l.estado === 'aviso') {
      alertas.push({ codigo: 'limite_aviso', severidad: 'info', mensaje: `Va en ${l.pct?.toFixed(0)}% del limite de ${ETIQUETA_METRICA[l.metrica]}.` });
    }
  }

  const hayAlta = alertas.some((a) => a.severidad === 'alta');
  const hayMedia = alertas.some((a) => a.severidad === 'media');
  const riesgo: Riesgo = hayAlta ? 'alto' : hayMedia ? 'medio' : margenPct === null && ingreso.ingresoMxn === null ? 'desconocido' : 'bajo';

  return {
    organizationId: entrada.organizationId,
    nombre: entrada.nombre,
    slug: entrada.slug,
    vertical: entrada.vertical,
    orgStatus: entrada.orgStatus,
    planId: entrada.plan?.id ?? null,
    planNombre: entrada.plan?.nombre ?? null,
    costoMicroUsd: { ...c, total },
    costoUsd: round2(total / MICRO),
    costoMxn,
    costoMxnPorCategoria,
    eventosTotal: entrada.eventosTotal,
    eventosEstimados: entrada.eventosEstimados,
    minutosVoz: entrada.minutosVoz,
    mensajes: entrada.mensajes,
    ingresoMxn: ingreso.ingresoMxn,
    ingresoRazon: ingreso.razon,
    asientosFacturables: ingreso.asientosFacturables,
    fuenteAsientos: ingreso.fuente,
    margenMxn,
    margenPct,
    llmUsoPct,
    consumo,
    alertas,
    riesgo,
  };
}

export interface ResumenCostoMargen {
  readonly organizaciones: number;
  readonly costoUsd: number;
  readonly costoMxn: number | null;
  /** Suma del ingreso de las organizaciones CON precio conocido. */
  readonly ingresoMxn: number;
  readonly organizacionesSinIngreso: number;
  /** Margen solo sobre las organizaciones con ingreso y costo conocidos (comparable manzana con manzana). */
  readonly margenMxn: number | null;
  readonly margenPct: number | null;
  readonly enRiesgoAlto: number;
  readonly enRiesgoMedio: number;
}

export function resumirCostoMargen(filas: readonly FilaCostoMargen[]): ResumenCostoMargen {
  let costoUsdMicro = 0;
  let costoMxn: number | null = 0;
  let ingreso = 0;
  let sinIngreso = 0;
  let ingresoComparable = 0;
  let costoComparable = 0;
  let hayComparable = false;
  for (const f of filas) {
    costoUsdMicro += f.costoMicroUsd.total;
    if (f.costoMxn === null) costoMxn = null;
    else if (costoMxn !== null) costoMxn += f.costoMxn;
    if (f.ingresoMxn === null) sinIngreso += 1;
    else ingreso += f.ingresoMxn;
    if (f.ingresoMxn !== null && f.costoMxn !== null) {
      hayComparable = true;
      ingresoComparable += f.ingresoMxn;
      costoComparable += f.costoMxn;
    }
  }
  const margenMxn = hayComparable ? round2(ingresoComparable - costoComparable) : null;
  return {
    organizaciones: filas.length,
    costoUsd: round2(costoUsdMicro / MICRO),
    costoMxn: costoMxn === null ? null : round2(costoMxn),
    ingresoMxn: round2(ingreso),
    organizacionesSinIngreso: sinIngreso,
    margenMxn,
    margenPct: margenMxn !== null && ingresoComparable > 0 ? round2((margenMxn / ingresoComparable) * 100) : null,
    enRiesgoAlto: filas.filter((f) => f.riesgo === 'alto').length,
    enRiesgoMedio: filas.filter((f) => f.riesgo === 'medio').length,
  };
}

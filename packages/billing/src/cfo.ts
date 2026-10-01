// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD EJECUTIVO CFO, INGRESOS (MRR/ARR/NRR) Y ALERTAS (SA-01, SA-05, SA-36)
//
// Funciones PURAS que componen lo que ya calcula `cost-margin.ts` (costo, ingreso esperado
// por plan y margen por organizacion) en una sola vista ejecutiva. No leen nada ni envian
// nada: reciben filas ya calculadas y devuelven datos.
//
// REGLA DE LA CASA: nunca inventar una cifra. Lo que no tiene fuente (caja, NRR sin foto del
// mes anterior, ingreso de una organizacion sin plan o con plan sin precio) sale como `null`
// / `disponible: false` con su razon, jamas como 0.
//
// Definiciones (una sola, para que no existan dos "MRR"):
//   * MRR = suma del ingreso esperado por el plan asignado (base + asientos facturables x
//     precio por asiento) de las organizaciones `active` cuya suscripcion no esta `cancelada`.
//     Es el contrato interno, no lo cobrado por Stripe.
//   * ARR = MRR x 12.
//   * NRR = (MRR inicial + expansion - contraccion - churn) / MRR inicial, sobre las
//     organizaciones que ya aportaban MRR el mes anterior (el nuevo negocio no cuenta).
//   * GRR = igual que NRR pero sin expansion.
// ═══════════════════════════════════════════════════════════════════════════
import type { FilaCostoMargen, ResumenCostoMargen } from './cost-margin.ts';
import { resumirCostoMargen, UMBRAL_MARGEN_PCT_DEFAULT } from './cost-margin.ts';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Una organizacion tal como la ven el dashboard y las alertas. */
export interface FilaCfo {
  readonly fila: FilaCostoMargen;
  /** `organization_billing.status` (`null` si no hay fila). */
  readonly billingStatus: string | null;
  /** `organization_billing.current_period_end` en ms. */
  readonly billingPeriodEndMs: number | null;
}

/** Foto de ingreso de una organizacion en un mes (lo que guarda `core.billing_snapshot_monthly`). */
export interface SnapshotMrr {
  readonly organizationId: string;
  readonly orgStatus: string;
  readonly billingStatus: string | null;
  /** Centavos MXN; `null` = no se sabe (sin plan o plan sin precio). */
  readonly mrrCentavos: number | null;
}

/** Una organizacion aporta MRR si esta activa, no cancelo su suscripcion y su ingreso es conocido. */
export function aportaMrr(orgStatus: string, billingStatus: string | null, mrrCentavos: number | null): boolean {
  return orgStatus === 'active' && billingStatus !== 'cancelada' && mrrCentavos !== null && mrrCentavos > 0;
}

/** La foto "en vivo" del mes en curso, con el mismo formato que la guardada. */
export function snapshotDesdeFila(f: FilaCfo): SnapshotMrr {
  return {
    organizationId: f.fila.organizationId,
    orgStatus: f.fila.orgStatus,
    billingStatus: f.billingStatus,
    mrrCentavos: f.fila.ingresoMxn === null ? null : Math.round(f.fila.ingresoMxn * 100),
  };
}

// ───────────────────────────── Ingresos ─────────────────────────────

export interface IngresoVertical {
  readonly vertical: string;
  readonly mrrMxn: number;
  readonly clientes: number;
  /** Organizaciones activas de esta vertical sin ingreso conocido (sin plan o plan sin precio). */
  readonly sinPrecio: number;
}

export interface IngresoCliente {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly mrrMxn: number;
  /** Participacion en el MRR total (0-100). */
  readonly participacionPct: number;
}

export interface IngresosCfo {
  readonly mrrMxn: number;
  readonly arrMxn: number;
  readonly clientesConIngreso: number;
  /** Organizaciones activas cuyo ingreso no se puede calcular: su MRR NO esta en el total. */
  readonly clientesSinPrecio: number;
  readonly porVertical: readonly IngresoVertical[];
  readonly topClientes: readonly IngresoCliente[];
  /** Participacion del cliente mas grande (0-100); `null` sin MRR. Concentracion = riesgo. */
  readonly concentracionTopPct: number | null;
}

const TOP_CLIENTES = 5;

export function calcularIngresos(filas: readonly FilaCfo[]): IngresosCfo {
  const activas = filas.filter((f) => f.fila.orgStatus === 'active');
  const verticales = new Map<string, { mrr: number; clientes: number; sinPrecio: number }>();
  const clientes: Array<{ f: FilaCostoMargen; mrr: number }> = [];
  let mrr = 0;
  let sinPrecio = 0;
  for (const { fila, billingStatus } of activas) {
    const acc = verticales.get(fila.vertical) ?? { mrr: 0, clientes: 0, sinPrecio: 0 };
    if (fila.ingresoMxn === null) {
      acc.sinPrecio += 1;
      sinPrecio += 1;
    } else if (billingStatus !== 'cancelada' && fila.ingresoMxn > 0) {
      acc.mrr += fila.ingresoMxn;
      acc.clientes += 1;
      mrr += fila.ingresoMxn;
      clientes.push({ f: fila, mrr: fila.ingresoMxn });
    }
    verticales.set(fila.vertical, acc);
  }
  clientes.sort((a, b) => b.mrr - a.mrr || a.f.nombre.localeCompare(b.f.nombre));
  const total = round2(mrr);
  const top = clientes.slice(0, TOP_CLIENTES).map(({ f, mrr: m }) => ({
    organizationId: f.organizationId,
    nombre: f.nombre,
    vertical: f.vertical,
    mrrMxn: round2(m),
    participacionPct: total > 0 ? round2((m / total) * 100) : 0,
  }));
  return {
    mrrMxn: total,
    arrMxn: round2(total * 12),
    clientesConIngreso: clientes.length,
    clientesSinPrecio: sinPrecio,
    porVertical: [...verticales.entries()]
      .map(([vertical, v]) => ({ vertical, mrrMxn: round2(v.mrr), clientes: v.clientes, sinPrecio: v.sinPrecio }))
      .sort((a, b) => b.mrrMxn - a.mrrMxn || a.vertical.localeCompare(b.vertical)),
    topClientes: top,
    concentracionTopPct: top.length > 0 && total > 0 ? top[0]!.participacionPct : null,
  };
}

// ───────────────────────────── NRR ─────────────────────────────

export type NrrCfo =
  | {
      readonly disponible: true;
      readonly mrrInicialMxn: number;
      readonly expansionMxn: number;
      readonly contraccionMxn: number;
      readonly churnMxn: number;
      readonly nuevoMxn: number;
      readonly mrrFinalMxn: number;
      readonly nrrPct: number | null;
      readonly grrPct: number | null;
      /** Organizaciones con MRR el mes anterior cuyo ingreso actual no se conoce: no cuentan como churn ni como contraccion. */
      readonly excluidasSinDato: number;
    }
  | { readonly disponible: false; readonly razon: 'sin_foto_previa' | 'no_migrado' };

/**
 * NRR/GRR de `actual` contra `previo`. `previo = null` (no hay foto del mes anterior) devuelve
 * `disponible: false`: sin historia no hay expansion, contraccion ni churn que medir.
 */
export function calcularNrr(previo: readonly SnapshotMrr[] | null, actual: readonly SnapshotMrr[]): NrrCfo {
  if (previo === null || previo.length === 0) return { disponible: false, razon: 'sin_foto_previa' };
  const actualPorOrg = new Map(actual.map((s) => [s.organizationId, s]));
  const previoOrgs = new Set<string>();
  let inicial = 0;
  let expansion = 0;
  let contraccion = 0;
  let churn = 0;
  let excluidas = 0;
  for (const p of previo) {
    if (!aportaMrr(p.orgStatus, p.billingStatus, p.mrrCentavos)) continue;
    previoOrgs.add(p.organizationId);
    const prev = p.mrrCentavos as number;
    const cur = actualPorOrg.get(p.organizationId);
    if (cur && cur.orgStatus === 'active' && cur.billingStatus !== 'cancelada' && cur.mrrCentavos === null) {
      excluidas += 1;
      continue;
    }
    inicial += prev;
    const ahora = cur && aportaMrr(cur.orgStatus, cur.billingStatus, cur.mrrCentavos) ? (cur.mrrCentavos as number) : 0;
    if (ahora === 0) churn += prev;
    else if (ahora > prev) expansion += ahora - prev;
    else if (ahora < prev) contraccion += prev - ahora;
  }
  let nuevo = 0;
  for (const a of actual) {
    if (!previoOrgs.has(a.organizationId) && aportaMrr(a.orgStatus, a.billingStatus, a.mrrCentavos)) nuevo += a.mrrCentavos as number;
  }
  const mxn = (c: number) => round2(c / 100);
  const final = inicial + expansion - contraccion - churn;
  return {
    disponible: true,
    mrrInicialMxn: mxn(inicial),
    expansionMxn: mxn(expansion),
    contraccionMxn: mxn(contraccion),
    churnMxn: mxn(churn),
    nuevoMxn: mxn(nuevo),
    mrrFinalMxn: mxn(final + nuevo),
    nrrPct: inicial > 0 ? round2((final / inicial) * 100) : null,
    grrPct: inicial > 0 ? round2(((inicial - contraccion - churn) / inicial) * 100) : null,
    excluidasSinDato: excluidas,
  };
}

// ───────────────────────────── Alertas (SA-36) ─────────────────────────────

export type CodigoAlertaCfo = 'margen_bajo' | 'voz_sobre_tope' | 'cobranza_vencida' | 'cliente_en_riesgo';
export type SeveridadAlertaCfo = 'critica' | 'alta' | 'media';

export interface OrganizacionAlertada {
  readonly organizationId: string;
  readonly nombre: string;
  /** Dato que dispara la alerta, ya redactado en texto ("margen 12.5 %", "pago pendiente desde hace 9 dias"). */
  readonly dato: string;
}

export interface AlertaCfo {
  readonly codigo: CodigoAlertaCfo;
  readonly severidad: SeveridadAlertaCfo;
  readonly titulo: string;
  readonly organizaciones: readonly OrganizacionAlertada[];
}

const DIA_MS = 86_400_000;

export interface OpcionesAlertasCfo {
  readonly umbralMargenPct?: number;
  /** Reloj inyectado (los tests no dependen de la hora real). */
  readonly ahoraMs: number;
}

function diasDesde(ms: number | null, ahoraMs: number): number | null {
  if (ms === null || ms >= ahoraMs) return null;
  return Math.floor((ahoraMs - ms) / DIA_MS);
}

/**
 * Evalua las cuatro reglas del CFO sobre organizaciones ACTIVAS (una prueba o una suspendida
 * no es riesgo de margen ni de cobranza). Sin LLM y sin I/O: cada alerta lleva el dato que la
 * dispara. Una alerta por regla (con la lista de organizaciones), no una por organizacion:
 * el CFO recibe un resumen, no una inundacion.
 */
export function evaluarAlertasCfo(filas: readonly FilaCfo[], opciones: OpcionesAlertasCfo): readonly AlertaCfo[] {
  const umbral = opciones.umbralMargenPct ?? UMBRAL_MARGEN_PCT_DEFAULT;
  const margen: OrganizacionAlertada[] = [];
  const voz: OrganizacionAlertada[] = [];
  const cobranza: OrganizacionAlertada[] = [];
  const riesgo: OrganizacionAlertada[] = [];

  for (const { fila, billingStatus, billingPeriodEndMs } of filas) {
    if (fila.orgStatus !== 'active') continue;
    const base = { organizationId: fila.organizationId, nombre: fila.nombre };
    const senales: string[] = [];

    // El umbral de ESTA evaluacion manda (la fila pudo calcularse con otro): se compara el margen directo.
    const negativo = fila.margenMxn !== null && fila.margenMxn < 0;
    const bajo = fila.margenPct !== null && fila.margenPct < umbral;
    if (negativo || bajo) {
      const dato = bajo ? `margen ${(fila.margenPct as number).toFixed(1)} % (umbral ${umbral} %)` : `margen negativo de ${(fila.margenMxn as number).toFixed(2)} MXN`;
      margen.push({ ...base, dato });
      senales.push('margen bajo');
    }

    const vozExcedida = fila.consumo.find((c) => c.metrica === 'minutos_voz_mes' && c.estado === 'excedido');
    if (vozExcedida && vozExcedida.uso !== null) {
      voz.push({ ...base, dato: `${Math.round(vozExcedida.uso)} min de voz sobre un tope de ${vozExcedida.limite} min/mes` });
      senales.push('voz sobre tope');
    }

    if (billingStatus === 'pago_pendiente') {
      const dias = diasDesde(billingPeriodEndMs, opciones.ahoraMs);
      cobranza.push({ ...base, dato: dias === null ? 'pago pendiente' : `pago pendiente, periodo vencido hace ${dias} dias` });
      senales.push('cobranza vencida');
    }

    if (fila.alertas.some((a) => a.codigo === 'tope_llm_agotado' || a.codigo === 'tope_llm')) senales.push('tope de LLM');

    if (senales.length >= 2) riesgo.push({ ...base, dato: senales.join(' + ') });
  }

  const alertas: AlertaCfo[] = [];
  const empuja = (codigo: CodigoAlertaCfo, severidad: SeveridadAlertaCfo, titulo: string, organizaciones: OrganizacionAlertada[]) => {
    if (organizaciones.length === 0) return;
    organizaciones.sort((a, b) => a.nombre.localeCompare(b.nombre) || a.organizationId.localeCompare(b.organizationId));
    alertas.push({ codigo, severidad, titulo, organizaciones });
  };
  empuja('cliente_en_riesgo', 'critica', 'Clientes en riesgo (dos o mas senales)', riesgo);
  empuja('margen_bajo', 'alta', `Clientes con margen bajo el ${umbral} %`, margen);
  empuja('cobranza_vencida', 'alta', 'Cobranza vencida', cobranza);
  empuja('voz_sobre_tope', 'media', 'Voz sobre el tope del plan', voz);
  return alertas;
}

// ───────────────────────────── Dashboard ─────────────────────────────

export interface ClienteMargen {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly ingresoMxn: number;
  readonly costoMxn: number;
  readonly margenMxn: number;
  readonly margenPct: number | null;
}

export type MargenCfo =
  | {
      readonly disponible: true;
      readonly resumen: ResumenCostoMargen;
      readonly umbralMargenPct: number;
      readonly clientesBajoUmbral: number;
      /** Organizaciones activas con margen calculable (ingreso y costo conocidos). */
      readonly clientesConMargen: number;
      readonly mejores: readonly ClienteMargen[];
      readonly peores: readonly ClienteMargen[];
    }
  | { readonly disponible: false; readonly razon: 'sin_tipo_de_cambio' | 'sin_ingreso_conocido' };

export interface CajaCfo {
  readonly disponible: false;
  readonly razon: string;
}

export interface CobranzaCfo {
  readonly pagoPendiente: number;
  /** MRR de los clientes con pago pendiente; `null` si ninguno tiene ingreso conocido. */
  readonly mrrEnRiesgoMxn: number | null;
}

export interface DashboardCfo {
  readonly mes: string;
  readonly ingresos: IngresosCfo;
  readonly nrr: NrrCfo;
  readonly margen: MargenCfo;
  readonly caja: CajaCfo;
  readonly cobranza: CobranzaCfo;
  readonly alertas: readonly AlertaCfo[];
}

export interface EntradaDashboardCfo {
  readonly mes: string;
  readonly filas: readonly FilaCfo[];
  readonly umbralMargenPct?: number;
  readonly mxnPorUsd: number | null;
  /** Foto del mes anterior; `null` = no existe (o la migracion no esta aplicada). */
  readonly snapshotsPrevios: readonly SnapshotMrr[] | null;
  /** Foto del mes consultado: la guardada o, en el mes en curso, la calculada en vivo. */
  readonly snapshotsActuales: readonly SnapshotMrr[];
  readonly ahoraMs: number;
}

const MEJORES_PEORES = 5;

function aClienteMargen(f: FilaCostoMargen): ClienteMargen {
  return {
    organizationId: f.organizationId,
    nombre: f.nombre,
    vertical: f.vertical,
    ingresoMxn: f.ingresoMxn as number,
    costoMxn: f.costoMxn as number,
    margenMxn: f.margenMxn as number,
    margenPct: f.margenPct,
  };
}

export function armarDashboardCfo(e: EntradaDashboardCfo): DashboardCfo {
  const umbral = e.umbralMargenPct ?? UMBRAL_MARGEN_PCT_DEFAULT;
  const activas = e.filas.filter((f) => f.fila.orgStatus === 'active');

  let margen: MargenCfo;
  const comparables = activas.map((f) => f.fila).filter((f) => f.ingresoMxn !== null && f.costoMxn !== null && f.margenMxn !== null);
  if (e.mxnPorUsd === null) margen = { disponible: false, razon: 'sin_tipo_de_cambio' };
  else if (comparables.length === 0) margen = { disponible: false, razon: 'sin_ingreso_conocido' };
  else {
    // Mayor a menor margen %; los de ingreso 0 (margenPct null) cuentan como el peor extremo.
    const orden = [...comparables].sort((a, b) => (b.margenPct ?? -1e9) - (a.margenPct ?? -1e9) || a.nombre.localeCompare(b.nombre));
    const n = orden.length;
    const k = Math.min(MEJORES_PEORES, Math.ceil(n / 2));
    const m = Math.min(MEJORES_PEORES, Math.floor(n / 2));
    margen = {
      disponible: true,
      resumen: resumirCostoMargen(activas.map((f) => f.fila)),
      umbralMargenPct: umbral,
      clientesBajoUmbral: comparables.filter((f) => (f.margenPct !== null && f.margenPct < umbral) || (f.margenMxn as number) < 0).length,
      clientesConMargen: n,
      mejores: orden.slice(0, k).map(aClienteMargen),
      peores: orden.slice(n - m).reverse().map(aClienteMargen),
    };
  }

  const pendientes = activas.filter((f) => f.billingStatus === 'pago_pendiente');
  const conIngreso = pendientes.filter((f) => f.fila.ingresoMxn !== null);
  const cobranza: CobranzaCfo = {
    pagoPendiente: pendientes.length,
    mrrEnRiesgoMxn: conIngreso.length === 0 ? null : round2(conIngreso.reduce((s, f) => s + (f.fila.ingresoMxn as number), 0)),
  };

  return {
    mes: e.mes,
    ingresos: calcularIngresos(e.filas),
    nrr: e.snapshotsPrevios === null ? { disponible: false, razon: 'sin_foto_previa' } : calcularNrr(e.snapshotsPrevios, e.snapshotsActuales),
    margen,
    caja: { disponible: false, razon: 'Todavia no hay una fuente de caja (saldos bancarios, cuentas por cobrar y pagos); el forecast de caja es un item pendiente.' },
    cobranza,
    alertas: evaluarAlertasCfo(e.filas, { umbralMargenPct: umbral, ahoraMs: e.ahoraMs }),
  };
}

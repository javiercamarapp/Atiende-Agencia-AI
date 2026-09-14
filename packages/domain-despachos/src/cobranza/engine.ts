// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE COBRANZA AUTOMATIZADA — puerto determinista (sin LLM) de
// ~/Desktop/supabase/despachos/b2b_ai/services/collections.py +
// collections_report.py (CollectionsManager.analyze/collectability_score/
// build_reminder + aging_report/projection/summary). Mismo criterio que
// vencimientos/engine.ts en este mismo paquete: lógica de negocio pura,
// 100% testeable, sin acceso a base de datos — el repositorio (ver
// `registerReceivable`/`listReceivables`/`insertCollectionEvent` en
// `../repository.ts`) es quien persiste la cuenta por cobrar y el historial
// de recordatorios que alimentan `scoreCobrabilidad`.
//
// GAP REAL VERIFICADO (auditoría previa a esta fase): `packages/domain-
// despachos` no tenía ningún módulo de cobranza — ni seguimiento de estado
// de facturas emitidas vs. pagos recibidos, ni aging, ni recordatorios
// escalonados. El origen Python cubre esto con 3 archivos
// (collections.py/collections_report.py/collections_templates.py) — este
// archivo + templates.ts son el port de esos 3.
//
// FIDELIDAD AL ORIGEN — el origen NUNCA envía mensajes reales (ver docstring
// de `CollectionsManager` en collections.py: "NO envía mensajes reales: solo
// genera el contenido y, opcionalmente, lo registra... El envío real queda a
// cargo del canal de notificaciones del cliente"). Este port respeta EXACTO
// ese límite: `construirRecordatorioCobranza` solo genera contenido
// (subject/body o texto de WhatsApp); no hay integración con
// `messaging_outbox`/`whatsapp-gateway` aquí — conectar el contenido
// generado a un canal de envío real es trabajo de una fase futura, no una
// omisión silenciosa de esta (ver README del vertical para el registro
// explícito de este límite).
// ═══════════════════════════════════════════════════════════════════════════
import { COBRANZA_STAGE_OFFSET_DAYS, COBRANZA_REMINDER_SEQUENCE, formatMontoCobranza, renderAsuntoRecordatorioCobranza, renderRecordatorioCobranza, type CobranzaReminderStage } from "./templates.ts";

export type { CobranzaReminderStage } from "./templates.ts";
export { COBRANZA_REMINDER_SEQUENCE, COBRANZA_STAGE_OFFSET_DAYS } from "./templates.ts";

/** Buckets de antigüedad de cartera — port literal de `AGE_BUCKETS`. */
export const COBRANZA_AGE_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;
export type CobranzaAgeBucket = (typeof COBRANZA_AGE_BUCKETS)[number];

function parseIsoDate(v: string): number {
  return Date.parse(`${v.slice(0, 10)}T00:00:00Z`);
}

/** Clasifica una cuenta por cobrar por días de atraso en un bucket de
 * antigüedad — port literal de `age_bucket`. Un monto no vencido
 * (`diasVencido <= 0`) cae en '0-30' (al corriente / no vencido), igual que
 * el origen. */
export function cobranzaAgeBucket(diasVencido: number): CobranzaAgeBucket {
  const d = Number.isFinite(diasVencido) ? Math.trunc(diasVencido) : 0;
  if (d <= 0) return "0-30";
  if (d <= 30) return "0-30";
  if (d <= 60) return "31-60";
  if (d <= 90) return "61-90";
  return "90+";
}

/** Días de atraso de una cuenta por cobrar respecto a hoy (negativo si aún
 * no vence) — port literal de `days_overdue`. `fechaVencimiento`/`todayIso`:
 * "YYYY-MM-DD". */
export function diasVencidoCartera(fechaVencimiento: string, todayIso: string): number {
  const due = parseIsoDate(fechaVencimiento);
  const today = parseIsoDate(todayIso);
  return Math.round((today - due) / 86_400_000);
}

const OFFSET_TO_STAGE: ReadonlyMap<number, CobranzaReminderStage> = new Map(COBRANZA_REMINDER_SEQUENCE.map((stage) => [-COBRANZA_STAGE_OFFSET_DAYS[stage], stage]));

/** Etapa de la secuencia de cobranza que corresponde HOY para una cuenta por
 * cobrar — port literal de `reminder_stage`: compara la fecha de
 * vencimiento contra hoy y devuelve la etapa cuyo offset en días coincide
 * EXACTAMENTE (-7/0/+7/+30/+60); en cualquier otra fecha devuelve `null` (no
 * toca enviar recordatorio hoy). */
export function etapaRecordatorioCobranzaHoy(fechaVencimiento: string, todayIso: string): CobranzaReminderStage | null {
  const due = parseIsoDate(fechaVencimiento);
  const today = parseIsoDate(todayIso);
  const delta = Math.round((due - today) / 86_400_000); // negativo = vencida hace |delta| días
  return OFFSET_TO_STAGE.get(delta) ?? null;
}

/** Un intento de contacto/respuesta ya registrado para una cuenta por cobrar
 * — port del shape de `CollectionEvent` que `collectability_score` lee del
 * historial (`tipo_recordatorio`/`respuesta`). */
export interface HistorialCobranzaEntry {
  readonly tipoRecordatorio: string;
  readonly respuesta: string | null;
}

const SCORE_BASE_POR_BUCKET: Record<CobranzaAgeBucket, number> = {
  "0-30": 0.75,
  "31-60": 0.55,
  "61-90": 0.38,
  "90+": 0.22,
};

/** Probabilidad de cobro (0..1) basada en antigüedad e historial — port
 * literal de `collectability_score`:
 *  1. Base por antigüedad (más vieja la deuda, menos cobrable).
 *  2. Ajuste por historial: 'pagado' -> 1.0 (ya cobrada); 'promesa_pago' ->
 *     +0.15; cualquier respuesta registrada -> +0.10; cada etapa de
 *     escalamiento alcanzada (segundo_recordatorio/escalamiento) -> -0.05.
 * Recortado a [0, 1] y redondeado a 2 decimales, igual que el origen. */
export function scoreCobrabilidadCartera(diasVencido: number, historial: readonly HistorialCobranzaEntry[] = []): number {
  let score = SCORE_BASE_POR_BUCKET[cobranzaAgeBucket(diasVencido)];

  if (historial.length > 0) {
    const respuestas = historial.map((h) => h.respuesta).filter((r): r is string => r !== null && r !== "");
    if (respuestas.includes("pagado")) return 1.0;
    if (respuestas.includes("promesa_pago")) score += 0.15;
    if (respuestas.length > 0) score += 0.1;
    const etapaAvance = historial.filter((h) => h.tipoRecordatorio === "segundo_recordatorio" || h.tipoRecordatorio === "escalamiento").length;
    score -= 0.05 * etapaAvance;
  }

  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Análisis de cartera — port de `CollectionsManager.analyze` (collections.py).
// ---------------------------------------------------------------------------
export interface CuentaPorCobrarInput {
  readonly facturaId: string;
  readonly nombreCliente: string;
  readonly monto: number;
  readonly fechaVencimiento: string; // "YYYY-MM-DD"
}

export interface CuentaPorCobrarAnalizada extends CuentaPorCobrarInput {
  readonly diasVencido: number;
  readonly bucket: CobranzaAgeBucket;
  readonly score: number;
}

export interface BucketCartera {
  readonly count: number;
  readonly monto: number;
}

export interface CarteraAnalizada {
  readonly totalInvoices: number;
  readonly totalMonto: number;
  readonly buckets: Record<CobranzaAgeBucket, BucketCartera>;
  readonly invoices: readonly CuentaPorCobrarAnalizada[];
}

function bucketsVacios(): Record<CobranzaAgeBucket, { count: number; monto: number }> {
  return { "0-30": { count: 0, monto: 0 }, "31-60": { count: 0, monto: 0 }, "61-90": { count: 0, monto: 0 }, "90+": { count: 0, monto: 0 } };
}

/** Analiza la cartera pendiente y la clasifica por antigüedad, calculando el
 * score de cobrabilidad de cada cuenta — port literal de
 * `CollectionsManager.analyze`. `historiales` (opcional): historial de
 * eventos de cobranza por `facturaId`, para que `scoreCobrabilidadCartera`
 * lo pondere (equivalente a que el origen lea `db.list_collection_events`
 * cuando no se le pasa `history` explícito). */
export function analizarCarteraCobranza(cuentas: readonly CuentaPorCobrarInput[], todayIso: string, historiales?: ReadonlyMap<string, readonly HistorialCobranzaEntry[]>): CarteraAnalizada {
  const buckets = bucketsVacios();
  let totalMonto = 0;
  const invoices: CuentaPorCobrarAnalizada[] = [];

  for (const cuenta of cuentas) {
    const diasVencido = diasVencidoCartera(cuenta.fechaVencimiento, todayIso);
    const bucket = cobranzaAgeBucket(diasVencido);
    const score = scoreCobrabilidadCartera(diasVencido, historiales?.get(cuenta.facturaId) ?? []);
    invoices.push({ ...cuenta, diasVencido, bucket, score });
    buckets[bucket].count += 1;
    buckets[bucket].monto += cuenta.monto;
    totalMonto += cuenta.monto;
  }

  return { totalInvoices: invoices.length, totalMonto, buckets, invoices };
}

// ---------------------------------------------------------------------------
// Reportes de cobranza — port de collections_report.py (aging_report,
// projection, summary). A diferencia de `analizarCarteraCobranza` (que
// CALCULA el score), estos reportes leen el `score` YA calculado de cada
// cuenta (0 si no viene) — mismo criterio del origen (`_score_of`):
// se encadenan sobre la salida de `analizarCarteraCobranza` o sobre cartera
// ya sincronizada en el repositorio con su score persistido.
// ---------------------------------------------------------------------------
export interface CuentaPorCobrarConScore extends CuentaPorCobrarInput {
  readonly score?: number;
}

export interface ReporteAntiguedadCartera {
  readonly buckets: Record<CobranzaAgeBucket, BucketCartera>;
  readonly totalCount: number;
  readonly totalMonto: number;
  readonly invoices: readonly CuentaPorCobrarAnalizada[];
}

/** Cartera pendiente agrupada por antigüedad — port literal de
 * `aging_report`. */
export function reporteAntiguedadCartera(cuentas: readonly CuentaPorCobrarConScore[], todayIso: string): ReporteAntiguedadCartera {
  const buckets = bucketsVacios();
  const invoices: CuentaPorCobrarAnalizada[] = [];
  for (const cuenta of cuentas) {
    const diasVencido = diasVencidoCartera(cuenta.fechaVencimiento, todayIso);
    const bucket = cobranzaAgeBucket(diasVencido);
    const score = cuenta.score ?? 0;
    buckets[bucket].count += 1;
    buckets[bucket].monto += cuenta.monto;
    invoices.push({ ...cuenta, diasVencido, bucket, score });
  }
  const totalMonto = Object.values(buckets).reduce((acc, b) => acc + b.monto, 0);
  const totalCount = Object.values(buckets).reduce((acc, b) => acc + b.count, 0);
  return { buckets, totalCount, totalMonto, invoices };
}

export interface RangoScoreProyeccion {
  readonly count: number;
  readonly montoTotal: number;
  readonly esperado: number;
}

export interface ProyeccionCobranza {
  readonly totalCartera: number;
  readonly totalEsperado: number;
  readonly tasaRecuperacionEsperada: number; // porcentaje, redondeado a 2 decimales
  readonly porBucket: Record<CobranzaAgeBucket, { readonly montoTotal: number; readonly esperado: number }>;
  readonly porScore: { readonly alta: RangoScoreProyeccion; readonly media: RangoScoreProyeccion; readonly baja: RangoScoreProyeccion };
}

/** Proyección de cobro esperado ponderando cada cuenta por su score de
 * cobrabilidad (esperado = monto × score) — port literal de `projection`.
 * Agrupa por bucket de antigüedad y por rango de score (alta >=0.7, media
 * 0.4-0.7, baja <0.4). */
export function proyeccionCobranza(cuentas: readonly CuentaPorCobrarConScore[], todayIso: string): ProyeccionCobranza {
  const porBucket: Record<CobranzaAgeBucket, { montoTotal: number; esperado: number }> = {
    "0-30": { montoTotal: 0, esperado: 0 },
    "31-60": { montoTotal: 0, esperado: 0 },
    "61-90": { montoTotal: 0, esperado: 0 },
    "90+": { montoTotal: 0, esperado: 0 },
  };
  const porScore = {
    alta: { count: 0, montoTotal: 0, esperado: 0 },
    media: { count: 0, montoTotal: 0, esperado: 0 },
    baja: { count: 0, montoTotal: 0, esperado: 0 },
  };

  for (const cuenta of cuentas) {
    const diasVencido = diasVencidoCartera(cuenta.fechaVencimiento, todayIso);
    const bucket = cobranzaAgeBucket(diasVencido);
    const score = cuenta.score ?? 0;
    const esperado = cuenta.monto * score;

    porBucket[bucket].montoTotal += cuenta.monto;
    porBucket[bucket].esperado += esperado;

    const key = score >= 0.7 ? "alta" : score >= 0.4 ? "media" : "baja";
    porScore[key].count += 1;
    porScore[key].montoTotal += cuenta.monto;
    porScore[key].esperado += esperado;
  }

  const totalCartera = Object.values(porBucket).reduce((acc, b) => acc + b.montoTotal, 0);
  const totalEsperado = Object.values(porBucket).reduce((acc, b) => acc + b.esperado, 0);

  return {
    totalCartera,
    totalEsperado,
    tasaRecuperacionEsperada: totalCartera ? Math.round((totalEsperado / totalCartera) * 10000) / 100 : 0,
    porBucket,
    porScore,
  };
}

export interface TopMontoCartera {
  readonly facturaId: string;
  readonly nombreCliente: string;
  readonly monto: number;
  readonly diasVencido: number;
  readonly bucket: CobranzaAgeBucket;
  readonly score: number;
}

export interface ResumenCobranza {
  readonly totalCartera: number;
  readonly totalCount: number;
  readonly totalEsperado: number;
  readonly tasaRecuperacionEsperada: number;
  readonly porAntiguedad: Record<CobranzaAgeBucket, { readonly count: number; readonly monto: number; readonly porcentaje: number }>;
  readonly alertas: readonly string[];
  readonly topMontos: readonly TopMontoCartera[];
}

/** Resumen ejecutivo de cobranza: montos por antigüedad, tasas, alertas
 * (cuentas en bucket 90+ o con score < 0.4) y los 5 montos pendientes más
 * altos — port literal de `summary`. */
export function resumenCobranza(cuentas: readonly CuentaPorCobrarConScore[], todayIso: string): ResumenCobranza {
  const aging = reporteAntiguedadCartera(cuentas, todayIso);
  const proj = proyeccionCobranza(cuentas, todayIso);
  const total = aging.totalMonto;

  const ratio = (bucket: CobranzaAgeBucket): number => (total ? Math.round((aging.buckets[bucket].monto / total) * 10000) / 100 : 0);

  const alertas: string[] = [];
  const vencido90 = aging.buckets["90+"].monto;
  if (vencido90 > 0) {
    alertas.push(`${aging.buckets["90+"].count} factura(s) con más de 90 días (${formatMontoCobranza(vencido90)}) requieren escalamiento inmediato.`);
  }
  const bajos = aging.invoices.filter((i) => i.score < 0.4);
  if (bajos.length > 0) {
    const sumaBajos = bajos.reduce((acc, i) => acc + i.monto, 0);
    alertas.push(`${bajos.length} factura(s) con score de cobrabilidad bajo (<0.4) acumulan ${formatMontoCobranza(sumaBajos)}.`);
  }

  const topMontos = [...aging.invoices].sort((a, b) => b.monto - a.monto).slice(0, 5);

  return {
    totalCartera: aging.totalMonto,
    totalCount: aging.totalCount,
    totalEsperado: proj.totalEsperado,
    tasaRecuperacionEsperada: proj.tasaRecuperacionEsperada,
    porAntiguedad: {
      "0-30": { ...aging.buckets["0-30"], porcentaje: ratio("0-30") },
      "31-60": { ...aging.buckets["31-60"], porcentaje: ratio("31-60") },
      "61-90": { ...aging.buckets["61-90"], porcentaje: ratio("61-90") },
      "90+": { ...aging.buckets["90+"], porcentaje: ratio("90+") },
    },
    alertas,
    topMontos,
  };
}

// ---------------------------------------------------------------------------
// Generación de recordatorios — port literal de
// `CollectionsManager.build_reminder`. NO envía nada (ver nota de fidelidad
// de cabecera); solo genera el contenido listo para que un canal real (fuera
// de alcance de esta fase) lo despache.
// ---------------------------------------------------------------------------
export interface RecordatorioCobranza {
  readonly stage: CobranzaReminderStage;
  readonly channel: "email" | "whatsapp";
  readonly subject?: string;
  readonly body?: string;
  readonly whatsapp?: string;
  readonly facturaId: string;
}

/** Genera el contenido del recordatorio para una etapa y canal — port
 * literal de `build_reminder`. Personaliza con nombre de cliente, monto
 * formateado, días vencidos y facturaId. NUNCA envía ni registra nada por sí
 * mismo (ver nota de fidelidad de cabecera). */
export function construirRecordatorioCobranza(factura: { readonly facturaId: string; readonly nombreCliente: string; readonly monto: number; readonly diasVencido: number }, stage: CobranzaReminderStage, channel: "email" | "whatsapp" = "email"): RecordatorioCobranza {
  const vars = {
    nombreEmpresa: factura.nombreCliente,
    monto: formatMontoCobranza(factura.monto),
    diasVencido: String(factura.diasVencido),
    facturaId: factura.facturaId,
  };
  if (channel === "email") {
    return { stage, channel, subject: renderAsuntoRecordatorioCobranza(stage, vars), body: renderRecordatorioCobranza(stage, "email", vars), facturaId: factura.facturaId };
  }
  return { stage, channel, whatsapp: renderRecordatorioCobranza(stage, "whatsapp", vars), facturaId: factura.facturaId };
}

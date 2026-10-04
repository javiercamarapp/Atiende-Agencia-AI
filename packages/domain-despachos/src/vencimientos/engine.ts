// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE VENCIMIENTOS FISCALES — puerto determinista (sin LLM) de
// ~/Desktop/supabase/despachos/b2b_ai/features/vencimientos/service.py
// (VencimientosService: calculate_deadlines/_calculate_priority/escalate).
// Mismo criterio que folioEngine.ts/quote.ts en domain-hoteles: lógica de negocio
// pura, 100% testeable, sin acceso a base de datos (el repositorio es quien persiste).
//
// D-26: el origen ponía las 4 obligaciones el día 17 sin ajustar por día hábil. Ahora las fechas salen de
// `calendario-fiscal.ts` (art. 12 CFF, plazos por obligación y régimen); `fechaLimiteDia17MesSiguiente` se
// conserva solo como fecha NOMINAL (sin ajuste) y ya no la usa el cálculo de vencimientos.
// ═══════════════════════════════════════════════════════════════════════════
import { calcularCalendarioFiscal } from "./calendario-fiscal.ts";
import type { TipoVencimientoFiscal } from "./calendario-fiscal.ts";

export type PrioridadVencimiento = "critica" | "alta" | "media" | "baja";
export type EstadoVencimiento = "pendiente" | "en_proceso" | "completado" | "vencido" | "escalado";
export type NivelEscalamiento = "nivel_1" | "nivel_2" | "nivel_3" | "nivel_4";
export type TipoVencimiento = TipoVencimientoFiscal;

/** Los 4 tipos originales (migración 001), los 2 que agrega la migración 019 (Balanza, Anual) y los 5 de la 024 (Retenciones, IMSS, IMSS-bimestral, ISN, Informativa). */
export const TIPOS_VENCIMIENTO_BASE: readonly TipoVencimiento[] = ["ISR", "IVA", "DIOT", "Nómina"];
export const TIPOS_VENCIMIENTO_MIGRACION_019: readonly TipoVencimiento[] = ["Balanza", "Anual"];
export const TIPOS_VENCIMIENTO_MIGRACION_024: readonly TipoVencimiento[] = ["Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Informativa"];
export const TIPOS_VENCIMIENTO: readonly TipoVencimiento[] = ["ISR", "IVA", "DIOT", "Nómina", "Balanza", "Anual", "Retenciones", "IMSS", "IMSS-bimestral", "ISN", "Informativa"];

/** YYYY-MM-DD NOMINAL del día 17 del mes SIGUIENTE a (year, month), SIN ajuste por día hábil (art. 12 CFF). Solo
 * referencia; las fechas límite reales salen de `calcularCalendarioFiscal`. `month` es 1-12. */
export function fechaLimiteDia17MesSiguiente(year: number, month: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-17`;
}

/** Días completos entre `todayIso` (YYYY-MM-DD) y `fechaLimite` (YYYY-MM-DD) —
 * negativo si ya venció. Port de `_days_until`, comparando fechas naive de
 * calendario (sin horas), que es lo único que el origen necesita en la práctica
 * (compara contra `datetime.now()` truncado a medianoche vía strftime). */
export function diasHasta(fechaLimite: string, todayIso: string): number {
  const target = Date.parse(`${fechaLimite}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  return Math.round((target - today) / 86_400_000);
}

/** Port literal de `_calculate_priority` (líneas 375-386). */
export function calcularPrioridad(diasRestantes: number): PrioridadVencimiento {
  if (diasRestantes < 0) return "critica";
  if (diasRestantes === 0) return "critica";
  if (diasRestantes <= 3) return "alta";
  if (diasRestantes <= 7) return "media";
  return "baja";
}

export interface DecisionEscalamiento {
  readonly level: NivelEscalamiento;
  readonly requiresHumanReview: true;
  readonly humanReviewReason: string;
  readonly notes: string;
}

/** Port literal de `escalate` (líneas 188-235) — el evento de escalamiento en sí es
 * responsabilidad del repositorio (persistir la fila `deadline_escalation`); esta
 * función solo decide EL NIVEL y el texto, determinista y testeable sin DB.
 * CFF art. 89: todo escalamiento exige revisión humana (`requires_human_review`
 * siempre `true` aquí — nunca se autocompletará un vencimiento fiscal sin que un
 * humano lo confirme, mismo espíritu de "anti-alucinación" que el flujo de revisión
 * de CFDI). */
export function decidirEscalamiento(tipo: TipoVencimiento, fechaLimite: string, diasRestantes: number): DecisionEscalamiento {
  let level: NivelEscalamiento;
  if (diasRestantes < 0) level = "nivel_4";
  else if (diasRestantes === 0) level = "nivel_3";
  else if (diasRestantes <= 1) level = "nivel_2";
  else level = "nivel_1";

  return {
    level,
    requiresHumanReview: true,
    humanReviewReason: `Escalamiento nivel ${level} para vencimiento ${tipo}`,
    notes: `Escalamiento automático para '${tipo}'. Fecha límite: ${fechaLimite}. Días restantes: ${diasRestantes}.`,
  };
}

/** Días hábiles de anticipación a los que el barrido empieza a avisar: 7, 3 y 1 (como el sistema suelto, `deadline_engine.py`). */
export const AVISOS_DIAS_HABILES: readonly number[] = [7, 3, 1];

/**
 * D-P3-33: decisión de escalamiento por DÍAS HÁBILES (el barrido avisaba por días naturales: un vencimiento a 7 hábiles quedaba sin aviso
 * y el viernes anterior a un 17 en lunes tampoco). `null` = aún falta más de 7 días hábiles: no toca avisar.
 *   <= 7 hábiles -> nivel_1 (primer aviso)   <= 3 -> nivel_2   <= 1 (o vence hoy) -> nivel_3   ya venció -> nivel_4
 * Cada nivel se registra una sola vez por vencimiento (el barrido no repite un nivel igual o mayor), así que un cron que se salte un día
 * no pierde el aviso: al volver a correr avisa del nivel que corresponda. Todo escalamiento exige revisión humana (CFF art. 89).
 */
export function decidirEscalamientoHabil(tipo: TipoVencimiento, fechaLimite: string, diasHabiles: number): DecisionEscalamiento | null {
  const maximo = Math.max(...AVISOS_DIAS_HABILES);
  if (diasHabiles > maximo) return null;
  let level: NivelEscalamiento;
  if (diasHabiles < 0) level = "nivel_4";
  else if (diasHabiles <= 1) level = "nivel_3";
  else if (diasHabiles <= 3) level = "nivel_2";
  else level = "nivel_1";
  const cuando = diasHabiles < 0 ? "ya venció" : diasHabiles === 0 ? "vence hoy" : `faltan ${diasHabiles} día(s) hábil(es)`;
  return {
    level,
    requiresHumanReview: true,
    humanReviewReason: `Escalamiento nivel ${level} para vencimiento ${tipo}`,
    notes: `Aviso automático para '${tipo}'. Fecha límite: ${fechaLimite}; ${cuando}.`,
  };
}

export interface NuevoVencimiento {
  readonly tipo: TipoVencimiento;
  readonly fechaLimite: string;
  readonly prioridad: PrioridadVencimiento;
  readonly descripcion: string;
  readonly periodo: string;
  /** Fecha del plazo antes del ajuste a día hábil (art. 12 CFF). */
  readonly fechaNominal: string;
  readonly ajustadaPorDiaInhabil: boolean;
  readonly fundamento: string;
  readonly validarConFiscalista: boolean;
  readonly nota: string | null;
}

/** Régimen que se asume cuando el despacho no capturó el del contribuyente: persona moral del régimen general. */
export const REGIMEN_FISCAL_POR_DEFECTO = "601";

/** Genera las obligaciones de un periodo según el régimen (default 601), con fecha límite en día hábil (D-26).
 * `month` es 1-12. Lanza `RegimenNoSoportadoError` si el régimen no tiene calendario modelado. */
export function calcularVencimientosDelPeriodo(
  year: number,
  month: number,
  todayIso: string,
  opciones: { readonly regimenFiscal?: string } = {},
): readonly NuevoVencimiento[] {
  const regimenFiscal = opciones.regimenFiscal ?? REGIMEN_FISCAL_POR_DEFECTO;
  return calcularCalendarioFiscal(year, month, { regimenFiscal }).map((o) => ({
    tipo: o.tipo,
    fechaLimite: o.fechaLimite,
    prioridad: calcularPrioridad(diasHasta(o.fechaLimite, todayIso)),
    descripcion: o.descripcion,
    periodo: o.periodo,
    fechaNominal: o.fechaNominal,
    ajustadaPorDiaInhabil: o.ajustadaPorDiaInhabil,
    fundamento: o.fundamento,
    validarConFiscalista: o.validarConFiscalista,
    nota: o.nota,
  }));
}

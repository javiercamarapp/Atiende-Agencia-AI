// ═══════════════════════════════════════════════════════════════════════════
// MOTOR DE VENCIMIENTOS FISCALES — puerto determinista (sin LLM) de
// ~/Desktop/supabase/despachos/b2b_ai/features/vencimientos/service.py
// (VencimientosService: calculate_deadlines/_calculate_priority/escalate).
// Mismo criterio que folioEngine.ts/quote.ts en domain-hoteles: lógica de negocio
// pura, 100% testeable, sin acceso a base de datos (el repositorio es quien persiste).
//
// LIMITACIÓN HEREDADA DEL ORIGEN (no una mejora silenciosa de esta reescritura — ver
// diseño Fase 1 despachos §5, punto 4): el "día 17 del mes siguiente" NO se ajusta
// por fin de semana/día inhábil ni por el sexto dígito del RFC (que en el régimen
// RESICO y otros desplaza la fecha límite real del SAT). Se replica EXACTO; cualquier
// ajuste de esto es una decisión explícita de una fase futura, no un efecto colateral
// de portar el código.
// ═══════════════════════════════════════════════════════════════════════════

export type PrioridadVencimiento = "critica" | "alta" | "media" | "baja";
export type EstadoVencimiento = "pendiente" | "en_proceso" | "completado" | "vencido" | "escalado";
export type NivelEscalamiento = "nivel_1" | "nivel_2" | "nivel_3" | "nivel_4";
export type TipoVencimiento = "ISR" | "IVA" | "DIOT" | "Nómina";

export const TIPOS_VENCIMIENTO: readonly TipoVencimiento[] = ["ISR", "IVA", "DIOT", "Nómina"];

/** YYYY-MM-DD del día 17 del mes SIGUIENTE a (year, month) — port literal de
 * `calculate_deadlines` (líneas 81-89): mismo cálculo para las 4 obligaciones
 * (ISR/IVA/DIOT/Nómina comparten fecha límite en el origen). `month` es 1-12. */
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

export interface NuevoVencimiento {
  readonly tipo: TipoVencimiento;
  readonly fechaLimite: string;
  readonly prioridad: PrioridadVencimiento;
  readonly descripcion: string;
  readonly periodo: string;
}

/** Genera los 4 vencimientos estándar (ISR/IVA/DIOT/Nómina) para un periodo —
 * port de la parte determinista de `calculate_deadlines` (sin el `_uuid`/persistencia,
 * que es responsabilidad del repositorio). `month` es 1-12. */
export function calcularVencimientosDelPeriodo(year: number, month: number, todayIso: string): readonly NuevoVencimiento[] {
  const fechaLimite = fechaLimiteDia17MesSiguiente(year, month);
  const prioridad = calcularPrioridad(diasHasta(fechaLimite, todayIso));
  const periodo = `${year}-${String(month).padStart(2, "0")}`;
  const mm = String(month).padStart(2, "0");

  return [
    { tipo: "ISR", fechaLimite, prioridad, descripcion: `Declaración mensual de ISR - ${mm}/${year}`, periodo },
    { tipo: "IVA", fechaLimite, prioridad, descripcion: `Declaración mensual de IVA - ${mm}/${year}`, periodo },
    { tipo: "DIOT", fechaLimite, prioridad, descripcion: `DIOT mensual - ${mm}/${year}`, periodo },
    { tipo: "Nómina", fechaLimite, prioridad, descripcion: `Declaración de nómina - ${mm}/${year}`, periodo },
  ];
}

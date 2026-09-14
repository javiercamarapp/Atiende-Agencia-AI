// renewal-radar.ts — Fase 6 pieza 5 (REQ-055): radar de renovaciones. A
// partir de contratos con fecha de fin conocida, calcula qué umbrales de
// antelación (configurables, por defecto 90/60/30 días) ya se cumplieron
// para generar una alerta de "renovación/licitación probable" -- pura
// función de fechas, sin acceso a base de datos (facilita la prueba
// exhaustiva; el repositorio hace el I/O real: consulta contratos, deduplica
// contra alertas ya emitidas, y persiste -- mismo espíritu de notificación
// consultable, sin envío externo real, que
// `tender-version-registry.ts::TenderChangeNotificationRecord`, Fase 5).
// Port ~literal del repo original
// (`licitaciones/apps/api/src/lib/expediente/renewal-radar.ts`).
//
// LÍMITE DOCUMENTADO (honesto, no oculto): esta pieza detecta alertas a
// partir de la fecha de fin del CONTRATO PROPIO (`ContractRecord.endDate`).
// Cruzar "convocatorias históricas de la misma entidad/objeto" para
// predecir una licitación futura SIN que exista todavía un contrato propio
// con fecha de fin (p. ej. la dependencia nunca le adjudicó antes) NO se
// construyó en esta fase -- a diferencia del repo original, que sí
// enriquecía cada alerta con convocatorias históricas de la misma entidad
// como contexto de apoyo; se omite aquí para mantener el alcance de la
// tarea despachada, documentado como trabajo futuro (ver README del
// vertical), no fingido.
export const DEFAULT_RENEWAL_LEAD_DAYS: readonly number[] = [90, 60, 30];

export interface RenewalCandidateContract {
  readonly contractId: string;
  readonly tenderId: string;
  readonly endDate: string; // "YYYY-MM-DD"
}

export interface RenewalAlertCandidate {
  readonly contractId: string;
  readonly tenderId: string;
  readonly predictedDate: string;
  readonly leadDays: number;
  /** Confianza más alta cuanto más cerca está el umbral cruzado de la fecha real de fin (antelación exacta = 1; nunca baja de 0.5 para una fecha de fin real y conocida). */
  readonly confidence: number;
}

export function daysBetween(fromIsoDate: string, toIsoDate: string): number {
  const from = new Date(`${fromIsoDate}T00:00:00Z`).getTime();
  const to = new Date(`${toIsoDate}T00:00:00Z`).getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * Para un contrato con `endDate` conocida, decide qué umbrales de
 * `leadDaysThresholds` ya se cumplieron a partir de `todayIsoDate`
 * (`daysUntilEnd <= threshold`, y todavía no venció: `daysUntilEnd >= 0`).
 * Puede devolver más de un umbral si varios ya se cumplieron a la vez (p.
 * ej. un escaneo tardío que salta directo a 30 días habiendo pasado ya el
 * de 90 y 60) -- el llamador decide, con el histórico de alertas ya
 * emitidas, cuáles insertar de nuevo (dedupe por (contrato, leadDays)).
 */
export function computeRenewalAlertCandidates(
  contracts: readonly RenewalCandidateContract[],
  todayIsoDate: string,
  leadDaysThresholds: readonly number[] = DEFAULT_RENEWAL_LEAD_DAYS,
): RenewalAlertCandidate[] {
  const candidates: RenewalAlertCandidate[] = [];
  const sortedThresholds = [...leadDaysThresholds].sort((a, b) => a - b);

  for (const contract of contracts) {
    const daysUntilEnd = daysBetween(todayIsoDate, contract.endDate);
    if (daysUntilEnd < 0) continue; // contrato ya vencido -- fuera de alcance del radar.

    for (const threshold of sortedThresholds) {
      if (daysUntilEnd <= threshold) {
        const confidence = threshold === 0 ? 1 : Math.max(0.5, 1 - Math.abs(threshold - daysUntilEnd) / (2 * threshold));
        candidates.push({
          contractId: contract.contractId,
          tenderId: contract.tenderId,
          predictedDate: contract.endDate,
          leadDays: threshold,
          confidence: Math.round(confidence * 100) / 100,
        });
      }
    }
  }
  return candidates;
}

export type RenewalUrgency = "urgente" | "proxima" | "seguimiento";

/**
 * Traduce un umbral de antelación (en días) a una etiqueta de urgencia
 * relativa a `sortedThresholds` (ascendente, sin duplicados): el umbral MÁS
 * PEQUEÑO es 'urgente', el MÁS GRANDE es 'seguimiento', cualquiera
 * intermedio es 'proxima'. Con un único umbral configurado, es 'urgente'.
 * Puro y determinista.
 */
export function urgencyForLeadDays(leadDays: number, sortedThresholds: readonly number[]): RenewalUrgency {
  const idx = sortedThresholds.indexOf(leadDays);
  if (idx <= 0) return "urgente";
  if (idx === sortedThresholds.length - 1) return "seguimiento";
  return "proxima";
}

export interface RenewalUpcomingCandidate extends RenewalAlertCandidate {
  readonly daysUntilEnd: number;
  readonly urgency: RenewalUrgency;
}

/**
 * Igual que `computeRenewalAlertCandidates` (un contrato puede cruzar
 * varios umbrales A LA VEZ y aparece una vez por cada uno, nunca deduplicado
 * a "el más urgente") pero además calcula `daysUntilEnd`/`urgency` para
 * consumo directo de un endpoint de negocio -- sin tocar ningún estado
 * persistido, pura, sin I/O.
 */
export function computeUpcomingRenewals(
  contracts: readonly RenewalCandidateContract[],
  todayIsoDate: string,
  leadDaysThresholds: readonly number[] = DEFAULT_RENEWAL_LEAD_DAYS,
): RenewalUpcomingCandidate[] {
  const sortedThresholds = [...new Set(leadDaysThresholds)].sort((a, b) => a - b);
  const candidates = computeRenewalAlertCandidates(contracts, todayIsoDate, sortedThresholds);
  return candidates.map((candidate) => ({
    ...candidate,
    daysUntilEnd: daysBetween(todayIsoDate, candidate.predictedDate),
    urgency: urgencyForLeadDays(candidate.leadDays, sortedThresholds),
  }));
}

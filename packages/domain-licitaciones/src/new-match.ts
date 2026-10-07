// Nuevo match (paridad3 L-P3-09): decide si una convocatoria RECIEN descubierta por la ingesta automatica merece avisar al equipo.
// Funcion PURA y determinista (el LLM nunca decide, REQ-070): reutiliza `MatchingEngine` tal cual, sin pesos propios.
//
// Regla:
//   - El plazo debe ser conocido y futuro. Sin plazo conocido (p. ej. un historico de contratos ya concluidos) no hay a que
//     llegar a tiempo: no se avisa (nunca se fabrica un plazo).
//   - Sin umbral configurado en la organizacion (`tenant_config.new_match_min_score` nulo): solo las convocatorias ELEGIBLES
//     (`eligibility.status === "cumple"`: cumplen todos los requisitos duros configurados en el perfil).
//   - Con umbral N: puntuacion >= N y que no incumpla un requisito duro (`no_cumple` nunca avisa, aun con puntuacion alta).
//   - Sin perfil de matching no hay contra que comparar: no se avisa (la elegibilidad es `no_evaluable`, nunca se asume "cumple").
import { MatchingEngine, toOrganizationMatchingProfile } from "./matching-engine.ts";
import type { MatchingProfileRecord, TenderRecord } from "./types.ts";

/** Contexto de matching de una organizacion para la sesion de sistema (umbral + perfil, que puede no existir). */
export interface NewMatchContext {
  /** 0-100, o `null` = solo las elegibles. */
  readonly minScore: number | null;
  readonly profile: MatchingProfileRecord | null;
}

/** Aviso de nuevo match persistido (dedupe por organizacion y convocatoria). Solo ids, puntuacion y bandera: sin PII. */
export interface NewMatchNoticeRecord {
  readonly tenderId: string;
  readonly score: number;
  readonly eligible: boolean;
  readonly createdAt: string;
}

export interface NewMatchEvaluation {
  readonly notify: boolean;
  readonly score: number;
  readonly eligible: boolean;
  /** Motivo de por que NO avisa (vacio si avisa): util para el reporte del cron y las pruebas. */
  readonly skipReason: "sin_perfil" | "sin_plazo" | "plazo_vencido" | "no_cumple" | "bajo_umbral" | "no_elegible" | null;
}

const engine = new MatchingEngine();

export function evaluateNewMatch(tender: TenderRecord, context: NewMatchContext, now: Date): NewMatchEvaluation {
  if (!context.profile) return { notify: false, score: 0, eligible: false, skipReason: "sin_perfil" };
  const result = engine.score(tender, toOrganizationMatchingProfile(context.profile, tender.organizationId));
  const eligible = result.eligibility.status === "cumple";
  const base = { score: result.score, eligible };

  if (tender.submissionDeadline === null) return { ...base, notify: false, skipReason: "sin_plazo" };
  const deadlineMs = new Date(tender.submissionDeadline).getTime();
  if (Number.isNaN(deadlineMs)) return { ...base, notify: false, skipReason: "sin_plazo" };
  if (deadlineMs <= now.getTime()) return { ...base, notify: false, skipReason: "plazo_vencido" };

  if (result.eligibility.status === "no_cumple") return { ...base, notify: false, skipReason: "no_cumple" };
  if (context.minScore === null) return eligible ? { ...base, notify: true, skipReason: null } : { ...base, notify: false, skipReason: "no_elegible" };
  return result.score >= context.minScore ? { ...base, notify: true, skipReason: null } : { ...base, notify: false, skipReason: "bajo_umbral" };
}

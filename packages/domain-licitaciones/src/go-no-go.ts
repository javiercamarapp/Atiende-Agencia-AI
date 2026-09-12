// buildGoNoGoDecision — Fase 3 §7: máquina de validación PURA (sin IO) para
// una decisión Go/No-Go, mismo espíritu que `ApprovalWorkflow.approve()`
// (approval-workflow.ts): valida las reglas duras y devuelve el registro
// listo para persistir, o lanza `GoNoGoRejectedError` sin tocar nada. Se
// invoca desde AMBOS adaptadores de repositorio (InMemory/Postgres) antes de
// insertar la fila -- defensa en profundidad además de
// `assertVerticalRole(c, GO_NO_GO_ROLES)` en la ruta y la policy RLS
// `licitaciones.can_go_no_go_org` (migración 008), igual que el resto del
// vertical nunca confía en una sola capa.
import { GO_NO_GO_ROLES } from "./roles.ts";
import type { LicitacionesRole } from "./roles.ts";
import { GoNoGoRejectedError } from "./errors.ts";
import { isoNow } from "./types.ts";
import type { EligibilityStatus } from "./matching-engine.ts";

export interface GoNoGoDecisionInput {
  readonly decision: "go" | "no_go";
  /** Al menos un motivo no vacío -- nunca una decisión sin justificación explícita. */
  readonly reasons: readonly string[];
  readonly actorId: string;
  readonly actorRole: LicitacionesRole;
  /** `MatchResult` vigente en el momento de decidir, ya calculado por el llamador (nunca por esta función: sellar un score que ESTA función recalculara reintroduciría la posibilidad de que el cliente lo manipule indirectamente). */
  readonly matchScore: number;
  readonly matchEligibilityStatus: EligibilityStatus;
  readonly matchInputsHash: string;
}

export interface GoNoGoDecisionToPersist {
  readonly decision: "go" | "no_go";
  readonly reasons: readonly string[];
  readonly matchScore: number;
  readonly matchEligibilityStatus: EligibilityStatus;
  readonly matchInputsHash: string;
  readonly decidedBy: string;
  readonly decidedByRole: LicitacionesRole;
  readonly decidedAt: string;
}

/**
 * Reglas duras (en este orden):
 *  1. Solo GO_NO_GO_ROLES (owner/admin/analyst/reviewer) pueden decidir;
 *     writer/viewer se rechazan siempre, sin excepción.
 *  2. Al menos un motivo, y ninguno vacío/solo-espacios -- una decisión sin
 *     justificación explícita nunca se persiste.
 */
export function buildGoNoGoDecision(input: GoNoGoDecisionInput): GoNoGoDecisionToPersist {
  if (!GO_NO_GO_ROLES.includes(input.actorRole)) {
    throw new GoNoGoRejectedError("rol_no_autorizado_para_decidir_go_no_go", `Rol "${input.actorRole}" no puede decidir go/no-go (se requiere owner/admin/analyst/reviewer).`);
  }
  if (input.reasons.length === 0 || input.reasons.some((r) => r.trim().length === 0)) {
    throw new GoNoGoRejectedError("motivo_requerido", "Se requiere al menos un motivo no vacío para registrar una decisión go/no-go.");
  }

  return {
    decision: input.decision,
    reasons: [...input.reasons],
    matchScore: input.matchScore,
    matchEligibilityStatus: input.matchEligibilityStatus,
    matchInputsHash: input.matchInputsHash,
    decidedBy: input.actorId,
    decidedByRole: input.actorRole,
    decidedAt: isoNow(),
  };
}

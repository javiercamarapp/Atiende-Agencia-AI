// Versión REDUCIDA de licitaciones/packages/expediente/src/approval-workflow.ts
// (330 líneas en origen) — ver diseño Fase 1 §3.1. Solo lo mínimo para el
// Flujo 3: el tipo `Approval` de alcance "expediente" y una función pura
// `evaluateExpedienteApproval` que replica EXACTAMENTE la regla que
// `PackageAssembler.buildManifest` aplica internamente (scope === "expediente"
// && scopeRef === "expediente" && status === "vigente" && inputsHash ===
// currentInputsHash) — para que apps/api pueda decidir el mismo veredicto sin
// duplicar la lógica.
//
// Se DIFIERE explícitamente (limitación conocida de Fase 1, documentada, no
// silenciosa): la máquina de estados completa de invalidación por-sección/
// por-documento con autoría (AE-02/AE-11 del origen) — Fase 1 solo reproduce
// la invalidación por HASH DE INSUMOS DIVERGENTE (que cubre tarifas/
// documentos/versión de bases, el caso de mayor impacto).
import type { InputsHash } from "./sealed-inputs.ts";

export type ApprovalScope = "expediente";

export interface Approval {
  readonly id: string;
  readonly scope: ApprovalScope;
  /** Ruta jerárquica del alcance — en Fase 1 siempre "expediente" (aprobación de alcance completo, nunca por sección/documento). */
  readonly scopeRef: "expediente";
  readonly approvedBy: string;
  readonly approvedByRole: string;
  readonly approvedAt: string;
  /** Hash de insumos BRANDED: solo se almacena el `InputsHash`, nunca el `ExpedienteInputs` completo. */
  readonly inputsHash: InputsHash;
  readonly status: "vigente" | "invalidada";
  readonly invalidatedAt?: string;
  readonly invalidatedReason?: string;
}

/**
 * Replica literal de la regla de `PackageAssembler.buildManifest`: una
 * aprobación solo cuenta como válida para el estado ACTUAL del expediente si
 * es de alcance "expediente" completo, está "vigente" y su `inputsHash`
 * coincide EXACTO con el hash actual de insumos. Devuelve `null` si ninguna
 * aprobación cumple las cuatro condiciones a la vez.
 */
export function evaluateExpedienteApproval(approvals: readonly Approval[], currentInputsHash: InputsHash): Approval | null {
  return approvals.find((a) => a.scope === "expediente" && a.scopeRef === "expediente" && a.status === "vigente" && a.inputsHash === currentInputsHash) ?? null;
}

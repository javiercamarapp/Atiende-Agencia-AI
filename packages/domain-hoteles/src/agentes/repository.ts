// Puerto de persistencia de agentes, guardrails, aprobaciones y plantillas (H-03). Separado de
// `HotelesRepository` (mismo criterio que tickets/housekeeping/identidad) para no ensanchar el puerto grande.
// El `actor` solo lo usa el repo en memoria (la base usa auth.uid() de la sesion y lo ignora).
import type {
  ActionPolicyInput,
  ActionPolicyListResult,
  ActionPolicyRecord,
  Actor,
  AgentConfigListResult,
  AgentConfigRecord,
  AgentConfigUpdate,
  AgentGate,
  AgentKey,
  ApprovalActionType,
  ApprovalEventRecord,
  ApprovalFilter,
  ApprovalListResult,
  ApprovalRecord,
  GuardrailsInput,
  GuardrailsRecord,
  GuardrailsResult,
  NewTemplateInput,
  ProposeActionInput,
  TemplateListResult,
  TemplateRecord,
} from "./tipos.ts";

export interface UsageDelta {
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costMicroUsd: number;
  readonly calls: number;
}

export interface AgentesRepository {
  // ---- catalogo (config + costo acumulado del mes) ----
  /** Vacio honesto (`disponible: false`) sin la migracion 035. */
  listAgentConfig(propertyId: string, month: string): Promise<AgentConfigListResult>;
  updateAgentConfig(propertyId: string, agentKey: AgentKey, update: AgentConfigUpdate): Promise<AgentConfigRecord>;

  // ---- guardrails y politicas ----
  getGuardrails(propertyId: string): Promise<GuardrailsResult>;
  upsertGuardrails(propertyId: string, input: GuardrailsInput): Promise<GuardrailsRecord>;
  /** Siempre devuelve las 5 acciones (la politica efectiva: configurada o la de por defecto). */
  listPolicies(propertyId: string): Promise<ActionPolicyListResult>;
  upsertPolicy(propertyId: string, actionType: ApprovalActionType, input: ActionPolicyInput): Promise<ActionPolicyRecord>;

  // ---- cola de aprobaciones ----
  listApprovals(propertyId: string, filter: ApprovalFilter): Promise<ApprovalListResult>;
  findApproval(propertyId: string, approvalId: string): Promise<ApprovalRecord | null>;
  listApprovalEvents(propertyId: string, approvalId: string): Promise<readonly ApprovalEventRecord[]>;
  /** Persona (staff) o agente (sistema: actor.userId null). Reintentar la misma llave devuelve la existente. */
  proposeAction(input: ProposeActionInput, actor: Actor): Promise<ApprovalRecord>;
  /** `aprobar`|`rechazar` con motivo; devuelve la fila (estado `expirada` si ya vencio). */
  decideApproval(propertyId: string, approvalId: string, decision: "aprobar" | "rechazar", reason: string, actor: Actor): Promise<ApprovalRecord>;
  cancelApproval(propertyId: string, approvalId: string, reason: string, actor: Actor): Promise<ApprovalRecord>;
  /** Marca ejecutada UNA vez. Solo si el estado devuelto es `ejecutada` hay que aplicar el efecto. */
  consumeApproval(propertyId: string, approvalId: string, executionRef: string, actor: Actor, now?: Date): Promise<ApprovalRecord>;
  /** SOLO sistema (cron): expira las abiertas vencidas. Lanza AgentesUnavailableError sin 035. */
  expireApprovals(propertyId: string, now: Date): Promise<number>;

  // ---- sistema: compuerta y costo ----
  /** SOLO sistema. `null` = la base aun no tiene la 035 (se trata como activo, comportamiento previo). */
  gate(propertyId: string, agentKey: AgentKey, month: string): Promise<AgentGate | null>;
  /** SOLO sistema. Best-effort: el llamador nunca debe tumbar un turno por esto. */
  recordUsage(propertyId: string, agentKey: AgentKey, month: string, delta: UsageDelta): Promise<void>;

  // ---- plantillas de WhatsApp versionadas ----
  listTemplates(propertyId: string): Promise<TemplateListResult>;
  createTemplate(input: NewTemplateInput, actor: Actor): Promise<TemplateRecord>;
  submitTemplate(propertyId: string, templateId: string, actor: Actor): Promise<TemplateRecord>;
  reviewTemplate(propertyId: string, templateId: string, decision: "aprobar" | "rechazar", reason: string, actor: Actor): Promise<TemplateRecord>;
  archiveTemplate(propertyId: string, templateId: string, actor: Actor): Promise<TemplateRecord>;
}

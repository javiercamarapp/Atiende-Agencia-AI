// H-03 -- tipos, catalogo estatico y errores de dominio de los agentes de hoteles (catalogo con kill switch
// y presupuesto, cola de aprobaciones humanas, plantillas de WhatsApp versionadas y guardrails). La
// autoridad es la base (migracion 035, RLS + funciones definer): estos tipos describen lo que ella devuelve.

export const AGENT_KEYS = ["recepcion_whatsapp", "revenue", "reputacion", "mantenimiento"] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export function isAgentKey(value: unknown): value is AgentKey {
  return typeof value === "string" && (AGENT_KEYS as readonly string[]).includes(value);
}

/** Metadatos fijos de cada agente. `gobernado` = hoy hay codigo que consulta el kill switch/presupuesto
 *  antes de correr; un agente NO gobernado guarda su configuracion pero ningun proceso la consulta todavia
 *  (la UI lo dice: no se promete un apagado que no apaga nada). */
export interface AgentCatalogEntry {
  readonly key: AgentKey;
  readonly nombre: string;
  readonly descripcion: string;
  /** Rol del `LlmGateway` que consume (para cruzar con core.llm_usage_daily); null = no usa LLM hoy. */
  readonly llmRole: string | null;
  readonly gobernado: boolean;
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    key: "recepcion_whatsapp",
    nombre: "Recepcion (WhatsApp)",
    descripcion: "Atiende al huesped por WhatsApp: pedidos de alimentos y bebidas, reportes de mantenimiento y derivacion a una persona.",
    llmRole: "hoteles:whatsapp_agent",
    gobernado: true,
  },
  {
    key: "revenue",
    nombre: "Revenue",
    descripcion: "Calcula recomendaciones de tarifa (pickup, eventos, competencia) sujetas al gate del motor.",
    llmRole: null,
    gobernado: true,
  },
  {
    key: "reputacion",
    nombre: "Reputacion",
    descripcion: "Clasifica resenas y propone acciones y respuestas.",
    llmRole: null,
    gobernado: false,
  },
  {
    key: "mantenimiento",
    nombre: "Mantenimiento",
    descripcion: "Abre y da seguimiento a tickets de mantenimiento.",
    llmRole: null,
    gobernado: false,
  },
];

export const APPROVAL_ACTION_TYPES = ["descuento_tarifa", "reembolso", "respuesta_resena", "mensaje_masivo", "cargo_folio"] as const;
export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number];

/** Solo estas acciones admiten ejecucion automatica bajo umbral; el contenido de cara al huesped exige humano SIEMPRE. */
export const AUTO_ELIGIBLE_ACTION_TYPES: readonly ApprovalActionType[] = ["descuento_tarifa", "reembolso", "cargo_folio"];

export const APPROVAL_STATUSES = ["pendiente", "aprobada", "rechazada", "expirada", "ejecutada", "cancelada", "bloqueada"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const POLICY_MODES = ["siempre_humano", "auto_bajo_umbral"] as const;
export type PolicyMode = (typeof POLICY_MODES)[number];

export const POLICY_APPROVER_ROLES = ["owner", "gm", "frontdesk", "reservations", "accountant"] as const;
export type PolicyApproverRole = (typeof POLICY_APPROVER_ROLES)[number];

export const TEMPLATE_STATUSES = ["borrador", "pendiente", "aprobada", "rechazada", "archivada"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];
export const TEMPLATE_LANGUAGES = ["es_MX", "es", "en_US", "en"] as const;
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number];
export const TEMPLATE_CATEGORIES = ["utility", "marketing"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_NAME_RE = /^[a-z][a-z0-9_]{2,59}$/;

/** Decision por defecto de una accion SIN politica configurada: siempre humano, 24 h, aprueban owner/gm. */
export const DEFAULT_APPROVAL_EXPIRES_MINUTES = 1440;
export const DEFAULT_APPROVER_ROLES: readonly PolicyApproverRole[] = ["owner", "gm"];

export interface AgentConfigRecord {
  readonly agentKey: AgentKey;
  readonly enabled: boolean;
  readonly pausedReason: string | null;
  readonly pausedAt: string | null;
  /** micro-USD (1 USD = 1_000_000); null = sin tope propio (hereda el de la organizacion). */
  readonly budgetMicroUsd: number | null;
  readonly updatedAt: string;
}

export interface AgentUsageRecord {
  readonly agentKey: AgentKey;
  readonly month: string;
  readonly costMicroUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly callCount: number;
}

export interface AgentConfigListResult {
  readonly disponible: boolean;
  readonly configs: readonly AgentConfigRecord[];
  readonly usage: readonly AgentUsageRecord[];
}

/** Lo que consulta un proceso de sistema (agente, cron) antes de correr. */
export interface AgentGate {
  readonly enabled: boolean;
  readonly budgetMicroUsd: number | null;
  readonly spentMicroUsd: number;
  readonly pausedReason: string | null;
}

export interface AgentConfigUpdate {
  /** undefined = no cambia. */
  readonly enabled?: boolean;
  /** undefined = no cambia; null = quitar el tope propio. */
  readonly budgetMicroUsd?: number | null;
  /** Obligatorio al pausar (5 a 300 caracteres). */
  readonly pausedReason?: string | null;
}

export interface GuardrailsRecord {
  readonly propertyId: string;
  readonly maxDiscountPct: number;
  readonly maxRefundCents: number;
  readonly maxFolioChargeCents: number;
  readonly maxMassRecipients: number;
  readonly blockedWords: readonly string[];
  /** 'HH:MM' (hora local de la property). */
  readonly sendWindowStart: string;
  readonly sendWindowEnd: string;
  readonly updatedAt: string;
  /** false = no hay fila: rigen los valores por defecto. */
  readonly configured: boolean;
}

export type GuardrailsInput = Omit<GuardrailsRecord, "propertyId" | "updatedAt" | "configured">;

export interface GuardrailsResult {
  readonly disponible: boolean;
  readonly guardrails: GuardrailsRecord;
}

export interface ActionPolicyRecord {
  readonly actionType: ApprovalActionType;
  readonly mode: PolicyMode;
  readonly autoMaxPercent: number | null;
  readonly autoMaxAmountCents: number | null;
  readonly expiresMinutes: number;
  readonly approverRoles: readonly PolicyApproverRole[];
  readonly configured: boolean;
  readonly updatedAt: string | null;
}

export interface ActionPolicyInput {
  readonly mode: PolicyMode;
  readonly autoMaxPercent: number | null;
  readonly autoMaxAmountCents: number | null;
  readonly expiresMinutes: number;
  readonly approverRoles: readonly PolicyApproverRole[];
}

export interface ActionPolicyListResult {
  readonly disponible: boolean;
  readonly politicas: readonly ActionPolicyRecord[];
}

export interface ApprovalRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly agentKey: AgentKey | "manual";
  readonly actionType: ApprovalActionType;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly amountCents: number | null;
  readonly currency: string;
  readonly percent: number | null;
  readonly recipients: number | null;
  readonly contentText: string | null;
  readonly idempotencyKey: string;
  readonly status: ApprovalStatus;
  /** null = lo propuso un agente (sistema). */
  readonly proposedBy: string | null;
  readonly autoApproved: boolean;
  readonly blockReason: string | null;
  readonly expiresAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
  readonly executedAt: string | null;
  readonly executedBy: string | null;
  readonly executionRef: string | null;
  readonly createdAt: string;
}

export interface ApprovalEventRecord {
  readonly id: string;
  readonly subjectId: string;
  readonly eventType: string;
  /** null = el sistema. */
  readonly actorId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface ApprovalFilter {
  readonly status?: ApprovalStatus;
  readonly actionType?: ApprovalActionType;
  readonly onlyOpen?: boolean;
}

export interface ApprovalListResult {
  readonly disponible: boolean;
  readonly aprobaciones: readonly ApprovalRecord[];
}

export interface ProposeActionInput {
  readonly propertyId: string;
  readonly agentKey: AgentKey;
  readonly actionType: ApprovalActionType;
  readonly summary: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly amountCents: number | null;
  readonly percent: number | null;
  readonly recipients: number | null;
  readonly contentText: string | null;
  /** Llave de idempotencia: reintentar la MISMA propuesta no duplica la cola. */
  readonly idempotencyKey: string;
  /** Reloj de la app; la base solo lo respeta en sesion de sistema. */
  readonly now?: Date;
}

/** Quien actua: Postgres usa auth.uid() de la sesion y lo IGNORA; el repo en memoria lo necesita. */
export interface Actor {
  readonly userId: string | null;
  readonly role: string | null;
}

export interface TemplateRecord {
  readonly id: string;
  readonly propertyId: string;
  readonly agentKey: AgentKey;
  readonly name: string;
  readonly language: TemplateLanguage;
  readonly category: TemplateCategory;
  readonly body: string;
  readonly version: number;
  readonly status: TemplateStatus;
  readonly createdBy: string | null;
  readonly submittedBy: string | null;
  readonly submittedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewReason: string | null;
  readonly createdAt: string;
}

export interface TemplateListResult {
  readonly disponible: boolean;
  readonly plantillas: readonly TemplateRecord[];
}

export interface NewTemplateInput {
  readonly propertyId: string;
  readonly agentKey: AgentKey;
  readonly name: string;
  readonly language: TemplateLanguage;
  readonly category: TemplateCategory;
  readonly body: string;
}

export class AgentesNotFoundError extends Error {
  constructor(what = "Recurso") {
    super(`${what} no encontrado, o sin permiso para verlo.`);
    this.name = "AgentesNotFoundError";
  }
}
export class AgentesConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentesConflictError";
  }
}
export class AgentesInvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentesInvalidInputError";
  }
}
export class AgentesAccessDeniedError extends Error {
  constructor(message = "No tienes permiso para esta operacion.") {
    super(message);
    this.name = "AgentesAccessDeniedError";
  }
}
/** La base aun no tiene la migracion 035: las escrituras responden 503 honesto. */
export class AgentesUnavailableError extends Error {
  constructor(public readonly operation: string) {
    super(`Agentes y aprobaciones: la migracion 035 aun no esta aplicada (${operation}).`);
    this.name = "AgentesUnavailableError";
  }
}

// Adaptador Postgres de agentes/aprobaciones/plantillas (H-03) sobre `TenantDbSession` (auth.uid() real por
// request, RLS real; o sesion de sistema para las funciones de sistema). REGLA DURA DE COMPATIBILIDAD CON LA
// BASE SIN MIGRAR: `dbSession` es UNA transaccion por request; un error de Postgres (42P01/42883/42703 si la
// migracion 035 no esta aplicada) la dejaria ABORTADA (25P02). Toda operacion corre dentro de
// `runWithSavepointFallback`: las lecturas degradan a vacio honesto (`disponible: false`), las escrituras a
// `AgentesUnavailableError` (503). El SQL es el MISMO que ejercita scripts/verify-hoteles-agentes-aprobaciones.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import { DEFAULT_GUARDRAILS, defaultPolicy } from "./guardrails.ts";
import type { AgentesRepository, UsageDelta } from "./repository.ts";
import {
  APPROVAL_ACTION_TYPES,
  AgentesAccessDeniedError,
  AgentesConflictError,
  AgentesInvalidInputError,
  AgentesNotFoundError,
  AgentesUnavailableError,
} from "./tipos.ts";
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
  ApprovalStatus,
  GuardrailsInput,
  GuardrailsRecord,
  GuardrailsResult,
  NewTemplateInput,
  PolicyApproverRole,
  PolicyMode,
  ProposeActionInput,
  TemplateCategory,
  TemplateLanguage,
  TemplateListResult,
  TemplateRecord,
  TemplateStatus,
} from "./tipos.ts";

const APPROVAL_COLS = `id, property_id, agent_key, action_type, summary, payload, amount_cents, currency, percent, recipients, content_text,
       idempotency_key, status, proposed_by, auto_approved, block_reason, expires_at::text as expires_at, decided_by, decided_at::text as decided_at,
       decision_reason, executed_at::text as executed_at, executed_by, execution_ref, created_at::text as created_at`;
const TEMPLATE_COLS = `id, property_id, agent_key, name, language, category, body, version, status, created_by, submitted_by,
       submitted_at::text as submitted_at, reviewed_by, reviewed_at::text as reviewed_at, review_reason, created_at::text as created_at`;
const GUARDRAIL_COLS = `property_id, max_discount_pct, max_refund_cents, max_folio_charge_cents, max_mass_recipients, blocked_words,
       send_window_start::text as send_window_start, send_window_end::text as send_window_end, updated_at::text as updated_at`;
const POLICY_COLS = `action_type, mode, auto_max_percent, auto_max_amount_cents, expires_minutes, approver_roles, updated_at::text as updated_at`;
const CONFIG_COLS = `agent_key, enabled, paused_reason, paused_at::text as paused_at, monthly_budget_micro_usd, updated_at::text as updated_at`;

interface ApprovalRow {
  id: string; property_id: string; agent_key: ApprovalRecord["agentKey"]; action_type: ApprovalActionType; summary: string; payload: unknown;
  amount_cents: string | number | null; currency: string; percent: string | number | null; recipients: number | null; content_text: string | null;
  idempotency_key: string; status: ApprovalStatus; proposed_by: string | null; auto_approved: boolean; block_reason: string | null; expires_at: string;
  decided_by: string | null; decided_at: string | null; decision_reason: string | null; executed_at: string | null; executed_by: string | null;
  execution_ref: string | null; created_at: string;
}
interface TemplateRow {
  id: string; property_id: string; agent_key: AgentKey; name: string; language: TemplateLanguage; category: TemplateCategory; body: string; version: number;
  status: TemplateStatus; created_by: string | null; submitted_by: string | null; submitted_at: string | null; reviewed_by: string | null;
  reviewed_at: string | null; review_reason: string | null; created_at: string;
}
interface GuardrailRow {
  property_id: string; max_discount_pct: string | number; max_refund_cents: string | number; max_folio_charge_cents: string | number; max_mass_recipients: number;
  blocked_words: string[] | null; send_window_start: string; send_window_end: string; updated_at: string;
}
interface PolicyRow {
  action_type: ApprovalActionType; mode: PolicyMode; auto_max_percent: string | number | null; auto_max_amount_cents: string | number | null;
  expires_minutes: number; approver_roles: PolicyApproverRole[]; updated_at: string;
}
interface ConfigRow {
  agent_key: AgentKey; enabled: boolean; paused_reason: string | null; paused_at: string | null; monthly_budget_micro_usd: string | number | null; updated_at: string;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

function mapApproval(r: ApprovalRow): ApprovalRecord {
  const payload = typeof r.payload === "string" ? safeJson(r.payload) : r.payload;
  return {
    id: r.id, propertyId: r.property_id, agentKey: r.agent_key, actionType: r.action_type, summary: r.summary,
    payload: payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {},
    amountCents: num(r.amount_cents), currency: r.currency, percent: num(r.percent), recipients: r.recipients, contentText: r.content_text,
    idempotencyKey: r.idempotency_key, status: r.status, proposedBy: r.proposed_by, autoApproved: r.auto_approved, blockReason: r.block_reason,
    expiresAt: r.expires_at, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionReason: r.decision_reason, executedAt: r.executed_at,
    executedBy: r.executed_by, executionRef: r.execution_ref, createdAt: r.created_at,
  };
}
function mapTemplate(r: TemplateRow): TemplateRecord {
  return {
    id: r.id, propertyId: r.property_id, agentKey: r.agent_key, name: r.name, language: r.language, category: r.category, body: r.body,
    version: Number(r.version), status: r.status, createdBy: r.created_by, submittedBy: r.submitted_by, submittedAt: r.submitted_at,
    reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at, reviewReason: r.review_reason, createdAt: r.created_at,
  };
}
function mapGuardrails(r: GuardrailRow): GuardrailsRecord {
  return {
    propertyId: r.property_id, maxDiscountPct: Number(r.max_discount_pct), maxRefundCents: Number(r.max_refund_cents),
    maxFolioChargeCents: Number(r.max_folio_charge_cents), maxMassRecipients: Number(r.max_mass_recipients), blockedWords: r.blocked_words ?? [],
    sendWindowStart: r.send_window_start.slice(0, 5), sendWindowEnd: r.send_window_end.slice(0, 5), updatedAt: r.updated_at, configured: true,
  };
}
function mapPolicy(r: PolicyRow): ActionPolicyRecord {
  return {
    actionType: r.action_type, mode: r.mode, autoMaxPercent: num(r.auto_max_percent), autoMaxAmountCents: num(r.auto_max_amount_cents),
    expiresMinutes: Number(r.expires_minutes), approverRoles: r.approver_roles, configured: true, updatedAt: r.updated_at,
  };
}
function mapConfig(r: ConfigRow): AgentConfigRecord {
  return { agentKey: r.agent_key, enabled: r.enabled, pausedReason: r.paused_reason, pausedAt: r.paused_at, budgetMicroUsd: num(r.monthly_budget_micro_usd), updatedAt: r.updated_at };
}
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}
function pgMessage(err: unknown): string {
  return err instanceof Error ? err.message : "";
}
/** Mensajes propios de la migracion 035 son seguros de mostrar; los de CHECK/FK del motor no. */
function safeMessage(err: unknown, fallback: string): string {
  const m = pgMessage(err);
  return m && !/^(new row|insert or update|update or delete|duplicate key|null value)/i.test(m) ? m : fallback;
}

/** Traduce un error de Postgres a un error de dominio tipado (nunca un 500 crudo). */
export function mapAgentesPgError(err: unknown, operation: string): unknown {
  if (
    err instanceof AgentesNotFoundError || err instanceof AgentesConflictError || err instanceof AgentesInvalidInputError ||
    err instanceof AgentesAccessDeniedError || err instanceof AgentesUnavailableError
  ) {
    return err;
  }
  if (isMigrationPendingError(err)) return new AgentesUnavailableError(operation);
  switch (pgCode(err)) {
    case "23503":
    case "P0002":
      return new AgentesNotFoundError();
    case "23505":
      return new AgentesConflictError(safeMessage(err, "Ya existe un registro equivalente (llave de idempotencia o version vigente)."));
    case "55000":
      return new AgentesConflictError(safeMessage(err, "La operacion no procede en el estado actual."));
    case "23514":
    case "22023":
      return new AgentesInvalidInputError(safeMessage(err, "Datos invalidos (fuera de rango, formato no permitido o no cumple un guardrail vigente)."));
    case "42501":
      return new AgentesAccessDeniedError(safeMessage(err, "No tienes permiso para esta operacion."));
    default:
      return err;
  }
}

export class PostgresAgentesRepository implements AgentesRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** Escritura protegida por SAVEPOINT: cualquier error recupera la sesion y se traduce. */
  private write<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary: fn,
      isRecoverable: () => true,
      fallback: (err) => {
        throw mapAgentesPgError(err, operation);
      },
    });
  }

  /** Lectura protegida por SAVEPOINT: solo "migracion pendiente" degrada; el resto se repropaga. */
  private read<T>(operation: string, primary: () => Promise<T>, onMissing: () => T): Promise<T> {
    return runWithSavepointFallback({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: (err) => {
        console.warn(`${operation}: agentes y aprobaciones (migracion 035) aun no aplicada -- degradando:`, err instanceof Error ? err.message : err);
        return Promise.resolve(onMissing());
      },
    });
  }

  /** La solicitud/plantilla debe pertenecer a la property de la URL (misma org no basta). */
  private async assertInProperty(table: "agent_approval_request" | "agent_wa_template", propertyId: string, id: string, what: string): Promise<void> {
    const { rows } = await this.db.query<{ ok: number }>(`select 1 as ok from hoteles.${table} where id = $1 and property_id = $2;`, [id, propertyId]);
    if (rows.length === 0) throw new AgentesNotFoundError(what);
  }

  // ---- catalogo ----
  async listAgentConfig(propertyId: string, month: string): Promise<AgentConfigListResult> {
    return this.read<AgentConfigListResult>(
      "listAgentConfig",
      async () => {
        const cfg = await this.db.query<ConfigRow>(`select ${CONFIG_COLS} from hoteles.agent_config where property_id = $1 order by agent_key;`, [propertyId]);
        const use = await this.db.query<{ agent_key: AgentKey; month: string; cost_micro_usd: string | number; tokens_in: string | number; tokens_out: string | number; call_count: string | number }>(
          `select agent_key, month, cost_micro_usd, tokens_in, tokens_out, call_count from hoteles.agent_usage_monthly where property_id = $1 and month = $2;`,
          [propertyId, month],
        );
        return {
          disponible: true,
          configs: cfg.rows.map(mapConfig),
          usage: use.rows.map((u) => ({ agentKey: u.agent_key, month: u.month, costMicroUsd: Number(u.cost_micro_usd), tokensIn: Number(u.tokens_in), tokensOut: Number(u.tokens_out), callCount: Number(u.call_count) })),
        };
      },
      () => ({ disponible: false, configs: [], usage: [] }),
    );
  }

  async updateAgentConfig(propertyId: string, agentKey: AgentKey, update: AgentConfigUpdate): Promise<AgentConfigRecord> {
    return this.write("updateAgentConfig", async () => {
      const cur = await this.db.query<ConfigRow>(`select ${CONFIG_COLS} from hoteles.agent_config where property_id = $1 and agent_key = $2;`, [propertyId, agentKey]);
      const prev = cur.rows[0] ? mapConfig(cur.rows[0]) : null;
      const enabled = update.enabled ?? prev?.enabled ?? true;
      const budget = update.budgetMicroUsd === undefined ? (prev?.budgetMicroUsd ?? null) : update.budgetMicroUsd;
      const reason = enabled ? null : (update.pausedReason ?? prev?.pausedReason ?? null);
      const { rows } = await this.db.query<ConfigRow>(
        `insert into hoteles.agent_config (property_id, agent_key, enabled, monthly_budget_micro_usd, paused_reason)
         values ($1, $2, $3, $4, $5)
         on conflict (property_id, agent_key) do update
           set enabled = excluded.enabled, monthly_budget_micro_usd = excluded.monthly_budget_micro_usd, paused_reason = excluded.paused_reason
         returning ${CONFIG_COLS};`,
        [propertyId, agentKey, enabled, budget, reason],
      );
      return mapConfig(rows[0]!);
    });
  }

  // ---- guardrails y politicas ----
  async getGuardrails(propertyId: string): Promise<GuardrailsResult> {
    return this.read<GuardrailsResult>(
      "getGuardrails",
      async () => {
        const { rows } = await this.db.query<GuardrailRow>(`select ${GUARDRAIL_COLS} from hoteles.agent_guardrail where property_id = $1;`, [propertyId]);
        return { disponible: true, guardrails: rows[0] ? mapGuardrails(rows[0]) : { propertyId, ...DEFAULT_GUARDRAILS, updatedAt: "", configured: false } };
      },
      () => ({ disponible: false, guardrails: { propertyId, ...DEFAULT_GUARDRAILS, updatedAt: "", configured: false } }),
    );
  }

  async upsertGuardrails(propertyId: string, g: GuardrailsInput): Promise<GuardrailsRecord> {
    return this.write("upsertGuardrails", async () => {
      const { rows } = await this.db.query<GuardrailRow>(
        `insert into hoteles.agent_guardrail (property_id, max_discount_pct, max_refund_cents, max_folio_charge_cents, max_mass_recipients, blocked_words, send_window_start, send_window_end)
         values ($1, $2, $3, $4, $5, $6::text[], $7::time, $8::time)
         on conflict (property_id) do update
           set max_discount_pct = excluded.max_discount_pct, max_refund_cents = excluded.max_refund_cents, max_folio_charge_cents = excluded.max_folio_charge_cents,
               max_mass_recipients = excluded.max_mass_recipients, blocked_words = excluded.blocked_words,
               send_window_start = excluded.send_window_start, send_window_end = excluded.send_window_end
         returning ${GUARDRAIL_COLS};`,
        [propertyId, g.maxDiscountPct, g.maxRefundCents, g.maxFolioChargeCents, g.maxMassRecipients, [...g.blockedWords], g.sendWindowStart, g.sendWindowEnd],
      );
      return mapGuardrails(rows[0]!);
    });
  }

  async listPolicies(propertyId: string): Promise<ActionPolicyListResult> {
    return this.read<ActionPolicyListResult>(
      "listPolicies",
      async () => {
        const { rows } = await this.db.query<PolicyRow>(`select ${POLICY_COLS} from hoteles.agent_action_policy where property_id = $1;`, [propertyId]);
        const byAction = new Map(rows.map((r) => [r.action_type, mapPolicy(r)]));
        return { disponible: true, politicas: APPROVAL_ACTION_TYPES.map((a) => byAction.get(a) ?? defaultPolicy(a)) };
      },
      () => ({ disponible: false, politicas: APPROVAL_ACTION_TYPES.map(defaultPolicy) }),
    );
  }

  async upsertPolicy(propertyId: string, actionType: ApprovalActionType, p: ActionPolicyInput): Promise<ActionPolicyRecord> {
    return this.write("upsertPolicy", async () => {
      const { rows } = await this.db.query<PolicyRow>(
        `insert into hoteles.agent_action_policy (property_id, action_type, mode, auto_max_percent, auto_max_amount_cents, expires_minutes, approver_roles)
         values ($1, $2, $3, $4, $5, $6, $7::text[])
         on conflict (property_id, action_type) do update
           set mode = excluded.mode, auto_max_percent = excluded.auto_max_percent, auto_max_amount_cents = excluded.auto_max_amount_cents,
               expires_minutes = excluded.expires_minutes, approver_roles = excluded.approver_roles
         returning ${POLICY_COLS};`,
        [propertyId, actionType, p.mode, p.autoMaxPercent, p.autoMaxAmountCents, p.expiresMinutes, [...p.approverRoles]],
      );
      return mapPolicy(rows[0]!);
    });
  }

  // ---- aprobaciones ----
  async listApprovals(propertyId: string, filter: ApprovalFilter): Promise<ApprovalListResult> {
    return this.read<ApprovalListResult>(
      "listApprovals",
      async () => {
        const { rows } = await this.db.query<ApprovalRow>(
          `select ${APPROVAL_COLS} from hoteles.agent_approval_request
            where property_id = $1
              and ($2::text is null or status = $2)
              and ($3::text is null or action_type = $3)
              and (not $4::boolean or status in ('pendiente', 'aprobada'))
            order by created_at desc, id desc limit 200;`,
          [propertyId, filter.status ?? null, filter.actionType ?? null, filter.onlyOpen ?? false],
        );
        return { disponible: true, aprobaciones: rows.map(mapApproval) };
      },
      () => ({ disponible: false, aprobaciones: [] }),
    );
  }

  async findApproval(propertyId: string, approvalId: string): Promise<ApprovalRecord | null> {
    return this.read<ApprovalRecord | null>(
      "findApproval",
      async () => {
        const { rows } = await this.db.query<ApprovalRow>(`select ${APPROVAL_COLS} from hoteles.agent_approval_request where property_id = $1 and id = $2;`, [propertyId, approvalId]);
        return rows[0] ? mapApproval(rows[0]) : null;
      },
      () => null,
    );
  }

  async listApprovalEvents(propertyId: string, approvalId: string): Promise<readonly ApprovalEventRecord[]> {
    return this.read<readonly ApprovalEventRecord[]>(
      "listApprovalEvents",
      async () => {
        const { rows } = await this.db.query<{ id: string; subject_id: string; event_type: string; actor_id: string | null; detail: unknown; created_at: string }>(
          `select id, subject_id, event_type, actor_id, detail, created_at::text as created_at from hoteles.agent_event
            where property_id = $1 and subject_type = 'aprobacion' and subject_id = $2 order by created_at asc, id asc;`,
          [propertyId, approvalId],
        );
        return rows.map((e) => ({
          id: e.id, subjectId: e.subject_id, eventType: e.event_type, actorId: e.actor_id, createdAt: e.created_at,
          detail: e.detail && typeof e.detail === "object" && !Array.isArray(e.detail) ? (e.detail as Record<string, unknown>) : {},
        }));
      },
      () => [],
    );
  }

  async proposeAction(i: ProposeActionInput, _actor: Actor): Promise<ApprovalRecord> {
    return this.write("proposeAction", async () => {
      const { rows } = await this.db.query<ApprovalRow>(
        `select ${APPROVAL_COLS} from hoteles.propose_agent_action($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11::timestamptz);`,
        [i.propertyId, i.agentKey, i.actionType, i.summary, JSON.stringify(i.payload), i.amountCents, i.percent, i.recipients, i.contentText, i.idempotencyKey, (i.now ?? new Date()).toISOString()],
      );
      return mapApproval(rows[0]!);
    });
  }

  async decideApproval(propertyId: string, approvalId: string, decision: "aprobar" | "rechazar", reason: string, _actor: Actor): Promise<ApprovalRecord> {
    return this.write("decideApproval", async () => {
      await this.assertInProperty("agent_approval_request", propertyId, approvalId, "Solicitud");
      const { rows } = await this.db.query<ApprovalRow>(`select ${APPROVAL_COLS} from hoteles.decide_agent_approval($1, $2, $3);`, [approvalId, decision, reason]);
      return mapApproval(rows[0]!);
    });
  }

  async cancelApproval(propertyId: string, approvalId: string, reason: string, _actor: Actor): Promise<ApprovalRecord> {
    return this.write("cancelApproval", async () => {
      await this.assertInProperty("agent_approval_request", propertyId, approvalId, "Solicitud");
      const { rows } = await this.db.query<ApprovalRow>(`select ${APPROVAL_COLS} from hoteles.cancel_agent_approval($1, $2);`, [approvalId, reason]);
      return mapApproval(rows[0]!);
    });
  }

  async consumeApproval(propertyId: string, approvalId: string, executionRef: string, _actor: Actor, now?: Date): Promise<ApprovalRecord> {
    return this.write("consumeApproval", async () => {
      await this.assertInProperty("agent_approval_request", propertyId, approvalId, "Solicitud");
      const { rows } = await this.db.query<ApprovalRow>(`select ${APPROVAL_COLS} from hoteles.consume_agent_approval($1, $2, $3::timestamptz);`, [approvalId, executionRef, (now ?? new Date()).toISOString()]);
      return mapApproval(rows[0]!);
    });
  }

  async expireApprovals(propertyId: string, now: Date): Promise<number> {
    return this.write("expireApprovals", async () => {
      const { rows } = await this.db.query<{ n: number }>(`select hoteles.expire_agent_approvals($1, $2::timestamptz) as n;`, [propertyId, now.toISOString()]);
      return Number(rows[0]?.n ?? 0);
    });
  }

  // ---- sistema ----
  async gate(propertyId: string, agentKey: AgentKey, month: string): Promise<AgentGate | null> {
    return this.read<AgentGate | null>(
      "gate",
      async () => {
        const { rows } = await this.db.query<{ out_enabled: boolean; out_budget_micro_usd: string | number | null; out_spent_micro_usd: string | number; out_paused_reason: string | null }>(
          `select out_enabled, out_budget_micro_usd, out_spent_micro_usd, out_paused_reason from hoteles.agent_gate($1, $2, $3);`,
          [propertyId, agentKey, month],
        );
        const r = rows[0];
        return r ? { enabled: r.out_enabled, budgetMicroUsd: num(r.out_budget_micro_usd), spentMicroUsd: Number(r.out_spent_micro_usd), pausedReason: r.out_paused_reason } : null;
      },
      () => null,
    );
  }

  async recordUsage(propertyId: string, agentKey: AgentKey, month: string, d: UsageDelta): Promise<void> {
    await this.write("recordUsage", async () => {
      await this.db.query(`select hoteles.record_agent_usage($1, $2, $3, $4, $5, $6, $7);`, [propertyId, agentKey, month, d.tokensIn, d.tokensOut, d.costMicroUsd, d.calls]);
    });
  }

  // ---- plantillas ----
  async listTemplates(propertyId: string): Promise<TemplateListResult> {
    return this.read<TemplateListResult>(
      "listTemplates",
      async () => {
        const { rows } = await this.db.query<TemplateRow>(`select ${TEMPLATE_COLS} from hoteles.agent_wa_template where property_id = $1 order by name, language, version desc limit 500;`, [propertyId]);
        return { disponible: true, plantillas: rows.map(mapTemplate) };
      },
      () => ({ disponible: false, plantillas: [] }),
    );
  }

  async createTemplate(i: NewTemplateInput, _actor: Actor): Promise<TemplateRecord> {
    return this.write("createTemplate", async () => {
      const { rows } = await this.db.query<TemplateRow>(`select ${TEMPLATE_COLS} from hoteles.create_agent_wa_template($1, $2, $3, $4, $5, $6);`, [i.propertyId, i.agentKey, i.name, i.language, i.category, i.body]);
      return mapTemplate(rows[0]!);
    });
  }

  async submitTemplate(propertyId: string, templateId: string, _actor: Actor): Promise<TemplateRecord> {
    return this.write("submitTemplate", async () => {
      await this.assertInProperty("agent_wa_template", propertyId, templateId, "Plantilla");
      const { rows } = await this.db.query<TemplateRow>(`select ${TEMPLATE_COLS} from hoteles.submit_agent_wa_template($1);`, [templateId]);
      return mapTemplate(rows[0]!);
    });
  }

  async reviewTemplate(propertyId: string, templateId: string, decision: "aprobar" | "rechazar", reason: string, _actor: Actor): Promise<TemplateRecord> {
    return this.write("reviewTemplate", async () => {
      await this.assertInProperty("agent_wa_template", propertyId, templateId, "Plantilla");
      const { rows } = await this.db.query<TemplateRow>(`select ${TEMPLATE_COLS} from hoteles.review_agent_wa_template($1, $2, $3);`, [templateId, decision, reason]);
      return mapTemplate(rows[0]!);
    });
  }

  async archiveTemplate(propertyId: string, templateId: string, _actor: Actor): Promise<TemplateRecord> {
    return this.write("archiveTemplate", async () => {
      await this.assertInProperty("agent_wa_template", propertyId, templateId, "Plantilla");
      const { rows } = await this.db.query<TemplateRow>(`select ${TEMPLATE_COLS} from hoteles.archive_agent_wa_template($1);`, [templateId]);
      return mapTemplate(rows[0]!);
    });
  }
}

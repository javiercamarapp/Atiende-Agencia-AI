// Repositorio en memoria de agentes/aprobaciones/plantillas (H-03). Espejo de la logica de la migracion 035
// para la integracion HTTP rapida (apps/api) y las pruebas de dominio; NO sustituye la verificacion contra
// Postgres real (RLS, GRANT, triggers, funciones definer: scripts/verify-hoteles-agentes-aprobaciones).
import { randomUUID } from "node:crypto";
import { DEFAULT_GUARDRAILS, defaultPolicy, evaluateGuardrails, guardrailsFrom, normalizeBlockedWords, qualifiesForAutoApproval, withinSendWindow } from "./guardrails.ts";
import type { AgentesRepository, UsageDelta } from "./repository.ts";
import {
  AGENT_KEYS,
  APPROVAL_ACTION_TYPES,
  AgentesAccessDeniedError,
  AgentesConflictError,
  AgentesInvalidInputError,
  AgentesNotFoundError,
  AgentesUnavailableError,
  TEMPLATE_NAME_RE,
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
  GuardrailsInput,
  GuardrailsRecord,
  GuardrailsResult,
  NewTemplateInput,
  ProposeActionInput,
  TemplateListResult,
  TemplateRecord,
} from "./tipos.ts";

export interface InMemoryAgentesOptions {
  /** Simula la base SIN la migracion 035. */
  readonly migrated?: boolean;
  readonly now?: () => Date;
  /** Zona horaria de la property para la ventana de envio. */
  readonly timeZone?: string | null;
}

const TERMINAL: readonly string[] = ["rechazada", "expirada", "ejecutada", "cancelada", "bloqueada"];
const AUTHOR_ROLES = ["owner", "gm", "frontdesk", "reservations"];
const MANAGE_ROLES = ["owner", "gm"];

export class InMemoryAgentesRepository implements AgentesRepository {
  private readonly migrated: boolean;
  private readonly clock: () => Date;
  private readonly timeZone: string | null;
  private readonly configs = new Map<string, AgentConfigRecord>();
  private readonly usage = new Map<string, { tokensIn: number; tokensOut: number; costMicroUsd: number; callCount: number }>();
  private readonly guardrails = new Map<string, GuardrailsRecord>();
  private readonly policies = new Map<string, ActionPolicyRecord>();
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly events: (ApprovalEventRecord & { propertyId: string })[] = [];
  private readonly templates = new Map<string, TemplateRecord>();

  constructor(opts: InMemoryAgentesOptions = {}) {
    this.migrated = opts.migrated ?? true;
    this.clock = opts.now ?? (() => new Date());
    this.timeZone = opts.timeZone ?? null;
  }

  private requireMigrated(operation: string): void {
    if (!this.migrated) throw new AgentesUnavailableError(operation);
  }

  private userNow(): Date {
    return this.clock();
  }

  /** Mismo criterio que hoteles.agent_clock: el reloj de la app solo vale en sesion de sistema. */
  private effectiveNow(actor: Actor, requested?: Date): Date {
    return actor.userId === null && requested ? requested : this.clock();
  }

  private log(a: ApprovalRecord, eventType: string, actorId: string | null, detail: Record<string, unknown> = {}): void {
    this.events.push({ id: randomUUID(), propertyId: a.propertyId, subjectId: a.id, eventType, actorId, detail, createdAt: this.clock().toISOString() });
  }

  // ---- catalogo ----
  async listAgentConfig(propertyId: string, month: string): Promise<AgentConfigListResult> {
    if (!this.migrated) return { disponible: false, configs: [], usage: [] };
    return {
      disponible: true,
      configs: AGENT_KEYS.flatMap((k) => this.configs.get(`${propertyId}|${k}`) ?? []),
      usage: AGENT_KEYS.flatMap((k) => {
        const u = this.usage.get(`${propertyId}|${k}|${month}`);
        return u ? [{ agentKey: k, month, ...u }] : [];
      }),
    };
  }

  async updateAgentConfig(propertyId: string, agentKey: AgentKey, update: AgentConfigUpdate): Promise<AgentConfigRecord> {
    this.requireMigrated("updateAgentConfig");
    const prev = this.configs.get(`${propertyId}|${agentKey}`);
    const enabled = update.enabled ?? prev?.enabled ?? true;
    const budget = update.budgetMicroUsd === undefined ? (prev?.budgetMicroUsd ?? null) : update.budgetMicroUsd;
    if (budget !== null && !(budget > 0)) throw new AgentesInvalidInputError("El presupuesto debe ser mayor a 0.");
    const reason = enabled ? null : (update.pausedReason ?? prev?.pausedReason ?? null);
    if (!enabled && (reason === null || reason.trim().length < 5 || reason.length > 300)) {
      throw new AgentesInvalidInputError("Pausar un agente exige un motivo (5 a 300 caracteres).");
    }
    const now = this.clock().toISOString();
    const rec: AgentConfigRecord = {
      agentKey,
      enabled,
      pausedReason: reason,
      pausedAt: enabled ? null : prev && !prev.enabled ? prev.pausedAt : now,
      budgetMicroUsd: budget,
      updatedAt: now,
    };
    this.configs.set(`${propertyId}|${agentKey}`, rec);
    return rec;
  }

  // ---- guardrails y politicas ----
  async getGuardrails(propertyId: string): Promise<GuardrailsResult> {
    if (!this.migrated) return { disponible: false, guardrails: { propertyId, ...DEFAULT_GUARDRAILS, updatedAt: "", configured: false } };
    return { disponible: true, guardrails: this.guardrails.get(propertyId) ?? { propertyId, ...DEFAULT_GUARDRAILS, updatedAt: "", configured: false } };
  }

  async upsertGuardrails(propertyId: string, input: GuardrailsInput): Promise<GuardrailsRecord> {
    this.requireMigrated("upsertGuardrails");
    if (!(input.maxDiscountPct > 0 && input.maxDiscountPct <= 100)) throw new AgentesInvalidInputError("maxDiscountPct fuera de rango (0, 100].");
    if (!(input.maxRefundCents > 0) || !(input.maxFolioChargeCents > 0)) throw new AgentesInvalidInputError("Los topes de monto deben ser mayores a 0.");
    if (!(input.maxMassRecipients >= 1 && input.maxMassRecipients <= 100000)) throw new AgentesInvalidInputError("maxMassRecipients fuera de rango.");
    if (!(input.sendWindowStart < input.sendWindowEnd)) throw new AgentesInvalidInputError("La ventana de envio exige inicio < fin.");
    let blockedWords: readonly string[];
    try {
      blockedWords = normalizeBlockedWords(input.blockedWords);
    } catch (err) {
      throw new AgentesInvalidInputError(err instanceof Error ? err.message : "Palabras bloqueadas invalidas.");
    }
    const rec: GuardrailsRecord = { propertyId, ...input, blockedWords, updatedAt: this.clock().toISOString(), configured: true };
    this.guardrails.set(propertyId, rec);
    return rec;
  }

  private effectiveGuardrails(propertyId: string): GuardrailsInput {
    const g = this.guardrails.get(propertyId);
    return g ? guardrailsFrom(g) : DEFAULT_GUARDRAILS;
  }

  async listPolicies(propertyId: string): Promise<ActionPolicyListResult> {
    if (!this.migrated) return { disponible: false, politicas: APPROVAL_ACTION_TYPES.map(defaultPolicy) };
    return { disponible: true, politicas: APPROVAL_ACTION_TYPES.map((a) => this.policies.get(`${propertyId}|${a}`) ?? defaultPolicy(a)) };
  }

  async upsertPolicy(propertyId: string, actionType: ApprovalActionType, input: ActionPolicyInput): Promise<ActionPolicyRecord> {
    this.requireMigrated("upsertPolicy");
    if (input.mode === "auto_bajo_umbral") {
      if (actionType === "respuesta_resena" || actionType === "mensaje_masivo") throw new AgentesInvalidInputError("El contenido para el huesped exige aprobacion humana siempre.");
      if (actionType === "descuento_tarifa" ? input.autoMaxPercent == null : input.autoMaxAmountCents == null) throw new AgentesInvalidInputError("Falta el umbral de ejecucion automatica.");
    }
    if (input.expiresMinutes < 5 || input.expiresMinutes > 10080) throw new AgentesInvalidInputError("La vigencia debe estar entre 5 y 10080 minutos.");
    if (input.approverRoles.length < 1) throw new AgentesInvalidInputError("Se requiere al menos un rol aprobador.");
    const rec: ActionPolicyRecord = {
      actionType,
      mode: input.mode,
      autoMaxPercent: input.mode === "siempre_humano" ? null : input.autoMaxPercent,
      autoMaxAmountCents: input.mode === "siempre_humano" ? null : input.autoMaxAmountCents,
      expiresMinutes: input.expiresMinutes,
      approverRoles: input.approverRoles,
      configured: true,
      updatedAt: this.clock().toISOString(),
    };
    this.policies.set(`${propertyId}|${actionType}`, rec);
    return rec;
  }

  // ---- aprobaciones ----
  async listApprovals(propertyId: string, filter: ApprovalFilter): Promise<ApprovalListResult> {
    if (!this.migrated) return { disponible: false, aprobaciones: [] };
    const rows = [...this.approvals.values()]
      .filter((a) => a.propertyId === propertyId)
      .filter((a) => (filter.status ? a.status === filter.status : true))
      .filter((a) => (filter.actionType ? a.actionType === filter.actionType : true))
      .filter((a) => (filter.onlyOpen ? a.status === "pendiente" || a.status === "aprobada" : true))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return { disponible: true, aprobaciones: rows };
  }

  async findApproval(propertyId: string, approvalId: string): Promise<ApprovalRecord | null> {
    if (!this.migrated) return null;
    const a = this.approvals.get(approvalId);
    return a && a.propertyId === propertyId ? a : null;
  }

  async listApprovalEvents(propertyId: string, approvalId: string): Promise<readonly ApprovalEventRecord[]> {
    if (!this.migrated) return [];
    return this.events.filter((e) => e.propertyId === propertyId && e.subjectId === approvalId).map(({ propertyId: _p, ...e }) => e);
  }

  async proposeAction(input: ProposeActionInput, actor: Actor): Promise<ApprovalRecord> {
    this.requireMigrated("proposeAction");
    const now = this.effectiveNow(actor, input.now);
    const agentKey: AgentKey | "manual" = actor.userId === null ? input.agentKey : "manual";
    if (actor.userId !== null && !AUTHOR_ROLES.includes(actor.role ?? "")) throw new AgentesAccessDeniedError("Sin permiso para proponer acciones en esta property.");
    for (const a of this.approvals.values()) {
      if (a.propertyId === input.propertyId && a.idempotencyKey === input.idempotencyKey) {
        const same = a.actionType === input.actionType && a.amountCents === input.amountCents && a.percent === input.percent && a.recipients === input.recipients && a.contentText === input.contentText && JSON.stringify(a.payload) === JSON.stringify(input.payload);
        if (!same) throw new AgentesConflictError("La llave de idempotencia ya se uso con contenido distinto.");
        return a;
      }
    }
    this.validateProposal(input);
    const policy = this.policies.get(`${input.propertyId}|${input.actionType}`) ?? defaultPolicy(input.actionType);
    const text = `${input.contentText ?? ""} ${input.summary}`;
    let block: string | null = null;
    if (agentKey !== "manual" && this.configs.get(`${input.propertyId}|${agentKey}`)?.enabled === false) block = "agente_pausado";
    if (!block) {
      const pending = [...this.approvals.values()].filter((a) => a.propertyId === input.propertyId && a.status === "pendiente" && a.expiresAt > now.toISOString()).length;
      if (pending >= 200) block = "cola_llena";
    }
    if (!block) block = evaluateGuardrails({ actionType: input.actionType, amountCents: input.amountCents, percent: input.percent, recipients: input.recipients, text }, this.effectiveGuardrails(input.propertyId));
    const auto = !block && agentKey !== "manual" && qualifiesForAutoApproval(policy, { actionType: input.actionType, amountCents: input.amountCents, percent: input.percent });
    const rec: ApprovalRecord = {
      id: randomUUID(),
      propertyId: input.propertyId,
      agentKey,
      actionType: input.actionType,
      summary: input.summary,
      payload: input.payload,
      amountCents: input.amountCents,
      currency: "MXN",
      percent: input.percent,
      recipients: input.recipients,
      contentText: input.contentText,
      idempotencyKey: input.idempotencyKey,
      status: block ? "bloqueada" : auto ? "aprobada" : "pendiente",
      proposedBy: actor.userId,
      autoApproved: auto,
      blockReason: block,
      expiresAt: new Date(now.getTime() + policy.expiresMinutes * 60_000).toISOString(),
      decidedBy: null,
      decidedAt: auto ? now.toISOString() : null,
      decisionReason: auto ? "politica_auto_bajo_umbral" : null,
      executedAt: null,
      executedBy: null,
      executionRef: null,
      createdAt: now.toISOString(),
    };
    this.approvals.set(rec.id, rec);
    this.log(rec, block ? "bloqueada" : auto ? "autoaprobada" : "propuesta", actor.userId, { agente: agentKey, accion: rec.actionType, estado: rec.status });
    return rec;
  }

  private validateProposal(i: ProposeActionInput): void {
    const bad = (m: string): never => {
      throw new AgentesInvalidInputError(m);
    };
    if (i.idempotencyKey.length < 8 || i.idempotencyKey.length > 120) bad("idempotencyKey: de 8 a 120 caracteres.");
    if (i.summary.length < 1 || i.summary.length > 300) bad("summary: de 1 a 300 caracteres.");
    if (i.actionType === "descuento_tarifa" && !(i.percent != null && i.percent > 0 && i.percent <= 100)) bad("percent: requerido, en (0, 100].");
    if ((i.actionType === "reembolso" || i.actionType === "cargo_folio") && !(i.amountCents != null && i.amountCents > 0)) bad("amountCents: requerido, mayor a 0.");
    if (i.actionType === "mensaje_masivo" && !(i.recipients != null && i.recipients > 0 && i.contentText)) bad("recipients y contentText: requeridos.");
    if (i.actionType === "respuesta_resena" && !i.contentText) bad("contentText: requerido.");
  }

  private load(propertyId: string, approvalId: string): ApprovalRecord {
    const a = this.approvals.get(approvalId);
    if (!a || a.propertyId !== propertyId) throw new AgentesNotFoundError("Solicitud");
    return a;
  }

  private save(a: ApprovalRecord, patch: Partial<ApprovalRecord>): ApprovalRecord {
    const next = { ...a, ...patch };
    this.approvals.set(a.id, next);
    return next;
  }

  async decideApproval(propertyId: string, approvalId: string, decision: "aprobar" | "rechazar", reason: string, actor: Actor): Promise<ApprovalRecord> {
    this.requireMigrated("decideApproval");
    const a = this.load(propertyId, approvalId);
    if (actor.userId === null) throw new AgentesAccessDeniedError("Requiere una persona autenticada.");
    if (reason.trim().length < 5 || reason.length > 500) throw new AgentesInvalidInputError("El motivo es obligatorio (5 a 500 caracteres).");
    const policy = this.policies.get(`${propertyId}|${a.actionType}`) ?? defaultPolicy(a.actionType);
    if (actor.role !== "owner" && !policy.approverRoles.includes((actor.role ?? "") as never)) throw new AgentesAccessDeniedError("Tu rol no puede decidir esta accion.");
    if (a.status !== "pendiente") throw new AgentesConflictError(`La solicitud ya esta ${a.status} y no admite una nueva decision.`);
    const now = this.userNow();
    if (a.expiresAt <= now.toISOString()) {
      const exp = this.save(a, { status: "expirada" });
      this.log(exp, "expirada", null, { de: "pendiente" });
      return exp;
    }
    if (a.proposedBy !== null && a.proposedBy === actor.userId) throw new AgentesAccessDeniedError("No puedes decidir una solicitud que tu mismo propusiste.");
    if (decision === "aprobar") {
      const v = evaluateGuardrails({ actionType: a.actionType, amountCents: a.amountCents, percent: a.percent, recipients: a.recipients, text: `${a.contentText ?? ""} ${a.summary}` }, this.effectiveGuardrails(propertyId));
      if (v) throw new AgentesInvalidInputError(`La solicitud excede un guardrail vigente (${v}).`);
    }
    const next = this.save(a, { status: decision === "aprobar" ? "aprobada" : "rechazada", decidedBy: actor.userId, decidedAt: now.toISOString(), decisionReason: reason.trim() });
    this.log(next, next.status, actor.userId, { de: "pendiente", motivo: next.decisionReason });
    return next;
  }

  async cancelApproval(propertyId: string, approvalId: string, reason: string, actor: Actor): Promise<ApprovalRecord> {
    this.requireMigrated("cancelApproval");
    const a = this.load(propertyId, approvalId);
    if (actor.userId === null) throw new AgentesAccessDeniedError("Requiere una persona autenticada.");
    if (reason.trim().length < 5 || reason.length > 500) throw new AgentesInvalidInputError("El motivo es obligatorio (5 a 500 caracteres).");
    if (!(MANAGE_ROLES.includes(actor.role ?? "") || a.proposedBy === actor.userId)) throw new AgentesAccessDeniedError("Solo owner/gm o quien la propuso cancelan una solicitud.");
    if (a.status !== "pendiente" && a.status !== "aprobada") throw new AgentesConflictError(`La solicitud ya esta ${a.status} y no se puede cancelar.`);
    const next = this.save(a, { status: "cancelada", decisionReason: reason.trim() });
    this.log(next, "cancelada", actor.userId, { de: a.status, motivo: next.decisionReason });
    return next;
  }

  async consumeApproval(propertyId: string, approvalId: string, executionRef: string, actor: Actor, now?: Date): Promise<ApprovalRecord> {
    this.requireMigrated("consumeApproval");
    const a = this.load(propertyId, approvalId);
    if (actor.userId !== null && !MANAGE_ROLES.includes(actor.role ?? "")) throw new AgentesNotFoundError("Solicitud");
    if (a.status !== "aprobada") throw new AgentesConflictError(`La solicitud esta ${a.status} y no se puede ejecutar.`);
    const t = this.effectiveNow(actor, now);
    if (a.expiresAt <= t.toISOString()) {
      const exp = this.save(a, { status: "expirada" });
      this.log(exp, "expirada", actor.userId, { de: "aprobada" });
      return exp;
    }
    const g = this.effectiveGuardrails(propertyId);
    const v = evaluateGuardrails({ actionType: a.actionType, amountCents: a.amountCents, percent: a.percent, recipients: a.recipients, text: `${a.contentText ?? ""} ${a.summary}` }, g);
    if (v) {
      const blocked = this.save(a, { status: "bloqueada", blockReason: v });
      this.log(blocked, "bloqueada", actor.userId, { de: "aprobada", motivo: v });
      return blocked;
    }
    if (a.actionType === "mensaje_masivo" && !withinSendWindow(t, this.timeZone, g.sendWindowStart, g.sendWindowEnd)) return a;
    const done = this.save(a, { status: "ejecutada", executedAt: t.toISOString(), executedBy: actor.userId, executionRef: executionRef.slice(0, 200) });
    this.log(done, "ejecutada", actor.userId, { referencia: done.executionRef });
    return done;
  }

  async expireApprovals(propertyId: string, now: Date): Promise<number> {
    this.requireMigrated("expireApprovals");
    let n = 0;
    for (const a of [...this.approvals.values()]) {
      if (a.propertyId === propertyId && (a.status === "pendiente" || a.status === "aprobada") && a.expiresAt <= now.toISOString()) {
        const exp = this.save(a, { status: "expirada" });
        this.log(exp, "expirada", null, { de: a.status });
        n += 1;
      }
    }
    return n;
  }

  // ---- sistema ----
  async gate(propertyId: string, agentKey: AgentKey, month: string): Promise<AgentGate | null> {
    if (!this.migrated) return null;
    const c = this.configs.get(`${propertyId}|${agentKey}`);
    return { enabled: c?.enabled ?? true, budgetMicroUsd: c?.budgetMicroUsd ?? null, spentMicroUsd: this.usage.get(`${propertyId}|${agentKey}|${month}`)?.costMicroUsd ?? 0, pausedReason: c?.pausedReason ?? null };
  }

  async recordUsage(propertyId: string, agentKey: AgentKey, month: string, d: UsageDelta): Promise<void> {
    this.requireMigrated("recordUsage");
    if (d.tokensIn < 0 || d.tokensOut < 0 || d.costMicroUsd < 0 || d.calls < 0) throw new AgentesInvalidInputError("Los acumulados no pueden ser negativos.");
    const key = `${propertyId}|${agentKey}|${month}`;
    const cur = this.usage.get(key) ?? { tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0 };
    this.usage.set(key, { tokensIn: cur.tokensIn + d.tokensIn, tokensOut: cur.tokensOut + d.tokensOut, costMicroUsd: cur.costMicroUsd + d.costMicroUsd, callCount: cur.callCount + d.calls });
  }

  // ---- plantillas ----
  async listTemplates(propertyId: string): Promise<TemplateListResult> {
    if (!this.migrated) return { disponible: false, plantillas: [] };
    const rows = [...this.templates.values()].filter((t) => t.propertyId === propertyId).sort((a, b) => (a.name === b.name ? b.version - a.version : a.name < b.name ? -1 : 1));
    return { disponible: true, plantillas: rows };
  }

  async createTemplate(input: NewTemplateInput, actor: Actor): Promise<TemplateRecord> {
    this.requireMigrated("createTemplate");
    if (actor.userId === null || !AUTHOR_ROLES.includes(actor.role ?? "")) throw new AgentesAccessDeniedError("Sin permiso para redactar plantillas en esta property.");
    if (!TEMPLATE_NAME_RE.test(input.name)) throw new AgentesInvalidInputError("Nombre de plantilla invalido (minusculas, digitos y guion bajo, 3 a 60).");
    if (input.body.length < 1 || input.body.length > 1024) throw new AgentesInvalidInputError("El cuerpo debe tener de 1 a 1024 caracteres.");
    if (evaluateGuardrails({ actionType: "respuesta_resena", text: input.body }, this.effectiveGuardrails(input.propertyId))) throw new AgentesInvalidInputError("La plantilla contiene una palabra bloqueada por los guardrails.");
    const version = Math.max(0, ...[...this.templates.values()].filter((t) => t.propertyId === input.propertyId && t.name === input.name && t.language === input.language).map((t) => t.version)) + 1;
    const rec: TemplateRecord = { id: randomUUID(), propertyId: input.propertyId, agentKey: input.agentKey, name: input.name, language: input.language, category: input.category, body: input.body, version, status: "borrador", createdBy: actor.userId, submittedBy: null, submittedAt: null, reviewedBy: null, reviewedAt: null, reviewReason: null, createdAt: this.clock().toISOString() };
    this.templates.set(rec.id, rec);
    return rec;
  }

  private loadTemplate(propertyId: string, id: string): TemplateRecord {
    const t = this.templates.get(id);
    if (!t || t.propertyId !== propertyId) throw new AgentesNotFoundError("Plantilla");
    return t;
  }

  async submitTemplate(propertyId: string, templateId: string, actor: Actor): Promise<TemplateRecord> {
    this.requireMigrated("submitTemplate");
    const t = this.loadTemplate(propertyId, templateId);
    if (actor.userId === null || !AUTHOR_ROLES.includes(actor.role ?? "")) throw new AgentesNotFoundError("Plantilla");
    if (t.status !== "borrador") throw new AgentesConflictError(`La plantilla ya esta ${t.status} y no se puede enviar a revision.`);
    const next = { ...t, status: "pendiente" as const, submittedBy: actor.userId, submittedAt: this.clock().toISOString() };
    this.templates.set(t.id, next);
    return next;
  }

  async reviewTemplate(propertyId: string, templateId: string, decision: "aprobar" | "rechazar", reason: string, actor: Actor): Promise<TemplateRecord> {
    this.requireMigrated("reviewTemplate");
    const t = this.loadTemplate(propertyId, templateId);
    if (reason.trim().length < 5 || reason.length > 300) throw new AgentesInvalidInputError("El motivo es obligatorio (5 a 300 caracteres).");
    if (actor.userId === null || !MANAGE_ROLES.includes(actor.role ?? "")) throw new AgentesAccessDeniedError("Solo owner/gm aprueban o rechazan plantillas.");
    if (t.status !== "pendiente") throw new AgentesConflictError(`La plantilla esta ${t.status} y no admite una decision.`);
    if (t.submittedBy === actor.userId && actor.role !== "owner") throw new AgentesAccessDeniedError("No puedes decidir una plantilla que tu mismo enviaste (solo el dueno).");
    if (decision === "aprobar") {
      for (const o of this.templates.values()) {
        if (o.propertyId === propertyId && o.name === t.name && o.language === t.language && o.status === "aprobada") this.templates.set(o.id, { ...o, status: "archivada" });
      }
    }
    const next: TemplateRecord = { ...t, status: decision === "aprobar" ? "aprobada" : "rechazada", reviewedBy: actor.userId, reviewedAt: this.clock().toISOString(), reviewReason: reason.trim() };
    this.templates.set(t.id, next);
    return next;
  }

  async archiveTemplate(propertyId: string, templateId: string, actor: Actor): Promise<TemplateRecord> {
    this.requireMigrated("archiveTemplate");
    const t = this.loadTemplate(propertyId, templateId);
    if (actor.userId === null || !MANAGE_ROLES.includes(actor.role ?? "")) throw new AgentesAccessDeniedError("Solo owner/gm archivan plantillas.");
    if (t.status !== "aprobada" && t.status !== "rechazada") throw new AgentesConflictError(`La plantilla esta ${t.status} y no se puede archivar.`);
    const next = { ...t, status: "archivada" as const };
    this.templates.set(t.id, next);
    return next;
  }
}

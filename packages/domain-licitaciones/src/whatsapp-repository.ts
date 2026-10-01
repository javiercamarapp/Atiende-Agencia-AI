// L-05 -- almacenamiento de WhatsApp de licitaciones (tablas/funciones de la migracion
// 030). Modulo APARTE de `repository.ts`/`postgres-repository.ts` (mismo criterio que
// `sala-guerra-repository.ts`: archivos compartidos por varias ramas en paralelo).
//
// REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: la API se despliega antes que la
// migracion 030. Cada operacion corre dentro de `runWithSavepointFallback`
// (SAVEPOINT / ROLLBACK TO SAVEPOINT) porque la sesion del request / del webhook es
// UNA transaccion: un 42P01/42703/42883 sin savepoint la dejaria abortada (25P02) y el
// COMMIT revertiria todo en silencio. Si falta la migracion se lanza
// `WhatsAppNotAvailableError`; el llamador decide: lecturas -> "no disponible aun",
// escrituras -> 503, webhook -> acuse 200 sin procesar. Nunca un 500.
//
// Quien usa que sesion:
//   - panel (sesion de staff): getContact / upsertContact / requestConsent / optOutSelf /
//     listEvents. RLS: cada usuario solo ve y edita su propia fila.
//   - webhook, tras abrir la sesion DEL USUARIO del token: consumeActionToken.
//   - sesion de SISTEMA (`auth.uid()` NULL): el resto (los guards viven en la base).
import { randomUUID } from "node:crypto";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError, runWithSavepointFallback } from "@atiende/db";
import type { MessagingOutboxItem, MessagingOutboxPort } from "@atiende/whatsapp-gateway";
import { WhatsAppNotAvailableError, sha256TokenHash } from "./whatsapp.ts";
import type { TokenConsumeResult, WhatsAppDecisionAction, WhatsAppTopic } from "./whatsapp.ts";

export type WhatsAppContactStatus = "pendiente" | "activo" | "baja";

export interface WhatsAppContactRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly phoneE164: string;
  readonly status: WhatsAppContactStatus;
  readonly notifyPlazos: boolean;
  readonly notifyConvocatorias: boolean;
  readonly notifyFallos: boolean;
  readonly notifyDecisiones: boolean;
  readonly consentRequestedAt: string | null;
  readonly optedInAt: string | null;
  readonly optedOutAt: string | null;
}

export interface WhatsAppContactInput {
  readonly phoneE164: string;
  readonly notifyPlazos: boolean;
  readonly notifyConvocatorias: boolean;
  readonly notifyFallos: boolean;
  readonly notifyDecisiones: boolean;
}

export interface WhatsAppEventRecord {
  readonly id: string;
  readonly userId: string | null;
  readonly tenderId: string | null;
  readonly event: string;
  readonly detail: string | null;
  readonly createdAt: string;
}

export interface TokenConsumeOutcome {
  readonly result: TokenConsumeResult;
  readonly tenderId: string | null;
  readonly action: WhatsAppDecisionAction | null;
  /** Rol vigente del usuario (solo cuando `result === "ok"`). */
  readonly role: string | null;
}

export interface ActiveContact {
  readonly userId: string;
  readonly phoneE164: string;
}

export interface IssueTokenInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly tenderId: string;
  readonly action: WhatsAppDecisionAction;
  readonly tokenHash: string;
  readonly expiresAtIso: string;
}

export interface WhatsAppRepository {
  // ---- panel (sesion de staff) ----
  getContact(organizationId: string, userId: string): Promise<WhatsAppContactRecord | null>;
  upsertContact(organizationId: string, userId: string, input: WhatsAppContactInput): Promise<WhatsAppContactRecord>;
  requestConsent(organizationId: string): Promise<boolean>;
  optOutSelf(organizationId: string): Promise<boolean>;
  listEvents(organizationId: string, limit?: number): Promise<readonly WhatsAppEventRecord[]>;

  // ---- webhook, sesion del usuario del token ----
  consumeActionToken(tokenHash: string, senderPhone: string, messageId: string): Promise<TokenConsumeOutcome>;

  // ---- sistema ----
  tokenOwner(tokenHash: string): Promise<{ readonly organizationId: string; readonly userId: string } | null>;
  activeContacts(organizationId: string, topic: WhatsAppTopic): Promise<readonly ActiveContact[]>;
  /** `null` si ya hay una solicitud vigente sin usar para ese usuario/convocatoria/accion. */
  issueActionToken(input: IssueTokenInput): Promise<string | null>;
  confirmOptIn(phoneE164: string): Promise<number>;
  optOutByPhone(phoneE164: string): Promise<number>;
  /** `null` si el `dedupeKey` ya estaba encolado (idempotente). */
  enqueueOutbox(organizationId: string, eventType: string, dedupeKey: string, payload: unknown): Promise<string | null>;
  claimOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxItem[]>;
  markOutboxSent(id: string): Promise<void>;
  markOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void>;
  markOutboxDead(id: string, attempts: number, errorClass: string): Promise<void>;
}

/**
 * Puerto del dispatcher de `@atiende/whatsapp-gateway`. `phoneNumberId` es el numero
 * remitente de la plataforma (config del ambiente): el payload de la cola solo guarda
 * `to`/`body`/`buttons`, nunca un remitente que un cliente pudiera haber elegido.
 * Base sin migrar: `claimBatch` devuelve vacio (no hay nada que enviar), no lanza.
 */
export function createLicitacionesMessagingOutboxPort(repo: WhatsAppRepository, phoneNumberId: string): MessagingOutboxPort {
  return {
    label: "licitaciones",
    async claimBatch(limit, leaseSeconds) {
      try {
        const items = await repo.claimOutboxBatch(limit, leaseSeconds);
        return items.map((item) => ({
          ...item,
          payload: item.payload && typeof item.payload === "object" ? { ...(item.payload as Record<string, unknown>), phoneNumberId } : item.payload,
        }));
      } catch (err) {
        if (err instanceof WhatsAppNotAvailableError) return [];
        throw err;
      }
    },
    markSent: (id) => repo.markOutboxSent(id),
    markRetry: (id, attempts, errorClass, nextAttemptAtIso) => repo.markOutboxRetry(id, attempts, errorClass, nextAttemptAtIso),
    markDead: (id, attempts, errorClass) => repo.markOutboxDead(id, attempts, errorClass),
  };
}

// ===========================================================================
// Postgres
// ===========================================================================

const TS = (col: string, alias = col): string => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${alias}`;
const CONTACT_COLS = `id, organization_id, user_id, phone_e164, status, notify_plazos, notify_convocatorias, notify_fallos, notify_decisiones, ${TS("consent_requested_at")}, ${TS("opted_in_at")}, ${TS("opted_out_at")}`;

interface ContactRow {
  id: string;
  organization_id: string;
  user_id: string;
  phone_e164: string;
  status: WhatsAppContactStatus;
  notify_plazos: boolean;
  notify_convocatorias: boolean;
  notify_fallos: boolean;
  notify_decisiones: boolean;
  consent_requested_at: string | null;
  opted_in_at: string | null;
  opted_out_at: string | null;
}

function mapContact(r: ContactRow): WhatsAppContactRecord {
  return {
    id: r.id,
    organizationId: r.organization_id,
    userId: r.user_id,
    phoneE164: r.phone_e164,
    status: r.status,
    notifyPlazos: r.notify_plazos,
    notifyConvocatorias: r.notify_convocatorias,
    notifyFallos: r.notify_fallos,
    notifyDecisiones: r.notify_decisiones,
    consentRequestedAt: r.consent_requested_at,
    optedInAt: r.opted_in_at,
    optedOutAt: r.opted_out_at,
  };
}

interface OutboxRow {
  id: string;
  attempts: number;
  payload: unknown;
}

export class PostgresWhatsAppRepository implements WhatsAppRepository {
  constructor(private readonly db: TenantDbSession) {}

  /** `primary` en un SAVEPOINT; base sin migrar (42P01/42703/42883) -> `WhatsAppNotAvailableError` con la sesion ya recuperada. */
  private guarded<T>(primary: () => Promise<T>): Promise<T> {
    return runWithSavepointFallback<T>({
      session: this.db,
      primary,
      isRecoverable: isMigrationPendingError,
      fallback: async () => {
        throw new WhatsAppNotAvailableError();
      },
    });
  }

  async getContact(organizationId: string, userId: string): Promise<WhatsAppContactRecord | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ContactRow>(`select ${CONTACT_COLS} from licitaciones.whatsapp_contact where organization_id = $1 and user_id = $2;`, [organizationId, userId]);
      return rows[0] ? mapContact(rows[0]) : null;
    });
  }

  async upsertContact(organizationId: string, userId: string, input: WhatsAppContactInput): Promise<WhatsAppContactRecord> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<ContactRow>(
        `insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, notify_plazos, notify_convocatorias, notify_fallos, notify_decisiones)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (organization_id, user_id) do update
           set phone_e164 = excluded.phone_e164, notify_plazos = excluded.notify_plazos, notify_convocatorias = excluded.notify_convocatorias,
               notify_fallos = excluded.notify_fallos, notify_decisiones = excluded.notify_decisiones
         returning ${CONTACT_COLS};`,
        [organizationId, userId, input.phoneE164, input.notifyPlazos, input.notifyConvocatorias, input.notifyFallos, input.notifyDecisiones],
      );
      return mapContact(rows[0]!);
    });
  }

  async requestConsent(organizationId: string): Promise<boolean> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select licitaciones.whatsapp_request_consent($1) as ok;`, [organizationId]);
      return rows[0]?.ok === true;
    });
  }

  async optOutSelf(organizationId: string): Promise<boolean> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ ok: boolean }>(`select licitaciones.whatsapp_opt_out_self($1) as ok;`, [organizationId]);
      return rows[0]?.ok === true;
    });
  }

  async listEvents(organizationId: string, limit = 50): Promise<readonly WhatsAppEventRecord[]> {
    const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ id: string; user_id: string | null; tender_id: string | null; event: string; detail: string | null; created_at: string }>(
        `select id, user_id, tender_id, event, detail, ${TS("created_at")} from licitaciones.whatsapp_event_log where organization_id = $1 order by created_at desc, id desc limit $2;`,
        [organizationId, capped],
      );
      return rows.map((r) => ({ id: r.id, userId: r.user_id, tenderId: r.tender_id, event: r.event, detail: r.detail, createdAt: r.created_at }));
    });
  }

  async consumeActionToken(tokenHash: string, senderPhone: string, messageId: string): Promise<TokenConsumeOutcome> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ resultado: TokenConsumeResult; convocatoria_id: string | null; accion: WhatsAppDecisionAction | null; rol: string | null }>(
        `select resultado, convocatoria_id, accion, rol from licitaciones.whatsapp_consume_action_token($1, $2, $3);`,
        [tokenHash, senderPhone, messageId],
      );
      const r = rows[0];
      if (!r) return { result: "no_encontrado" as const, tenderId: null, action: null, role: null };
      return { result: r.resultado, tenderId: r.convocatoria_id, action: r.accion, role: r.rol };
    });
  }

  async tokenOwner(tokenHash: string): Promise<{ organizationId: string; userId: string } | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ organization_id: string; user_id: string }>(`select organization_id, user_id from licitaciones.system_whatsapp_token_owner($1);`, [tokenHash]);
      return rows[0] ? { organizationId: rows[0].organization_id, userId: rows[0].user_id } : null;
    });
  }

  async activeContacts(organizationId: string, topic: WhatsAppTopic): Promise<readonly ActiveContact[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ user_id: string; phone_e164: string }>(`select user_id, phone_e164 from licitaciones.system_whatsapp_active_contacts($1, $2);`, [organizationId, topic]);
      return rows.map((r) => ({ userId: r.user_id, phoneE164: r.phone_e164 }));
    });
  }

  async issueActionToken(input: IssueTokenInput): Promise<string | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ id: string | null }>(
        `select licitaciones.system_issue_whatsapp_action_token($1, $2, $3, $4, $5, $6::timestamptz) as id;`,
        [input.organizationId, input.userId, input.tenderId, input.action, input.tokenHash, input.expiresAtIso],
      );
      return rows[0]?.id ?? null;
    });
  }

  async confirmOptIn(phoneE164: string): Promise<number> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ n: number }>(`select licitaciones.system_whatsapp_confirm_opt_in($1)::int as n;`, [phoneE164]);
      return rows[0]?.n ?? 0;
    });
  }

  async optOutByPhone(phoneE164: string): Promise<number> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ n: number }>(`select licitaciones.system_whatsapp_opt_out($1)::int as n;`, [phoneE164]);
      return rows[0]?.n ?? 0;
    });
  }

  async enqueueOutbox(organizationId: string, eventType: string, dedupeKey: string, payload: unknown): Promise<string | null> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<{ id: string | null }>(`select licitaciones.system_enqueue_whatsapp_outbox($1, $2, $3, $4::jsonb) as id;`, [organizationId, eventType, dedupeKey, JSON.stringify(payload)]);
      return rows[0]?.id ?? null;
    });
  }

  async claimOutboxBatch(limit: number, leaseSeconds: number): Promise<readonly MessagingOutboxItem[]> {
    return this.guarded(async () => {
      const { rows } = await this.db.query<OutboxRow>(`select id, attempts, payload from licitaciones.claim_whatsapp_outbox_batch($1, $2);`, [limit, leaseSeconds]);
      return rows.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
    });
  }

  async markOutboxSent(id: string): Promise<void> {
    await this.guarded(async () => {
      await this.db.query(`select licitaciones.complete_whatsapp_outbox_sent($1);`, [id]);
    });
  }

  async markOutboxRetry(id: string, attempts: number, errorClass: string, nextAttemptAtIso: string): Promise<void> {
    await this.guarded(async () => {
      await this.db.query(`select licitaciones.complete_whatsapp_outbox_retry($1, $2, $3, $4::timestamptz);`, [id, attempts, errorClass, nextAttemptAtIso]);
    });
  }

  async markOutboxDead(id: string, attempts: number, errorClass: string): Promise<void> {
    await this.guarded(async () => {
      await this.db.query(`select licitaciones.complete_whatsapp_outbox_dead($1, $2, $3);`, [id, attempts, errorClass]);
    });
  }
}

// ===========================================================================
// En memoria (tests de API/dominio). Reproduce las reglas de la base: un solo uso,
// expiracion, usuario/telefono/rol ligados y consentimiento verificado por mensaje entrante.
// ===========================================================================

interface MemToken {
  organizationId: string;
  userId: string;
  tenderId: string;
  action: WhatsAppDecisionAction;
  phone: string;
  expiresAt: number;
  consumedMessageId: string | null;
}

export interface InMemoryWhatsAppOutboxRow {
  readonly id: string;
  readonly organizationId: string;
  readonly eventType: string;
  readonly dedupeKey: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "sent" | "dead";
  attempts: number;
}

export class InMemoryWhatsAppRepository implements WhatsAppRepository {
  readonly contacts = new Map<string, WhatsAppContactRecord>();
  readonly tokens = new Map<string, MemToken>();
  readonly outbox: InMemoryWhatsAppOutboxRow[] = [];
  readonly events: { organizationId: string; userId: string | null; event: string; detail: string | null }[] = [];
  /** user -> rol vigente (para `consumeActionToken` / `activeContacts("decisiones")`). */
  readonly roles = new Map<string, string>();
  now: () => number = () => Date.now();
  /** Simula la base sin migrar: toda operacion lanza `WhatsAppNotAvailableError`. */
  unavailable = false;

  private key(orgId: string, userId: string): string {
    return `${orgId}:${userId}`;
  }

  private guard(): void {
    if (this.unavailable) throw new WhatsAppNotAvailableError();
  }

  setRole(userId: string, role: string): void {
    this.roles.set(userId, role);
  }

  async getContact(organizationId: string, userId: string): Promise<WhatsAppContactRecord | null> {
    this.guard();
    return this.contacts.get(this.key(organizationId, userId)) ?? null;
  }

  async upsertContact(organizationId: string, userId: string, input: WhatsAppContactInput): Promise<WhatsAppContactRecord> {
    this.guard();
    const prev = this.contacts.get(this.key(organizationId, userId));
    const phoneChanged = !prev || prev.phoneE164 !== input.phoneE164;
    const next: WhatsAppContactRecord = {
      id: prev?.id ?? randomUUID(),
      organizationId,
      userId,
      phoneE164: input.phoneE164,
      status: phoneChanged ? "pendiente" : prev!.status,
      notifyPlazos: input.notifyPlazos,
      notifyConvocatorias: input.notifyConvocatorias,
      notifyFallos: input.notifyFallos,
      notifyDecisiones: input.notifyDecisiones,
      consentRequestedAt: phoneChanged ? null : prev!.consentRequestedAt,
      optedInAt: phoneChanged ? null : prev!.optedInAt,
      optedOutAt: prev?.optedOutAt ?? null,
    };
    this.contacts.set(this.key(organizationId, userId), next);
    return next;
  }

  /** Atajo de test: el actor de la sesion de staff simulada. */
  actorUserId: string | null = null;

  async requestConsent(organizationId: string): Promise<boolean> {
    this.guard();
    const c = this.actorUserId ? this.contacts.get(this.key(organizationId, this.actorUserId)) : undefined;
    if (!c) return false;
    this.contacts.set(this.key(organizationId, c.userId), { ...c, status: "pendiente", consentRequestedAt: new Date(this.now()).toISOString(), optedOutAt: null });
    const dedupeKey = `consent:${c.id}:${Math.floor(this.now() / 3_600_000)}`;
    await this.enqueueOutbox(organizationId, "consent_request", dedupeKey, { to: c.phoneE164, body: "consentimiento" });
    this.events.push({ organizationId, userId: c.userId, event: "consentimiento_solicitado", detail: null });
    return true;
  }

  async optOutSelf(organizationId: string): Promise<boolean> {
    this.guard();
    const c = this.actorUserId ? this.contacts.get(this.key(organizationId, this.actorUserId)) : undefined;
    if (!c || c.status === "baja") return false;
    this.contacts.set(this.key(organizationId, c.userId), { ...c, status: "baja", optedOutAt: new Date(this.now()).toISOString() });
    this.events.push({ organizationId, userId: c.userId, event: "baja", detail: "panel" });
    return true;
  }

  async listEvents(organizationId: string, limit = 50): Promise<readonly WhatsAppEventRecord[]> {
    this.guard();
    return this.events
      .filter((e) => e.organizationId === organizationId)
      .slice(-limit)
      .reverse()
      .map((e, i) => ({ id: String(i), userId: e.userId, tenderId: null, event: e.event, detail: e.detail, createdAt: new Date(this.now()).toISOString() }));
  }

  async consumeActionToken(tokenHash: string, senderPhone: string, messageId: string): Promise<TokenConsumeOutcome> {
    this.guard();
    const miss = (result: TokenConsumeResult, t?: MemToken): TokenConsumeOutcome => ({ result, tenderId: t?.tenderId ?? null, action: t?.action ?? null, role: null });
    const t = this.tokens.get(tokenHash);
    if (!t || (this.actorUserId !== null && t.userId !== this.actorUserId)) return miss("no_encontrado");
    if (t.consumedMessageId !== null) {
      if (t.consumedMessageId === messageId) return miss("duplicado", t);
      this.events.push({ organizationId: t.organizationId, userId: t.userId, event: "token_rechazado_reutilizado", detail: null });
      return miss("ya_usado", t);
    }
    if (t.expiresAt <= this.now()) return miss("expirado", t);
    const c = this.contacts.get(this.key(t.organizationId, t.userId));
    if (!c || c.status !== "activo") return miss("contacto_inactivo", t);
    if (c.phoneE164 !== t.phone || t.phone !== senderPhone) return miss("telefono_distinto", t);
    const role = this.roles.get(t.userId) ?? null;
    if (!role || !["owner", "admin", "analyst", "reviewer"].includes(role)) return miss("rol_insuficiente", t);
    t.consumedMessageId = messageId;
    this.events.push({ organizationId: t.organizationId, userId: t.userId, event: "decision_por_whatsapp", detail: t.action });
    return { result: "ok", tenderId: t.tenderId, action: t.action, role };
  }

  async tokenOwner(tokenHash: string): Promise<{ organizationId: string; userId: string } | null> {
    this.guard();
    const t = this.tokens.get(tokenHash);
    return t ? { organizationId: t.organizationId, userId: t.userId } : null;
  }

  async activeContacts(organizationId: string, topic: WhatsAppTopic): Promise<readonly ActiveContact[]> {
    this.guard();
    return [...this.contacts.values()]
      .filter((c) => c.organizationId === organizationId && c.status === "activo")
      .filter((c) => {
        if (topic === "plazos") return c.notifyPlazos;
        if (topic === "convocatorias") return c.notifyConvocatorias;
        if (topic === "fallos") return c.notifyFallos;
        return c.notifyDecisiones && ["owner", "admin", "analyst", "reviewer"].includes(this.roles.get(c.userId) ?? "");
      })
      .map((c) => ({ userId: c.userId, phoneE164: c.phoneE164 }));
  }

  async issueActionToken(input: IssueTokenInput): Promise<string | null> {
    this.guard();
    const vigente = [...this.tokens.values()].some(
      (t) => t.userId === input.userId && t.tenderId === input.tenderId && t.action === input.action && t.consumedMessageId === null && t.expiresAt > this.now(),
    );
    if (vigente) return null;
    const c = this.contacts.get(this.key(input.organizationId, input.userId));
    if (!c || c.status !== "activo") throw new Error("contacto de WhatsApp no activo");
    this.tokens.set(input.tokenHash, {
      organizationId: input.organizationId,
      userId: input.userId,
      tenderId: input.tenderId,
      action: input.action,
      phone: c.phoneE164,
      expiresAt: Date.parse(input.expiresAtIso),
      consumedMessageId: null,
    });
    return randomUUID();
  }

  async confirmOptIn(phoneE164: string): Promise<number> {
    this.guard();
    let n = 0;
    for (const [k, c] of this.contacts) {
      if (c.phoneE164 === phoneE164 && c.status === "pendiente" && c.consentRequestedAt) {
        this.contacts.set(k, { ...c, status: "activo", optedInAt: new Date(this.now()).toISOString() });
        this.events.push({ organizationId: c.organizationId, userId: c.userId, event: "opt_in", detail: "mensaje entrante" });
        n += 1;
      }
    }
    return n;
  }

  async optOutByPhone(phoneE164: string): Promise<number> {
    this.guard();
    let n = 0;
    for (const [k, c] of this.contacts) {
      if (c.phoneE164 === phoneE164 && c.status !== "baja") {
        this.contacts.set(k, { ...c, status: "baja", optedOutAt: new Date(this.now()).toISOString() });
        this.events.push({ organizationId: c.organizationId, userId: c.userId, event: "baja", detail: "mensaje entrante" });
        n += 1;
      }
    }
    return n;
  }

  async enqueueOutbox(organizationId: string, eventType: string, dedupeKey: string, payload: unknown): Promise<string | null> {
    this.guard();
    if (this.outbox.some((r) => r.organizationId === organizationId && r.dedupeKey === dedupeKey)) return null;
    const id = randomUUID();
    this.outbox.push({ id, organizationId, eventType, dedupeKey, payload: payload as Record<string, unknown>, status: "pending", attempts: 0 });
    return id;
  }

  async claimOutboxBatch(limit: number): Promise<readonly MessagingOutboxItem[]> {
    this.guard();
    const picked = this.outbox.filter((r) => r.status === "pending").slice(0, limit);
    for (const r of picked) r.status = "processing";
    return picked.map((r) => ({ id: r.id, attempts: r.attempts, payload: r.payload }));
  }

  async markOutboxSent(id: string): Promise<void> {
    const r = this.outbox.find((x) => x.id === id);
    if (r) {
      r.status = "sent";
      delete r.payload.buttons;
    }
  }

  async markOutboxRetry(id: string, attempts: number): Promise<void> {
    const r = this.outbox.find((x) => x.id === id);
    if (r) {
      r.status = "pending";
      r.attempts = attempts;
    }
  }

  async markOutboxDead(id: string, attempts: number): Promise<void> {
    const r = this.outbox.find((x) => x.id === id);
    if (r) {
      r.status = "dead";
      r.attempts = attempts;
      delete r.payload.buttons;
    }
  }

  /** Atajo de test: arma un token como lo haria el emisor (hash del token en claro). */
  seedToken(token: string, init: Omit<MemToken, "consumedMessageId">): string {
    const hash = sha256TokenHash(token);
    this.tokens.set(hash, { ...init, consumedMessageId: null });
    return hash;
  }
}

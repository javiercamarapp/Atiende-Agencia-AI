// Repositorios del superadmin "CFO": MFA TOTP, interruptores de plataforma y
// gestion de organizaciones -- puertos contra las funciones `security definer`
// de packages/db/migrations/0025_superadmin_mfa_switches_orgs.sql.
//
// SESIONES (ver el comentario de cabecera de la migracion): las funciones del
// factor MFA que reciben el RESULTADO de la verificacion (`getFactor`,
// `beginEnrollment`, `recordAttempt`) y `getBlocked` de los interruptores son
// SOLO-SISTEMA: el llamador las invoca en `withAppSession({ userId: null })`.
// Todo lo demas es caller-bound: `withAppSession({ userId: callerId })`. Estas
// clases no eligen la sesion; reciben el `TenantDbSession` ya abierto.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada metodo corre bajo
// `runWithSavepointFallback` -- un SQLSTATE 42883/42P01/42703 (migracion 0025
// sin aplicar) revierte SOLO el savepoint (la transaccion de la sesion sigue
// viva) y devuelve `availability: "not_migrated"`; nunca 500 ni exito simulado.
// Los errores de negocio de la base (42501/22023/P0002/55006/23505/23514) se
// traducen a `SuperadminSeguridadError` tipado.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

export type SeguridadAvailability = "available" | "not_migrated";

export type SeguridadErrorCode = "forbidden" | "invalid" | "not_found" | "conflict";

export class SuperadminSeguridadError extends Error {
  readonly code: SeguridadErrorCode;
  constructor(message: string, code: SeguridadErrorCode) {
    super(message);
    this.name = "SuperadminSeguridadError";
    this.code = code;
  }
}

function pgCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err ? ((err as { code?: unknown }).code as string | undefined) : undefined;
}

function toTypedError(err: unknown): SuperadminSeguridadError | null {
  const message = err instanceof Error ? err.message : String(err);
  switch (pgCode(err)) {
    case "42501":
      return new SuperadminSeguridadError(message, "forbidden");
    case "22023":
    case "23514":
      return new SuperadminSeguridadError(message, "invalid");
    case "P0002":
      return new SuperadminSeguridadError(message, "not_found");
    case "55006":
    case "23505":
      return new SuperadminSeguridadError(message, "conflict");
    default:
      return null;
  }
}

let warned = false;
function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    "superadmin-seguridad-repository: las funciones/tablas de 0025_superadmin_mfa_switches_orgs.sql no existen todavia " +
      "(SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aun' (nunca 500, nunca exito simulado). Aplica la migracion " +
      "(o su espejo en supabase/migrations/) para habilitar MFA, interruptores y gestion de organizaciones.",
  );
}

/** Corre `run` bajo SAVEPOINT; base sin migrar -> `onMissing()`; error de negocio -> error tipado. */
async function guarded<TOk, TMissing>(db: TenantDbSession, run: () => Promise<TOk>, onMissing: () => TMissing): Promise<TOk | TMissing> {
  try {
    return await runWithSavepointFallback<TOk | TMissing>({
      session: db,
      primary: run,
      isRecoverable: (err) => isMigrationPendingError(err),
      fallback: async () => {
        warnOnce();
        return onMissing();
      },
    });
  } catch (err) {
    throw toTypedError(err) ?? err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MFA
// ═══════════════════════════════════════════════════════════════════════════
export interface MfaFactorRow {
  readonly secretCiphertext: string;
  readonly status: "pending" | "active";
  readonly lastUsedStep: number | null;
  readonly lockedUntilMs: number | null;
}

export type MfaAttemptResult = "ok" | "activated" | "invalid" | "locked" | "replay";

export interface SecurityEventRow {
  readonly id: string;
  readonly seq: number;
  readonly area: "mfa" | "switch" | "org";
  readonly event: string;
  readonly actorUserId: string | null;
  readonly targetUserId: string | null;
  readonly organizationId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAtMs: number;
}

export interface MfaRepository {
  /** SISTEMA. */
  getFactor(userId: string): Promise<{ availability: SeguridadAvailability; factor: MfaFactorRow | null }>;
  /** SISTEMA. Lanza `conflict` si ya hay un factor activo, `forbidden` si no es superadmin. */
  beginEnrollment(userId: string, secretCiphertext: string): Promise<{ availability: SeguridadAvailability }>;
  /** SISTEMA. */
  recordAttempt(userId: string, ok: boolean, step: number | null): Promise<{ availability: SeguridadAvailability; result: MfaAttemptResult | null }>;
  /** CALLER. Resetea el factor de OTRO superadmin. */
  reset(callerId: string, targetUserId: string, reason: string): Promise<{ availability: SeguridadAvailability }>;
  /** CALLER. */
  listEvents(callerId: string, area: "mfa" | "switch" | "org" | null, limit?: number): Promise<{ availability: SeguridadAvailability; events: readonly SecurityEventRow[] }>;
}

interface FactorRaw {
  secret_ciphertext: string;
  status: "pending" | "active";
  last_used_step: string | number | null;
  locked_until: string | null;
}

interface EventRaw {
  id: string;
  seq: string | number;
  area: "mfa" | "switch" | "org";
  event: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  organization_id: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: string;
}

function mapEvent(r: EventRaw): SecurityEventRow {
  return {
    id: r.id,
    seq: Number(r.seq),
    area: r.area,
    event: r.event,
    actorUserId: r.actor_user_id,
    targetUserId: r.target_user_id,
    organizationId: r.organization_id,
    detail: r.detail ?? {},
    occurredAtMs: new Date(r.occurred_at).getTime(),
  };
}

export class PostgresMfaRepository implements MfaRepository {
  constructor(private readonly db: TenantDbSession) {}

  getFactor(userId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<FactorRaw>(`select * from core.superadmin_mfa_get_factor($1);`, [userId]);
        const r = rows[0];
        return {
          availability: "available" as const,
          factor: r
            ? {
                secretCiphertext: r.secret_ciphertext,
                status: r.status,
                lastUsedStep: r.last_used_step === null ? null : Number(r.last_used_step),
                lockedUntilMs: r.locked_until ? new Date(r.locked_until).getTime() : null,
              }
            : null,
        };
      },
      () => ({ availability: "not_migrated" as const, factor: null }),
    );
  }

  beginEnrollment(userId: string, secretCiphertext: string) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_mfa_begin_enrollment($1, $2);`, [userId, secretCiphertext]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  recordAttempt(userId: string, ok: boolean, step: number | null) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ r: MfaAttemptResult }>(`select core.superadmin_mfa_record_attempt($1, $2, $3) as r;`, [userId, ok, step]);
        return { availability: "available" as const, result: rows[0]?.r ?? null };
      },
      () => ({ availability: "not_migrated" as const, result: null }),
    );
  }

  reset(callerId: string, targetUserId: string, reason: string) {
    return guarded(
      this.db,
      async () => {
        await this.db.query(`select core.superadmin_mfa_reset($1, $2, $3);`, [callerId, targetUserId, reason]);
        return { availability: "available" as const };
      },
      () => ({ availability: "not_migrated" as const }),
    );
  }

  listEvents(callerId: string, area: "mfa" | "switch" | "org" | null, limit = 100) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<EventRaw>(`select * from core.list_superadmin_security_events($1, $2, $3);`, [callerId, area, limit]);
        return { availability: "available" as const, events: rows.map(mapEvent) };
      },
      () => ({ availability: "not_migrated" as const, events: [] as readonly SecurityEventRow[] }),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Interruptores
// ═══════════════════════════════════════════════════════════════════════════
export type SwitchScope = "global" | "agente" | "cron";

export interface PlatformSwitchRow {
  readonly scope: SwitchScope;
  readonly target: string;
  readonly blocked: boolean;
  readonly reason: string;
  readonly updatedBy: string | null;
  readonly updatedAtMs: number;
}

export interface BlockedSwitch {
  readonly scope: SwitchScope;
  readonly target: string;
}

export interface PlatformSwitchRepository {
  /** CALLER. */
  setSwitch(callerId: string, scope: SwitchScope, target: string, blocked: boolean, reason: string): Promise<{ availability: SeguridadAvailability; row: PlatformSwitchRow | null }>;
  /** CALLER. */
  list(callerId: string): Promise<{ availability: SeguridadAvailability; switches: readonly PlatformSwitchRow[] }>;
  /** SISTEMA. Solo los bloqueados. */
  getBlocked(): Promise<{ availability: SeguridadAvailability; blocked: readonly BlockedSwitch[] }>;
}

interface SwitchRaw {
  scope: SwitchScope;
  target: string;
  blocked: boolean;
  reason: string;
  updated_by: string | null;
  updated_at: string;
}

function mapSwitch(r: SwitchRaw): PlatformSwitchRow {
  return { scope: r.scope, target: r.target, blocked: r.blocked, reason: r.reason, updatedBy: r.updated_by, updatedAtMs: new Date(r.updated_at).getTime() };
}

export class PostgresPlatformSwitchRepository implements PlatformSwitchRepository {
  constructor(private readonly db: TenantDbSession) {}

  setSwitch(callerId: string, scope: SwitchScope, target: string, blocked: boolean, reason: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<SwitchRaw>(`select * from core.set_platform_switch($1, $2, $3, $4, $5);`, [callerId, scope, target, blocked, reason]);
        const r = rows[0];
        if (!r) throw new Error("set_platform_switch no devolvio fila");
        return { availability: "available" as const, row: mapSwitch(r) };
      },
      () => ({ availability: "not_migrated" as const, row: null }),
    );
  }

  list(callerId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<SwitchRaw>(`select * from core.list_platform_switches_for_superadmin($1);`, [callerId]);
        return { availability: "available" as const, switches: rows.map(mapSwitch) };
      },
      () => ({ availability: "not_migrated" as const, switches: [] as readonly PlatformSwitchRow[] }),
    );
  }

  getBlocked() {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<{ scope: SwitchScope; target: string }>(`select * from core.get_blocked_platform_switches();`);
        return { availability: "available" as const, blocked: rows.map((r) => ({ scope: r.scope, target: r.target })) };
      },
      () => ({ availability: "not_migrated" as const, blocked: [] as readonly BlockedSwitch[] }),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Organizaciones
// ═══════════════════════════════════════════════════════════════════════════
export type OrgActionTipo = "alta" | "suspender" | "reactivar" | "cambiar_plan";
export type OrgActionEstado = "pending" | "executed" | "cancelled" | "expired";

export interface OrgAdminActionRow {
  readonly id: string;
  readonly tipo: OrgActionTipo;
  readonly organizationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly motivo: string;
  readonly estado: OrgActionEstado;
  readonly creadoPor: string;
  readonly creadoEnMs: number;
  readonly venceEnMs: number;
  readonly confirmadoPor: string | null;
  readonly confirmadoEnMs: number | null;
  readonly resultado: Readonly<Record<string, unknown>> | null;
}

export interface OrgAdminRepository {
  request(callerId: string, tipo: OrgActionTipo, organizationId: string | null, payload: Record<string, unknown>, motivo: string): Promise<{ availability: SeguridadAvailability; action: OrgAdminActionRow | null }>;
  confirm(callerId: string, actionId: string): Promise<{ availability: SeguridadAvailability; action: OrgAdminActionRow | null }>;
  cancel(callerId: string, actionId: string): Promise<{ availability: SeguridadAvailability; action: OrgAdminActionRow | null }>;
  list(callerId: string, limit?: number): Promise<{ availability: SeguridadAvailability; actions: readonly OrgAdminActionRow[] }>;
}

interface OrgActionRaw {
  id: string;
  tipo: OrgActionTipo;
  organization_id: string | null;
  payload: Record<string, unknown> | null;
  motivo: string;
  estado: OrgActionEstado;
  creado_por: string;
  creado_en: string;
  vence_en: string;
  confirmado_por: string | null;
  confirmado_en: string | null;
  resultado: Record<string, unknown> | null;
}

function mapOrgAction(r: OrgActionRaw): OrgAdminActionRow {
  return {
    id: r.id,
    tipo: r.tipo,
    organizationId: r.organization_id,
    payload: r.payload ?? {},
    motivo: r.motivo,
    estado: r.estado,
    creadoPor: r.creado_por,
    creadoEnMs: new Date(r.creado_en).getTime(),
    venceEnMs: new Date(r.vence_en).getTime(),
    confirmadoPor: r.confirmado_por,
    confirmadoEnMs: r.confirmado_en ? new Date(r.confirmado_en).getTime() : null,
    resultado: r.resultado,
  };
}

export class PostgresOrgAdminRepository implements OrgAdminRepository {
  constructor(private readonly db: TenantDbSession) {}

  request(callerId: string, tipo: OrgActionTipo, organizationId: string | null, payload: Record<string, unknown>, motivo: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<OrgActionRaw>(`select * from core.request_org_admin_action($1, $2, $3, $4::jsonb, $5);`, [callerId, tipo, organizationId, JSON.stringify(payload), motivo]);
        const r = rows[0];
        if (!r) throw new Error("request_org_admin_action no devolvio fila");
        return { availability: "available" as const, action: mapOrgAction(r) };
      },
      () => ({ availability: "not_migrated" as const, action: null }),
    );
  }

  confirm(callerId: string, actionId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<OrgActionRaw>(`select * from core.confirm_org_admin_action($1, $2);`, [callerId, actionId]);
        const r = rows[0];
        if (!r) throw new Error("confirm_org_admin_action no devolvio fila");
        return { availability: "available" as const, action: mapOrgAction(r) };
      },
      () => ({ availability: "not_migrated" as const, action: null }),
    );
  }

  cancel(callerId: string, actionId: string) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<OrgActionRaw>(`select * from core.cancel_org_admin_action($1, $2);`, [callerId, actionId]);
        const r = rows[0];
        if (!r) throw new Error("cancel_org_admin_action no devolvio fila");
        return { availability: "available" as const, action: mapOrgAction(r) };
      },
      () => ({ availability: "not_migrated" as const, action: null }),
    );
  }

  list(callerId: string, limit = 50) {
    return guarded(
      this.db,
      async () => {
        const { rows } = await this.db.query<OrgActionRaw>(`select * from core.list_org_admin_actions_for_superadmin($1, $2);`, [callerId, limit]);
        return { availability: "available" as const, actions: rows.map(mapOrgAction) };
      },
      () => ({ availability: "not_migrated" as const, actions: [] as readonly OrgAdminActionRow[] }),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Adaptadores EN MEMORIA -- reproducen la semantica de negocio de las funciones
// SQL (sin auth.uid(): los tests de rutas inyectan quien es superadmin con
// `seedSuperadmin`). El caso "base sin migrar" y el aborto de transaccion los
// ejercita un test dedicado del adaptador Postgres con AbortAwareFakeSession.
// ═══════════════════════════════════════════════════════════════════════════
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;
const ACTION_TTL_MS = 10 * 60_000;
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/u;
const VERTICALES = new Set(["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"]);

interface InMemoryClock {
  readonly now?: () => number;
}

export class InMemoryMfaRepository implements MfaRepository {
  private readonly factors = new Map<string, { secretCiphertext: string; status: "pending" | "active"; lastUsedStep: number | null; failed: number; lockedUntilMs: number | null }>();
  private readonly superadmins = new Set<string>();
  private readonly events: SecurityEventRow[] = [];
  private seq = 0;
  constructor(private readonly clock: InMemoryClock = {}) {}

  private now(): number {
    return (this.clock.now ?? Date.now)();
  }

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }

  private log(event: string, actor: string | null, target: string | null, detail: Record<string, unknown> = {}): void {
    this.seq += 1;
    this.events.push({ id: `ev-${this.seq}`, seq: this.seq, area: "mfa", event, actorUserId: actor, targetUserId: target, organizationId: null, detail, occurredAtMs: this.now() });
  }

  async getFactor(userId: string) {
    const f = this.factors.get(userId);
    return {
      availability: "available" as const,
      factor: f ? { secretCiphertext: f.secretCiphertext, status: f.status, lastUsedStep: f.lastUsedStep, lockedUntilMs: f.lockedUntilMs } : null,
    };
  }

  async beginEnrollment(userId: string, secretCiphertext: string) {
    if (!this.superadmins.has(userId)) throw new SuperadminSeguridadError("el usuario no es superadmin de plataforma", "forbidden");
    if (this.factors.get(userId)?.status === "active") throw new SuperadminSeguridadError("ya existe un factor activo", "conflict");
    this.factors.set(userId, { secretCiphertext, status: "pending", lastUsedStep: null, failed: 0, lockedUntilMs: null });
    this.log("mfa_enroll_started", userId, userId);
    return { availability: "available" as const };
  }

  async recordAttempt(userId: string, ok: boolean, step: number | null) {
    const f = this.factors.get(userId);
    if (!f) throw new SuperadminSeguridadError("el usuario no tiene factor MFA", "not_found");
    if (f.lockedUntilMs !== null && f.lockedUntilMs > this.now()) return { availability: "available" as const, result: "locked" as const };
    if (!ok) {
      f.failed += 1;
      if (f.failed >= MAX_FAILED) {
        f.failed = 0;
        f.lockedUntilMs = this.now() + LOCK_MS;
        this.log("mfa_locked", userId, userId);
        return { availability: "available" as const, result: "locked" as const };
      }
      this.log("mfa_failed", userId, userId, { intentos: f.failed });
      return { availability: "available" as const, result: "invalid" as const };
    }
    if (step === null) throw new SuperadminSeguridadError("p_step requerido cuando p_ok", "invalid");
    if (f.lastUsedStep !== null && step <= f.lastUsedStep) {
      this.log("mfa_replay", userId, userId);
      return { availability: "available" as const, result: "replay" as const };
    }
    const wasPending = f.status === "pending";
    f.lastUsedStep = step;
    f.failed = 0;
    f.lockedUntilMs = null;
    f.status = "active";
    this.log(wasPending ? "mfa_activated" : "mfa_verified", userId, userId);
    return { availability: "available" as const, result: wasPending ? ("activated" as const) : ("ok" as const) };
  }

  async reset(callerId: string, targetUserId: string, reason: string) {
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo un superadmin de plataforma real puede ejecutar esta accion", "forbidden");
    if (callerId === targetUserId) throw new SuperadminSeguridadError("no puedes resetear tu propio factor; pide a otro superadmin", "forbidden");
    if (reason.trim().length < 20) throw new SuperadminSeguridadError("motivo obligatorio (minimo 20 caracteres)", "invalid");
    if (!this.factors.has(targetUserId)) throw new SuperadminSeguridadError("el usuario no tiene factor MFA", "not_found");
    this.factors.delete(targetUserId);
    this.log("mfa_reset", callerId, targetUserId, { motivo: reason.trim() });
    return { availability: "available" as const };
  }

  async listEvents(callerId: string, area: "mfa" | "switch" | "org" | null, limit = 100) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, events: [] as readonly SecurityEventRow[] };
    const rows = this.events.filter((e) => area === null || e.area === area).slice().reverse().slice(0, limit);
    return { availability: "available" as const, events: rows };
  }
}

export class InMemoryPlatformSwitchRepository implements PlatformSwitchRepository {
  private readonly rows = new Map<string, PlatformSwitchRow>();
  private readonly superadmins = new Set<string>();
  constructor(private readonly clock: InMemoryClock = {}) {}

  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }

  private static targetValido(scope: string, target: string): boolean {
    if (scope === "global") return target === "llm" || target === "crons";
    if (scope === "agente") return /^[a-z][a-z0-9_]{0,40}:[a-z][a-z0-9_]{0,60}$/u.test(target);
    if (scope === "cron") return /^\/internal\/[a-z0-9/_-]{1,120}$/u.test(target);
    return false;
  }

  async setSwitch(callerId: string, scope: SwitchScope, target: string, blocked: boolean, reason: string) {
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo un superadmin de plataforma real puede ejecutar esta accion", "forbidden");
    if (reason.trim().length < 20) throw new SuperadminSeguridadError("motivo obligatorio (minimo 20 caracteres)", "invalid");
    if (!InMemoryPlatformSwitchRepository.targetValido(scope, target)) throw new SuperadminSeguridadError("clave de interruptor invalida", "invalid");
    const row: PlatformSwitchRow = { scope, target, blocked, reason: reason.trim(), updatedBy: callerId, updatedAtMs: (this.clock.now ?? Date.now)() };
    this.rows.set(`${scope}|${target}`, row);
    return { availability: "available" as const, row };
  }

  async list(callerId: string) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, switches: [] as readonly PlatformSwitchRow[] };
    return { availability: "available" as const, switches: [...this.rows.values()].sort((a, b) => `${a.scope}${a.target}`.localeCompare(`${b.scope}${b.target}`)) };
  }

  async getBlocked() {
    return { availability: "available" as const, blocked: [...this.rows.values()].filter((r) => r.blocked).map((r) => ({ scope: r.scope, target: r.target })) };
  }
}

export class InMemoryOrgAdminRepository implements OrgAdminRepository {
  private readonly actions: OrgAdminActionRow[] = [];
  private readonly orgs = new Map<string, { vertical: string; name: string; slug: string; status: "trial" | "active" | "suspended" }>();
  private readonly superadmins = new Set<string>();
  private idSeq = 0;
  constructor(private readonly clock: InMemoryClock = {}) {}

  private now(): number {
    return (this.clock.now ?? Date.now)();
  }
  seedSuperadmin(userId: string): void {
    this.superadmins.add(userId);
  }
  seedOrganization(id: string, org: { vertical: string; name: string; slug: string; status: "trial" | "active" | "suspended" }): void {
    this.orgs.set(id, { ...org });
  }
  organizationStatus(id: string): "trial" | "active" | "suspended" | undefined {
    return this.orgs.get(id)?.status;
  }
  organizationBySlug(slug: string): string | undefined {
    return [...this.orgs.entries()].find(([, o]) => o.slug === slug)?.[0];
  }

  private requireSuperadmin(callerId: string): void {
    if (!this.superadmins.has(callerId)) throw new SuperadminSeguridadError("solo un superadmin de plataforma real puede ejecutar esta accion", "forbidden");
  }

  async request(callerId: string, tipo: OrgActionTipo, organizationId: string | null, payload: Record<string, unknown>, motivo: string) {
    this.requireSuperadmin(callerId);
    const m = motivo.trim();
    if (m.length < 20) throw new SuperadminSeguridadError("motivo obligatorio (minimo 20 caracteres)", "invalid");
    let finalPayload: Record<string, unknown> = {};
    if (tipo === "alta") {
      if (organizationId !== null) throw new SuperadminSeguridadError("alta no recibe organization_id", "invalid");
      const vertical = typeof payload.vertical === "string" ? payload.vertical : "";
      const name = typeof payload.name === "string" ? payload.name.trim() : "";
      const slug = typeof payload.slug === "string" ? payload.slug : "";
      if (!VERTICALES.has(vertical) || name.length < 2 || name.length > 120 || !SLUG_RE.test(slug)) throw new SuperadminSeguridadError("alta requiere payload {vertical, name (2-120), slug valido}", "invalid");
      if (this.organizationBySlug(slug)) throw new SuperadminSeguridadError("el slug ya existe", "conflict");
      finalPayload = { vertical, name, slug };
    } else {
      const org = organizationId ? this.orgs.get(organizationId) : undefined;
      if (!org) throw new SuperadminSeguridadError("la organizacion no existe", "not_found");
      if (tipo === "suspender" && org.status === "suspended") throw new SuperadminSeguridadError("la organizacion ya esta suspendida", "conflict");
      if (tipo === "reactivar" && org.status !== "suspended") throw new SuperadminSeguridadError("la organizacion no esta suspendida", "conflict");
      if (tipo === "cambiar_plan") {
        const plan = payload.plan;
        if (plan !== "trial" && plan !== "active") throw new SuperadminSeguridadError("cambiar_plan requiere payload {plan: trial|active}", "invalid");
        if (org.status === "suspended") throw new SuperadminSeguridadError("reactiva la organizacion antes de cambiar su plan", "conflict");
        if (org.status === plan) throw new SuperadminSeguridadError("la organizacion ya tiene ese plan", "conflict");
        finalPayload = { plan };
      }
      if (this.actions.some((a) => a.estado === "pending" && a.organizationId === organizationId)) throw new SuperadminSeguridadError("ya hay una accion pendiente para esta organizacion", "conflict");
    }
    this.idSeq += 1;
    const action: OrgAdminActionRow = {
      id: `org-action-${this.idSeq}`,
      tipo,
      organizationId,
      payload: finalPayload,
      motivo: m,
      estado: "pending",
      creadoPor: callerId,
      creadoEnMs: this.now(),
      venceEnMs: this.now() + ACTION_TTL_MS,
      confirmadoPor: null,
      confirmadoEnMs: null,
      resultado: null,
    };
    this.actions.push(action);
    return { availability: "available" as const, action };
  }

  private find(id: string): { index: number; action: OrgAdminActionRow } {
    const index = this.actions.findIndex((a) => a.id === id);
    if (index < 0) throw new SuperadminSeguridadError("la accion no existe", "not_found");
    return { index, action: this.actions[index]! };
  }

  async confirm(callerId: string, actionId: string) {
    this.requireSuperadmin(callerId);
    const { index, action } = this.find(actionId);
    if (action.creadoPor !== callerId) throw new SuperadminSeguridadError("solo quien solicito la accion puede confirmarla", "forbidden");
    if (action.estado !== "pending") throw new SuperadminSeguridadError(`la accion ya no esta pendiente (estado ${action.estado})`, "conflict");
    if (action.venceEnMs <= this.now()) {
      const expired = { ...action, estado: "expired" as const };
      this.actions[index] = expired;
      return { availability: "available" as const, action: expired };
    }
    let resultado: Record<string, unknown>;
    if (action.tipo === "alta") {
      const slug = String(action.payload.slug);
      if (this.organizationBySlug(slug)) throw new SuperadminSeguridadError("el slug ya existe", "conflict");
      const id = `org-new-${this.idSeq}-${slug}`;
      this.orgs.set(id, { vertical: String(action.payload.vertical), name: String(action.payload.name), slug, status: "trial" });
      resultado = { organization_id: id, status: "trial" };
    } else {
      const org = this.orgs.get(action.organizationId!);
      if (!org) throw new SuperadminSeguridadError("la organizacion ya no existe", "not_found");
      if (action.tipo === "suspender") {
        if (org.status === "suspended") throw new SuperadminSeguridadError("la organizacion ya esta suspendida", "conflict");
        resultado = { status_previo: org.status, status: "suspended" };
        org.status = "suspended";
      } else if (action.tipo === "reactivar") {
        if (org.status !== "suspended") throw new SuperadminSeguridadError("la organizacion ya no esta suspendida", "conflict");
        const previa = this.actions
          .filter((a) => a.organizationId === action.organizationId && a.tipo === "suspender" && a.estado === "executed")
          .sort((a, b) => (b.confirmadoEnMs ?? 0) - (a.confirmadoEnMs ?? 0))[0];
        const previo = previa?.resultado?.status_previo;
        const status = previo === "trial" || previo === "active" ? previo : "active";
        org.status = status;
        resultado = { status_previo: "suspended", status };
      } else {
        if (org.status === "suspended") throw new SuperadminSeguridadError("la organizacion esta suspendida", "conflict");
        const plan = action.payload.plan as "trial" | "active";
        if (org.status === plan) throw new SuperadminSeguridadError("la organizacion ya tiene ese plan", "conflict");
        resultado = { status_previo: org.status, status: plan };
        org.status = plan;
      }
    }
    const executed: OrgAdminActionRow = { ...action, estado: "executed", confirmadoPor: callerId, confirmadoEnMs: this.now(), resultado };
    this.actions[index] = executed;
    return { availability: "available" as const, action: executed };
  }

  async cancel(callerId: string, actionId: string) {
    this.requireSuperadmin(callerId);
    const { index, action } = this.find(actionId);
    if (action.creadoPor !== callerId) throw new SuperadminSeguridadError("solo quien solicito la accion puede cancelarla", "forbidden");
    if (action.estado !== "pending") throw new SuperadminSeguridadError(`la accion ya no esta pendiente (estado ${action.estado})`, "conflict");
    const cancelled = { ...action, estado: "cancelled" as const };
    this.actions[index] = cancelled;
    return { availability: "available" as const, action: cancelled };
  }

  async list(callerId: string, limit = 50) {
    if (!this.superadmins.has(callerId)) return { availability: "available" as const, actions: [] as readonly OrgAdminActionRow[] };
    return { availability: "available" as const, actions: this.actions.slice().reverse().slice(0, limit) };
  }
}

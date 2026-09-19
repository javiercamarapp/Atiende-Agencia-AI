// Repositorio de impersonación de superadmin -- puerto contra las funciones
// `security definer` de `packages/db/migrations/0020_superadmin_impersonacion.sql`.
// Vive en `packages/db` (no en un `domain-<vertical>`) porque el esquema es
// `core`, platform-wide -- mismo criterio que `CoreRepository` en este mismo
// paquete (prospectos/notificaciones/facturación de plataforma).
//
// A diferencia de `CoreRepository` (una instancia FIJA de sesión de sistema,
// ver `apps/api/src/production/core-repository.ts`), este repositorio se
// construye POR REQUEST sobre el `TenantDbSession` ya abierto como el CALLER
// real (`engine.withAppSession({ userId: callerId }, (db) => ...)`) -- las
// funciones SQL exigen `auth.uid() = p_caller_id`, así que una sesión de
// sistema (`auth.uid()` NULL) siempre las rechazaría. Mismo patrón EXACTO que
// `BreakGlassSessionRepository`/`PostgresBreakGlassSessionRepository` de
// `@atiende/domain-rentas` (packages/domain-rentas/src/break-glass/
// postgres-sesion-repository.ts).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR (corrección obligatoria de la tarea):
// `dbSession`/`withAppSession` abre UNA transacción por request. Un error
// SQLSTATE 42883/42P01/42703 (la migración 0020 sin aplicar) deja esa
// transacción ABORTADA -- cualquier query posterior en la MISMA sesión
// fallaría con 25P02 y el COMMIT final revertiría TODO el request en
// silencio, aunque el resto del handler nunca haya lanzado. Por eso CADA
// método abre un SAVEPOINT antes de llamar a la función nueva y hace
// `ROLLBACK TO SAVEPOINT` + `RELEASE SAVEPOINT` en el catch -- mismo patrón
// que `packages/domain-citas/src/postgres-repository.ts::upsertCustomer`
// (líneas ~460-483) -- antes de devolver un estado "no disponible aún"
// honesto (nunca simula éxito, nunca 500, nunca deja la transacción del
// request en curso rota para el resto de queries de este mismo handler).
import type { TenantDbSession } from "@atiende/core-tenancy";

export interface ImpersonationSessionRow {
  readonly id: string;
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly organizationId: string;
  readonly reason: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
}

export type ImpersonationAuditEventType = "start" | "end";

export interface ImpersonationAuditEntryRow {
  readonly id: string;
  readonly sessionId: string;
  readonly eventType: ImpersonationAuditEventType;
  readonly actorUserId: string;
  readonly actorEmail: string | null;
  readonly organizationId: string;
  readonly reason: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly occurredAtMs: number;
  readonly seq: number;
  readonly prevHash: string | null;
  readonly hash: string;
}

/** Errores tipados que reflejan los `errcode` reales que lanza
 *  `core.start_impersonation_session`/`core.end_impersonation_session` --
 *  el adaptador Postgres los traduce por código, nunca por parseo de mensaje. */
export class ImpersonationError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}
/** SQLSTATE 42501 -- caller binding inválido, no-superadmin, target-es-superadmin,
 *  o "no eres el dueño de esta sesión". */
export class ImpersonationForbiddenError extends ImpersonationError {
  constructor(message: string) {
    super(message, "impersonation_forbidden");
  }
}
/** SQLSTATE 22023 -- motivo ausente o menor a 20 caracteres. */
export class ImpersonationReasonInvalidError extends ImpersonationError {
  constructor(message: string) {
    super(message, "impersonation_reason_invalid");
  }
}
/** SQLSTATE P0002 -- organización o sesión inexistente. */
export class ImpersonationNotFoundError extends ImpersonationError {
  constructor(message: string) {
    super(message, "impersonation_not_found");
  }
}
/** SQLSTATE 55006 -- sesión ya activa / ya terminada / ya vencida. */
export class ImpersonationConflictError extends ImpersonationError {
  constructor(message: string) {
    super(message, "impersonation_conflict");
  }
}

/** `"not_migrated"` cuando `0020_superadmin_impersonacion.sql` todavía no se
 *  aplicó contra la base real (SQLSTATE 42883/42P01/42703) -- la ruta HTTP
 *  responde 503 honesto con este estado, nunca 500 ni un éxito simulado. */
export type ImpersonationAvailability = "available" | "not_migrated";

export interface ImpersonationRepository {
  startSession(
    callerId: string,
    organizationId: string,
    reason: string,
  ): Promise<{ availability: ImpersonationAvailability; session: ImpersonationSessionRow | null }>;
  endSession(
    callerId: string,
    sessionId: string,
  ): Promise<{ availability: ImpersonationAvailability; entry: ImpersonationAuditEntryRow | null }>;
  getActiveSession(callerId: string): Promise<{ availability: ImpersonationAvailability; session: ImpersonationSessionRow | null }>;
  isActiveForOrganization(callerId: string, organizationId: string): Promise<boolean>;
  listSessions(callerId: string, limit?: number): Promise<{ availability: ImpersonationAvailability; sessions: readonly ImpersonationSessionRow[] }>;
  listAuditLog(callerId: string, limit?: number): Promise<{ availability: ImpersonationAvailability; entries: readonly ImpersonationAuditEntryRow[] }>;
}

interface ImpersonationSessionRawRow {
  id: string;
  actor_user_id: string;
  actor_email: string | null;
  organization_id: string;
  reason: string;
  started_at: string;
  expires_at: string;
}

interface ImpersonationAuditEntryRawRow {
  id: string;
  session_id: string;
  event_type: ImpersonationAuditEventType;
  actor_user_id: string;
  actor_email: string | null;
  organization_id: string;
  reason: string | null;
  detail: Record<string, unknown>;
  occurred_at: string;
  seq: string | number;
  prev_hash: string | null;
  hash: string;
}

function mapSession(row: ImpersonationSessionRawRow): ImpersonationSessionRow {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    organizationId: row.organization_id,
    reason: row.reason,
    startedAtMs: new Date(row.started_at).getTime(),
    expiresAtMs: new Date(row.expires_at).getTime(),
  };
}

function mapAuditEntry(row: ImpersonationAuditEntryRawRow): ImpersonationAuditEntryRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    organizationId: row.organization_id,
    reason: row.reason,
    detail: row.detail ?? {},
    occurredAtMs: new Date(row.occurred_at).getTime(),
    seq: Number(row.seq),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/** SQLSTATE de "función/tabla/columna no existe" -- la base real va detrás del
 *  código (ver comentario de cabecera del archivo). */
function isMigrationMissingError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

function toTypedError(err: unknown): ImpersonationError | null {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "42501") return new ImpersonationForbiddenError(message);
  if (code === "22023") return new ImpersonationReasonInvalidError(message);
  if (code === "P0002") return new ImpersonationNotFoundError(message);
  if (code === "55006") return new ImpersonationConflictError(message);
  return null;
}

let warnedAboutMissingImpersonationSchema = false;
function warnMissingImpersonationSchemaOnce(): void {
  if (warnedAboutMissingImpersonationSchema) return;
  warnedAboutMissingImpersonationSchema = true;
  console.warn(
    "PostgresImpersonationRepository: core.start_impersonation_session y funciones " +
      "relacionadas no existen todavía (SQLSTATE 42883/42P01/42703) -- degradando a " +
      "'no disponible aún' (nunca 500, nunca simula una sesión). Aplica " +
      "packages/db/migrations/0020_superadmin_impersonacion.sql (o su espejo en " +
      "supabase/migrations/) para habilitar la impersonación de superadmin.",
  );
}

/** Ejecuta `run()` bajo un SAVEPOINT dedicado -- si `run()` lanza un error de
 *  "función/tabla/columna no existe" (base sin migrar), revierte SOLO ese
 *  SAVEPOINT (la transacción del request sigue viva y usable para lo que
 *  venga después del handler) y devuelve `{ availability: "not_migrated" }`
 *  vía `onMissing`. Cualquier otro error (incluidos los `ImpersonationError`
 *  tipados) se libera del SAVEPOINT y se re-lanza tal cual -- SÍ debe abortar
 *  el resto del request, es un rechazo real de negocio, no un problema de
 *  compatibilidad. */
async function withSavepointFallback<T>(
  db: TenantDbSession,
  savepointName: string,
  run: () => Promise<T>,
  onMissing: () => T,
): Promise<T> {
  await db.exec(`SAVEPOINT ${savepointName}`);
  try {
    const result = await run();
    await db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    return result;
  } catch (err) {
    if (isMigrationMissingError(err)) {
      await db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      warnMissingImpersonationSchemaOnce();
      return onMissing();
    }
    await db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    const typed = toTypedError(err);
    throw typed ?? err;
  }
}

export class PostgresImpersonationRepository implements ImpersonationRepository {
  constructor(private readonly db: TenantDbSession) {}

  async startSession(callerId: string, organizationId: string, reason: string) {
    return withSavepointFallback(
      this.db,
      "sp_start_impersonation",
      async () => {
        const { rows } = await this.db.query<ImpersonationSessionRawRow>(
          `select * from core.start_impersonation_session($1, $2, $3);`,
          [callerId, organizationId, reason],
        );
        const row = rows[0];
        if (!row) throw new Error("start_impersonation_session no devolvió fila");
        return { availability: "available" as const, session: mapSession(row) };
      },
      () => ({ availability: "not_migrated" as const, session: null }),
    );
  }

  async endSession(callerId: string, sessionId: string) {
    return withSavepointFallback(
      this.db,
      "sp_end_impersonation",
      async () => {
        const { rows } = await this.db.query<ImpersonationAuditEntryRawRow>(
          `select * from core.end_impersonation_session($1, $2);`,
          [callerId, sessionId],
        );
        const row = rows[0];
        if (!row) throw new Error("end_impersonation_session no devolvió fila");
        return { availability: "available" as const, entry: mapAuditEntry(row) };
      },
      () => ({ availability: "not_migrated" as const, entry: null }),
    );
  }

  async getActiveSession(callerId: string) {
    return withSavepointFallback(
      this.db,
      "sp_get_active_impersonation",
      async () => {
        const { rows } = await this.db.query<ImpersonationSessionRawRow>(
          `select * from core.get_active_impersonation_session_for_superadmin($1);`,
          [callerId],
        );
        const row = rows[0];
        return { availability: "available" as const, session: row ? mapSession(row) : null };
      },
      () => ({ availability: "not_migrated" as const, session: null }),
    );
  }

  async isActiveForOrganization(callerId: string, organizationId: string): Promise<boolean> {
    return withSavepointFallback(
      this.db,
      "sp_is_active_impersonation",
      async () => {
        const { rows } = await this.db.query<{ is_impersonation_active_for_caller_and_org: boolean }>(
          `select core.is_impersonation_active_for_caller_and_org($1, $2) as is_impersonation_active_for_caller_and_org;`,
          [callerId, organizationId],
        );
        return rows[0]?.is_impersonation_active_for_caller_and_org ?? false;
      },
      () => false,
    );
  }

  async listSessions(callerId: string, limit = 100) {
    return withSavepointFallback(
      this.db,
      "sp_list_impersonation_sessions",
      async () => {
        const { rows } = await this.db.query<ImpersonationSessionRawRow>(
          `select * from core.list_impersonation_sessions_for_superadmin($1, $2);`,
          [callerId, limit],
        );
        return { availability: "available" as const, sessions: rows.map(mapSession) };
      },
      () => ({ availability: "not_migrated" as const, sessions: [] }),
    );
  }

  async listAuditLog(callerId: string, limit = 200) {
    return withSavepointFallback(
      this.db,
      "sp_list_impersonation_audit_log",
      async () => {
        const { rows } = await this.db.query<ImpersonationAuditEntryRawRow>(
          `select * from core.list_impersonation_audit_log_for_superadmin($1, $2);`,
          [callerId, limit],
        );
        return { availability: "available" as const, entries: rows.map(mapAuditEntry) };
      },
      () => ({ availability: "not_migrated" as const, entries: [] }),
    );
  }
}

/** Adaptador en memoria -- mismo criterio que `InMemoryBreakGlassSessionRepository`
 *  de `@atiende/domain-rentas`: reproduce la semántica de negocio real (caller-
 *  binding trivial porque no hay `auth.uid()` que simular aquí, reglas de
 *  motivo/duplicado/expiración/target-superadmin) sin Postgres, para tests
 *  unitarios de rutas. Nunca simula el escenario `"not_migrated"` -- ese caso
 *  solo lo ejercita un test dedicado del adaptador Postgres (mock que lanza
 *  `{code:'42883'}`). */
export class InMemoryImpersonationRepository implements ImpersonationRepository {
  private readonly sessions = new Map<string, ImpersonationSessionRow>();
  private readonly auditLog: ImpersonationAuditEntryRow[] = [];
  private seq = 0;

  constructor(
    private readonly deps: {
      readonly isPlatformSuperadmin: (userId: string) => boolean;
      readonly organizationExists: (organizationId: string) => boolean;
      readonly organizationHasSuperadminMember: (organizationId: string) => boolean;
      readonly staffEmail: (userId: string) => string | null;
      readonly now?: () => number;
      readonly sessionDurationMs?: number;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private nextId(): string {
    return `imp-${Math.random().toString(36).slice(2)}-${this.auditLog.length}-${this.sessions.size}`;
  }

  async startSession(callerId: string, organizationId: string, reason: string) {
    if (!this.deps.isPlatformSuperadmin(callerId)) {
      throw new ImpersonationForbiddenError("solo un superadmin de plataforma real puede iniciar una impersonación");
    }
    const trimmed = reason?.trim() ?? "";
    if (trimmed.length < 20) {
      throw new ImpersonationReasonInvalidError("motivo obligatorio (mínimo 20 caracteres)");
    }
    if (!this.deps.organizationExists(organizationId)) {
      throw new ImpersonationNotFoundError(`la organización ${organizationId} no existe`);
    }
    if (this.deps.organizationHasSuperadminMember(organizationId)) {
      throw new ImpersonationForbiddenError("no se puede impersonar una organización que tiene a otro superadmin de plataforma como miembro");
    }
    const nowMs = this.now();
    const hasActive = [...this.sessions.values()].some(
      (s) => s.actorUserId === callerId && s.expiresAtMs > nowMs && !this.auditLog.some((e) => e.sessionId === s.id && e.eventType === "end"),
    );
    if (hasActive) {
      throw new ImpersonationConflictError("ya existe una sesión de impersonación activa para este superadmin");
    }

    const session: ImpersonationSessionRow = {
      id: this.nextId(),
      actorUserId: callerId,
      actorEmail: this.deps.staffEmail(callerId),
      organizationId,
      reason: trimmed,
      startedAtMs: nowMs,
      expiresAtMs: nowMs + (this.deps.sessionDurationMs ?? 15 * 60_000),
    };
    this.sessions.set(session.id, session);
    this.auditLog.push({
      id: `${session.id}-start`,
      sessionId: session.id,
      eventType: "start",
      actorUserId: callerId,
      actorEmail: session.actorEmail,
      organizationId,
      reason: trimmed,
      detail: { expiresAtMs: session.expiresAtMs },
      occurredAtMs: nowMs,
      seq: ++this.seq,
      prevHash: null,
      hash: `fake-hash-${this.seq}`,
    });
    return { availability: "available" as const, session };
  }

  async endSession(callerId: string, sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ImpersonationNotFoundError(`la sesión ${sessionId} no existe`);
    if (session.actorUserId !== callerId) {
      throw new ImpersonationForbiddenError("solo el superadmin que abrió la sesión puede terminarla");
    }
    if (this.auditLog.some((e) => e.sessionId === sessionId && e.eventType === "end")) {
      throw new ImpersonationConflictError(`la sesión ${sessionId} ya fue terminada`);
    }
    const nowMs = this.now();
    if (session.expiresAtMs <= nowMs) {
      throw new ImpersonationConflictError(`la sesión ${sessionId} ya expiró -- no requiere cierre explícito`);
    }
    const entry: ImpersonationAuditEntryRow = {
      id: `${sessionId}-end`,
      sessionId,
      eventType: "end",
      actorUserId: callerId,
      actorEmail: session.actorEmail,
      organizationId: session.organizationId,
      reason: null,
      detail: {},
      occurredAtMs: nowMs,
      seq: ++this.seq,
      prevHash: null,
      hash: `fake-hash-${this.seq}`,
    };
    this.auditLog.push(entry);
    return { availability: "available" as const, entry };
  }

  async getActiveSession(callerId: string) {
    const nowMs = this.now();
    const active = [...this.sessions.values()]
      .filter((s) => s.actorUserId === callerId && s.expiresAtMs > nowMs && !this.auditLog.some((e) => e.sessionId === s.id && e.eventType === "end"))
      .sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
    return { availability: "available" as const, session: active ?? null };
  }

  async isActiveForOrganization(callerId: string, organizationId: string): Promise<boolean> {
    const { session } = await this.getActiveSession(callerId);
    return session?.organizationId === organizationId;
  }

  async listSessions(callerId: string, limit = 100) {
    if (!this.deps.isPlatformSuperadmin(callerId)) return { availability: "available" as const, sessions: [] };
    const sessions = [...this.sessions.values()].sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, limit);
    return { availability: "available" as const, sessions };
  }

  async listAuditLog(callerId: string, limit = 200) {
    if (!this.deps.isPlatformSuperadmin(callerId)) return { availability: "available" as const, entries: [] };
    const entries = [...this.auditLog].sort((a, b) => b.occurredAtMs - a.occurredAtMs).slice(0, limit);
    return { availability: "available" as const, entries };
  }
}

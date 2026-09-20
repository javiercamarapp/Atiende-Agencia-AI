// AuthzAuditRepository -- puerto contra las funciones `security definer` de
// packages/db/migrations/0021_superadmin_authz_audit_log.sql. Vive en
// packages/db (no en apps/api ni en un domain-<vertical>) por el mismo
// criterio que impersonation-repository.ts en este mismo paquete: el esquema
// es `core`, platform-wide.
//
// A diferencia de `ImpersonationRepository` (siempre construido sobre la
// sesión del CALLER real), este repositorio se usa con DOS sesiones
// distintas según el método -- `recordDenial` corre en sesión de SISTEMA
// (`auth.uid()` NULL, ver 0021_superadmin_authz_audit_log.sql para el
// porqué), `list` corre en la sesión del propio superadmin (caller-bound,
// `auth.uid() = p_caller_id`). El repositorio no decide por sí mismo qué
// sesión usar -- solo recibe el `TenantDbSession` que el llamador ya abrió,
// mismo criterio que `PostgresImpersonationRepository`.
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: ambos métodos capturan
// 42883/42P01/42703 y degradan a `{ availability: "not_migrated" }` -- nunca
// 500, nunca simulan una escritura/lectura exitosa.
//
// `recordDenial` NUNCA lanza, bajo ningún error (deliberadamente MÁS
// permisivo que el resto de este repositorio, y que `list` de aquí mismo) --
// mandato explícito de la tarea: "registrar la denegación NUNCA debe cambiar
// la respuesta ni tumbar el request". Corre SIEMPRE en su PROPIA transacción
// de sistema (ver apps/api/src/production/persistent-authz-audit-sink.ts,
// que abre `engine.withAppSession({ userId: null }, ...)` dedicado por
// escritura, nunca la transacción de negocio del request denegado) -- un
// SAVEPOINT alrededor de la llamada sigue siendo la defensa correcta incluso
// así (mismo patrón que el resto del repo, ver AGENTS.md de esta tarea): dado
// que esta clase no puede garantizar en qué sesión la use un llamador futuro,
// protegerla contra dejar SU PROPIA transacción abortada es gratis y
// consistente con el resto de este paquete.
//
// `runWithSavepointFallback` (../savepoint-fallback.ts, ya disponible en
// este mismo paquete desde el PR #158 -- traído a esta rama con `git merge
// origin/main`, ver progreso-*.md de esta tarea): reemplaza el
// SAVEPOINT/ROLLBACK TO SAVEPOINT/RELEASE manual que este archivo escribía a
// mano ANTES de que ese helper existiera en `main` -- mismo mandato de la
// tarea ("donde tu código use SAVEPOINT manual para un fallback, usa el
// helper compartido"). `recordDenial` usa `isRecoverable: () => true` (nunca
// relanza, ver el párrafo de arriba) y branchea DENTRO de `fallback` entre
// "migración no aplicada" y "cualquier otro error real" -- `list` sí relanza
// lo que no sea 42883/42P01/42703, así que su `isRecoverable` es
// `isMigrationMissingError` tal cual.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "./savepoint-fallback.ts";

export type AuthzAuditAvailability = "available" | "not_migrated";
export type AuthzAuditDecision = "allowed" | "denied";

export interface AuthzAuditLogEntryInput {
  readonly actorUserId: string | null;
  /** IP ya normalizada por el llamador (ver apps/api/src/http-security.ts) --
   *  este repositorio nunca decide cómo extraerla, solo la persiste tal cual. */
  readonly actorIp: string | null;
  readonly organizationId: string | null;
  readonly action: string;
  readonly route: string;
  readonly method: string;
  readonly decision: AuthzAuditDecision;
  readonly reason: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly occurredAtMs: number;
}

export interface AuthzAuditLogRow extends AuthzAuditLogEntryInput {
  readonly id: string;
}

export interface AuthzAuditRepository {
  /** Best-effort real -- ver cabecera del archivo. `id: null` significa "no se
   *  escribió esta vez" (migración no aplicada, tope defensivo alcanzado, o
   *  cualquier otro error real de Postgres) -- el llamador decide el fallback
   *  a memoria con el MISMO criterio sin importar la causa exacta. */
  recordDenial(input: AuthzAuditLogEntryInput): Promise<{ availability: AuthzAuditAvailability; id: string | null }>;
  list(callerId: string, limit?: number, offset?: number): Promise<{ availability: AuthzAuditAvailability; entries: readonly AuthzAuditLogRow[]; hasMore: boolean }>;
}

interface AuthzAuditLogRawRow {
  id: string;
  actor_user_id: string | null;
  actor_ip: string | null;
  organization_id: string | null;
  action: string;
  route: string;
  method: string;
  decision: AuthzAuditDecision;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
}

function mapRow(row: AuthzAuditLogRawRow): AuthzAuditLogRow {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorIp: row.actor_ip,
    organizationId: row.organization_id,
    action: row.action,
    route: row.route,
    method: row.method,
    decision: row.decision,
    reason: row.reason,
    metadata: row.metadata ?? {},
    occurredAtMs: new Date(row.occurred_at).getTime(),
  };
}

/** SQLSTATE de "función/tabla/columna no existe" -- la base real va detrás del
 *  código (ver comentario de cabecera del archivo). */
function isMigrationMissingError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42883" || code === "42P01" || code === "42703";
}

let warnedAboutMissingAuthzAuditSchema = false;
function warnMissingAuthzAuditSchemaOnce(): void {
  if (warnedAboutMissingAuthzAuditSchema) return;
  warnedAboutMissingAuthzAuditSchema = true;
  console.warn(
    "PostgresAuthzAuditRepository: core.record_authz_audit_denial/core.list_authz_audit_log_for_superadmin no existen " +
      "todavía (SQLSTATE 42883/42P01/42703) -- degradando a 'no disponible aún' (nunca 500, nunca simula una escritura/" +
      "lectura). Aplica packages/db/migrations/0021_superadmin_authz_audit_log.sql (o su espejo en supabase/migrations/) " +
      "para habilitarlo.",
  );
}

export class PostgresAuthzAuditRepository implements AuthzAuditRepository {
  constructor(private readonly db: TenantDbSession) {}

  async recordDenial(input: AuthzAuditLogEntryInput): Promise<{ availability: AuthzAuditAvailability; id: string | null }> {
    return runWithSavepointFallback<{ availability: AuthzAuditAvailability; id: string | null }>({
      session: this.db,
      // Nombre explícito (en vez del generado por default) -- los tests de
      // este archivo verifican el nombre EXACTO del SAVEPOINT en `session.calls`
      // (mismo criterio que el resto de este monorepo: un nombre legible en
      // logs/tests, ver el comentario de cabecera de `SavepointFallbackOptions
      // .savepointName`).
      savepointName: "sp_record_authz_audit_denial",
      primary: async () => {
        const { rows } = await this.db.query<{ id: string | null }>(
          `select core.record_authz_audit_denial($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as id;`,
          [
            input.actorUserId,
            input.actorIp,
            input.organizationId,
            input.action,
            input.route,
            input.method,
            input.decision,
            input.reason,
            JSON.stringify(input.metadata ?? {}),
            new Date(input.occurredAtMs).toISOString(),
          ],
        );
        return { availability: "available" as const, id: rows[0]?.id ?? null };
      },
      // Best-effort REAL (mandato de la tarea: "registrar la denegación NUNCA
      // debe cambiar la respuesta ni tumbar el request") -- CUALQUIER error
      // de `primary` degrada aquí, nunca se relanza (a diferencia de `list`,
      // ver abajo).
      isRecoverable: () => true,
      fallback: async (err) => {
        if (isMigrationMissingError(err)) {
          warnMissingAuthzAuditSchemaOnce();
          return { availability: "not_migrated", id: null };
        }
        // Cualquier otro error real de Postgres (conexión, violación de FK,
        // etc. -- el tope defensivo de la propia función SQL ya devuelve
        // NULL sin lanzar, así que nunca llega aquí) se registra en logs y
        // se traduce a "no se pudo escribir esta vez", NUNCA se relanza.
        console.error("PostgresAuthzAuditRepository.recordDenial: error inesperado escribiendo la bitácora persistente (best-effort, no se relanza):", err);
        return { availability: "available", id: null };
      },
    });
  }

  async list(callerId: string, limit = 50, offset = 0): Promise<{ availability: AuthzAuditAvailability; entries: readonly AuthzAuditLogRow[]; hasMore: boolean }> {
    return runWithSavepointFallback<{ availability: AuthzAuditAvailability; entries: readonly AuthzAuditLogRow[]; hasMore: boolean }>({
      session: this.db,
      savepointName: "sp_list_authz_audit_log",
      primary: async () => {
        // Pide una fila de más ("peek") para saber si hay más página sin un
        // COUNT(*) aparte -- mismo criterio que el paginado de break-glass
        // (ver packages/domain-rentas/src/break-glass/postgres-data-repository.ts).
        // `least(..., 201)` -- 1 más que `AUTHZ_AUDIT_LOG_LIMIT_MAX` (el
        // máximo EXPUESTO a un caller real, ver
        // apps/api/src/routes/superadmin.ts, sin cambios, sigue en 200):
        // `core.list_authz_audit_log_for_superadmin` sube su tope duro
        // INTERNO a 201 desde packages/db/migrations/
        // 0022_superadmin_bitacoras_endurecimiento.sql específicamente para
        // que este "peek" funcione también en el caso límite `limit === 200`
        // -- antes de esa migración, pedir `limit+1 = 201` no servía de nada
        // (la función lo recortaba de vuelta a 200 antes de que este
        // repositorio pudiera ver la fila de más) y `hasMore` reportaba
        // `false` aunque existiera una página 201+ real. `Math.min` sigue
        // aquí como defensa en profundidad (nunca pedir más de 201 pase lo
        // que pase con `limit`).
        const queryLimit = Math.min(limit + 1, 201);
        const { rows } = await this.db.query<AuthzAuditLogRawRow>(`select * from core.list_authz_audit_log_for_superadmin($1, $2, $3);`, [callerId, queryLimit, offset]);
        const hasMore = rows.length > limit;
        const trimmed = hasMore ? rows.slice(0, limit) : rows;
        return { availability: "available" as const, entries: trimmed.map(mapRow), hasMore };
      },
      isRecoverable: isMigrationMissingError,
      fallback: async () => {
        warnMissingAuthzAuditSchemaOnce();
        return { availability: "not_migrated", entries: [], hasMore: false };
      },
    });
  }
}

/** Adaptador en memoria -- para tests unitarios de rutas/del sink, mismo
 *  criterio que `InMemoryImpersonationRepository`. Nunca simula
 *  `"not_migrated"` (ese caso solo lo ejercita un doble dedicado que lanza
 *  `{code: '42883'}` contra `PostgresAuthzAuditRepository`, ver sus tests). */
export class InMemoryAuthzAuditRepository implements AuthzAuditRepository {
  private readonly rows: AuthzAuditLogRow[] = [];
  private seq = 0;

  async recordDenial(input: AuthzAuditLogEntryInput): Promise<{ availability: "available"; id: string }> {
    const id = `authz-audit-${++this.seq}`;
    this.rows.unshift({ id, ...input });
    return { availability: "available", id };
  }

  async list(_callerId: string, limit = 50, offset = 0): Promise<{ availability: "available"; entries: readonly AuthzAuditLogRow[]; hasMore: boolean }> {
    const entries = this.rows.slice(offset, offset + limit);
    return { availability: "available", entries, hasMore: this.rows.length > offset + limit };
  }

  /** Azúcar para tests -- mismo criterio que `InMemoryAuditSink.entries`. */
  get all(): readonly AuthzAuditLogRow[] {
    return this.rows;
  }
}

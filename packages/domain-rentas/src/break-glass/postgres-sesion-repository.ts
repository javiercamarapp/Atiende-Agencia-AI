// PostgresBreakGlassSessionRepository -- adaptador de producción de
// `BreakGlassSessionRepository`, sobre las 3 funciones security definer de
// ../../migrations/018_break_glass_wiring.sql
// (open_break_glass_session/list_break_glass_sessions_for_superadmin/
// close_break_glass_session).
//
// SESIÓN REQUERIDA: la sesión del PROPIO superadmin
// (`engine.withAppSession({ userId: actor.userId }, ...)`) -- MISMO patrón que
// `PostgresBreakGlassAuditRepository` (misma carpeta): las 3 funciones exigen
// `auth.uid() = p_caller_id` antes de nada, así que una sesión de sistema
// (`userId: null`) siempre sería rechazada con `42501`, nunca "0 resultados"
// engañoso.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { BreakGlassSessionRepository } from "./sesion-repository.ts";
import type { BreakGlassSession, NewBreakGlassSessionInput } from "./tipos.ts";

interface BreakGlassSessionRow {
  id: string;
  actor_user_id: string;
  actor_email: string | null;
  organization_id: string;
  reason: string;
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
  closed_by: string | null;
}

function mapRow(row: BreakGlassSessionRow): BreakGlassSession {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    organizationId: row.organization_id,
    reason: row.reason,
    openedAtMs: new Date(row.opened_at).getTime(),
    expiresAtMs: new Date(row.expires_at).getTime(),
    closedAtMs: row.closed_at ? new Date(row.closed_at).getTime() : null,
    closedBy: row.closed_by,
  };
}

export class PostgresBreakGlassSessionRepository implements BreakGlassSessionRepository {
  constructor(private readonly db: TenantDbSession) {}

  async open(input: NewBreakGlassSessionInput): Promise<BreakGlassSession> {
    const { rows } = await this.db.query<BreakGlassSessionRow>(
      `select * from rentas.open_break_glass_session($1, $2, $3, $4);`,
      [input.actor.userId, input.organizationId, input.reason, input.durationMinutes],
    );
    const row = rows[0];
    if (!row) throw new Error("open_break_glass_session: no devolvió ninguna fila.");
    return mapRow(row);
  }

  async listForActor(actorUserId: string): Promise<readonly BreakGlassSession[]> {
    const { rows } = await this.db.query<BreakGlassSessionRow>(
      `select * from rentas.list_break_glass_sessions_for_superadmin($1);`,
      [actorUserId],
    );
    return rows.map(mapRow);
  }

  async close(actorUserId: string, sessionId: string): Promise<BreakGlassSession> {
    const { rows } = await this.db.query<BreakGlassSessionRow>(
      `select * from rentas.close_break_glass_session($1, $2);`,
      [actorUserId, sessionId],
    );
    const row = rows[0];
    if (!row) throw new Error("close_break_glass_session: no devolvió ninguna fila.");
    return mapRow(row);
  }
}

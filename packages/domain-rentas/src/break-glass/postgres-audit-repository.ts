// PostgresBreakGlassAuditRepository -- adaptador de producción de
// `BreakGlassAuditRepository`, sobre el `TenantDbSession` genérico de
// `@atiende/core-tenancy` (mismo contrato que el resto de domain-rentas).
//
// SESIÓN REQUERIDA: la sesión del PROPIO superadmin (`engine.withAppSession({ userId:
// actor.userId }, ...)`), NUNCA la sesión admin/service-role -- la policy de INSERT de
// ../../migrations/012_break_glass_audit.sql exige `actor_user_id = auth.uid()`
// (nadie escribe una fila de auditoría a nombre de otro) y
// `rentas.is_platform_superadmin(auth.uid())` (defensa en profundidad: incluso si el
// llamador TS se equivocara de actor, la base lo rechaza). Contraste deliberado con
// `PostgresBreakGlassRentasDataRepository` (misma carpeta), que SÍ requiere la sesión
// admin -- son dos requisitos de privilegio distintos para dos operaciones distintas,
// ver el comentario de cabecera de ese archivo.
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { BreakGlassAuditRepository } from "./audit-repository.ts";
import type { BreakGlassAuditEntry, BreakGlassResourceType, NewBreakGlassAuditEntry } from "./tipos.ts";

interface BreakGlassAccessLogRow {
  id: string;
  actor_user_id: string;
  actor_email: string | null;
  organization_id: string;
  reason: string;
  resource_type: BreakGlassResourceType;
  resource_scope: Record<string, unknown>;
  result_summary: Record<string, unknown>;
  occurred_at: string;
  seq: string; // bigint -> string vía driver pg
  prev_hash: string | null;
  hash: string;
}

function mapRow(row: BreakGlassAccessLogRow): BreakGlassAuditEntry {
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    organizationId: row.organization_id,
    reason: row.reason,
    resourceType: row.resource_type,
    resourceScope: row.resource_scope,
    resultSummary: row.result_summary,
    occurredAtMs: new Date(row.occurred_at).getTime(),
    seq: Number(row.seq),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export class PostgresBreakGlassAuditRepository implements BreakGlassAuditRepository {
  constructor(private readonly db: TenantDbSession) {}

  async record(entry: NewBreakGlassAuditEntry): Promise<BreakGlassAuditEntry> {
    // `occurred_at`/`prev_hash`/`hash`/`seq` los calcula el trigger
    // (rentas.break_glass_log_set_hash) -- este INSERT solo aporta lo que el llamador
    // decide; `occurred_at` se pasa como pista (el trigger la usa si no es null, ver
    // `coalesce(new.occurred_at, now())`) para que `nowMs` inyectado en tests/acceso.ts
    // sea el mismo timestamp que termina en la fila, no el reloj real del servidor.
    const { rows } = await this.db.query<BreakGlassAccessLogRow>(
      `insert into rentas.break_glass_access_log
         (actor_user_id, actor_email, organization_id, reason, resource_type, resource_scope, result_summary, occurred_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz)
       returning id, actor_user_id, actor_email, organization_id, reason, resource_type,
                 resource_scope, result_summary, occurred_at::text as occurred_at, seq, prev_hash, hash;`,
      [
        entry.actorUserId,
        entry.actorEmail,
        entry.organizationId,
        entry.reason,
        entry.resourceType,
        JSON.stringify(entry.resourceScope),
        JSON.stringify(entry.resultSummary),
        new Date(entry.occurredAtMs).toISOString(),
      ],
    );
    const row = rows[0];
    if (!row) {
      // No debería ocurrir nunca (INSERT ... RETURNING de una sola fila) -- si pasa,
      // es un estado que `leerDatosTenantBreakGlass` debe tratar igual que cualquier
      // otro fallo de escritura (fail-closed), nunca como "éxito silencioso".
      throw new Error("break_glass_access_log: INSERT no devolvió ninguna fila.");
    }
    return mapRow(row);
  }
}

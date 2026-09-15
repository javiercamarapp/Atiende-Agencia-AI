// ProductionHotelesFraudeAuditSink — adaptador real de `AuditSink` para
// `deps.hotelesFraudeAuditSink`, consumido por `production/deps.ts`.
//
// Mismo gap, mismo remedio, que `ProductionDespachosAuditSink` (`./despachos-audit-sink.ts`,
// ver también `packages/domain-despachos/migrations/008_despachos_audit_log.sql`,
// cuyo comentario de cabecera dejaba explícitamente a `hotelesFraudeAuditSink` FUERA
// de ese cambio como "gap propio de hoteles, no pedido en esa fase"): mientras este
// puerto siguiera siendo `notProductionReady` (lanza SIEMPRE), cualquier llamada real
// desde `apps/api/src/routes/verticals/hoteles/fraude.ts` -- tanto
// `POST .../fraude/escaneos` (cuando detecta un hallazgo NUEVO) como
// `POST .../fraude/alertas/:id/{confirmar,descartar}` -- tumbaba el request con un
// 500 DESPUÉS de que la escritura de negocio (`recordFraudAlert`/`resolveFraudAlert`)
// ya había hecho su INSERT/UPDATE en la misma transacción de request.
//
// Dos decisiones de diseño, ambas heredadas de `ProductionDespachosAuditSink`:
//
//   1. Sesión de SISTEMA (`engine.withAppSession({ userId: null }, ...)`) -- el actor
//      real ya viene explícito en `entry.actorUserId`, la escritura en sí la hace el
//      sistema. Bajo esa sesión `auth.uid()` es NULL, así que el INSERT pasa por
//      `hoteles.record_fraude_audit_log()` (`security definer`, ver la migración 017)
//      en vez de depender de una policy de INSERT normal (que no existe a propósito,
//      ver esa misma migración).
//
//   2. NUNCA lanza ni rechaza -- contrato explícito de `@atiende/core-authz::AuditSink`
//      (ver cabecera de `packages/core-authz/src/audit.ts`: "record NUNCA debe poder
//      bloquear ni tumbar el request... una implementación real debe atrapar sus
//      propios errores"). Un fallo de escritura de auditoría (Postgres caído,
//      timeout, lo que sea) se registra en stderr estructurado y se descarta -- jamás
//      vuelve a convertirse en el mismo 500-después-del-commit que esta clase existe
//      para eliminar.
import type { AuditSink, AuthzAuditEntry } from "@atiende/core-authz";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionHotelesFraudeAuditSink implements AuditSink {
  constructor(private readonly engine: TenancyEngine) {}

  async record(entry: AuthzAuditEntry): Promise<void> {
    // `hoteles.fraude_audit_log.organization_id`/`property_id` son `not null`
    // (tabla property-scoped, ver migración 017) -- `AuthzAuditEntry.organizationId`
    // es opcional en el tipo genérico compartido porque OTROS consumidores de
    // `AuditSink` (ej. el gateo de /admin) sí auditan intentos sin organización
    // resuelta. `hotelesFraudeAuditSink` en concreto solo lo llama `fraude.ts`, ya
    // autenticado y con property/organización verificadas
    // (`requirePropertyMembership("propertyId")`), así que esto nunca debería
    // disparar en producción real -- se deja como defensa en profundidad (nunca
    // lanzar) en vez de asumir un invariante que este archivo no controla.
    const propertyId = typeof entry.metadata?.propertyId === "string" ? (entry.metadata.propertyId as string) : null;
    if (!entry.organizationId || !propertyId) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "hoteles_fraude_audit_sink_dropped_entry",
          reason: !entry.organizationId ? "missing_organization_id" : "missing_property_id",
          action: entry.action,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    try {
      await this.engine.withAppSession({ userId: null }, (session) =>
        session.query(`select hoteles.record_fraude_audit_log($1, $2, $3, $4, $5::jsonb);`, [
          entry.organizationId,
          propertyId,
          entry.actorUserId ?? null,
          entry.action,
          JSON.stringify(entry),
        ]),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "hoteles_fraude_audit_sink_write_failed",
          message: err instanceof Error ? err.message : String(err),
          action: entry.action,
          organization_id: entry.organizationId,
          property_id: propertyId,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

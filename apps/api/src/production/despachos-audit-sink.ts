// ProductionDespachosAuditSink — adaptador real de `AuditSink` para
// `deps.despachosAuditSink`, consumido por `production/deps.ts`.
//
// Corrige la regresión real de la Ronda 12 (ver
// packages/domain-despachos/migrations/008_despachos_audit_log.sql para el
// análisis completo): `cierre-mensual.ts`/`migracion-catalogo.ts` ya llamaban a
// `deps.despachosAuditSink.record(...)` DESPUÉS de que la escritura de negocio
// (completar tarea/cerrar un período fiscal irreversible/aprobar-rechazar-editar un
// mapeo) ya había hecho su INSERT/UPDATE en la misma transacción de request —
// mientras el puerto siguiera siendo `notProductionReady` (lanza SIEMPRE), esa
// llamada tumbaba el request con un 500 después de que Postgres ya había hecho
// commit.
//
// Dos decisiones de diseño, ambas heredadas de adaptadores ya existentes en este
// mismo directorio (nunca inventadas para este archivo):
//
//   1. Sesión de SISTEMA (`engine.withAppSession({ userId: null }, ...)`), MISMO
//      patrón exacto que `ProductionCoreRepository` (`./core-repository.ts`): esta
//      auditoría no depende de RLS por-actor (a diferencia de
//      `restaurantesRepo`/`despachosRepo`/etc., que SÍ necesitan la sesión
//      por-request para que `auth.uid()` resuelva la policy real del staff
//      autenticado) — el actor real ya viene explícito en `entry.actorUserId`, la
//      escritura en sí la hace el sistema. Bajo esa sesión `auth.uid()` es NULL, así
//      que el INSERT pasa por `despachos.record_audit_log()` (`security definer`,
//      ver la migración 007) en vez de depender de una policy de INSERT normal.
//
//   2. NUNCA lanza ni rechaza — contrato explícito de
//      `@atiende/core-authz::AuditSink` (ver cabecera de `packages/core-authz/src/
//      audit.ts`: "record NUNCA debe poder bloquear ni tumbar el request... una
//      implementación real (Postgres/Sentry/lo que sea) debe atrapar sus propios
//      errores"). Un fallo de escritura de auditoría (Postgres caído, timeout, lo
//      que sea) se registra en stderr estructurado y se descarta — jamás vuelve a
//      convertirse en el mismo 500-después-del-commit que esta clase existe para
//      eliminar.
import type { AuditSink, AuthzAuditEntry } from "@atiende/core-authz";
import type { TenancyEngine } from "@atiende/core-tenancy";

export class ProductionDespachosAuditSink implements AuditSink {
  constructor(private readonly engine: TenancyEngine) {}

  async record(entry: AuthzAuditEntry): Promise<void> {
    // `despachos.audit_log.organization_id` es `not null` (tabla por-tenant, ver
    // migración 007) — `AuthzAuditEntry.organizationId` es opcional en el tipo
    // genérico compartido porque OTROS consumidores de `AuditSink` (ej. el gateo
    // de /admin, ver `packages/core-authz/src/admin-middleware.ts`) sí auditan
    // intentos sin organización resuelta. `despachosAuditSink` en concreto solo lo
    // llaman rutas ya autenticadas y con property/organización verificada (ver
    // `routes/verticals/despachos/{cierre-mensual,migracion-catalogo}.ts`), así que
    // esto nunca debería disparar en producción real — se deja como defensa en
    // profundidad (nunca lanzar) en vez de asumir un invariante que este archivo no
    // controla.
    if (!entry.organizationId) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "despachos_audit_sink_dropped_entry",
          reason: "missing_organization_id",
          action: entry.action,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    try {
      await this.engine.withAppSession({ userId: null }, (session) =>
        session.query(`select despachos.record_audit_log($1, $2, $3, $4::jsonb);`, [
          entry.organizationId,
          entry.actorUserId ?? null,
          entry.action,
          JSON.stringify(entry),
        ]),
      );
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "despachos_audit_sink_write_failed",
          message: err instanceof Error ? err.message : String(err),
          action: entry.action,
          organization_id: entry.organizationId,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
}

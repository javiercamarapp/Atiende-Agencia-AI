// PersistentAuthzAuditSink — adaptador real de `AuditSink` para
// `deps.authzAuditSink`, consumido por `production/deps.ts` y montado en
// `routes/superadmin.ts` sobre `requireAdminAccess`.
//
// Cierra el hueco declarado explícitamente en el PR #162 ("Huecos conocidos"):
// `requireAdminAccess` (audit-on-denial) ya registraba cada intento denegado
// de acceso a `/superadmin/*`, pero el sink era `InMemoryAuditSink` — se
// pierde en cada reinicio/redeploy, y en serverless cada instancia lambda
// tiene el suyo, así que la bitácora de denegaciones no existía de verdad en
// producción.
//
// Mismas dos decisiones de diseño que `ProductionDespachosAuditSink`/
// `ProductionHotelesFraudeAuditSink` (este mismo directorio, NUNCA
// reinventadas):
//
//   1. Sesión de SISTEMA (`engine.withAppSession({ userId: null }, ...)`) —
//      el actor real ya viene explícito en `entry.actorUserId` (puede ser
//      `null` si la denegación ocurrió sin JWT resuelto), la escritura en sí
//      la hace el sistema. `core.record_authz_audit_denial` (migración 0021)
//      es una función de SOLO SISTEMA (`auth.uid() is null`) — nunca
//      caller-bound, a diferencia de `despachos.record_audit_log`.
//
//   2. NUNCA lanza ni rechaza — contrato explícito de
//      `@atiende/core-authz::AuditSink`.
//
// TERCERA decisión, propia de esta clase (a diferencia de los dos adaptadores
// de arriba, que asumen su migración ya aplicada en producción): COMPATIBILIDAD
// CON LA BASE SIN MIGRAR real (mandato explícito de la tarea) — mientras
// `packages/db/migrations/0021_superadmin_authz_audit_log.sql` no esté
// aplicada contra Supabase real (`PostgresAuthzAuditRepository.recordDenial`
// devuelve `{ availability: "not_migrated", id: null }`, NUNCA lanza), o si el
// tope defensivo de la propia función SQL descarta la fila (`id: null` con
// `availability: "available"` — ráfaga real), esta clase cae al MISMO
// `InMemoryAuditSink` que `requireAdminAccess` usaba antes de esta migración
// — el comportamiento actual (bitácora en memoria, por-proceso) sigue
// disponible como piso, nunca un 500, nunca una denegación silenciosamente no
// auditada en ninguna parte.
import type { AuditSink, AuthzAuditEntry } from "@atiende/core-authz";
import { InMemoryAuditSink } from "@atiende/core-authz";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { PostgresAuthzAuditRepository } from "@atiende/db";

export class PersistentAuthzAuditSink implements AuditSink {
  /** Piso en memoria — nunca se reemplaza por otra instancia, así que
   *  `memoryFallback` (abajo) sigue siendo un handle estable para tests/
   *  diagnóstico incluso después de muchas llamadas a `record`. */
  private readonly fallback = new InMemoryAuditSink();

  constructor(private readonly engine: TenancyEngine) {}

  async record(entry: AuthzAuditEntry): Promise<void> {
    try {
      const result = await this.engine.withAppSession({ userId: null }, (session) =>
        new PostgresAuthzAuditRepository(session).recordDenial({
          actorUserId: entry.actorUserId,
          actorIp: entry.ip ?? null,
          organizationId: entry.organizationId ?? null,
          action: entry.action,
          route: entry.route,
          method: entry.method,
          decision: entry.decision,
          reason: entry.reason ?? null,
          // Nunca `userAgent` -- sin PII innecesaria (mandato de la tarea).
          // `platformRole`/`allowedRoles` (lo único que admin-middleware.ts
          // pone en `metadata` hoy) no es PII.
          metadata: entry.metadata ?? {},
          occurredAtMs: Date.parse(entry.at) || Date.now(),
        }),
      );
      if (result.id === null) {
        // "no disponible aún" (migración 0021 sin aplicar) o tope defensivo
        // de ráfaga alcanzado -- cae al piso en memoria, mismo comportamiento
        // que este sink tenía ANTES de esta migración, nunca un 500 ni una
        // denegación que no queda registrada en ninguna parte.
        this.fallback.record(entry);
      }
    } catch (err) {
      // `engine.withAppSession` en sí podría lanzar (abrir la conexión falla,
      // pool agotado, etc.) -- `PostgresAuthzAuditRepository.recordDenial`
      // nunca lanza, pero abrir la sesión de sistema es responsabilidad del
      // motor, fuera de su alcance. Mismo criterio "nunca tumbar el request"
      // que el resto de este archivo: se registra en logs y cae al piso en
      // memoria.
      console.error(
        JSON.stringify({
          level: "error",
          event: "authz_audit_sink_write_failed",
          message: err instanceof Error ? err.message : String(err),
          action: entry.action,
          route: entry.route,
          timestamp: new Date().toISOString(),
        }),
      );
      this.fallback.record(entry);
    }
  }

  /** Azúcar para tests/diagnóstico -- las entradas que NO llegaron a
   *  persistirse (migración sin aplicar, o tope defensivo de ráfaga), mismo
   *  criterio que `InMemoryAuditSink.entries`/`.denied()`. */
  get memoryFallback(): InMemoryAuditSink {
    return this.fallback;
  }
}

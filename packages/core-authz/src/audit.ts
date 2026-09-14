// ═══════════════════════════════════════════════════════════════════════════
// AUDITORÍA DE AUTORIZACIÓN — adaptado de atiende-ai/src/lib/admin/audit-log.ts
// (`AdminAuditEntry`/`logAdminAction` -> tabla `admin_audit_log`), con una
// diferencia deliberada que es justo la pieza nueva que pide esta fase:
//
//   atiende-ai audita SOLO lo que el handler YA decidió permitir — el caller
//   llama `logAdminAction` a mano DESPUÉS de ejecutar la acción admin. Un
//   intento RECHAZADO (403) nunca pasaba por ahí: no hay rastro de quién
//   intentó una acción de /admin sin permiso. Ningún repo de referencia
//   (ni proyecto-origen ni atiende-ai) auditaba la denegación — ver reporte de la
//   fase.
//
//   Aquí `AuditSink.record` se llama desde `requireAdminAccess`
//   (admin-middleware.ts) para AMBOS desenlaces, y el campo `decision`
//   distingue uno de otro. `record` NUNCA debe poder bloquear ni tumbar el
//   request — mismo criterio que el try/catch de `logAdminAction` ("Audit
//   log fail no debe bloquear la action principal, solo log"): una
//   implementación real (Postgres/Sentry/lo que sea) debe atrapar sus propios
//   errores; esta interfaz no impone eso, pero `InMemoryAuditSink` de abajo y
//   los tests documentan la expectativa.
// ═══════════════════════════════════════════════════════════════════════════

export type AuthzDecision = "allowed" | "denied";

/** Por qué se denegó — o `undefined` si `decision === "allowed"`. */
export type DenialReason =
  | "insufficient_role"
  | "route_not_mapped"
  | "rate_limited"
  | "no_membership";

export interface AuthzAuditEntry {
  readonly at: string; // ISO 8601 — quien construye el entry decide el reloj (testeable)
  readonly actorUserId: string | null;
  readonly actorEmail?: string | null;
  readonly organizationId?: string | null;
  /** Acción de negocio en formato "recurso:verbo", ej. "admin:access". */
  readonly action: string;
  readonly route: string;
  readonly method: string;
  readonly decision: AuthzDecision;
  readonly reason?: DenialReason;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditSink {
  record(entry: AuthzAuditEntry): void | Promise<void>;
}

/**
 * Implementación de referencia para tests y para arrancar en desarrollo sin
 * base de datos — mismo rol que `fakeEngine` en core-auth/tests/middleware.spec.ts.
 * Una app real conecta una implementación que escribe a
 * `core.authz_audit_log` (packages/db) o reutiliza `admin_audit_log` si la
 * vertical ya la tiene (hoteles: `packages/db/migrations/0008_audit_log.sql`).
 */
export class InMemoryAuditSink implements AuditSink {
  readonly entries: AuthzAuditEntry[] = [];

  record(entry: AuthzAuditEntry): void {
    this.entries.push(entry);
  }

  /** Solo las entradas denegadas — azúcar para tests/dashboards. */
  denied(): readonly AuthzAuditEntry[] {
    return this.entries.filter((e) => e.decision === "denied");
  }

  clear(): void {
    this.entries.length = 0;
  }
}

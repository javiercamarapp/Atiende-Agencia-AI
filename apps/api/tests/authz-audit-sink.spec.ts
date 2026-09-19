// PersistentAuthzAuditSink -- ver production/authz-audit-sink.ts para el diseño
// completo. A diferencia de ProductionDespachosAuditSink/
// ProductionHotelesFraudeAuditSink (que asumen su migración ya aplicada en
// producción), esta clase tiene una tercera responsabilidad propia:
// compatibilidad con la base SIN migrar (mandato de la tarea) -- estos tests
// cubren justo eso, con un `TenancyEngine`/`TenantDbSession` falsos (nunca
// Postgres real, eso lo cubre scripts/verify-superadmin-auditoria-denegaciones/).
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import type { AuthzAuditEntry } from "@atiende/core-authz";
import { PersistentAuthzAuditSink } from "../src/production/authz-audit-sink.ts";

function migrationMissingError(): Error & { code: string } {
  return Object.assign(new Error("function core.record_authz_audit_denial(...) does not exist"), { code: "42883" });
}

const ENTRADA: AuthzAuditEntry = {
  at: "2026-09-19T12:00:00.000Z",
  actorUserId: "staff-1",
  organizationId: null,
  action: "admin:access",
  route: "/superadmin/impersonacion/sesiones",
  method: "POST",
  decision: "denied",
  reason: "no_membership",
  ip: "150.172.238.178",
  metadata: { platformRole: null, allowedRoles: ["owner"] },
};

/** Motor falso mínimo -- ejecuta `fn` directamente contra una sesión que
 *  responde lo que el test programe, sin abrir ninguna conexión real. */
function fakeEngine(session: TenantDbSession): TenancyEngine {
  return {
    async withAppSession(claims, fn) {
      expect(claims.userId).toBeNull(); // SIEMPRE sesión de sistema, nunca la del actor auditado
      return fn(session);
    },
  };
}

function sessionThatReturns(id: string | null): TenantDbSession {
  return {
    query: async <T>() => ({ rows: [{ id }] as unknown as T[] }),
    exec: async () => undefined,
  };
}

function sessionThatThrows(err: Error): TenantDbSession {
  return {
    query: async () => {
      throw err;
    },
    exec: async () => undefined,
  };
}

describe("PersistentAuthzAuditSink.record", () => {
  it("camino feliz -- escribe vía la sesión de sistema, NO cae al fallback en memoria", async () => {
    const sink = new PersistentAuthzAuditSink(fakeEngine(sessionThatReturns("row-1")));
    await sink.record(ENTRADA);
    expect(sink.memoryFallback.entries).toHaveLength(0);
  });

  it("migración 0021 no aplicada (42883) -- cae al fallback en memoria, NUNCA lanza", async () => {
    const sink = new PersistentAuthzAuditSink(fakeEngine(sessionThatThrows(migrationMissingError())));
    await expect(sink.record(ENTRADA)).resolves.toBeUndefined();
    expect(sink.memoryFallback.entries).toHaveLength(1);
    expect(sink.memoryFallback.entries[0]).toEqual(ENTRADA);
  });

  it("el repositorio devuelve id:null (tope defensivo de ráfaga alcanzado) -- cae al fallback en memoria, NUNCA lanza", async () => {
    const sink = new PersistentAuthzAuditSink(fakeEngine(sessionThatReturns(null)));
    await sink.record(ENTRADA);
    expect(sink.memoryFallback.entries).toHaveLength(1);
  });

  it("engine.withAppSession en sí lanza (ej. pool agotado) -- cae al fallback en memoria, NUNCA tumba el request", async () => {
    const engineRoto: TenancyEngine = {
      async withAppSession() {
        throw new Error("no se pudo abrir la conexión");
      },
    };
    const sink = new PersistentAuthzAuditSink(engineRoto);
    await expect(sink.record(ENTRADA)).resolves.toBeUndefined();
    expect(sink.memoryFallback.entries).toHaveLength(1);
  });

  it("nunca envía entry.metadata.userAgent -- el mandato es 'sin PII innecesaria, nunca cabeceras crudas'", async () => {
    const capturas: unknown[] = [];
    const session: TenantDbSession = {
      query: async <T>(_sql: string, params?: unknown[]) => {
        capturas.push(params);
        return { rows: [{ id: "row-1" }] as unknown as T[] };
      },
      exec: async () => undefined,
    };
    const sink = new PersistentAuthzAuditSink(fakeEngine(session));
    await sink.record({ ...ENTRADA, userAgent: "Mozilla/5.0 (algo muy identificable)" });

    const params = capturas[0] as unknown[];
    // Orden posicional de PostgresAuthzAuditRepository.recordDenial: [actorUserId,
    // actorIp, organizationId, action, route, method, decision, reason, metadata, occurredAt].
    const metadataJson = params[8] as string;
    expect(metadataJson).not.toContain("Mozilla");
  });
});

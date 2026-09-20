// Corrección de revisión #2 sobre PR #176 (auditoría a3) — reemplaza por
// completo la versión anterior de este archivo, que probaba (y "celebraba"
// como best-effort correcto) un `repo.runWithRowSavepoint` alrededor de
// `licitaciones.enqueue_messaging_outbox` corriendo en la sesión de STAFF del
// request. Esa función SQL es EXCLUSIVA de sesión de sistema sin excepción
// (`supabase/migrations/20240101000089_020_email_outbox_authenticated_grants.sql:17-25`,
// certificado por `scripts/verify-outbox-grants/assertions.sql` casos 11/12):
// con `auth.uid()` real SIEMPRE lanza `42501`, así que el SAVEPOINT evitaba el
// 500 pero el correo de invitación NUNCA se encolaba en producción — el test
// anterior confirmaba justo ese comportamiento roto en vez de detectarlo.
//
// El remedio real (ver el comentario de cabecera de
// `enqueueStaffInviteEmailPostCommit` en `admin-staff.ts`) es encolar el
// correo DESPUÉS del commit, en una transacción NUEVA de sesión de sistema
// (`deps.engine.withAppSession({ userId: null }, ...)`), igual que
// `despachos/vencimientos.ts` y `hoteles/reservas.ts`. Estos tests afirman el
// EFECTO real, no solo la ausencia de un 500:
// 1) la sesión que ejecuta el INSERT es la de SISTEMA (`userId: null`), NUNCA
//    la del staff que hizo la invitación;
// 2) con esa sesión de sistema, la fila SÍ queda encolada (el INSERT real
//    llega hasta `session.query`, vía `PostgresLicitacionesRepository` real —
//    no el doble en memoria, que no ejecuta SQL);
// 3) un fallo real de Postgres en esa sesión de sistema (`AbortAwareFakeSession`,
//    mismo doble que el resto de specs de esta auditoría) se loguea pero
//    NUNCA se propaga — sigue siendo best-effort real, ahora en el lugar que
//    de verdad puede tener éxito.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresLicitacionesRepository } from "@atiende/domain-licitaciones";
import { enqueueStaffInviteEmailPostCommit } from "../src/routes/verticals/licitaciones/admin-staff.ts";

const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000o1";
const INVITE_ID = "00000000-0000-0000-0000-0000000000i1";
const CORREO = { asunto: "Invitación", html: "<p>hola</p>", texto: "hola" };

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("enqueue_messaging_outbox es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

/** Mismo doble mínimo de `TenantDbSession` que el resto de specs de esta
 * auditoría (p. ej. `hoteles-admin-staff-savepoint.spec.ts`): reproduce el
 * estado ABORTADO real de Postgres tras un error dentro de la transacción. Se
 * usa aquí para la sesión de SISTEMA (no la de staff — esa ya no participa en
 * absoluto en este encolado), para probar que un fallo ahí sigue siendo
 * best-effort real. */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  private savepointTaken = false;
  readonly queries: unknown[] = [];
  readonly execCalls: string[] = [];

  private throwAborted(): never {
    const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
    err.code = "25P02";
    throw err;
  }

  async query<T>(sql?: string, params?: unknown[]): Promise<{ rows: T[] }> {
    if (this.aborted) this.throwAborted();
    this.queries.push({ sql, params });
    return { rows: [] as T[] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.execCalls.push(n);
    if (n.startsWith("rollback to savepoint")) {
      if (!this.savepointTaken) throw new Error(`AbortAwareFakeSession: ROLLBACK TO SAVEPOINT sin savepoint previo (${sql})`);
      this.aborted = false;
      this.savepointTaken = false;
      return;
    }
    if (this.aborted) this.throwAborted();
    if (n.startsWith("savepoint")) {
      this.savepointTaken = true;
      return;
    }
    if (n.startsWith("release savepoint")) {
      this.savepointTaken = false;
      return;
    }
    throw new Error(`AbortAwareFakeSession: exec no soportado: ${sql}`);
  }
}

describe("enqueueStaffInviteEmailPostCommit (licitaciones) — corrección #2 sobre PR #176", () => {
  it("usa sesión de SISTEMA (userId: null), nunca la del staff, y la fila queda realmente encolada", async () => {
    const systemSession = new AbortAwareFakeSession();
    const claimsSeen: Array<{ userId: string | null }> = [];
    const engine = {
      async withAppSession<T>(claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
        claimsSeen.push(claims);
        return fn(systemSession);
      },
    };
    const deps = {
      engine,
      licitacionesRepo: (db: TenantDbSession) => new PostgresLicitacionesRepository(db),
    };
    const enqueueSpy = vi.spyOn(PostgresLicitacionesRepository.prototype, "enqueueMessagingOutbox");

    await enqueueStaffInviteEmailPostCommit(deps, ORGANIZATION_ID, INVITE_ID, "nuevo@licitaciones-de-prueba.mx", CORREO);

    // Efecto 1: la sesión abierta para este encolado es de sistema, no de staff.
    expect(claimsSeen).toEqual([{ userId: null }]);
    // Efecto 2: el encolado real corrió (contra el repo Postgres real, sobre la
    // sesión de sistema) con el evento/payload correctos.
    expect(enqueueSpy).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      "email",
      "staff.invite",
      `staff-invite:${INVITE_ID}`,
      expect.objectContaining({ to: "nuevo@licitaciones-de-prueba.mx", subject: CORREO.asunto }),
    );
    // Efecto 3: la fila realmente llegó a `session.query` (INSERT real, no un
    // mock que nunca toca la sesión) y la sesión de sistema no quedó abortada.
    expect(systemSession.queries.length).toBeGreaterThan(0);
    expect(systemSession.aborted).toBe(false);

    enqueueSpy.mockRestore();
  });

  it("un fallo real de Postgres en la sesión de sistema (p. ej. 42501 inesperado, o Resend/columna sin migrar) se loguea pero NUNCA se propaga", async () => {
    const systemSession = new AbortAwareFakeSession();
    const engine = {
      async withAppSession<T>(_claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
        return fn(systemSession);
      },
    };
    const deps = {
      engine,
      licitacionesRepo: (db: TenantDbSession) => new PostgresLicitacionesRepository(db),
    };
    const enqueueSpy = vi.spyOn(PostgresLicitacionesRepository.prototype, "enqueueMessagingOutbox").mockImplementation(async () => {
      systemSession.aborted = true;
      throw pgPermissionDenied();
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      enqueueStaffInviteEmailPostCommit(deps, ORGANIZATION_ID, INVITE_ID, "nuevo@licitaciones-de-prueba.mx", CORREO),
    ).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalled();

    enqueueSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("nunca abre ni toca una sesión de STAFF -- el encolado no depende en absoluto de `auth.uid()` del request", async () => {
    let withAppSessionCalls = 0;
    const systemSession = new AbortAwareFakeSession();
    const engine = {
      async withAppSession<T>(claims: { userId: string | null }, fn: (session: TenantDbSession) => Promise<T>): Promise<T> {
        withAppSessionCalls += 1;
        expect(claims.userId).toBeNull();
        return fn(systemSession);
      },
    };
    const deps = {
      engine,
      licitacionesRepo: (db: TenantDbSession) => new PostgresLicitacionesRepository(db),
    };
    vi.spyOn(PostgresLicitacionesRepository.prototype, "enqueueMessagingOutbox").mockResolvedValue(undefined);

    await enqueueStaffInviteEmailPostCommit(deps, ORGANIZATION_ID, INVITE_ID, "nuevo@licitaciones-de-prueba.mx", CORREO);

    expect(withAppSessionCalls).toBe(1);

    vi.restoreAllMocks();
  });
});

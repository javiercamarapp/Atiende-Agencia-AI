// Corrección de revisión sobre PR #176 (auditoría a3) — regresión para
// `tryEnqueueStaffInviteEmail` (apps/api/src/routes/verticals/hoteles/admin-staff.ts).
// Un revisor independiente marcó que este best-effort encolaba el correo de
// invitación DENTRO de la MISMA transacción de sesión de staff que ya persistió
// `createStaffInvite`, con un try/catch plano sin SAVEPOINT — un error real de
// Postgres en `enqueue_messaging_outbox` (deadlock/timeout transitorio, o `42501`
// del guard) dejaba la transacción en 25P02, y el `commit;` que sigue
// (`managed-postgres-engine.ts`) revertía también la invitación ya "persistida"
// con `AbortedTransactionCommitError` -> 500, exactamente lo que el comentario de
// ese archivo promete que nunca pasa.
//
// Se prueba contra `PostgresHotelesRepository` real (no el doble en memoria, cuyo
// `runWithRowSavepoint` es un no-op que no reproduce el estado abortado de
// Postgres) + un doble LOCAL mínimo de `TenantDbSession`
// (`AbortAwareFakeSession`, mismo patrón que
// `licitaciones-email-dispatch-savepoint.spec.ts`/`hoteles-email-dispatch-
// savepoint.spec.ts` de este mismo directorio — NO el helper compartido de
// `packages/domain-hoteles/tests/support`, que es para tests DENTRO de ese
// paquete). Cada test de "fallo" de este archivo FALLA contra el código
// anterior (try/catch sin `repo.runWithRowSavepoint`): sin el SAVEPOINT, la
// consulta posterior sobre la MISMA sesión lanza 25P02 en vez de resolver.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresHotelesRepository } from "@atiende/domain-hoteles";
import { tryEnqueueStaffInviteEmail } from "../src/routes/verticals/hoteles/admin-staff.ts";

const PROPERTY_ID = "00000000-0000-0000-0000-0000000000p1";
const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000o1";
const INVITE_ID = "00000000-0000-0000-0000-0000000000i1";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("permission denied for function enqueue_messaging_outbox") as Error & { code: string };
  err.code = "42501";
  return err;
}

const CORREO = { asunto: "Invitación", html: "<p>hola</p>", texto: "hola" };

/** Doble mínimo local de `TenantDbSession` que reproduce el estado ABORTADO real
 * de Postgres: tras un error dentro de la transacción, CUALQUIER comando (salvo
 * `ROLLBACK TO SAVEPOINT` hacia un savepoint que sí se tomó antes) sigue
 * fallando con 25P02, hasta ese `ROLLBACK TO SAVEPOINT` real. */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  private savepointTaken = false;
  readonly execCalls: string[] = [];

  private throwAborted(): never {
    const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
    err.code = "25P02";
    throw err;
  }

  async query<T>(): Promise<{ rows: T[] }> {
    if (this.aborted) this.throwAborted();
    return { rows: [] as T[] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.execCalls.push(n);

    if (n.startsWith("rollback to savepoint")) {
      if (!this.savepointTaken) {
        throw new Error(`AbortAwareFakeSession: ROLLBACK TO SAVEPOINT sin savepoint previo (${sql})`);
      }
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

describe("tryEnqueueStaffInviteEmail (hoteles) — SAVEPOINT (corrección de revisión PR #176)", () => {
  it("un 42501 real de enqueue_messaging_outbox NUNCA deja la sesión abortada -- la invitación ya persistida sobrevive", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresHotelesRepository(session);
    vi.spyOn(repo, "enqueueMessagingOutbox").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });

    // No lanza -- best-effort real.
    await expect(tryEnqueueStaffInviteEmail(repo, PROPERTY_ID, ORGANIZATION_ID, INVITE_ID, "nuevo@hotel-de-prueba.mx", CORREO)).resolves.toBeUndefined();

    // La prueba real: el SAVEPOINT interno recuperó la transacción -- una
    // consulta POSTERIOR sobre la MISMA sesión (aquí, la que haría el `commit;`
    // real de managed-postgres-engine.ts) resuelve en vez de lanzar 25P02
    // (AbortedTransactionCommitError). Contra el código anterior (sin
    // `repo.runWithRowSavepoint`) esta aserción falla: la sesión queda abortada.
    await expect(session.query()).resolves.toEqual({ rows: [] });
    expect(session.execCalls.some((c) => c.startsWith("savepoint"))).toBe(true);
    expect(session.execCalls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(session.execCalls.some((c) => c.startsWith("release savepoint"))).toBe(true);
  });

  it("éxito real: encola el correo sin dejar rastro de SAVEPOINT sin liberar", async () => {
    const session = new AbortAwareFakeSession();
    const repo = new PostgresHotelesRepository(session);
    const enqueueSpy = vi.spyOn(repo, "enqueueMessagingOutbox").mockResolvedValue(undefined);

    await tryEnqueueStaffInviteEmail(repo, PROPERTY_ID, ORGANIZATION_ID, INVITE_ID, "nuevo@hotel-de-prueba.mx", CORREO);

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(session.execCalls.some((c) => c.startsWith("release savepoint"))).toBe(true);
    expect(session.execCalls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });
});

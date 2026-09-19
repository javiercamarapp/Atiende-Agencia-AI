// Fix hallazgo auditoría a2 (CRÍTICO) — regresión para
// `triggerHotelesEmailDispatchInline`. El repositorio en memoria (usado por el
// resto de hoteles-email-dispatch.spec.ts) nunca aplica el guard real de
// `hoteles.claim_email_outbox_batch` (auth.uid() no nulo -> 42501, ver
// packages/domain-hoteles/migrations/016_email_outbox_authenticated_grants.sql),
// así que esta suite fuerza esa misma excepción con un doble de
// `claimEmailOutboxBatch` y un doble LOCAL mínimo de `TenantDbSession`
// (`AbortAwareFakeSession`, mismo patrón que
// packages/domain-citas/tests/upsert-customer-savepoint.spec.ts — NO el helper
// compartido de PR #158, que todavía no vive en main) para probar el mecanismo
// completo: SAVEPOINT antes, ROLLBACK TO SAVEPOINT + RELEASE en el catch, nunca
// relanza.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryHotelesRepository } from "@atiende/domain-hoteles";
import { triggerHotelesEmailDispatchInline } from "../src/routes/verticals/hoteles/email-dispatch.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";
import { buildApp } from "../src/app.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_email_outbox_batch es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

/** Doble mínimo local de `TenantDbSession` que reproduce el estado ABORTADO real
 * de Postgres: tras un error, CUALQUIER `query`/`exec` (salvo un `ROLLBACK TO
 * SAVEPOINT`) sigue fallando con 25P02 -- mismo criterio que
 * `AbortAwareFakeSession` de domain-citas/domain-restaurantes, pero LOCAL a este
 * archivo (ver comentario de cabecera: no depende del helper de PR #158). */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  readonly execCalls: string[] = [];

  async query<T>(): Promise<{ rows: T[] }> {
    if (this.aborted) {
      const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
      err.code = "25P02";
      throw err;
    }
    return { rows: [] as T[] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.execCalls.push(n);
    if (n.startsWith("savepoint")) return;
    if (n.startsWith("rollback to savepoint")) {
      this.aborted = false;
      return;
    }
    if (n.startsWith("release savepoint")) return;
    throw new Error(`AbortAwareFakeSession: exec no soportado: ${sql}`);
  }
}

describe("triggerHotelesEmailDispatchInline — SAVEPOINT (regresión auditoría a2)", () => {
  it("con sesión de staff (claimEmailOutboxBatch lanza 42501): SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const repo = new InMemoryHotelesRepository();
    vi.spyOn(repo, "claimEmailOutboxBatch").mockRejectedValue(pgPermissionDenied());
    const session = new AbortAwareFakeSession();

    await expect(triggerHotelesEmailDispatchInline(ctx.deps, session, repo)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "rollback to savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
  });

  it("sin el SAVEPOINT, la misma excepción SÍ dejaría la sesión abortada para cualquier consulta posterior (prueba de que el bug era real)", async () => {
    const session = new AbortAwareFakeSession();
    await expect(
      (async () => {
        try {
          throw pgPermissionDenied();
        } catch {
          session.aborted = true; // el catch sin SAVEPOINT nunca recupera la sesión
        }
        return session.query();
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });

  it("éxito real: SAVEPOINT -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const repo = new InMemoryHotelesRepository();
    const session = new AbortAwareFakeSession();

    await triggerHotelesEmailDispatchInline(ctx.deps, session, repo);

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
  });
});

// Fix hallazgo auditoría a2 (CRÍTICO) — regresión para
// `triggerRentasEmailDispatchInline`. Mismo criterio que
// hoteles-email-dispatch-savepoint.spec.ts/citas-email-dispatch-savepoint.spec.ts:
// el repositorio en memoria nunca aplica el guard real de
// `rentas.claim_email_outbox_batch` (auth.uid() no nulo -> 42501), así que esta
// suite fuerza esa misma excepción con un doble de `claimEmailOutboxBatch` y un
// doble LOCAL mínimo de `TenantDbSession` (`AbortAwareFakeSession`, patrón LOCAL
// a este archivo — NO el helper compartido de PR #158, que todavía no vive en
// main).
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRentasRepository } from "@atiende/domain-rentas";
import { triggerRentasEmailDispatchInline } from "../src/routes/verticals/rentas/email-dispatch.ts";
import { buildRentasTestContext } from "./rentas-fixtures.ts";
import { buildApp } from "../src/app.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_email_outbox_batch es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

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

describe("triggerRentasEmailDispatchInline — SAVEPOINT (regresión auditoría a2)", () => {
  it("con sesión de staff (claimEmailOutboxBatch lanza 42501): SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const repo = new InMemoryRentasRepository();
    vi.spyOn(repo, "claimEmailOutboxBatch").mockRejectedValue(pgPermissionDenied());
    const session = new AbortAwareFakeSession();

    await expect(triggerRentasEmailDispatchInline(ctx.deps, session, repo)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "rollback to savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
  });

  it("éxito real: SAVEPOINT -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const repo = new InMemoryRentasRepository();
    const session = new AbortAwareFakeSession();

    await triggerRentasEmailDispatchInline(ctx.deps, session, repo);

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
  });
});

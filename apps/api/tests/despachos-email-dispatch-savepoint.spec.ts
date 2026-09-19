// Fix hallazgo auditoría a2 (CRÍTICO) — regresión para
// `triggerDespachosEmailDispatchInline`. Mismo criterio que
// hoteles-email-dispatch-savepoint.spec.ts: el repositorio en memoria nunca
// aplica el guard real de `despachos.claim_email_outbox_batch` (auth.uid() no
// nulo -> 42501), así que esta suite fuerza esa misma excepción con un doble de
// `claimEmailOutboxBatch` y un doble LOCAL mínimo de `TenantDbSession`
// (`AbortAwareFakeSession`, patrón LOCAL a este archivo — NO el helper
// compartido de PR #158, que todavía no vive en main).
//
// Fix a2b (parte C, seguimiento PR #166) — revisión independiente marcó que
// el doble ANTERIOR no reproducía el estado abortado real: el mock de
// `claimEmailOutboxBatch` rechazaba la promesa SIN tocar la sesión, `exec()`
// nunca lanzaba 25P02, y ningún test consultaba la sesión DESPUÉS del
// trigger. Corregido: el mock ahora pone `session.aborted = true` ANTES de
// rechazar (reproduce que corre sobre la MISMA sesión/transacción), `exec()`
// lanza 25P02 si la sesión está abortada y el comando no es `ROLLBACK TO
// SAVEPOINT`, y `ROLLBACK TO SAVEPOINT` solo "funciona" si un `SAVEPOINT` fue
// realmente tomado antes. Cada test de fallo verifica además que una consulta
// POSTERIOR sobre la misma sesión resuelve.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryDespachosRepository } from "@atiende/domain-despachos";
import { triggerDespachosEmailDispatchInline } from "../src/routes/verticals/despachos/notifications.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import { buildApp } from "../src/app.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_email_outbox_batch es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

/** Doble mínimo local de `TenantDbSession` que reproduce el estado ABORTADO
 * real de Postgres: tras un error dentro de la transacción, CUALQUIER
 * comando (salvo `ROLLBACK TO SAVEPOINT` hacia un savepoint que sí se tomó
 * antes) sigue fallando con 25P02, hasta ese `ROLLBACK TO SAVEPOINT` real. */
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

describe("triggerDespachosEmailDispatchInline — SAVEPOINT (regresión auditoría a2 / fix a2b)", () => {
  it("con sesión de staff (claim_email_outbox_batch lanza 42501 DENTRO de esta misma sesión): SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza, y la sesión vuelve a servir consultas", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, resend: { ...ctx.deps.env.resend, apiKey: "re_test_key" } } };
    const repo = new InMemoryDespachosRepository();
    const session = new AbortAwareFakeSession();
    vi.spyOn(repo, "claimEmailOutboxBatch").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });

    await expect(triggerDespachosEmailDispatchInline(deps, session, repo)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "rollback to savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
    await expect(session.query()).resolves.toEqual({ rows: [] });
  });

  it("fix (parte C): si la transacción YA venía abortada ANTES de este trigger, el propio SAVEPOINT lanza 25P02 -- igual nunca relanza (antes del fix, el exec corría fuera del try y sí se propagaba)", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const repo = new InMemoryDespachosRepository();
    const claimSpy = vi.spyOn(repo, "claimEmailOutboxBatch");
    const session = new AbortAwareFakeSession();
    session.aborted = true;

    await expect(triggerDespachosEmailDispatchInline(ctx.deps, session, repo)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "rollback to savepoint sp_inline_email_dispatch"]);
    expect(claimSpy).not.toHaveBeenCalled();
  });

  it("éxito real: SAVEPOINT -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const ctx = await buildDespachosTestContext(buildApp);
    const repo = new InMemoryDespachosRepository();
    const session = new AbortAwareFakeSession();

    await triggerDespachosEmailDispatchInline(ctx.deps, session, repo);

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
  });
});

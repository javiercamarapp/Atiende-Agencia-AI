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
//
// Fix a2b (parte C, seguimiento PR #166) — revisión independiente marcó que
// el doble ANTERIOR no reproducía el estado abortado real: el mock de
// `claimEmailOutboxBatch` rechazaba la promesa SIN tocar la sesión, `exec()`
// nunca lanzaba 25P02, y ningún test consultaba la sesión DESPUÉS del
// trigger para confirmar que de verdad quedó recuperada. Corregido abajo:
// el mock ahora pone `session.aborted = true` ANTES de rechazar (reproduce
// que, en Postgres real, `claim_email_outbox_batch` corre sobre la MISMA
// sesión/transacción — su 42501 no es un rechazo aislado), `exec()` lanza
// 25P02 si la sesión está abortada y el comando no es `ROLLBACK TO
// SAVEPOINT`, y `ROLLBACK TO SAVEPOINT` solo "funciona" si un `SAVEPOINT`
// fue realmente tomado antes (mismo comportamiento real de Postgres: no se
// puede volver a un savepoint que nunca se creó). Cada test de fallo ahora
// además verifica que una consulta POSTERIOR sobre la misma sesión resuelve.
//
// Corrección (revisión independiente PR #168, segunda vuelta) — el test de
// "transacción ya abortada ANTES de este trigger" de abajo afirmaba
// `resolves.toBeUndefined()` sin consultar la sesión después: no detectaba
// que, con el fix ANTERIOR (tragar siempre el 25P02 del propio SAVEPOINT),
// el resto del request seguía corriendo sobre una transacción condenada, y
// el `commit;` a secas de `managed-postgres-engine.ts` (SIN
// AbortedTransactionCommitError -- PR #158 sigue abierto) se convertía en un
// ROLLBACK silencioso: 2xx con la escritura de negocio perdida. Corregido:
// ahora afirma que el trigger RELANZA (ver `savepointTaken` en
// `email-dispatch.ts`) para que el `catch` de `withAppSession` haga el
// ROLLBACK real y el caller reciba un 5xx honesto.
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
      // Único comando que Postgres real acepta DENTRO de una transacción
      // abortada -- pero solo si el savepoint nombrado en verdad existe.
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

describe("triggerHotelesEmailDispatchInline — SAVEPOINT (regresión auditoría a2 / fix a2b)", () => {
  it("con sesión de staff (claim_email_outbox_batch lanza 42501 DENTRO de esta misma sesión): SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza, y la sesión vuelve a servir consultas", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, resend: { ...ctx.deps.env.resend, apiKey: "re_test_key" } } };
    const repo = new InMemoryHotelesRepository();
    const session = new AbortAwareFakeSession();
    // Reproduce el mecanismo REAL: `claim_email_outbox_batch` corre sobre la
    // MISMA sesión/transacción que este trigger recibió -- su 42501 la deja
    // abortada, no es un rechazo aislado de una promesa cualquiera.
    vi.spyOn(repo, "claimEmailOutboxBatch").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });

    await expect(triggerHotelesEmailDispatchInline(deps, session, repo)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "rollback to savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
    // La prueba real de que el ROLLBACK TO SAVEPOINT funcionó: una consulta
    // POSTERIOR sobre la MISMA sesión ya no ve 25P02.
    await expect(session.query()).resolves.toEqual({ rows: [] });
  });

  it("fix corregido: si la transacción YA venía abortada ANTES de este trigger (causa AJENA), el propio SAVEPOINT lanza 25P02 y AHORA SÍ relanza -- no hay nada que un ROLLBACK TO SAVEPOINT pueda proteger, y tragarlo convertiría un 500 honesto en un 2xx con la escritura de negocio perdida", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const repo = new InMemoryHotelesRepository();
    const claimSpy = vi.spyOn(repo, "claimEmailOutboxBatch");
    const session = new AbortAwareFakeSession();
    session.aborted = true; // transacción ya rota por algo AJENO a este trigger

    await expect(triggerHotelesEmailDispatchInline(ctx.deps, session, repo)).rejects.toMatchObject({ code: "25P02" });

    // El SAVEPOINT mismo falló (25P02): nunca se llegó a llamar el claim, y
    // NO se intenta ningún ROLLBACK TO SAVEPOINT (no hay savepoint real que
    // liberar) -- la sesión queda abortada tal cual, para que el `catch` de
    // `withAppSession` (managed-postgres-engine.ts) haga el ROLLBACK real de
    // TODA la transacción y el caller reciba un 5xx en vez de un 2xx con la
    // escritura perdida.
    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch"]);
    expect(claimSpy).not.toHaveBeenCalled();
    expect(session.aborted).toBe(true);
  });

  it("éxito real (con proveedor configurado): SAVEPOINT -> claim real -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const deps = { ...ctx.deps, env: { ...ctx.deps.env, resend: { ...ctx.deps.env.resend, apiKey: "re_test_key" } } };
    const repo = new InMemoryHotelesRepository();
    const claimSpy = vi.spyOn(repo, "claimEmailOutboxBatch");
    const session = new AbortAwareFakeSession();

    await triggerHotelesEmailDispatchInline(deps, session, repo);

    // A diferencia del test anterior (parte a2b, parte A) -- aquí SÍ hay
    // `apiKey` configurada, así que el claim real corre (nunca cae en el
    // camino `notConfigured` que evita llamarlo del todo).
    expect(claimSpy).toHaveBeenCalledTimes(1);
    expect(session.execCalls).toEqual(["savepoint sp_inline_email_dispatch", "release savepoint sp_inline_email_dispatch"]);
  });
});

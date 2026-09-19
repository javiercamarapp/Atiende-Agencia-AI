// Fix hallazgo auditoría a2b (CRÍTICO, primo directo del bug de correo cerrado en
// PR #166) — regresión para `triggerRestaurantesWhatsAppDispatchInline` (mismo
// núcleo `triggerInline` que también usan `triggerCitasWhatsAppDispatchInline`/
// `triggerHotelesWhatsAppDispatchInline`, ver
// apps/api/src/routes/internal/whatsapp-dispatch.ts): `restaurantes.
// claim_messaging_outbox_batch` tiene el MISMO guard `auth.uid() is not null ->
// 42501` que `claim_email_outbox_batch`, así que llamarlo en sesión de STAFF
// (`apps/api/src/routes/verticals/restaurantes/{admin-orders,repartidor-orders}.ts`)
// siempre lanza — sin SAVEPOINT eso abortaba la transacción completa del request
// (25P02) hasta un `ROLLBACK TO SAVEPOINT`.
//
// A diferencia de `restaurantes-email-dispatch-savepoint.spec.ts` (PR #166), este
// `AbortAwareFakeSession` SÍ reproduce el estado abortado real de Postgres (hallazgo
// no bloqueante de la revisión de #166, corregido aquí desde el inicio):
//   - el mock de `claimMessagingOutboxBatch` pone `session.aborted = true` ANTES de
//     lanzar (no solo lanza un error suelto sin tocar la sesión);
//   - `exec()`/`query()` lanzan 25P02 mientras `aborted` sea `true`, salvo
//     `ROLLBACK TO SAVEPOINT` (que además exige que el savepoint exista de verdad,
//     igual que Postgres real);
//   - cada test que prueba la recuperación afirma que una `query()` POSTERIOR al
//     trigger resuelve — no solo que `execCalls` tiene la secuencia esperada.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { InMemoryRestaurantesRepository } from "@atiende/domain-restaurantes";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { triggerRestaurantesWhatsAppDispatchInline } from "../src/routes/internal/whatsapp-dispatch.ts";
import type { AppDeps } from "../src/deps.ts";
import { buildTestDeps } from "./fixtures.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_messaging_outbox_batch es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

function pg25P02(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
  return err;
}

/** Doble mínimo de `TenantDbSession` que reproduce el estado ABORTADO real de
 *  Postgres — a diferencia de un doble plano que solo lanza el error del claim sin
 *  tocar la sesión (defecto ya señalado en la revisión de PR #166, ver comentario
 *  de cabecera). */
class AbortAwareFakeSession implements TenantDbSession {
  aborted = false;
  private savepointEstablished = false;
  readonly execCalls: string[] = [];

  async query<T>(): Promise<{ rows: T[] }> {
    if (this.aborted) throw pg25P02();
    return { rows: [] as T[] };
  }

  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    this.execCalls.push(n);
    if (n.startsWith("rollback to savepoint")) {
      if (!this.savepointEstablished) throw new Error(`AbortAwareFakeSession: no existe el savepoint a revertir (${sql})`);
      this.aborted = false;
      return;
    }
    // Mismo comportamiento real de Postgres: mientras la transacción está
    // abortada, CUALQUIER comando que no sea ROLLBACK/ROLLBACK TO SAVEPOINT falla.
    if (this.aborted) throw pg25P02();
    if (n.startsWith("savepoint")) {
      this.savepointEstablished = true;
      return;
    }
    if (n.startsWith("release savepoint")) {
      this.savepointEstablished = false;
      return;
    }
    throw new Error(`AbortAwareFakeSession: exec no soportado: ${sql}`);
  }
}

async function buildDepsWithDispatcher(): Promise<{ deps: AppDeps; restaurantesRepo: InMemoryRestaurantesRepository }> {
  const { deps, restaurantesRepo } = await buildTestDeps();
  const graphClient = new FakeWhatsAppGraphClient();
  return { deps: { ...deps, whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient }) }, restaurantesRepo };
}

describe("triggerRestaurantesWhatsAppDispatchInline — SAVEPOINT (regresión auditoría a2b, primo de PR #166)", () => {
  it("con sesión de staff (claimMessagingOutboxBatch lanza 42501 y aborta la sesión): SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza, y la sesión vuelve a estar sana", async () => {
    const { deps, restaurantesRepo } = await buildDepsWithDispatcher();
    vi.spyOn(restaurantesRepo, "claimMessagingOutboxBatch").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });
    const session = new AbortAwareFakeSession();

    await expect(triggerRestaurantesWhatsAppDispatchInline(deps, session, restaurantesRepo)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_inline_whatsapp_dispatch", "rollback to savepoint sp_inline_whatsapp_dispatch", "release savepoint sp_inline_whatsapp_dispatch"]);
    expect(session.aborted).toBe(false);
    // La prueba real de que el SAVEPOINT recuperó la transacción de negocio, no
    // solo el estado interno del doble: una consulta DESPUÉS del trigger resuelve
    // (el mismo `commit;` posterior de `managed-postgres-engine.ts` ya no vería una
    // transacción abortada).
    await expect(session.query()).resolves.toEqual({ rows: [] });
  });

  it("éxito real (sin claim pendiente que reclamar): SAVEPOINT -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const { deps, restaurantesRepo } = await buildDepsWithDispatcher();
    const session = new AbortAwareFakeSession();

    await triggerRestaurantesWhatsAppDispatchInline(deps, session, restaurantesRepo);

    expect(session.execCalls).toEqual(["savepoint sp_inline_whatsapp_dispatch", "release savepoint sp_inline_whatsapp_dispatch"]);
    expect(session.aborted).toBe(false);
  });

  it("sin dispatcher configurado (falta WHATSAPP_ACCESS_TOKEN): no-op seguro, nunca toca la sesión", async () => {
    const { deps, restaurantesRepo } = await buildTestDeps(); // sin override de whatsAppDispatcher -- undefined por defecto.
    const session = new AbortAwareFakeSession();

    await triggerRestaurantesWhatsAppDispatchInline(deps, session, restaurantesRepo);

    expect(session.execCalls).toEqual([]);
  });

  it("si la sesión YA venía abortada de antes (causa ajena a este trigger): nunca convierte el best-effort en una excepción NUEVA (no-bloqueante de la revisión de PR #166 -- el SAVEPOINT va DENTRO del try)", async () => {
    const { deps, restaurantesRepo } = await buildDepsWithDispatcher();
    const session = new AbortAwareFakeSession();
    session.aborted = true; // Nadie estableció un savepoint todavía en esta transacción.

    await expect(triggerRestaurantesWhatsAppDispatchInline(deps, session, restaurantesRepo)).resolves.toBeUndefined();

    // El propio `SAVEPOINT` lanza (transacción ya abortada); el intento de
    // recuperación también falla (no hay savepoint que revertir) -- ambos se
    // tragan, nunca se relanza fuera de esta función.
    expect(session.aborted).toBe(true); // No es responsabilidad de este trigger arreglar un abort previo ajeno.
  });
});

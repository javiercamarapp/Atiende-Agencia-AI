// Fix Blocker A (revisión independiente de PR #169, auditoría a2b) — regresión para
// el SAVEPOINT de `runNotifyBestEffort` (ver src/order-notifications.ts) alrededor
// de `tryNotifyCustomerOnOrderStatusChange`/`tryNotifyStaffOrderProblem`.
//
// El bloqueante real: `changeOrderStatus`/`changeAssignedOrderStatus`
// (order-lifecycle.ts) persisten el nuevo estado del pedido ANTES de llamar a
// `tryNotify*`. En sesión de STAFF (admin-orders.ts/repartidor-orders.ts) ambas
// escrituras viven en la MISMA transacción. Contra la base real sin migrar, el
// SELECT de `resolveActiveWhatsAppPhoneNumberId` (postgres-repository.ts:631, sobre
// `restaurantes.whatsapp_channel_config`) lanza `permission denied` (42501) — sin
// GRANT `select` a `authenticated` hasta supabase/migrations/
// 20240101000140_017_restaurantes_sistema_whatsapp_channel_config.sql. Sin un
// SAVEPOINT alrededor de ese best-effort, esa excepción deja la transacción
// COMPLETA abortada (25P02): el `commit;` posterior de
// `packages/db/src/managed-postgres-engine.ts` se convierte en un ROLLBACK
// silencioso y el cambio de estado del pedido —ya "persistido" antes en la misma
// transacción— se pierde con una respuesta 2xx. `triggerInline` (whatsapp-dispatch.ts)
// ya se protegía con su propio SAVEPOINT, pero corre DESPUÉS de este best-effort, así
// que nunca llegaba a rescatar nada.
//
// Mismo `AbortAwareFakeSession` (reproduce el estado ABORTADO real de Postgres) que
// `apps/api/tests/whatsapp-inline-dispatch-savepoint.spec.ts` usa para el SAVEPOINT
// de `triggerInline` — aquí se prueba el SAVEPOINT hermano, uno más arriba en el
// mismo request.
import { describe, expect, it, vi } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { createOrder } from "../src/orders.ts";
import { changeOrderStatus } from "../src/order-lifecycle.ts";
import { tryNotifyCustomerOnOrderStatusChange } from "../src/order-notifications.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("permission denied for table whatsapp_channel_config") as Error & { code: string };
  err.code = "42501";
  return err;
}

function pg25P02(): Error & { code: string } {
  const err = new Error("current transaction is aborted, commands ignored until end of transaction block") as Error & { code: string };
  err.code = "25P02";
  return err;
}

/** Doble mínimo de `TenantDbSession` que reproduce el estado ABORTADO real de
 *  Postgres — idéntico en espíritu al de `whatsapp-inline-dispatch-savepoint.spec.ts`:
 *  el mock del SELECT pone `aborted = true` ANTES de lanzar (no solo lanza un error
 *  suelto sin tocar la sesión), y `query()`/`exec()` lanzan 25P02 mientras la sesión
 *  siga abortada, salvo `ROLLBACK TO SAVEPOINT` (que además exige que el savepoint
 *  exista de verdad). */
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

async function seedOrder(fixture: ReturnType<typeof buildRestaurantFixture>, overrides: Partial<CreateOrderInput> = {}) {
  const input: CreateOrderInput = {
    organizationId: fixture.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Deb",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
    source: "web",
    ...overrides,
  };
  return createOrder(fixture.repo, input);
}

describe("tryNotifyCustomerOnOrderStatusChange — SAVEPOINT (Blocker A, revisión de PR #169)", () => {
  it("con sesión de staff (resolveActiveWhatsAppPhoneNumberId lanza 42501 y aborta la sesión): SAVEPOINT -> ROLLBACK TO SAVEPOINT -> RELEASE, nunca relanza, y la sesión vuelve a estar sana", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "preparando");
    const session = new AbortAwareFakeSession();
    vi.spyOn(fixture.repo, "resolveActiveWhatsAppPhoneNumberId").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });

    await expect(tryNotifyCustomerOnOrderStatusChange(fixture.repo, preparando!, session)).resolves.toBeUndefined();

    expect(session.execCalls).toEqual(["savepoint sp_order_notify_best_effort", "rollback to savepoint sp_order_notify_best_effort", "release savepoint sp_order_notify_best_effort"]);
    expect(session.aborted).toBe(false);
    // La prueba real de que el SAVEPOINT recuperó la transacción de negocio (no solo
    // el estado interno del doble): una consulta DESPUÉS del best-effort resuelve —
    // el `commit;` posterior de managed-postgres-engine.ts ya no vería una
    // transacción abortada, así que el UPDATE de status de arriba (ya "persistido"
    // en la misma transacción real) sobrevive.
    await expect(session.query()).resolves.toEqual({ rows: [] });
  });

  it("éxito real (organización con WhatsApp conectado): SAVEPOINT -> RELEASE, sin ROLLBACK TO SAVEPOINT", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "preparando");
    const session = new AbortAwareFakeSession();

    await tryNotifyCustomerOnOrderStatusChange(fixture.repo, preparando!, session);

    expect(session.execCalls).toEqual(["savepoint sp_order_notify_best_effort", "release savepoint sp_order_notify_best_effort"]);
    expect(session.aborted).toBe(false);
    expect(fixture.repo.getOutbox()).toHaveLength(1);
  });

  it("sin `db` (caller de sesión de sistema, p.ej. createOrder): corre sin SAVEPOINT, igual que antes", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "preparando");
    vi.spyOn(fixture.repo, "resolveActiveWhatsAppPhoneNumberId").mockRejectedValue(pgPermissionDenied());

    await expect(tryNotifyCustomerOnOrderStatusChange(fixture.repo, preparando!)).resolves.toBeUndefined();
  });

  it("si la sesión YA venía abortada de antes (causa ajena a este best-effort): nunca convierte el best-effort en una excepción NUEVA (SAVEPOINT dentro del try, mismo criterio que triggerInline)", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "preparando");
    const session = new AbortAwareFakeSession();
    session.aborted = true; // Nadie estableció un savepoint todavía en esta transacción.

    await expect(tryNotifyCustomerOnOrderStatusChange(fixture.repo, preparando!, session)).resolves.toBeUndefined();

    // El propio SAVEPOINT lanza (transacción ya abortada); el intento de
    // recuperación también falla (no hay savepoint que revertir) -- ambos se
    // tragan, nunca se relanza fuera de este best-effort.
    expect(session.aborted).toBe(true); // No es responsabilidad de este best-effort arreglar un abort previo ajeno.
  });
});

describe("changeOrderStatus + tryNotifyCustomerOnOrderStatusChange — flujo completo de staff (Blocker A, revisión de PR #169)", () => {
  it("el UPDATE de status ya se considera persistido pese a que el best-effort de notificación falle -- el SAVEPOINT deja la sesión sana para el `commit;` real que sigue", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const session = new AbortAwareFakeSession();
    vi.spyOn(fixture.repo, "resolveActiveWhatsAppPhoneNumberId").mockImplementation(async () => {
      session.aborted = true;
      throw pgPermissionDenied();
    });

    const updated = await changeOrderStatus(fixture.repo, fixture.organizationId, order, "preparando", session);

    expect(updated.status).toBe("preparando");
    // Reproduce exactamente el mecanismo real: SAVEPOINT/ROLLBACK TO SAVEPOINT del
    // best-effort de notificación, y la sesión queda sana para que el `commit;` de
    // `managed-postgres-engine.ts` confirme el UPDATE de arriba en vez de convertirse
    // en un ROLLBACK silencioso.
    expect(session.execCalls).toEqual(["savepoint sp_order_notify_best_effort", "rollback to savepoint sp_order_notify_best_effort", "release savepoint sp_order_notify_best_effort"]);
    expect(session.aborted).toBe(false);
    await expect(session.query()).resolves.toEqual({ rows: [] });
  });
});

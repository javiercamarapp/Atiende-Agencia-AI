// Blocker B (revisión independiente de PR #169, auditoría a2b) — regresión para el
// drenado POST-COMMIT en sesión de SISTEMA desde los 2 call sites de staff
// (admin-orders.ts/repartidor-orders.ts), mismo patrón que
// `apps/api/src/routes/verticals/hoteles/folios.ts::runHotelesEmailDispatch` (PR
// #166).
//
// El intento INLINE (`triggerRestaurantesWhatsAppDispatchInline`, mismo `db`/
// transacción que la ruta) corre en sesión de STAFF: `claim_messaging_outbox_batch`
// SIEMPRE lanza 42501 ahí (guard cross-tenant real, correcto y necesario) — así que
// ese intento es un no-op garantizado. Antes de este fix, el ÚNICO disparador que sí
// lograba enviar el WhatsApp real era el cron diario (hasta ~24h después). Este test
// prueba que la tarea `postCommitTasks` (sesión de SISTEMA, `dispatchWhatsAppVertical`)
// SÍ logra despachar el mensaje justo después de que el request confirma, sin esperar
// al cron -- reproduciendo el guard real con un spy que falla la PRIMERA llamada
// (el intento inline, en sesión de staff) y deja pasar la SEGUNDA (el post-commit, en
// sesión de sistema).
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeWhatsAppGraphClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("claim_messaging_outbox_batch es solo para la sesión de sistema") as Error & { code: string };
  err.code = "42501";
  return err;
}

describe("PATCH .../admin/orders/:orderId/status — drenado real vía postCommitTasks (Blocker B, revisión de PR #169)", () => {
  it("el intento inline en sesión de staff falla (42501, guard real) pero postCommitTasks SÍ despacha el WhatsApp al cliente sin esperar el cron diario", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const graphClient = new FakeWhatsAppGraphClient();
    const deps = { ...ctx.deps, whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient }) };
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PHONE_NUMBER_ID_TEST");
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", customerPhone: "9990001111" });
    ctx.restaurantesRepo.seedOrder(order);

    const claimSpy = vi.spyOn(ctx.restaurantesRepo, "claimMessagingOutboxBatch");
    claimSpy.mockImplementationOnce(async () => {
      // Reproduce el guard real de `claim_messaging_outbox_batch` en sesión de
      // STAFF (la PRIMERA llamada real de este request es el intento inline,
      // mismo `db`/transacción que la ruta) -- SIEMPRE lanza, haya o no mensajes
      // pendientes.
      throw pgPermissionDenied();
    });
    // Las llamadas SIGUIENTES (la de `postCommitTasks`, sesión de SISTEMA) usan la
    // implementación real del doble en memoria -- sin el guard, porque en
    // Postgres real esa sesión SÍ pasa `auth.uid() is null`.

    const app = buildApp(deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`,
      authedJson(ctx.staff.owner.token, { status: "preparando" }, "PATCH"),
    );

    expect(res.status).toBe(200);
    expect(claimSpy).toHaveBeenCalledTimes(2); // 1: intento inline (falla) -- 2: postCommitTasks (sesión de sistema, real).
    // La prueba real de que el drenado post-commit funcionó: el WhatsApp
    // realmente salió por el Graph API (fake), sin esperar el cron diario.
    expect(graphClient.sent).toHaveLength(1);
    expect(graphClient.sent[0]).toMatchObject({ to: "9990001111", phoneNumberId: "PHONE_NUMBER_ID_TEST" });
  });

  it("mismo drenado post-commit desde repartidor-orders.ts (changeAssignedOrderStatus)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const graphClient = new FakeWhatsAppGraphClient();
    const deps = { ...ctx.deps, whatsAppDispatcher: new WhatsAppOutboundDispatcher({ graphClient }) };
    ctx.restaurantesRepo.seedWhatsAppChannel(ctx.organizationId, "PHONE_NUMBER_ID_TEST");
    const order = makeOrder({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyIdA,
      status: "preparando",
      customerPhone: "9990002222",
      assignedRepartidorId: ctx.staff.repartidor.id,
    });
    ctx.restaurantesRepo.seedOrder(order);

    const claimSpy = vi.spyOn(ctx.restaurantesRepo, "claimMessagingOutboxBatch");
    claimSpy.mockImplementationOnce(async () => {
      throw pgPermissionDenied();
    });

    const app = buildApp(deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`,
      authedJson(ctx.staff.repartidor.token, { status: "en_camino" }, "PATCH"),
    );

    expect(res.status).toBe(200);
    expect(claimSpy).toHaveBeenCalledTimes(2);
    expect(graphClient.sent).toHaveLength(1);
    expect(graphClient.sent[0]).toMatchObject({ to: "9990002222", phoneNumberId: "PHONE_NUMBER_ID_TEST" });
  });
});

// Auditoría a3 (hallazgos confirmados #2 y #4) — regresión para el SAVEPOINT que
// faltaba alrededor de las TRES variantes best-effort de `order-notifications.ts`
// que `orders.ts::createOrder`/`admin-orders.ts::assign-repartidor` de verdad llaman:
// `tryNotifyStaffNewOrder`, `tryNotifyStaffRepartidorAssigned` y
// `tryNotifyCustomerOrderConfirmationEmail`. A diferencia de
// `order-notifications-savepoint.spec.ts` (que ya cubre las dos variantes
// convertidas en PR #169 vía `runNotifyBestEffort`+`db` explícito), estas tres NO
// reciben ningún `TenantDbSession` -- dependían por completo de que el propio `repo`
// aislara el intento, y no lo hacían: un `try/catch` plano alrededor del `*Core`
// deja la transacción real ABORTADA (25P02) si la consulta de encolado falla.
//
// Se prueba contra `PostgresRestaurantesRepository` real (no el doble en memoria,
// cuyo `runWithRowSavepoint` es un no-op que no reproduce el estado abortado de
// Postgres) + `AbortAwareFakeSession` (packages/domain-restaurantes/tests/support,
// mismo doble que `postgres-repository-create-order-savepoint.spec.ts`): pone
// `aborted=true` y lanza justo cuando la consulta de encolado real correría,
// exactamente como Postgres real. Cada test de este archivo FALLA contra el código
// anterior (try/catch sin `repo.runWithRowSavepoint`): sin el SAVEPOINT, la consulta
// de negocio posterior (aquí, una consulta cualquiera sobre la MISMA sesión) lanza
// 25P02 en vez de resolver.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { tryNotifyCustomerOrderConfirmationEmail, tryNotifyStaffNewOrder, tryNotifyStaffRepartidorAssigned } from "../src/order-notifications.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { Order } from "../src/types.ts";

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("permission denied for function enqueue_staff_order_notification") as Error & { code: string };
  err.code = "42501";
  return err;
}

const BASE_ORDER: Order = {
  id: "00000000-0000-0000-0000-0000000000f1",
  organizationId: "00000000-0000-0000-0000-0000000000o1",
  propertyId: "00000000-0000-0000-0000-0000000000p1",
  customerId: null,
  customerName: "Deb",
  customerPhone: "+529990001111",
  customerAddress: null,
  customerEmail: "deb@example.com",
  branch: "Fco. Montejo",
  total: 164,
  status: "pending",
  items: [{ id: "prod-1", name: "Tacos de Bistec", price: 164, quantity: 1 }],
  source: "web",
  notes: null,
  paymentMethod: null,
  callTranscript: null,
  callRecordingUrl: null,
  dedupeFingerprint: null,
  idempotencyKey: null,
  createdAt: new Date().toISOString(),
  assignedRepartidorId: null,
  estimatedDeliveryAt: null,
  incidentNote: null,
};

describe("tryNotifyStaffNewOrder — SAVEPOINT (auditoría a3, hallazgo confirmado #2)", () => {
  it("un 42501 real de enqueue_staff_order_notification NUNCA deja la sesión abortada -- el pedido ya insertado sobrevive", async () => {
    const session = new AbortAwareFakeSession([
      { match: /enqueue_staff_order_notification/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    // No lanza -- best-effort real.
    await expect(tryNotifyStaffNewOrder(repo, BASE_ORDER)).resolves.toBeUndefined();

    // La prueba real: el SAVEPOINT interno recuperó la transacción -- una consulta
    // POSTERIOR sobre la MISMA sesión (aquí, la que haría el `commit;` real de
    // managed-postgres-engine.ts) resuelve en vez de lanzar 25P02
    // (AbortedTransactionCommitError). Contra el código anterior (sin
    // `repo.runWithRowSavepoint`) esta aserción falla: la sesión queda abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("éxito real: encola la notificación sin dejar rastro de SAVEPOINT sin liberar", async () => {
    const session = new AbortAwareFakeSession([{ match: /enqueue_staff_order_notification/, respond: () => [{ id: "n1", created_at: new Date().toISOString(), acknowledged_at: null, acknowledged_by: null }] }]);
    const repo = new PostgresRestaurantesRepository(session);

    await tryNotifyStaffNewOrder(repo, BASE_ORDER);

    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });
});

describe("tryNotifyStaffRepartidorAssigned — SAVEPOINT (auditoría a3, hallazgo confirmado #2)", () => {
  it("un 42501 real de enqueue_staff_order_notification NUNCA deja la sesión abortada -- el dispatch del repartidor ya persistido sobrevive", async () => {
    const session = new AbortAwareFakeSession([
      { match: /enqueue_staff_order_notification/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    const assigned: Order = { ...BASE_ORDER, assignedRepartidorId: "00000000-0000-0000-0000-0000000000r1" };

    await expect(tryNotifyStaffRepartidorAssigned(repo, assigned)).resolves.toBeUndefined();

    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });
});

describe("tryNotifyCustomerOrderConfirmationEmail — SAVEPOINT (auditoría a3, hallazgo confirmado #2)", () => {
  it("un 42501 real de enqueue_messaging_outbox NUNCA deja la sesión abortada -- el pedido ya insertado sobrevive", async () => {
    const session = new AbortAwareFakeSession([
      { match: /enqueue_messaging_outbox/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    await expect(tryNotifyCustomerOrderConfirmationEmail(repo, BASE_ORDER)).resolves.toBeUndefined();

    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("sin correo en archivo: nunca llama a enqueue_messaging_outbox, nunca abre SAVEPOINT innecesario", async () => {
    const session = new AbortAwareFakeSession([
      { match: /enqueue_messaging_outbox/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    const sinCorreo: Order = { ...BASE_ORDER, customerEmail: null };

    await expect(tryNotifyCustomerOrderConfirmationEmail(repo, sinCorreo)).resolves.toBeUndefined();

    // El SAVEPOINT sí se abre (envuelve el core completo), pero como el core
    // retorna temprano (`no_email`), nunca llega a la consulta que fallaría.
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });
});

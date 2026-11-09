// Aviso «va en camino» contra la base SIN la migracion 107 (o con ella), con el repositorio Postgres sobre una sesion que reproduce el estado
// ABORTADO real de Postgres: el cambio de estado del pedido y el aviso comparten UNA transaccion (sesion de staff o de chofer), asi que un 42883
// de la funcion nueva sin SAVEPOINT dejaria la transaccion abortada y el aviso anterior (y el propio cambio de estado) se perderian.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { createOrder } from "../src/orders.ts";
import { notifyCustomerOnOrderStatusChangeCore } from "../src/order-notifications.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function pgUndefinedFunction(): Error & { code: string } {
  const err = new Error("function restaurantes.aviso_en_camino_contexto(uuid, uuid) does not exist") as Error & { code: string };
  err.code = "42883";
  return err;
}

async function pedidoEnCamino() {
  const fx = buildRestaurantFixture();
  const order = await createOrder(fx.repo, {
    organizationId: fx.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Ana",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30",
    items: [{ productId: fx.products.cocaCola, requestedQuantity: 1 }],
    source: "web",
  });
  return { ...order, source: "voice" as const, status: "en_camino" as const, orderNumber: 77 };
}

function sesion(extra: readonly FakeSessionHandler[], encolados: unknown[][]): AbortAwareFakeSession {
  return new AbortAwareFakeSession([
    ...extra,
    { match: /whatsapp_branch_channel/, respond: () => [] },
    { match: /from restaurantes\.whatsapp_channel_config/, respond: () => [{ phone_number_id: "PNID_1" }] },
    { match: /from restaurantes\.branch_policy/, respond: () => [] },
    { match: /listorderpickupinfo|restaurantes\.orders o|canal/i, respond: () => [] },
    { match: /whatsapp_agent_config/, respond: () => [] },
    {
      match: /restaurantes\.enqueue_messaging_outbox/,
      respond: () => {
        encolados.push([]);
        return [];
      },
    },
  ]);
}

describe("aviso en camino: repositorio Postgres con SAVEPOINT", () => {
  it("base sin la 107: la lectura cae a `disponible: false` con ROLLBACK TO SAVEPOINT y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /aviso_en_camino_contexto/, respond: () => pgUndefinedFunction() }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    const repo = new PostgresRestaurantesRepository(s);
    expect(await repo.leerContextoAvisoEnCamino("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002")).toEqual({ disponible: false });
    expect(s.calls).toContain("rollback to savepoint sp_restaurantes_aviso_en_camino_contexto");
    await expect(s.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("base sin la 107: la marca no hace nada y no deja la transaccion abortada", async () => {
    const s = new AbortAwareFakeSession([{ match: /aviso_en_camino_marcar/, respond: () => pgUndefinedFunction() }, { match: /select 1/, respond: () => [{ ok: 1 }] }]);
    await expect(new PostgresRestaurantesRepository(s).marcarAvisoEnCamino("00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002", "texto")).resolves.toBeUndefined();
    await expect(s.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("con la 107: traduce el jsonb de la base (valores desconocidos caen al lado seguro)", async () => {
    const s = new AbortAwareFakeSession([
      {
        match: /aviso_en_camino_contexto/,
        respond: () => [{ c: { activo: true, ventana_abierta: false, consentimiento: "x", requiere_consentimiento: true, aviso_whatsapp: null, plantilla: { nombre: "pedido_en_camino", idioma: "es_MX", variables: ["sucursal", 3, "folio"] }, ya_avisado: false } }],
      },
    ]);
    expect(await new PostgresRestaurantesRepository(s).leerContextoAvisoEnCamino("o", "p")).toEqual({
      disponible: true,
      contexto: { activo: true, ventanaAbierta: false, consentimiento: "sin_registro", requiereConsentimiento: true, avisoWhatsapp: null, plantilla: { nombre: "pedido_en_camino", idioma: "es_MX", variables: ["sucursal", "folio"] }, yaAvisado: false },
    });
  });

  it("de punta a punta contra la base sin la 107: se encola el aviso anterior (el gateway decide con la lista global)", async () => {
    const order = await pedidoEnCamino();
    const encolados: unknown[][] = [];
    const s = sesion([{ match: /aviso_en_camino_contexto/, respond: () => pgUndefinedFunction() }], encolados);
    const r = await notifyCustomerOnOrderStatusChangeCore(new PostgresRestaurantesRepository(s), order);
    expect(r).toEqual({ enqueued: true });
    expect(encolados).toHaveLength(1);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint sp_restaurantes_aviso_en_camino_contexto"))).toBe(true);
  });

  it("con la 107 y sin plantilla: no encola, marca el pedido y emite la notificacion al dueno", async () => {
    const order = await pedidoEnCamino();
    const encolados: unknown[][] = [];
    const s = sesion(
      [
        { match: /aviso_en_camino_contexto/, respond: () => [{ c: { activo: true, ventana_abierta: false, consentimiento: "sin_registro", requiere_consentimiento: false, aviso_whatsapp: null, plantilla: null, ya_avisado: false } }] },
        { match: /aviso_en_camino_marcar/, respond: () => [{ aviso_en_camino_marcar: true }] },
        { match: /core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
      ],
      encolados,
    );
    const r = await notifyCustomerOnOrderStatusChangeCore(new PostgresRestaurantesRepository(s), order);
    expect(r).toEqual({ enqueued: false, reason: "falta_plantilla" });
    expect(encolados).toHaveLength(0);
    expect(s.calls.some((c) => c.includes("aviso_en_camino_marcar"))).toBe(true);
    expect(s.calls.some((c) => c.includes("core.emit_notification"))).toBe(true);
  });
});

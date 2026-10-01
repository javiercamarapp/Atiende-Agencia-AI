// REGLA DURA de compatibilidad con la base SIN migrar (migracion 028: recoger, promociones automaticas,
// cortesia y puentes). Mergear despliega el codigo y la base va atras: todo lo nuevo que el repositorio
// lee/escribe corre DENTRO de la transaccion unica de un request. `AbortAwareFakeSession` reproduce el
// estado abortado (25P02) de Postgres: cada caso verifica (1) el camino anterior / vacio honesto y (2) que
// la MISMA sesion sigue utilizable despues (la siguiente query del request resuelve).
import { describe, expect, it } from "vitest";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const PROPERTY_ID = "00000000-0000-4000-8000-0000000000a1";
const ORG_ID = "00000000-0000-4000-8000-0000000000b1";
const ORDER_ID = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinTabla = (tabla: string) => pgError("42P01", `relation "restaurantes.${tabla}" does not exist`);
const sinColumna = (columna: string) => pgError("42703", `column "${columna}" does not exist`);

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const PROMO_BASE = {
  id: "00000000-0000-4000-8000-0000000000d1",
  organization_id: ORG_ID,
  code: "LUNES2X1",
  name: "Lunes 2x1",
  description: null,
  type: "bogo",
  value: "1",
  min_order_total: null,
  starts_at: null,
  ends_at: null,
  days_of_week: [1],
  start_time: null,
  end_time: null,
  max_uses: null,
  times_used: 0,
  is_active: true,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

describe("promociones automaticas (promotions.auto_apply)", () => {
  it("base SIN migrar: listAutoApplyPromotions devuelve [] (vacio honesto) y la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([{ match: /auto_apply/i, respond: () => sinColumna("auto_apply") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listAutoApplyPromotions(ORG_ID)).toEqual([]);
    await sesionSigueViva(session);
  });

  it("base migrada: lee autoApply y la cortesia", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /from restaurantes\.promotions where organization_id = \$1 and auto_apply/i,
        respond: () => [{ ...PROMO_BASE, channels: ["recoger"], product_ids: ["p1"], auto_apply: true, courtesy_product_ids: ["a1", "a2"], courtesy_quantity: 2 }],
      },
    ]);
    const [p] = await new PostgresRestaurantesRepository(session).listAutoApplyPromotions(ORG_ID);
    expect(p).toMatchObject({ code: "LUNES2X1", autoApply: true, channels: ["recoger"], courtesyProductIds: ["a1", "a2"], courtesyQuantity: 2 });
  });

  it("lectura por codigo con TRES escalones: sin 028 cae a 027; sin 027 cae a las columnas base (todo en la misma sesion)", async () => {
    const sin028 = new AbortAwareFakeSession([
      { match: /auto_apply/i, respond: () => sinColumna("auto_apply") },
      { match: /channels, product_ids/i, respond: () => [{ ...PROMO_BASE, channels: ["recoger"], product_ids: null }] },
      SIGUIENTE,
    ]);
    expect(await new PostgresRestaurantesRepository(sin028).findPromotionByCode(ORG_ID, "LUNES2X1")).toMatchObject({ channels: ["recoger"], autoApply: false, courtesyProductIds: null });
    await sesionSigueViva(sin028);

    const sin027 = new AbortAwareFakeSession([
      { match: /auto_apply/i, respond: () => sinColumna("auto_apply") },
      { match: /channels, product_ids/i, respond: () => sinColumna("channels") },
      { match: /from restaurantes\.promotions where/i, respond: () => [PROMO_BASE] },
      SIGUIENTE,
    ]);
    expect(await new PostgresRestaurantesRepository(sin027).findPromotionByCode(ORG_ID, "LUNES2X1")).toMatchObject({ code: "LUNES2X1", autoApply: false, channels: null });
    await sesionSigueViva(sin027);
  });

  it("base SIN migrar: crear o editar una promocion automatica/cortesia lanza Unavailable (503), nunca una fila a medias", async () => {
    const alta = new AbortAwareFakeSession([{ match: /insert into restaurantes\.promotions/i, respond: () => sinColumna("auto_apply") }, SIGUIENTE]);
    await expect(
      new PostgresRestaurantesRepository(alta).createPromotion(ORG_ID, { code: "MARTES", name: "Martes", type: "cortesia", value: 1, autoApply: true, channels: ["recoger"], productIds: ["p"], courtesyProductIds: ["a"], courtesyQuantity: 2 }),
    ).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(alta);

    const cambio = new AbortAwareFakeSession([{ match: /update restaurantes\.promotions/i, respond: () => sinColumna("auto_apply") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(cambio).updatePromotion(ORG_ID, PROMO_BASE.id, { autoApply: true })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(cambio);
  });
});

describe("puentes (branch_hours_exception)", () => {
  it("base SIN migrar: la lectura devuelve [] y la escritura lanza Unavailable; la sesion sigue viva", async () => {
    const lectura = new AbortAwareFakeSession([{ match: /branch_hours_exception/i, respond: () => sinTabla("branch_hours_exception") }, SIGUIENTE]);
    const repo = new PostgresRestaurantesRepository(lectura);
    expect(await repo.listBranchHoursExceptions(PROPERTY_ID, "2026-09-29", "2026-09-30")).toEqual([]);
    await sesionSigueViva(lectura);

    const proximas = new AbortAwareFakeSession([{ match: /branch_hours_exception/i, respond: () => sinTabla("branch_hours_exception") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(proximas).listUpcomingBranchHoursExceptions(ORG_ID, "2026-09-29")).toEqual([]);
    await sesionSigueViva(proximas);

    const alta = new AbortAwareFakeSession([{ match: /insert into restaurantes\.branch_hours_exception/i, respond: () => sinTabla("branch_hours_exception") }, SIGUIENTE]);
    await expect(
      new PostgresRestaurantesRepository(alta).createBranchHoursException(ORG_ID, { propertyId: PROPERTY_ID, fechaDesde: "2026-10-01", fechaHasta: "2026-10-02", horario: [{ dias: [4], abre: "12:00", cierra: "16:00" }] }),
    ).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(alta);

    const baja = new AbortAwareFakeSession([{ match: /delete from restaurantes\.branch_hours_exception/i, respond: () => sinTabla("branch_hours_exception") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(baja).deleteBranchHoursException(ORG_ID, ORDER_ID)).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(baja);
  });

  it("base migrada: mapea fechas y horario; un horario ilegible se trata como sin turnos (nunca bloquea)", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /from restaurantes\.branch_hours_exception/i,
        respond: () => [
          { id: "e1", property_id: PROPERTY_ID, fecha_desde: "2026-10-01", fecha_hasta: "2026-10-02", horario: [{ dias: [4], abre: "12:00", cierra: "16:00" }], motivo: "Puente" },
          { id: "e2", property_id: PROPERTY_ID, fecha_desde: "2026-10-05", fecha_hasta: "2026-10-05", horario: "no-es-un-arreglo", motivo: null },
        ],
      },
    ]);
    const out = await new PostgresRestaurantesRepository(session).listBranchHoursExceptions(PROPERTY_ID, "2026-10-01", "2026-10-05");
    expect(out[0]).toMatchObject({ fechaDesde: "2026-10-01", fechaHasta: "2026-10-02", motivo: "Puente", horario: [{ dias: [4], abre: "12:00", cierra: "16:00" }] });
    expect(out[1]!.horario).toEqual([]);
  });
});

describe("estados de recoger (orders.status check de la migracion 028)", () => {
  const ORDER_ROW = {
    id: ORDER_ID, organization_id: ORG_ID, property_id: PROPERTY_ID, customer_id: null, customer_name: "Ana", customer_phone: "+5219990001111", customer_address: null, customer_email: null,
    branch: "Suc", total: "100", status: "listo_para_recoger", items: [], source: "whatsapp", notes: null, payment_method: "efectivo", call_transcript: null, call_recording_url: null,
    dedupe_fingerprint: null, idempotency_key: null, created_at: "2026-09-30T00:00:00Z", assigned_repartidor_id: null, estimated_delivery_at: null, incident_note: null,
  };

  it("base SIN migrar: marcar listo_para_recoger (23514) lanza Unavailable con SAVEPOINT; la sesion sigue viva", async () => {
    const session = new AbortAwareFakeSession([
      { match: /update restaurantes\.orders/i, respond: () => pgError("23514", 'new row for relation "orders" violates check constraint "orders_status_check"') },
      SIGUIENTE,
    ]);
    await expect(new PostgresRestaurantesRepository(session).updateOrderStatus(ORG_ID, ORDER_ID, "preparando", "listo_para_recoger")).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("lo mismo para no_recogido", async () => {
    const session = new AbortAwareFakeSession([{ match: /update restaurantes\.orders/i, respond: () => pgError("23514", "check") }, SIGUIENTE]);
    await expect(new PostgresRestaurantesRepository(session).updateOrderStatus(ORG_ID, ORDER_ID, "listo_para_recoger", "no_recogido")).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await sesionSigueViva(session);
  });

  it("un estado de siempre NO captura 23514: el error real se propaga (no se disfraza de 'migracion pendiente')", async () => {
    const session = new AbortAwareFakeSession([{ match: /update restaurantes\.orders/i, respond: () => pgError("23514", "check real") }]);
    await expect(new PostgresRestaurantesRepository(session).updateOrderStatus(ORG_ID, ORDER_ID, "pending", "preparando")).rejects.toMatchObject({ code: "23514" });
  });

  it("base migrada: el UPDATE devuelve el pedido con el estado nuevo", async () => {
    const session = new AbortAwareFakeSession([{ match: /update restaurantes\.orders/i, respond: () => [ORDER_ROW] }]);
    expect(await new PostgresRestaurantesRepository(session).updateOrderStatus(ORG_ID, ORDER_ID, "preparando", "listo_para_recoger")).toMatchObject({ status: "listo_para_recoger", id: ORDER_ID });
  });

  it("listOrderPickupInfo: base SIN migrar devuelve [] y la sesion sigue viva; migrada mapea canal/propina/hora", async () => {
    const sin = new AbortAwareFakeSession([{ match: /from restaurantes\.orders/i, respond: () => sinColumna("canal") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(sin).listOrderPickupInfo(ORG_ID, [ORDER_ID])).toEqual([]);
    await sesionSigueViva(sin);
    const con = new AbortAwareFakeSession([{ match: /from restaurantes\.orders/i, respond: () => [{ id: ORDER_ID, canal: "recoger", propina: "15.00", hora_recogida: "2026-09-30T20:00:00-06:00" }] }]);
    expect(await new PostgresRestaurantesRepository(con).listOrderPickupInfo(ORG_ID, [ORDER_ID])).toEqual([{ orderId: ORDER_ID, canal: "recoger", propina: 15, horaRecogida: "2026-09-30T20:00:00-06:00" }]);
  });
});

describe("create_order_idempotent con las llaves nuevas", () => {
  it("manda canal, propina y hora_recogida en el jsonb (el function viejo las ignora; el nuevo las persiste)", async () => {
    const capturados: unknown[][] = [];
    const session: TenantDbSession = {
      async query<T>(sql: string, params?: unknown[]) {
        if (/create_order_idempotent/.test(sql)) capturados.push(params ?? []);
        return {
          rows: [
            {
              create_order_idempotent: {
                id: ORDER_ID, organization_id: ORG_ID, property_id: PROPERTY_ID, customer_id: null, customer_name: "Ana", customer_phone: "+5219990001111", customer_address: null, customer_email: null,
                branch: "Suc", total: "100", status: "pending", items: [], source: "whatsapp", notes: null, payment_method: "tarjeta", call_transcript: null, call_recording_url: null,
                dedupe_fingerprint: null, idempotency_key: null, created_at: "2026-09-30T00:00:00Z", assigned_repartidor_id: null, estimated_delivery_at: null, incident_note: null,
                canal: "recoger", propina: "15.00", hora_recogida: "2026-09-30T20:00:00-06:00",
              },
            },
          ] as T[],
        };
      },
      async exec() {},
    } as unknown as TenantDbSession;
    const order = await new PostgresRestaurantesRepository(session).createOrderIdempotent(
      { organizationId: ORG_ID, propertyId: PROPERTY_ID, customerId: null, customerName: "Ana", customerPhone: "+5219990001111", customerAddress: null, customerEmail: null, branch: "Suc", total: 100, items: [], source: "whatsapp", notes: null, paymentMethod: "tarjeta", callTranscript: null, callRecordingUrl: null, canal: "recoger", propina: 15, horaRecogida: "2026-09-30T20:00:00-06:00" },
      "a".repeat(64),
      null,
    );
    const json = JSON.parse(String(capturados[0]![0])) as Record<string, unknown>;
    expect(json).toMatchObject({ canal: "recoger", propina: 15, hora_recogida: "2026-09-30T20:00:00-06:00" });
    expect(order).toMatchObject({ canal: "recoger", propina: 15, horaRecogida: "2026-09-30T20:00:00-06:00" });
  });
});

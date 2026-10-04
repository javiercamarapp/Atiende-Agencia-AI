// Compatibilidad con la base SIN la migracion 042 (QA R1 automatizacion). Todo corre dentro de la transaccion unica del
// barrido; `AbortAwareFakeSession` reproduce el estado abortado (25P02): vacio honesto Y sesion todavia utilizable.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { PostgresPrivacidadRepository } from "../src/privacidad/postgres-repository.ts";
import { InMemoryRestaurantesRepository } from "../src/in-memory-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("pos_comanda_promovidos_sin_comanda contra la base sin la 042", () => {
  it("funcion inexistente (42883) -> [] y la MISMA sesion sigue viva (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([{ match: /pos_comanda_promovidos_sin_comanda/, respond: () => pgError("42883", "function does not exist") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listPromotedOrdersWithoutComanda({ hours: 24, limit: 100 })).toEqual([]);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("tabla del outbox inexistente (42P01) -> []", async () => {
    const session = new AbortAwareFakeSession([{ match: /pos_comanda_promovidos_sin_comanda/, respond: () => pgError("42P01", "relation does not exist") }, SIGUIENTE]);
    expect(await new PostgresRestaurantesRepository(session).listPromotedOrdersWithoutComanda({ hours: 24, limit: 100 })).toEqual([]);
  });

  it("en memoria: devuelve los promovidos recientes en estado vivo y excluye programado/cancelado/viejos", async () => {
    const repo = new InMemoryRestaurantesRepository();
    const base = { organizationId: "o", propertyId: "p", customerName: "x", customerPhone: "1", total: 1, items: [], source: "web", createdAt: new Date().toISOString() } as never;
    const mk = (id: string, status: string, horasAtras: number | null) => ({ ...(base as object), id, status, programadoPara: new Date().toISOString(), promovidoAt: horasAtras === null ? null : new Date(Date.now() - horasAtras * 3_600_000).toISOString() }) as never;
    for (const o of [mk("reciente", "pending", 1), mk("preparando", "preparando", 2), mk("cancelado", "cancelado", 1), mk("programado", "programado", null), mk("viejo", "pending", 48)]) (repo as unknown as { seedOrder(o: unknown): void }).seedOrder(o);
    const r = await repo.listPromotedOrdersWithoutComanda({ hours: 24, limit: 100 });
    expect(r.map((o) => o.id)).toEqual(["preparando", "reciente"]);
  });
});

describe("purga por retencion: lectura compatible con la funcion de 3 columnas (030 sin 042)", () => {
  it("las columnas nuevas ausentes salen como 0, no como NaN ni como error", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_purge_expired_privacy_data/, respond: () => [{ out_conversations_cleared: 2, out_voice_turns_deleted: 5, out_voice_calls_anonymized: 1 }] },
    ]);
    const r = await new PostgresPrivacidadRepository(session).purgeExpiredPrivacyData(500);
    expect(r).toMatchObject({ disponible: true, conversationsCleared: 2, voiceTurnsDeleted: 5, voiceCallsAnonymized: 1, ordersVoiceCleared: 0, outboxPayloadsErased: 0, staffNotificationsErased: 0 });
  });

  it("con la 042: las tres columnas nuevas se leen", async () => {
    const session = new AbortAwareFakeSession([
      { match: /system_purge_expired_privacy_data/, respond: () => [{ out_conversations_cleared: 0, out_voice_turns_deleted: 0, out_voice_calls_anonymized: 3, out_orders_voice_cleared: 4, out_outbox_payloads_erased: 5, out_staff_notifications_erased: 6 }] },
    ]);
    const r = await new PostgresPrivacidadRepository(session).purgeExpiredPrivacyData(500);
    expect(r).toMatchObject({ voiceCallsAnonymized: 3, ordersVoiceCleared: 4, outboxPayloadsErased: 5, staffNotificationsErased: 6 });
  });
});

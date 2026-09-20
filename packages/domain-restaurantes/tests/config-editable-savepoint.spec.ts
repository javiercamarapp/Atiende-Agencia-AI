// FASE 3 (producto) — regresión de `PostgresRestaurantesRepository.
// upsertWhatsappChannelConfig`/`createKnownZone`/`deleteKnownZone` (ver
// migrations/021_restaurantes_config_editable_y_search_path_fix.sql). A
// diferencia de `restaurantes.audit_log` (tabla NUEVA, SQLSTATE 42883/42P01/
// 42703), `whatsapp_channel_config`/`known_zone` YA EXISTÍAN desde Fase 1/2:
// si la migración 021 todavía no se aplicó a la base real, el INSERT/UPDATE/
// DELETE nuevo falla por RLS/GRANT ausente (SQLSTATE 42501,
// "insufficient_privilege") -- nunca por "objeto inexistente". Mismo
// mecanismo de SAVEPOINT que el resto de este paquete (`AbortAwareFakeSession`
// -- doble que SÍ reproduce 25P02/estado abortado, nunca uno plano).
import { describe, expect, it } from "vitest";
import { RestaurantesConfigUnavailableError } from "../src/repository.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG_ID = "org-1";

function permissionDeniedError(objeto: string): Error & { code: string } {
  const err = new Error(`permission denied for table ${objeto}`) as Error & { code: string };
  err.code = "42501";
  return err;
}

describe("PostgresRestaurantesRepository.upsertWhatsappChannelConfig — fallback SQLSTATE 42501 (base real sin migrar)", () => {
  it("GRANT/policy todavía no aplicados -> RestaurantesConfigUnavailableError (nunca un 500), transacción recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into restaurantes\.whatsapp_channel_config/, respond: () => permissionDeniedError("whatsapp_channel_config") },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    await expect(repo.upsertWhatsappChannelConfig(ORG_ID, "15550001111")).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);

    expect(session.calls).toContain("savepoint sp_restaurantes_whatsapp_config_write");
    expect(session.calls).toContain("rollback to savepoint sp_restaurantes_whatsapp_config_write");
    expect(session.calls).toContain("release savepoint sp_restaurantes_whatsapp_config_write");

    // La transacción quedó recuperada -- el resto del request no ve 25P02.
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("sin el SAVEPOINT, la misma secuencia SÍ deriva en 25P02 (prueba de que el bug sería real)", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into restaurantes\.whatsapp_channel_config/, respond: () => permissionDeniedError("whatsapp_channel_config") }]);
    await expect(
      (async () => {
        try {
          await session.query("insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ($1, $2);", []);
        } catch {
          // el código sin SAVEPOINT no hacía nada aquí -- solo dejaba la sesión abortada.
        }
        return session.query("select 1 as siguiente_query_del_request;");
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });

  it("camino feliz: GRANT/policy ya aplicados -> upsert real, nunca fallback", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into restaurantes\.whatsapp_channel_config/, respond: () => [{ phone_number_id: "15550001111" }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.upsertWhatsappChannelConfig(ORG_ID, "15550001111")).resolves.toEqual({ phoneNumberId: "15550001111" });
  });
});

describe("PostgresRestaurantesRepository.createKnownZone/deleteKnownZone — fallback SQLSTATE 42501", () => {
  it("createKnownZone: GRANT todavía no aplicado -> RestaurantesConfigUnavailableError, transacción recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into restaurantes\.known_zone/, respond: () => permissionDeniedError("known_zone") },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    await expect(repo.createKnownZone(ORG_ID, { name: "Altabrisa", lat: 21.06, lng: -89.62 })).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("deleteKnownZone: GRANT todavía no aplicado -> RestaurantesConfigUnavailableError, transacción recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /delete from restaurantes\.known_zone/, respond: () => permissionDeniedError("known_zone") },
      { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    await expect(repo.deleteKnownZone(ORG_ID, "zone-1")).rejects.toBeInstanceOf(RestaurantesConfigUnavailableError);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("camino feliz: crea y borra sin fallback", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into restaurantes\.known_zone/, respond: () => [{ id: "zone-1", organization_id: ORG_ID, name: "Altabrisa", lat: "21.06", lng: "-89.62", created_at: "2026-09-20T00:00:00.000Z" }] },
      { match: /delete from restaurantes\.known_zone/, respond: () => [{ id: "zone-1" }] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

    const created = await repo.createKnownZone(ORG_ID, { name: "Altabrisa", lat: 21.06, lng: -89.62 });
    expect(created).toEqual({ id: "zone-1", organizationId: ORG_ID, name: "Altabrisa", lat: 21.06, lng: -89.62, createdAt: "2026-09-20T00:00:00.000Z" });

    await expect(repo.deleteKnownZone(ORG_ID, "zone-1")).resolves.toBe(true);
  });
});

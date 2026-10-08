// Rn-13 / Rn-P3-23 -- repositorio de sync: tokens de exportación y reclamo manual. Dos mitades:
//  1. Adaptador en memoria (misma semántica que la migración 037).
//  2. Adaptador Postgres contra la base SIN la migración 037: cada operación degrada con SAVEPOINT
//     (AbortAwareFakeSession reproduce el estado abortado real; una sesión falsa plana no sirve).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { generarTokenFeed } from "../src/ical/feed-token.ts";
import { InMemoryRentasCalendarSyncRepository } from "../src/sync/in-memory-repository.ts";
import { PostgresRentasCalendarSyncRepository } from "../src/sync/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function fixture() {
  const store = new InMemoryRentasCalendarStore();
  const repo = new InMemoryRentasCalendarSyncRepository(store);
  let ahora = Date.parse("2026-10-07T12:00:00Z");
  repo.reloj = () => ahora;
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const unidadId = randomUUID();
  const airbnb = store.findCanalPorCodigo("airbnb")!;
  const vrbo = store.findCanalPorCodigo("vrbo")!;
  return { store, repo, organizationId, propertyId, unidadId, airbnb, vrbo, avanzar: (ms: number) => (ahora += ms) };
}

describe("tokens de exportación (adaptador en memoria)", () => {
  it("rotar crea un token vigente; rotar de nuevo revoca el anterior y deja uno solo", async () => {
    const f = fixture();
    const t1 = generarTokenFeed();
    const t2 = generarTokenFeed();
    const base = { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, canalId: f.airbnb.id };

    await f.repo.rotarFeedToken({ ...base, tokenHash: t1.hash });
    expect(await f.repo.resolverFeedToken(t1.hash)).toMatchObject({ disponible: true, token: { unidadId: f.unidadId, canalCodigo: "airbnb" } });

    await f.repo.rotarFeedToken({ ...base, tokenHash: t2.hash });
    // La rotación invalida el anterior: un token revocado no resuelve (la ruta lo traduce en 404).
    expect(await f.repo.resolverFeedToken(t1.hash)).toEqual({ disponible: true, token: null });
    expect(await f.repo.resolverFeedToken(t2.hash)).toMatchObject({ token: { canalCodigo: "airbnb" } });

    const lista = await f.repo.listarFeedTokens(f.propertyId, f.unidadId);
    expect(lista.disponible && lista.tokens).toHaveLength(1);
  });

  it("un hash desconocido no resuelve; cada canal tiene su propio token", async () => {
    const f = fixture();
    const a = generarTokenFeed();
    const v = generarTokenFeed();
    await f.repo.rotarFeedToken({ organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, canalId: f.airbnb.id, tokenHash: a.hash });
    await f.repo.rotarFeedToken({ organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, canalId: f.vrbo.id, tokenHash: v.hash });
    expect(await f.repo.resolverFeedToken(generarTokenFeed().hash)).toEqual({ disponible: true, token: null });
    expect(await f.repo.resolverFeedToken(a.hash)).toMatchObject({ token: { canalCodigo: "airbnb" } });
    expect(await f.repo.resolverFeedToken(v.hash)).toMatchObject({ token: { canalCodigo: "vrbo" } });
    const lista = await f.repo.listarFeedTokens(f.propertyId, f.unidadId);
    expect(lista.disponible && lista.tokens.map((t) => t.canalCodigo)).toEqual(["airbnb", "vrbo"]);
  });

  it("el listado no expone el hash ni el valor en claro", async () => {
    const f = fixture();
    const t = generarTokenFeed();
    await f.repo.rotarFeedToken({ organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, canalId: f.airbnb.id, tokenHash: t.hash });
    const serializado = JSON.stringify(await f.repo.listarFeedTokens(f.propertyId, f.unidadId));
    expect(serializado).not.toContain(t.hash);
    expect(serializado).not.toContain(t.token);
  });

  it("registra el último acceso, a lo más una escritura por minuto", async () => {
    const f = fixture();
    const t = generarTokenFeed();
    await f.repo.rotarFeedToken({ organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, canalId: f.airbnb.id, tokenHash: t.hash });
    const ultimo = async () => {
      const l = await f.repo.listarFeedTokens(f.propertyId, f.unidadId);
      return l.disponible ? l.tokens[0]!.ultimoAccesoEn : "no_disponible";
    };
    expect(await ultimo()).toBeNull();
    await f.repo.resolverFeedToken(t.hash);
    const primero = await ultimo();
    expect(primero).toBe("2026-10-07T12:00:00.000Z");
    f.avanzar(10_000);
    await f.repo.resolverFeedToken(t.hash);
    expect(await ultimo()).toBe(primero);
    f.avanzar(61_000);
    await f.repo.resolverFeedToken(t.hash);
    expect(await ultimo()).toBe("2026-10-07T12:01:11.000Z");
  });

  it("sin la migración 037 todo responde disponible:false", async () => {
    const f = fixture();
    f.repo.migracion037Disponible = false;
    const base = { organizationId: f.organizationId, propertyId: f.propertyId, unidadId: f.unidadId, canalId: f.airbnb.id, tokenHash: generarTokenFeed().hash };
    expect(await f.repo.rotarFeedToken(base)).toEqual({ disponible: false });
    expect(await f.repo.listarFeedTokens(f.propertyId, f.unidadId)).toEqual({ disponible: false });
    expect(await f.repo.resolverFeedToken(base.tokenHash)).toEqual({ disponible: false });
    expect(await f.repo.reclamarFeedManual("x", 120)).toEqual({ disponible: false });
  });
});

describe("PostgresRentasCalendarSyncRepository -- base sin la migración 037", () => {
  const sinFuncion = (n: string) => Object.assign(new Error(`function ${n}() does not exist`), { code: "42883" });
  const sinTabla = () => Object.assign(new Error('relation "rentas.feed_export_token" does not exist'), { code: "42P01" });
  const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };
  const usable = async (s: AbortAwareFakeSession) => expect(s.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });

  it("rotarFeedToken / resolverFeedToken / reclamarFeedManual: 42883 -> disponible:false y la transacción compartida sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /rotar_feed_export_token/i, respond: () => sinFuncion("rentas.rotar_feed_export_token") },
      { match: /resolver_feed_export_token/i, respond: () => sinFuncion("rentas.resolver_feed_export_token") },
      { match: /claim_ical_feed_manual/i, respond: () => sinFuncion("rentas.claim_ical_feed_manual") },
      SIGUIENTE,
    ]);
    const repo = new PostgresRentasCalendarSyncRepository(session);
    await expect(repo.rotarFeedToken({ organizationId: "o", propertyId: "p", unidadId: "u", canalId: "c", tokenHash: "a".repeat(64) })).resolves.toEqual({ disponible: false });
    await usable(session);
    await expect(repo.resolverFeedToken("a".repeat(64))).resolves.toEqual({ disponible: false });
    await usable(session);
    await expect(repo.reclamarFeedManual("f", 120)).resolves.toEqual({ disponible: false });
    await usable(session);
    expect(session.calls).toContain("rollback to savepoint sp_rentas_feed_token_rotar");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_feed_token_resolver");
    expect(session.calls).toContain("rollback to savepoint sp_rentas_ical_claim_manual");
  });

  it("listarFeedTokens: 42P01 -> disponible:false", async () => {
    const session = new AbortAwareFakeSession([{ match: /from rentas\.feed_export_token/i, respond: () => sinTabla() }, SIGUIENTE]);
    await expect(new PostgresRentasCalendarSyncRepository(session).listarFeedTokens("p", "u")).resolves.toEqual({ disponible: false });
    await usable(session);
  });

  it("un error que NO es de migración pendiente (p. ej. 42501 sin permiso) sí se propaga", async () => {
    const session = new AbortAwareFakeSession([{ match: /rotar_feed_export_token/i, respond: () => Object.assign(new Error("sin permiso"), { code: "42501" }) }]);
    await expect(new PostgresRentasCalendarSyncRepository(session).rotarFeedToken({ organizationId: "o", propertyId: "p", unidadId: "u", canalId: "c", tokenHash: "a".repeat(64) })).rejects.toMatchObject({ code: "42501" });
  });

  it("con la migración aplicada, rotar devuelve el token creado y resolver mapea la fila", async () => {
    const session = new AbortAwareFakeSession([
      { match: /rotar_feed_export_token/i, respond: () => [{ token_id: "t1", creado_en: "2026-10-07T12:00:00.000Z" }] },
      {
        match: /resolver_feed_export_token/i,
        respond: () => [{ token_id: "t1", token_hash: "a".repeat(64), organization_id: "o", property_id: "p", unidad_id: "u", canal_id: "c", canal_codigo: "airbnb" }],
      },
      { match: /claim_ical_feed_manual/i, respond: () => [{ feed_id: "f", lease_token: "lt" }] },
    ]);
    const repo = new PostgresRentasCalendarSyncRepository(session);
    await expect(repo.rotarFeedToken({ organizationId: "o", propertyId: "p", unidadId: "u", canalId: "c", tokenHash: "a".repeat(64) })).resolves.toEqual({ disponible: true, tokenId: "t1", creadoEn: "2026-10-07T12:00:00.000Z" });
    await expect(repo.resolverFeedToken("a".repeat(64))).resolves.toEqual({
      disponible: true,
      token: { tokenId: "t1", tokenHash: "a".repeat(64), organizationId: "o", propertyId: "p", unidadId: "u", canalId: "c", canalCodigo: "airbnb" },
    });
    await expect(repo.reclamarFeedManual("f", 120)).resolves.toEqual({ disponible: true, leaseToken: "lt" });
  });
});

// QA-restaurantes-R1-automatizacion-08: cron /internal/restaurantes/voz-huerfanas. Cierra como abandonadas las llamadas de voz sin cierre; sin
// secreto 401; sin la migracion 060 (sesion ABORTABLE que reproduce 25P02) responde not_available y la MISMA sesion sigue viva.
import { describe, expect, it } from "vitest";
import { InMemoryVozRepository, PostgresVozRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const RUTA = "/internal/restaurantes/voz-huerfanas";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };

async function construir(vozRepo: AppDeps["vozRepo"] | undefined) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const { vozRepo: _sinVoz, ...resto } = ctx.deps;
  void _sinVoz;
  const deps: AppDeps = { ...resto, ...(vozRepo ? { vozRepo } : {}) };
  const app = buildApp(deps);
  const llamar = (metodo: "GET" | "POST", secreto: string | null) => app.request(RUTA, { method: metodo, headers: secreto ? { "x-atiende-internal-secret": secreto } : {} });
  return { ctx, app, llamar, secreto: ctx.deps.env.internalSecret };
}

describe("cron voz-huerfanas", () => {
  it("sin secreto responde 401 y con uno equivocado tambien", async () => {
    const t = await construir(() => new InMemoryVozRepository());
    expect((await t.llamar("GET", null)).status).toBe(401);
    expect((await t.llamar("POST", "otro-secreto")).status).toBe(401);
  });

  it("cierra como abandonadas las llamadas abiertas hace mas de 2 h y deja intactas las recientes y las ya cerradas; la segunda corrida no cierra nada", async () => {
    const voz = new InMemoryVozRepository();
    const t = await construir(() => voz);
    voz.seedProperty(t.ctx.propertyIdA, t.ctx.organizationId);
    const ahora = Date.now();
    voz.reloj = () => ahora - 3 * 3_600_000;
    const vieja = await voz.iniciarConversacion({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, externalId: "vieja", canal: "llamada", proveedor: "gemini-3.8-live", voiceId: null, callerHash: null, startedAt: null });
    await voz.registrarTurno({ organizationId: t.ctx.organizationId, conversationId: vieja, seq: 0, rol: "cliente", texto: "hola", duracionMs: null, latenciaMs: 200, costoMicroUsd: 400_000 });
    voz.reloj = () => ahora - 10 * 60_000;
    const reciente = await voz.iniciarConversacion({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, externalId: "reciente", canal: "llamada", proveedor: "gemini-3.8-live", voiceId: null, callerHash: null, startedAt: null });
    voz.reloj = () => ahora - 5 * 3_600_000;
    const cerrada = await voz.iniciarConversacion({ organizationId: t.ctx.organizationId, propertyId: t.ctx.propertyIdA, externalId: "cerrada", canal: "llamada", proveedor: "gemini-3.8-live", voiceId: null, callerHash: null, startedAt: null });
    await voz.cerrarConversacion({ organizationId: t.ctx.organizationId, conversationId: cerrada, resultado: "escalado", endedAt: null, orderId: null });
    voz.reloj = () => ahora;

    const r1 = await t.llamar("GET", t.secreto);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, status: "ok", closed: 1 });
    const detalle = async (id: string) => (await voz.getConversacion(t.ctx.organizationId, t.ctx.propertyIdA, id)).valor!.conversacion;
    expect(await detalle(vieja)).toMatchObject({ resultado: "abandonado", costoEstimadoMicroUsd: 400_000, latenciaP95Ms: 200 });
    expect((await detalle(vieja)).endedAt).not.toBeNull();
    expect(await detalle(reciente)).toMatchObject({ resultado: null, endedAt: null });
    expect(await detalle(cerrada)).toMatchObject({ resultado: "escalado" });

    const r2 = await t.llamar("POST", t.secreto);
    expect(await r2.json()).toEqual({ ok: true, status: "ok", closed: 0 });
  });

  it("base sin migrar (repositorio en memoria sin migracion): 200 not_available, nada se cierra", async () => {
    const voz = new InMemoryVozRepository();
    voz.migrada = false;
    const t = await construir(() => voz);
    const r = await t.llamar("GET", t.secreto);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: "not_available", closed: 0 });
  });

  it("sin vozRepo en el despliegue: 200 not_available", async () => {
    const t = await construir(undefined);
    const r = await t.llamar("GET", t.secreto);
    expect(await r.json()).toEqual({ ok: true, status: "not_available", closed: 0 });
  });

  it("Postgres SIN la migracion 060 (42883 con la transaccion abortada): not_available y la MISMA sesion sigue viva por SAVEPOINT", async () => {
    const session = new AbortAwareFakeSession([
      { match: /voz_cerrar_huerfanas/i, respond: () => Object.assign(new Error("function restaurantes.voz_cerrar_huerfanas(integer, integer) does not exist"), { code: "42883" }) },
      SIGUIENTE,
    ]);
    const t = await construir(() => new PostgresVozRepository(session));
    const r = await t.llamar("GET", t.secreto);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, status: "not_available", closed: 0 });
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("Postgres con la 060: llama a la funcion con 120 min y lote de 200 y devuelve lo que cerro", async () => {
    const session = new AbortAwareFakeSession([{ match: /voz_cerrar_huerfanas/i, respond: () => [{ cerradas: 3 }] }, SIGUIENTE]);
    const t = await construir(() => new PostgresVozRepository(session));
    const r = await t.llamar("GET", t.secreto);
    expect(await r.json()).toEqual({ ok: true, status: "ok", closed: 3 });
    expect(session.calls.some((c) => /voz_cerrar_huerfanas/.test(c))).toBe(true);
  });
});

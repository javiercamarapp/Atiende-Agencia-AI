// REGLA DURA de compatibilidad con la base SIN migrar (migración 025, voz), a nivel HTTP: el
// request corre dentro de UNA transacción (`withAppSession`); con el repositorio Postgres REAL y una
// sesión que reproduce el estado ABORTADO de Postgres (25P02), cada ruta debe (1) degradar a vacío
// honesto / 503 y (2) dejar la MISMA sesión utilizable (`ROLLBACK TO SAVEPOINT`), porque un
// `COMMIT` sobre una transacción abortada revertiría en silencio todo lo demás del request.
// Una sesión falsa plana NO sirve: nunca queda "abortada".
import { describe, expect, it } from "vitest";
import { FakeVoiceProvider, PostgresVozRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const UUID = "00000000-0000-4000-8000-00000000ffff";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const sinObjeto = (code: "42P01" | "42883") => pgError(code, code === "42P01" ? 'relation "restaurantes.x" does not exist' : "function restaurantes.voz_x does not exist");

async function construir(handlers: readonly FakeSessionHandler[]) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const session = new AbortAwareFakeSession([...handlers, SIGUIENTE]);
  const provider = new FakeVoiceProvider();
  const deps: AppDeps = {
    ...ctx.deps,
    vozRepo: () => new PostgresVozRepository(session),
    voiceProvider: provider,
    env: { ...ctx.deps.env, voicePreviewTokenSecret: "secreto-de-preview-de-pruebas-0123456789" },
  };
  return { ctx, session, provider, app: buildApp(deps), base: `/v1/restaurantes/${ctx.propertyIdA}/admin/voz`, secret: ctx.deps.env.internalSecret };
}

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const TODAS_SIN_TABLA: FakeSessionHandler[] = [
  { match: /branch_voice_config/i, respond: () => sinObjeto("42P01") },
  { match: /voice_preview_sessions/i, respond: () => sinObjeto("42P01") },
  { match: /voice_conversation|voice_turn/i, respond: () => sinObjeto("42P01") },
  { match: /restaurantes\.voz_/i, respond: () => sinObjeto("42883") },
];

const CONFIG_OK = { habilitado: true, proveedor: "gemini-3.8-live", voiceId: "Kore", comportamiento: "", mensajeInicial: "" };

describe("rutas de voz contra la base sin migrar, con la transacción del request en estado abortado", () => {
  it("GET config: 200 con disponible=false y la sesión sigue viva", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_TABLA);
    const res = await app.request(`${base}/config`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, configurada: false });
    await sesionSigueViva(session);
  });

  it("PUT config: lectura previa degrada y la escritura da 503, todo sobre la MISMA sesión", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_TABLA);
    const res = await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, CONFIG_OK, "PUT"));
    expect(res.status).toBe(503);
    await sesionSigueViva(session);
    expect(ctx.restaurantesRepo.auditLog.some((r) => r.action === "configuracion.voz_actualizada")).toBe(false);
  });

  it("GET conversaciones: lista vacía disponible=false (200); detalle 503; sesión viva", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_TABLA);
    const lista = await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token));
    expect(lista.status).toBe(200);
    expect(await lista.json()).toMatchObject({ disponible: false, total: 0, items: [] });
    await sesionSigueViva(session);
    expect((await app.request(`${base}/conversaciones/${UUID}`, authedGet(ctx.staff.owner.token))).status).toBe(503);
    await sesionSigueViva(session);
  });

  it("POST preview: 503 sin emitir nada con el proveedor y sesión viva", async () => {
    const { ctx, app, base, session, provider } = await construir(TODAS_SIN_TABLA);
    const res = await app.request(`${base}/preview/sesion`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(503);
    expect(provider.emitidas).toHaveLength(0);
    await sesionSigueViva(session);
  });

  it("registrador interno: 503 en iniciar/turno/cerrar y sesión viva tras cada una", async () => {
    const { ctx, app, session, secret } = await construir(TODAS_SIN_TABLA);
    const org = ctx.organizationId;
    const llamar = async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      return app.request(`/internal/restaurantes/voz${path}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": secret } });
    };
    expect((await llamar("/conversaciones", { organizationId: org, propertyId: ctx.propertyIdA, externalId: "s", canal: "llamada", proveedor: "gemini-3.8-live" })).status).toBe(503);
    await sesionSigueViva(session);
    expect((await llamar(`/conversaciones/${UUID}/turnos`, { organizationId: org, seq: 0, rol: "cliente", texto: "hola" })).status).toBe(503);
    await sesionSigueViva(session);
    expect((await llamar(`/conversaciones/${UUID}/cerrar`, { organizationId: org, resultado: "escalado" })).status).toBe(503);
    await sesionSigueViva(session);
  });

  it("base migrada: un rechazo de pertenencia (42501) es 404 y la sesión queda viva; un error inesperado NO se disfraza de 'no disponible'", async () => {
    const a = await construir([{ match: /voz_iniciar_conversacion/i, respond: () => pgError("42501", "la sucursal no pertenece a la organizacion") }]);
    const raw = JSON.stringify({ organizationId: a.ctx.organizationId, propertyId: a.ctx.propertyIdA, externalId: "s", canal: "llamada", proveedor: "gemini-3.8-live" });
    const ini = await a.app.request("/internal/restaurantes/voz/conversaciones", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": a.secret } });
    expect(ini.status).toBe(404);
    await sesionSigueViva(a.session);

    const b = await construir([{ match: /from restaurantes\.branch_voice_config/i, respond: () => pgError("57P01", "connection terminated") }]);
    const res = await b.app.request(`${b.base}/config`, authedGet(b.ctx.staff.owner.token));
    expect(res.status).toBe(500);
  });
});

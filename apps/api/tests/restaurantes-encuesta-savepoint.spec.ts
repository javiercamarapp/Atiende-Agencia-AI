// REGLA DURA de compatibilidad con la base SIN migrar (migracion 061, encuesta post-entrega), a nivel HTTP: el request corre dentro de UNA
// transaccion (`withAppSession`); con el repositorio Postgres REAL y una sesion que reproduce el estado ABORTADO de Postgres (25P02), cada
// ruta debe degradar a "no disponible" (nunca un 500) y dejar la MISMA sesion utilizable (`ROLLBACK TO SAVEPOINT`).
import { describe, expect, it } from "vitest";
import { PostgresEncuestaRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { encuestaTokenKey, issueEncuestaToken } from "../src/encuesta-token.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../../../packages/domain-restaurantes/tests/support/aborting-fake-session.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

const ORDER = "00000000-0000-4000-8000-0000000000c1";
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const falla = (patron: RegExp, code: string): FakeSessionHandler => ({ match: patron, respond: () => { throw pgError(code, "base sin migrar"); } });

async function construir(handlers: readonly FakeSessionHandler[]) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const session = new AbortAwareFakeSession([...handlers, SIGUIENTE]);
  const deps: AppDeps = { ...ctx.deps, encuestaRepo: () => new PostgresEncuestaRepository(session) };
  const token = issueEncuestaToken(encuestaTokenKey(TEST_ENV.internalSecret), ctx.organizationId, ORDER);
  return { ctx, session, app: envolver(buildApp(deps)), token };
}

async function sesionViva(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

describe.each([["42883"], ["42P01"], ["42703"]])("encuesta contra la base sin migrar con la transaccion abortada (SQLSTATE %s)", (code) => {
  it("GET publico: 200 con disponible=false", async () => {
    const { ctx, app, session, token } = await construir([falla(/encuesta_publica/, code)]);
    const res = await app.request(`/v1/restaurantes/los-taquitos-de-pm/encuesta/${token}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false });
    expect(ctx.organizationId).toBeTruthy();
    await sesionViva(session);
  });

  it("POST publico: 503 con disponible=false (nada se pierde en silencio)", async () => {
    const { app, session, token } = await construir([falla(/encuesta_responder/, code)]);
    const raw = JSON.stringify({ calificacion: 5 });
    const res = await app.request(`/v1/restaurantes/los-taquitos-de-pm/encuesta/${token}`, {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", "content-length": String(raw.length), origin: "http://localhost:5173" },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ disponible: false });
    await sesionViva(session);
  });

  it("panel: config y resumen responden 200 con disponible=false, y guardar la config responde 503", async () => {
    const { ctx, app, session } = await construir([falla(/encuesta_config_leer/, code), falla(/encuesta_resumen/, code), falla(/encuesta_config_guardar/, code)]);
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas`;
    expect(await (await app.request(`${base}/config`, authedGet(ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, config: { activa: false } });
    expect(await (await app.request(`${base}/resumen`, authedGet(ctx.staff.owner.token))).json()).toMatchObject({ disponible: false, porSucursal: [] });
    const put = await app.request(`${base}/config`, authedJson(ctx.staff.owner.token, { activa: true, esperaMin: 30, resenasUrl: null, umbralResena: 4 }, "PUT"));
    expect(put.status).toBe(503);
    await sesionViva(session);
  });

  it("barrido interno: 200 con status not_available y sin encolar nada", async () => {
    const { ctx, app, session } = await construir([falla(/encuesta_candidatas/, code)]);
    const res = await app.request("/internal/restaurantes/enviar-encuestas", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(await res.json()).toMatchObject({ ok: true, status: "not_available", enqueued: 0 });
    expect(ctx.restaurantesRepo.getOutbox()).toHaveLength(0);
    await sesionViva(session);
  });
});

describe("un error de Postgres que NO es de base sin migrar no se traga", () => {
  it("42501 en el resumen: la ruta falla (>= 400) en vez de mostrar ceros", async () => {
    const { ctx, app } = await construir([falla(/encuesta_resumen/, "42501")]);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/encuestas/resumen`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

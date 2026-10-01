// REGLA DURA de compatibilidad con la base SIN migrar (migración 035, KPI de voz), a nivel HTTP: el request corre dentro de
// UNA transacción (`withAppSession`); con el repositorio Postgres REAL y una sesión que reproduce el estado ABORTADO de
// Postgres (25P02), cada ruta debe (1) degradar a vacío honesto / 503 y (2) dejar la MISMA sesión utilizable
// (`ROLLBACK TO SAVEPOINT`). Una sesión falsa plana NO sirve: nunca queda "abortada".
import { describe, expect, it } from "vitest";
import { PostgresVozKpiRepository } from "@atiende/domain-restaurantes";
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
  const deps: AppDeps = { ...ctx.deps, vozKpiRepo: () => new PostgresVozKpiRepository(session) };
  return { ctx, session, app: buildApp(deps), base: `/v1/restaurantes/${ctx.propertyIdA}/admin/voz`, secret: ctx.deps.env.internalSecret };
}

async function sesionSigueViva(session: AbortAwareFakeSession) {
  await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
}

const TODAS_SIN_OBJETO: FakeSessionHandler[] = [
  { match: /voice_alert_config|voice_alert\b|voice_event/i, respond: () => sinObjeto("42P01") },
  { match: /restaurantes\.voz_/i, respond: () => sinObjeto("42883") },
];

const UMBRALES = { umbralCostoDiaCentavosMxn: 8000, umbralTasaErrorPct: 40, minLlamadasTasaError: 5 };

describe("rutas de KPI de voz contra la base sin migrar, con la transacción del request en estado abortado", () => {
  it("GET kpi: 200 con disponible=false y ceros, y la sesión sigue viva", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_OBJETO);
    const res = await app.request(`${base}/kpi`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, mes: { llamadas: 0 } });
    await sesionSigueViva(session);
  });

  it("GET alertas: 200 con disponible=false (umbrales y lista) y sesión viva tras CADA consulta", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_OBJETO);
    const res = await app.request(`${base}/alertas`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, alertas: [], umbrales: { configurado: false } });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(2);
    await sesionSigueViva(session);
  });

  it("POST evaluar: 200 con disponible=false y sesión viva", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_OBJETO);
    const res = await app.request(`${base}/alertas/evaluar`, authedJson(ctx.staff.owner.token, {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, alertas: [] });
    await sesionSigueViva(session);
  });

  it("PUT umbrales: la lectura previa degrada, la escritura da 503, sin bitácora, y la sesión sigue viva", async () => {
    const { ctx, app, base, session } = await construir(TODAS_SIN_OBJETO);
    const res = await app.request(`${base}/alertas/config`, authedJson(ctx.staff.owner.token, UMBRALES, "PUT"));
    expect(res.status).toBe(503);
    await sesionSigueViva(session);
    expect(ctx.restaurantesRepo.auditLog.some((r) => r.action === "configuracion.voz_umbrales_actualizados")).toBe(false);
  });

  it("registrador de eventos: 503 y sesión viva", async () => {
    const { ctx, app, session, secret } = await construir(TODAS_SIN_OBJETO);
    const raw = JSON.stringify({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, conversationId: UUID, tipo: "tool_call", herramienta: "x", latenciaMs: 5 });
    const res = await app.request("/internal/restaurantes/voz/eventos", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": secret } });
    expect(res.status).toBe(503);
    await sesionSigueViva(session);
  });

  it("base migrada: un rechazo de pertenencia (42501) al registrar es 404; un error inesperado NO se disfraza de 'no disponible'", async () => {
    const a = await construir([{ match: /voz_registrar_evento/i, respond: () => pgError("42501", "la sucursal no pertenece a la organizacion") }]);
    const raw = JSON.stringify({ organizationId: a.ctx.organizationId, propertyId: a.ctx.propertyIdA, tipo: "tool_call", herramienta: "x", latenciaMs: 5 });
    const res = await a.app.request("/internal/restaurantes/voz/eventos", { method: "POST", body: raw, headers: { "content-type": "application/json", "content-length": String(raw.length), "x-atiende-internal-secret": a.secret } });
    expect(res.status).toBe(404);
    await sesionSigueViva(a.session);

    const b = await construir([{ match: /voz_kpis_diarios/i, respond: () => pgError("57P01", "connection terminated") }]);
    expect((await b.app.request(`${b.base}/kpi`, authedGet(b.ctx.staff.owner.token))).status).toBe(500);
  });
});

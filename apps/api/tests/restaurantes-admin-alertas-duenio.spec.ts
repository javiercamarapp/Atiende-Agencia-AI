// Autopiloto 2: umbrales configurables de las alertas al dueño («WhatsApp silencioso»). La regla vive en la base (Postgres real en
// scripts/verify-restaurantes-marketing-campanas); aqui: roles, validacion de forma, valores por omision conservadores, base sin migrar y que el
// guardado reciba la organizacion de la sesion (nunca del cliente).
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

type Manejador = (params: unknown[]) => unknown[] | Error;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

async function contexto(manejadores: Record<string, Manejador>) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const llamadas: Array<{ funcion: string; params: unknown[] }> = [];
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      const funcion = Object.keys(manejadores).find((f) => sql.includes(f));
      if (funcion) {
        llamadas.push({ funcion, params: params ?? [] });
        const r = manejadores[funcion]!(params ?? []);
        if (r instanceof Error) throw r;
        return { rows: r as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => ctx.deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  return { ctx, app: buildApp({ ...ctx.deps, engine }), llamadas };
}

const URL = (p: string) => `/v1/restaurantes/${p}/admin/alertas-duenio`;
const CUERPO = { silencioActivo: true, silencioVentanaMin: 90, silencioHistoricoMin: 4.5 };

describe("GET .../admin/alertas-duenio", () => {
  it("sin configuracion propia devuelve los valores por omision conservadores (60 min y 3 mensajes), configurado=false", async () => {
    const { ctx, app } = await contexto({ "from restaurantes.alertas_duenio_config": () => [] });
    const res = await app.request(URL(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disponible: true, silencioActivo: true, silencioVentanaMin: 60, silencioHistoricoMin: 3, configurado: false });
  });

  it("con configuracion propia la devuelve (numeric de pg llega como texto)", async () => {
    const { ctx, app, llamadas } = await contexto({ "from restaurantes.alertas_duenio_config": () => [{ silencio_activo: false, silencio_ventana_min: 120, silencio_historico_min: "4.50" }] });
    const body = await (await app.request(URL(ctx.propertyIdA), authedGet(ctx.staff.admin.token))).json();
    expect(body).toEqual({ disponible: true, silencioActivo: false, silencioVentanaMin: 120, silencioHistoricoMin: 4.5, configurado: true });
    expect(llamadas[0]!.params).toEqual([ctx.organizationId]);
  });

  it("base sin migrar: disponible=false con los valores por omision (nunca un 500)", async () => {
    const { ctx, app } = await contexto({ "from restaurantes.alertas_duenio_config": () => pgError("42P01", 'relation "restaurantes.alertas_duenio_config" does not exist') });
    const res = await app.request(URL(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, silencioVentanaMin: 60, silencioHistoricoMin: 3, configurado: false });
  });

  it("staff de piso, repartidor y otra organizacion NO entran", async () => {
    const { ctx, app } = await contexto({});
    expect((await app.request(URL(ctx.propertyIdA), authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(URL(ctx.propertyIdA), authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect([403, 404]).toContain((await app.request(URL(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status);
  });
});

describe("PUT .../admin/alertas-duenio", () => {
  const filas = { "from restaurantes.alertas_duenio_config": () => [{ silencio_activo: true, silencio_ventana_min: 90, silencio_historico_min: "4.50" }], alertas_duenio_guardar_config: () => [] };

  it("owner guarda: la base recibe la organizacion de la sesion y los umbrales", async () => {
    const { ctx, app, llamadas } = await contexto(filas);
    const res = await app.request(URL(ctx.propertyIdA), authedJson(ctx.staff.owner.token, CUERPO, "PUT"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ silencioVentanaMin: 90, silencioHistoricoMin: 4.5, configurado: true });
    expect(llamadas.find((l) => l.funcion === "alertas_duenio_guardar_config")!.params).toEqual([ctx.organizationId, true, 90, 4.5]);
  });

  it("validacion de forma antes de tocar la base: tipos, rangos de ventana (15..360) y de historico (1..1000) -> 400", async () => {
    const { ctx, app, llamadas } = await contexto(filas);
    const put = (body: unknown) => app.request(URL(ctx.propertyIdA), authedJson(ctx.staff.owner.token, body, "PUT"));
    expect((await put({ ...CUERPO, silencioActivo: "si" })).status).toBe(400);
    expect((await put({ ...CUERPO, silencioVentanaMin: 5 })).status).toBe(400);
    expect((await put({ ...CUERPO, silencioVentanaMin: 61.5 })).status).toBe(400);
    expect((await put({ ...CUERPO, silencioHistoricoMin: 0 })).status).toBe(400);
    expect((await put({ ...CUERPO, silencioHistoricoMin: 5000 })).status).toBe(400);
    expect(llamadas).toEqual([]);
  });

  it("staff de piso -> 403 sin tocar la base; 42501 de la base -> 403; base sin migrar -> 503", async () => {
    const { ctx, app, llamadas } = await contexto(filas);
    expect((await app.request(URL(ctx.propertyIdA), authedJson(ctx.staff.staffSucursalA.token, CUERPO, "PUT"))).status).toBe(403);
    expect(llamadas).toEqual([]);
    const sinAcceso = await contexto({ alertas_duenio_guardar_config: () => pgError("42501", "sin acceso") });
    expect((await sinAcceso.app.request(URL(sinAcceso.ctx.propertyIdA), authedJson(sinAcceso.ctx.staff.owner.token, CUERPO, "PUT"))).status).toBe(403);
    const sinMigrar = await contexto({ alertas_duenio_guardar_config: () => pgError("42883", "function restaurantes.alertas_duenio_guardar_config(uuid) does not exist") });
    expect((await sinMigrar.app.request(URL(sinMigrar.ctx.propertyIdA), authedJson(sinMigrar.ctx.staff.owner.token, CUERPO, "PUT"))).status).toBe(503);
  });
});

// Autopiloto 2: HTTP de las campanas de reactivacion (admin-marketing.ts). La regla vive en la base (probada contra Postgres real en
// scripts/verify-restaurantes-marketing-campanas); aqui: roles (solo owner/admin), validacion de forma, traduccion de errores de negocio a
// "requiere X" (409), base sin migrar (GET honesto, escrituras 503) y que NINGUNA respuesta lleve telefonos ni nombres de clientes.
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const CAMPANA = "6129984c-4f5e-4a0f-9b7e-0d4d8a1b2c0c";

type Manejador = (params: unknown[]) => unknown[] | Error;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const CONFIG_FILA = { activo: true, tarifa_centavos: 80, tope_mensual_centavos: null, minimo_segmento: 10, plantilla_nombre: "reactivacion_promo", plantilla_idioma: "es_MX", hay_promocion_vigente: true, plantilla_aprobada: true, whatsapp_conectado: true, gastado_mes_centavos: 0, consentimientos_vigentes: 40 };
const CAMPANA_FILA = { campana_id: CAMPANA, segmento: "inactivo_30", estado: "borrador", conteo: 23, conteo_control: 2, costo_estimado_centavos: 1840, promo_nombre: "Vuelve con 10 por ciento", promo_codigo: "VUELVE10", creada_at: "2026-10-04T14:00:00.000Z", decidida_at: null, encolados: null, enviados: 0, recompra_tratados: 0, recompra_control: 0, ingreso_tratados: 0, ventana_cerrada: false };

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

const URL_BASE = (p: string) => `/v1/restaurantes/${p}/admin/marketing`;
const SANA: Record<string, Manejador> = {
  marketing_config_leer: () => [CONFIG_FILA],
  marketing_resumen_campanas: () => [CAMPANA_FILA],
  marketing_guardar_config: () => [],
  marketing_decidir_campana: (p) => [{ estado: p[1] === true ? "aprobada" : "rechazada", encolados: p[1] === true ? 21 : 0, control: p[1] === true ? 2 : 0 }],
};

describe("GET .../admin/marketing", () => {
  it("owner y admin ven la configuracion con los requisitos reales y las campanas con atribucion; la respuesta no trae telefonos ni nombres", async () => {
    const { ctx, app, llamadas } = await contexto(SANA);
    for (const token of [ctx.staff.owner.token, ctx.staff.admin.token]) {
      const res = await app.request(URL_BASE(ctx.propertyIdA), authedGet(token));
      expect(res.status).toBe(200);
      const texto = await res.text();
      const body = JSON.parse(texto) as { disponible: boolean; config: { hayPromocionVigente: boolean; plantillaAprobada: boolean; whatsappConectado: boolean; tarifaCentavos: number }; campanas: Array<{ id: string; costoEstimadoCentavos: number; conteoControl: number }> };
      expect(body.disponible).toBe(true);
      expect(body.config).toMatchObject({ hayPromocionVigente: true, plantillaAprobada: true, whatsappConectado: true, tarifaCentavos: 80 });
      expect(body.campanas[0]).toMatchObject({ id: CAMPANA, costoEstimadoCentavos: 1840, conteoControl: 2 });
      expect(texto).not.toMatch(/\+52|"phone"|"telefono"|"customerName"/);
    }
    // La organizacion sale de la sesion autenticada, nunca del cliente.
    expect(llamadas.every((l) => l.params[0] === ctx.organizationId)).toBe(true);
  });

  it("staff de piso, repartidor y otra organizacion NO entran (403)", async () => {
    const { ctx, app } = await contexto(SANA);
    expect((await app.request(URL_BASE(ctx.propertyIdA), authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(URL_BASE(ctx.propertyIdA), authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect([403, 404]).toContain((await app.request(URL_BASE(ctx.propertyIdA), authedGet(ctx.staff.otroOrgOwner.token))).status);
    expect((await app.request(URL_BASE(ctx.propertyIdA))).status).toBe(401);
  });

  it("base SIN migrar: disponible=false con vacio honesto (nunca un 500)", async () => {
    const { ctx, app } = await contexto({
      marketing_config_leer: () => pgError("42883", "function restaurantes.marketing_config_leer(uuid) does not exist"),
      marketing_resumen_campanas: () => pgError("42883", "function restaurantes.marketing_resumen_campanas(uuid) does not exist"),
    });
    const res = await app.request(URL_BASE(ctx.propertyIdA), authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disponible: false, config: null, campanas: [] });
  });
});

describe("PUT .../admin/marketing/config", () => {
  const cuerpo = { activo: true, tarifaCentavos: 80, topeMensualCentavos: 50000, minimoSegmento: 10, plantillaNombre: "reactivacion_promo", plantillaIdioma: "es_MX" };

  it("owner guarda la configuracion y la base recibe la organizacion de la sesion", async () => {
    const { ctx, app, llamadas } = await contexto(SANA);
    const res = await app.request(`${URL_BASE(ctx.propertyIdA)}/config`, authedJson(ctx.staff.owner.token, cuerpo, "PUT"));
    expect(res.status).toBe(200);
    const guardar = llamadas.find((l) => l.funcion === "marketing_guardar_config")!;
    expect(guardar.params).toEqual([ctx.organizationId, true, 80, 50000, 10, "reactivacion_promo", "es_MX"]);
  });

  it("validacion de forma: activo obligatorio, tarifa entera positiva, plantilla con el formato de Meta -> 400", async () => {
    const { ctx, app } = await contexto(SANA);
    const put = (body: unknown) => app.request(`${URL_BASE(ctx.propertyIdA)}/config`, authedJson(ctx.staff.owner.token, body, "PUT"));
    expect((await put({ tarifaCentavos: 80 })).status).toBe(400);
    expect((await put({ ...cuerpo, tarifaCentavos: 0 })).status).toBe(400);
    expect((await put({ ...cuerpo, tarifaCentavos: 1.5 })).status).toBe(400);
    expect((await put({ ...cuerpo, plantillaNombre: "Tiene Mayusculas" })).status).toBe(400);
    expect((await put({ ...cuerpo, plantillaIdioma: "español" })).status).toBe(400);
  });

  it("staff de piso -> 403; base sin migrar -> 503", async () => {
    const { ctx, app } = await contexto(SANA);
    expect((await app.request(`${URL_BASE(ctx.propertyIdA)}/config`, authedJson(ctx.staff.staffSucursalA.token, cuerpo, "PUT"))).status).toBe(403);
    const sinMigrar = await contexto({ marketing_guardar_config: () => pgError("42883", "function restaurantes.marketing_guardar_config(uuid) does not exist") });
    expect((await sinMigrar.app.request(`${URL_BASE(sinMigrar.ctx.propertyIdA)}/config`, authedJson(sinMigrar.ctx.staff.owner.token, cuerpo, "PUT"))).status).toBe(503);
  });
});

describe("POST .../admin/marketing/campanas/:campanaId/decidir", () => {
  const decidir = (ctx: Awaited<ReturnType<typeof contexto>>["ctx"], app: Awaited<ReturnType<typeof contexto>>["app"], token: string, body: unknown, id = CAMPANA) =>
    app.request(`${URL_BASE(ctx.propertyIdA)}/campanas/${id}/decidir`, authedJson(token, body, "POST"));

  it("aprobar con un clic: la base recibe (campana, true) y la respuesta trae encolados y control", async () => {
    const { ctx, app, llamadas } = await contexto(SANA);
    const res = await decidir(ctx, app, ctx.staff.owner.token, { accion: "aprobar" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ estado: "aprobada", encolados: 21, control: 2 });
    expect(llamadas.find((l) => l.funcion === "marketing_decidir_campana")!.params).toEqual([CAMPANA, true]);
  });

  it("rechazar: la base recibe (campana, false) y no se encola nada", async () => {
    const { ctx, app } = await contexto(SANA);
    const res = await decidir(ctx, app, ctx.staff.admin.token, { accion: "rechazar" });
    expect(await res.json()).toEqual({ estado: "rechazada", encolados: 0, control: 0 });
  });

  it.each([
    ["requiere_tarifa", "tarifa"],
    ["requiere_plantilla_aprobada", "plantilla"],
    ["requiere_whatsapp_conectado", "WhatsApp"],
    ["tope_mensual_excedido", "tope mensual"],
    ["campana_no_aprobable", "ya fue decidida"],
    ["requiere_marketing_activo", "desactivadas"],
    ["requiere_nuevo_borrador", "siguiente borrador"],
  ])("la base dice %s -> 409 con mensaje 'requiere X' en espanol, nunca un 500", async (codigo, fragmento) => {
    const { ctx, app } = await contexto({ marketing_decidir_campana: () => pgError("P0001", codigo) });
    const res = await decidir(ctx, app, ctx.staff.owner.token, { accion: "aprobar" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain(fragmento);
  });

  it("campana ajena o inexistente (42501 de la base) -> 403 sin distinguir los casos; staff de piso -> 403; base sin migrar -> 503", async () => {
    const ajena = await contexto({ marketing_decidir_campana: () => pgError("42501", "sin acceso") });
    expect((await decidir(ajena.ctx, ajena.app, ajena.ctx.staff.owner.token, { accion: "aprobar" })).status).toBe(403);
    const { ctx, app, llamadas } = await contexto(SANA);
    expect((await decidir(ctx, app, ctx.staff.staffSucursalA.token, { accion: "aprobar" })).status).toBe(403);
    expect(llamadas).toEqual([]);
    const sinMigrar = await contexto({ marketing_decidir_campana: () => pgError("42883", "function restaurantes.marketing_decidir_campana(uuid) does not exist") });
    expect((await decidir(sinMigrar.ctx, sinMigrar.app, sinMigrar.ctx.staff.owner.token, { accion: "aprobar" })).status).toBe(503);
  });

  it("validacion: accion invalida o id que no es un id -> 400, sin tocar la base", async () => {
    const { ctx, app, llamadas } = await contexto(SANA);
    expect((await decidir(ctx, app, ctx.staff.owner.token, { accion: "borrar" })).status).toBe(400);
    expect((await decidir(ctx, app, ctx.staff.owner.token, {}, CAMPANA)).status).toBe(400);
    expect((await decidir(ctx, app, ctx.staff.owner.token, { accion: "aprobar" }, "no-es-un-id")).status).toBe(400);
    expect(llamadas).toEqual([]);
  });
});

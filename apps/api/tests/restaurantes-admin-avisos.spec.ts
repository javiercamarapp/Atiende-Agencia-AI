// R-16 -- rutas de avisos del staff: .../admin/avisos (Mis avisos + matriz del equipo + umbrales), PUT .../preferencias y PUT .../umbral.
// La autoridad real (rol, organizacion, rango) vive en las funciones de la base y la prueba contra Postgres real es
// scripts/verify-restaurantes-avisos-staff; aqui: primer filtro por rol, validacion, mapeo de errores de la base, bitacora y base sin migrar.
import { describe, expect, it } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const UMBRAL_REGEX = /restaurantes\.set_umbral_entrega_tardia/;

interface Fila { user_id: string; tipo: string; enabled: boolean; sonido: boolean }

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Envuelve el motor: responde a las funciones de la migracion 043 con un almacen en memoria (o con el error que se pida). */
function conBaseDeAvisos(
  deps: Awaited<ReturnType<typeof buildRestaurantesKpiTestContext>>["deps"],
  propiedades: ReadonlyArray<{ id: string; name: string }>,
  opts: { sinMigrar?: boolean; errorAlGuardar?: Error } = {},
) {
  const filas: Fila[] = [];
  const umbrales = new Map<string, number>();
  const llamadas: Array<{ sql: string; params: unknown[] }> = [];
  const envolver = (session: TenantDbSession, userId: string | null): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params: unknown[] = []) => {
      const noExiste = () => pgError("42883", `function ${/restaurantes\./.test(sql) ? "restaurantes.set_umbral_entrega_tardia(uuid, integer)" : "core.list_notification_preferences(uuid, boolean)"} does not exist`);
      if (/core\.list_notification_preferences/.test(sql)) {
        if (opts.sinMigrar) throw noExiste();
        const todos = params[1] === true;
        return { rows: filas.filter((f) => todos || f.user_id === userId) as unknown as T[] };
      }
      if (/core\.set_notification_preference/.test(sql)) {
        if (opts.sinMigrar) throw noExiste();
        if (opts.errorAlGuardar) throw opts.errorAlGuardar;
        llamadas.push({ sql, params });
        const objetivo = (params[1] as string | null) ?? userId!;
        const i = filas.findIndex((f) => f.user_id === objetivo && f.tipo === params[2]);
        const fila = { user_id: objetivo, tipo: params[2] as string, enabled: params[3] as boolean, sonido: params[4] as boolean };
        if (i >= 0) filas[i] = fila;
        else filas.push(fila);
        return { rows: [] as T[] };
      }
      if (/from core\.property p/.test(sql)) {
        if (opts.sinMigrar) throw pgError("42P01", 'relation "restaurantes.sucursal_avisos_config" does not exist');
        return { rows: propiedades.map((p) => ({ property_id: p.id, name: p.name, entrega_tardia_min: umbrales.get(p.id) ?? null })) as unknown as T[] };
      }
      if (UMBRAL_REGEX.test(sql)) {
        if (opts.sinMigrar) throw noExiste();
        if (opts.errorAlGuardar) throw opts.errorAlGuardar;
        umbrales.set(params[0] as string, params[1] as number);
        return { rows: [] as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (s) => fn(envolver(s, (claims as { userId: string | null }).userId))) };
  return { deps: { ...deps, engine }, filas, umbrales, llamadas };
}

async function construir(opts: { sinMigrar?: boolean; errorAlGuardar?: Error } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const base = conBaseDeAvisos(ctx.deps, [{ id: ctx.propertyIdA, name: "Francisco de Montejo" }, { id: ctx.propertyIdB, name: "Centro" }], opts);
  const app = buildApp(base.deps);
  const ruta = `/v1/restaurantes/${ctx.propertyIdA}/admin/avisos`;
  return { ctx, app, ruta, ...base };
}

describe("GET .../admin/avisos", () => {
  it("un staff ve SOLO 'Mis avisos' (todo encendido por defecto): sin matriz del equipo ni umbrales", async () => {
    const t = await construir();
    const res = await t.app.request(t.ruta, authedGet(t.ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; eventos: Array<{ tipo: string }>; mias: Array<{ tipo: string; enabled: boolean; sonido: boolean }>; equipo: unknown; umbrales: unknown };
    expect(body.disponible).toBe(true);
    expect(body.equipo).toBeNull();
    expect(body.umbrales).toBeNull();
    expect(body.mias).toHaveLength(body.eventos.length);
    expect(body.mias.every((m) => m.enabled && m.sonido)).toBe(true);
    expect(body.eventos.map((e) => e.tipo)).toContain("restaurantes.pedido.entrega_tardia");
  });

  it("owner/admin ven ademas la matriz del equipo y los umbrales por sucursal (sin configurar = null)", async () => {
    const t = await construir();
    await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.staffSucursalA.token, { tipo: "restaurantes.handoff.solicitado", enabled: false }, "PUT"));
    const res = await t.app.request(t.ruta, authedGet(t.ctx.staff.owner.token));
    const body = (await res.json()) as {
      equipo: Array<{ userId: string; verticalRole: string; preferencias: Array<{ tipo: string; enabled: boolean }> }>;
      umbrales: Array<{ propertyId: string; entregaTardiaMin: number | null }>;
      umbralDefectoMin: number;
    };
    expect(body.equipo.length).toBeGreaterThanOrEqual(4);
    const staff = body.equipo.find((m) => m.userId === t.ctx.staff.staffSucursalA.id)!;
    expect(staff.preferencias.find((p) => p.tipo === "restaurantes.handoff.solicitado")?.enabled).toBe(false);
    expect(staff.preferencias.find((p) => p.tipo === "restaurantes.pedido.nuevo")?.enabled).toBe(true);
    expect(body.umbrales).toHaveLength(2);
    expect(body.umbrales.every((u) => u.entregaTardiaMin === null)).toBe(true);
    expect(body.umbralDefectoMin).toBe(45);
  });

  it("repartidor -> 403 y sin sesion -> 401", async () => {
    const t = await construir();
    expect((await t.app.request(t.ruta, authedGet(t.ctx.staff.repartidor.token))).status).toBe(403);
    expect((await t.app.request(t.ruta)).status).toBe(401);
  });

  it("base SIN migrar -> 200 con disponible=false (estado honesto, sin 500) y la lista de eventos para pintar la pantalla", async () => {
    const t = await construir({ sinMigrar: true });
    const res = await t.app.request(t.ruta, authedGet(t.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; mias: unknown[]; equipo: unknown; umbrales: unknown; eventos: unknown[] };
    expect(body).toMatchObject({ disponible: false, mias: [], equipo: null, umbrales: null });
    expect(body.eventos.length).toBeGreaterThan(0);
  });
});

describe("PUT .../admin/avisos/preferencias", () => {
  it("cada persona apaga su propio aviso (y el sonido) y se refleja en su 'Mis avisos'; no genera bitacora", async () => {
    const t = await construir();
    const res = await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.staffSucursalA.token, { tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: false }, "PUT"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: false });
    expect(t.llamadas[0]!.params).toEqual([t.ctx.organizationId, null, "restaurantes.pedido.nuevo", false, false]);
    const mias = (await (await t.app.request(t.ruta, authedGet(t.ctx.staff.staffSucursalA.token))).json()) as { mias: Array<{ tipo: string; enabled: boolean; sonido: boolean }> };
    expect(mias.mias.find((m) => m.tipo === "restaurantes.pedido.nuevo")).toMatchObject({ enabled: false, sonido: false });
    const auditoria = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 50 });
    expect(auditoria.items.filter((e) => e.action === "avisos.preferencia")).toHaveLength(0);
  });

  it("cambiar solo el aviso conserva la preferencia de sonido ya guardada", async () => {
    const t = await construir();
    const put = (body: unknown) => t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.owner.token, body, "PUT"));
    await put({ tipo: "restaurantes.pedido.nuevo", enabled: true, sonido: false });
    const r = await put({ tipo: "restaurantes.pedido.nuevo", enabled: false });
    expect(await r.json()).toMatchObject({ enabled: false, sonido: false });
  });

  it("owner edita la preferencia de su staff y queda bitacora (id de la persona, sin correo)", async () => {
    const t = await construir();
    const res = await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.owner.token, { tipo: "restaurantes.callback.pendiente", enabled: false, userId: t.ctx.staff.staffSucursalA.id }, "PUT"));
    expect(res.status).toBe(200);
    expect(t.llamadas[0]!.params[1]).toBe(t.ctx.staff.staffSucursalA.id);
    const auditoria = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 50 });
    const e = auditoria.items.find((x) => x.action === "avisos.preferencia");
    expect(e).toMatchObject({ entityId: t.ctx.staff.staffSucursalA.id, campo: "restaurantes.callback.pendiente", antes: "encendido", despues: "apagado" });
    expect(JSON.stringify(e)).not.toContain("@");
  });

  it("un staff NO puede editar la de otra persona (403 antes de tocar la base) y un repartidor ni siquiera llega", async () => {
    const t = await construir();
    const r = await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.staffSucursalA.token, { tipo: "restaurantes.pedido.nuevo", enabled: false, userId: t.ctx.staff.owner.id }, "PUT"));
    expect(r.status).toBe(403);
    expect(t.llamadas).toHaveLength(0);
    expect((await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.repartidor.token, { tipo: "restaurantes.pedido.nuevo", enabled: false }, "PUT"))).status).toBe(403);
  });

  it("validacion: tipo desconocido, enabled no booleano, userId invalido -> 400", async () => {
    const t = await construir();
    const put = (body: unknown) => t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.owner.token, body, "PUT"));
    expect((await put({ tipo: "hoteles.ticket.sla_vencido", enabled: false })).status).toBe(400);
    expect((await put({ tipo: "restaurantes.pedido.nuevo", enabled: "no" })).status).toBe(400);
    expect((await put({ tipo: "restaurantes.pedido.nuevo", enabled: false, userId: "../x" })).status).toBe(400);
    expect((await put({ tipo: "restaurantes.pedido.nuevo", enabled: false, sonido: "si" })).status).toBe(400);
    expect(t.llamadas).toHaveLength(0);
  });

  it("la base rechaza por permiso (42501: un admin no edita a un owner) -> 403", async () => {
    const t = await construir({ errorAlGuardar: pgError("42501", "set_notification_preference: un admin no edita las de un owner") });
    const r = await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.admin.token, { tipo: "restaurantes.pedido.nuevo", enabled: false, userId: t.ctx.staff.owner.id }, "PUT"));
    expect(r.status).toBe(403);
  });

  it("base SIN migrar -> 503 honesto", async () => {
    const t = await construir({ sinMigrar: true });
    const r = await t.app.request(`${t.ruta}/preferencias`, authedJson(t.ctx.staff.owner.token, { tipo: "restaurantes.pedido.nuevo", enabled: false }, "PUT"));
    expect(r.status).toBe(503);
  });
});

describe("PUT .../admin/avisos/umbral", () => {
  it("owner fija los minutos de una sucursal, se lee de vuelta y queda bitacora con antes/despues", async () => {
    const t = await construir();
    const r = await t.app.request(`${t.ruta}/umbral`, authedJson(t.ctx.staff.owner.token, { propertyId: t.ctx.propertyIdB, minutos: 30 }, "PUT"));
    expect(r.status).toBe(200);
    expect(t.umbrales.get(t.ctx.propertyIdB)).toBe(30);
    const body = (await (await t.app.request(t.ruta, authedGet(t.ctx.staff.owner.token))).json()) as { umbrales: Array<{ propertyId: string; entregaTardiaMin: number | null }> };
    expect(body.umbrales.find((u) => u.propertyId === t.ctx.propertyIdB)?.entregaTardiaMin).toBe(30);
    const auditoria = await t.ctx.restaurantesRepo.listAuditoria(t.ctx.organizationId, {}, { limit: 50 });
    expect(auditoria.items.find((x) => x.action === "avisos.umbral_entrega_tardia")).toMatchObject({ entityId: t.ctx.propertyIdB, antes: null, despues: "30" });
  });

  it("staff -> 403; fuera de rango / no entero / sucursal ajena -> 400/404; base sin migrar -> 503", async () => {
    const t = await construir();
    const put = (token: string, body: unknown) => t.app.request(`${t.ruta}/umbral`, authedJson(token, body, "PUT"));
    expect((await put(t.ctx.staff.staffSucursalA.token, { propertyId: t.ctx.propertyIdA, minutos: 30 })).status).toBe(403);
    expect((await put(t.ctx.staff.owner.token, { propertyId: t.ctx.propertyIdA, minutos: 5 })).status).toBe(400);
    expect((await put(t.ctx.staff.owner.token, { propertyId: t.ctx.propertyIdA, minutos: 30.5 })).status).toBe(400);
    expect((await put(t.ctx.staff.owner.token, { propertyId: "no-es-uuid", minutos: 30 })).status).toBe(400);
    expect((await put(t.ctx.staff.owner.token, { propertyId: "11111111-1111-4111-8111-111111111111", minutos: 30 })).status).toBe(404);
    expect(t.umbrales.size).toBe(0);
    const viejo = await construir({ sinMigrar: true });
    expect((await viejo.app.request(`${viejo.ruta}/umbral`, authedJson(viejo.ctx.staff.owner.token, { propertyId: viejo.ctx.propertyIdA, minutos: 30 }, "PUT"))).status).toBe(503);
  });
});

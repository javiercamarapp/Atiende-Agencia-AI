// R-15 (migración 042): perfil operativo del repartidor. Cada caso afirma el EFECTO (qué quedó guardado, quién puede, qué NO se tocó),
// no solo el status. Las reglas de RLS reales las prueba scripts/verify-restaurantes-repartidor-perfil; aquí el contrato HTTP.
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRepartidorPerfilRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

afterEach(() => vi.useRealTimers());
function hoyFijo(iso = "2026-10-03T18:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

const PERFIL = {
  vehiculoTipo: "moto",
  placas: "ABC-123",
  disponibilidad: "disponible",
  turno: "L-V 12:00-20:00",
  licenciaNumero: "LIC-9",
  licenciaVigencia: "2027-06-30",
  emergenciaNombre: "Maria Perez",
  emergenciaTelefono: "+52 55 1234 5678",
};

async function construir(opts: { sinRepo?: boolean; repo?: InMemoryRepartidorPerfilRepository } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const repo = opts.repo ?? new InMemoryRepartidorPerfilRepository();
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { repartidorPerfilRepo: () => repo }) };
  const propio = `/v1/restaurantes/${ctx.propertyIdA}/repartidor/perfil`;
  const gestion = (userId: string) => `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/${userId}/perfil-repartidor`;
  return { ctx, repo, deps, app: envolver(buildApp(deps)), propio, gestion };
}

describe("perfil propio del repartidor", () => {
  it("sin perfil: 200 con perfil null (vacio honesto)", async () => {
    const { ctx, app, propio } = await construir();
    const res = await app.request(propio, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: true, perfil: null });
  });

  it("PUT guarda SU perfil (telefono a 10 digitos) y el GET lo devuelve; la alerta de licencia no aplica con vigencia lejana", async () => {
    hoyFijo();
    const { ctx, repo, app, propio } = await construir();
    const put = await app.request(propio, authedJson(ctx.staff.repartidor.token, PERFIL, "PUT"));
    expect(put.status).toBe(200);
    const r = await put.json();
    expect(r.perfil).toMatchObject({ userId: ctx.staff.repartidor.id, vehiculoTipo: "moto", placas: "ABC-123", emergenciaTelefono: "5512345678", licenciaEstado: "vigente" });
    expect(repo.filas.get(`${ctx.organizationId}|${ctx.staff.repartidor.id}`)?.emergenciaTelefono).toBe("5512345678");
    const get = await (await app.request(propio, authedGet(ctx.staff.repartidor.token))).json();
    expect(get.perfil.licenciaNumero).toBe("LIC-9");
  });

  it("licencia a menos de 30 dias: el perfil la marca por_vencer con los dias restantes; vencida marca vencida", async () => {
    hoyFijo();
    const { ctx, app, propio } = await construir();
    const por = await (await app.request(propio, authedJson(ctx.staff.repartidor.token, { ...PERFIL, licenciaVigencia: "2026-10-20" }, "PUT"))).json();
    expect(por.perfil).toMatchObject({ licenciaEstado: "por_vencer", licenciaDias: 17 });
    const venc = await (await app.request(propio, authedJson(ctx.staff.repartidor.token, { ...PERFIL, licenciaVigencia: "2026-10-01" }, "PUT"))).json();
    expect(venc.perfil).toMatchObject({ licenciaEstado: "vencida", licenciaDias: -2 });
  });

  it("la fecha de hoy sigue la zona de la sucursal (02:00Z del 4 sigue siendo el 3 en Mexico)", async () => {
    hoyFijo("2026-10-04T02:00:00Z");
    const { ctx, app, propio } = await construir();
    expect((await (await app.request(propio, authedGet(ctx.staff.repartidor.token))).json()).hoy).toBe("2026-10-03");
  });

  it.each([
    ["vehiculo desconocido", { ...PERFIL, vehiculoTipo: "cohete" }],
    ["telefono de 5 digitos", { ...PERFIL, emergenciaTelefono: "12345" }],
    ["licencia sin vigencia", { ...PERFIL, licenciaVigencia: null }],
    ["fecha imposible", { ...PERFIL, licenciaVigencia: "2027-02-30" }],
    ["emergencia sin telefono", { ...PERFIL, emergenciaTelefono: null }],
    ["cuerpo que no es objeto", [1, 2]],
  ])("rechaza %s con 400 y no guarda nada", async (_n, body) => {
    const { ctx, repo, app, propio } = await construir();
    expect((await app.request(propio, authedJson(ctx.staff.repartidor.token, body, "PUT"))).status).toBe(400);
    expect(repo.filas.size).toBe(0);
  });

  it("owner, admin, staff de piso y owner ajeno NO usan la ruta propia (403); sin sesion 401", async () => {
    const { ctx, repo, app, propio } = await construir();
    for (const token of [ctx.staff.owner.token, ctx.staff.admin.token, ctx.staff.staffSucursalA.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(propio, authedGet(token))).status).toBe(403);
      expect((await app.request(propio, authedJson(token, PERFIL, "PUT"))).status).toBe(403);
    }
    expect((await app.request(propio)).status).toBe(401);
    expect(repo.filas.size).toBe(0);
  });

  it("base SIN migrar: GET responde disponible=false (sin 500) y PUT 503 honesto", async () => {
    const { ctx, app, propio } = await construir({ repo: new InMemoryRepartidorPerfilRepository({ disponible: false }) });
    expect(await (await app.request(propio, authedGet(ctx.staff.repartidor.token))).json()).toMatchObject({ disponible: false, perfil: null });
    expect((await app.request(propio, authedJson(ctx.staff.repartidor.token, PERFIL, "PUT"))).status).toBe(503);
  });

  it("despliegue sin repartidorPerfilRepo: 503 honesto", async () => {
    const { ctx, app, propio } = await construir({ sinRepo: true });
    expect((await app.request(propio, authedGet(ctx.staff.repartidor.token))).status).toBe(503);
  });

  it("la correccion del propio repartidor no escribe en la bitacora de gestion (record_audit_log solo admite owner/admin/staff)", async () => {
    const { ctx, app, propio } = await construir();
    await app.request(propio, authedJson(ctx.staff.repartidor.token, PERFIL, "PUT"));
    const pagina = await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never);
    expect(pagina.items.filter((i) => i.action.startsWith("repartidor.perfil"))).toHaveLength(0);
  });
});

describe("gestion por owner/admin", () => {
  it("owner guarda el perfil de un repartidor de su organizacion y queda en la bitacora SIN valores personales", async () => {
    hoyFijo();
    const { ctx, repo, app, gestion } = await construir();
    const res = await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, PERFIL, "PUT"));
    expect(res.status).toBe(200);
    expect(repo.filas.get(`${ctx.organizationId}|${ctx.staff.repartidor.id}`)?.placas).toBe("ABC-123");
    const pagina = await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never);
    const fila = pagina.items.find((i) => i.action === "repartidor.perfil_actualizado");
    expect(fila).toBeDefined();
    expect(fila).toMatchObject({ entityType: "repartidor", entityId: ctx.staff.repartidor.id });
    expect(JSON.stringify(fila)).not.toMatch(/LIC-9|5512345678|Maria|ABC-123/);
    expect(fila!.campo).toContain("emergenciaTelefono");
  });

  it("la bitacora registra SOLO lo que cambio y no escribe nada si no cambio nada", async () => {
    hoyFijo();
    const { ctx, app, gestion } = await construir();
    const put = (cuerpo: unknown) => app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.admin.token, cuerpo, "PUT"));
    await put(PERFIL);
    await put({ ...PERFIL, disponibilidad: "en_descanso" });
    await put({ ...PERFIL, disponibilidad: "en_descanso" });
    const filas = (await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never)).items.filter((i) => i.action === "repartidor.perfil_actualizado");
    expect(filas.map((f) => f.campo)).toContain("disponibilidad");
    expect(filas).toHaveLength(2);
  });

  it("owner y admin leen el perfil completo (licencia y contacto de emergencia)", async () => {
    const { ctx, app, gestion } = await construir();
    await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, PERFIL, "PUT"));
    for (const token of [ctx.staff.owner.token, ctx.staff.admin.token]) {
      const r = await (await app.request(gestion(ctx.staff.repartidor.id), authedGet(token))).json();
      expect(r.perfil).toMatchObject({ licenciaNumero: "LIC-9", emergenciaNombre: "Maria Perez", emergenciaTelefono: "5512345678" });
    }
  });

  it("el staff de piso NO tiene acceso (ni lectura ni escritura ni supresion): 403, y no cambia nada", async () => {
    const { ctx, repo, app, gestion } = await construir();
    await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, PERFIL, "PUT"));
    const t = ctx.staff.staffSucursalA.token;
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedGet(t))).status).toBe(403);
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedJson(t, { ...PERFIL, placas: "XXX" }, "PUT"))).status).toBe(403);
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedJson(t, undefined, "DELETE"))).status).toBe(403);
    expect(repo.filas.get(`${ctx.organizationId}|${ctx.staff.repartidor.id}`)?.placas).toBe("ABC-123");
  });

  it("un repartidor NO usa la ruta de gestion, ni siquiera sobre su propio id (403)", async () => {
    const { ctx, app, gestion } = await construir();
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.repartidor.token, PERFIL, "PUT"))).status).toBe(403);
  });

  it("el objetivo debe ser repartidor DE ESTA organizacion: staff, owner, usuario de otra organizacion o uuid inventado -> 404 uniforme; no uuid -> 400", async () => {
    const { ctx, repo, app, gestion } = await construir();
    for (const id of [ctx.staff.staffSucursalA.id, ctx.staff.owner.id, ctx.staff.otroOrgOwner.id, "00000000-0000-4000-8000-0000000000aa"]) {
      expect((await app.request(gestion(id), authedJson(ctx.staff.owner.token, PERFIL, "PUT"))).status).toBe(404);
      expect((await app.request(gestion(id), authedGet(ctx.staff.owner.token))).status).toBe(404);
    }
    expect((await app.request(gestion("no-es-uuid"), authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect(repo.filas.size).toBe(0);
  });

  it("cross-tenant: el owner de OTRA organizacion no gestiona perfiles de esta (403 en la sucursal ajena, nada cambia)", async () => {
    const { ctx, repo, app, gestion } = await construir();
    const res = await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.otroOrgOwner.token, PERFIL, "PUT"));
    expect([403, 404]).toContain(res.status);
    expect(repo.filas.size).toBe(0);
  });

  it("DELETE (ARCO cancelacion): borra el perfil, queda en la bitacora y repetirlo no inventa otro rastro", async () => {
    const { ctx, repo, app, gestion } = await construir();
    await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, PERFIL, "PUT"));
    const del = await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, undefined, "DELETE"));
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true, borrado: true });
    expect(repo.filas.size).toBe(0);
    expect((await (await app.request(gestion(ctx.staff.repartidor.id), authedJson(ctx.staff.owner.token, undefined, "DELETE"))).json()).borrado).toBe(false);
    const filas = (await ctx.restaurantesRepo.listAuditoria(ctx.organizationId, {}, { limit: 10 } as never)).items.filter((i) => i.action === "repartidor.perfil_suprimido");
    expect(filas).toHaveLength(1);
  });

  it("base SIN migrar: GET disponible=false; PUT y DELETE 503", async () => {
    const { ctx, app, gestion } = await construir({ repo: new InMemoryRepartidorPerfilRepository({ disponible: false }) });
    const t = ctx.staff.owner.token;
    expect(await (await app.request(gestion(ctx.staff.repartidor.id), authedGet(t))).json()).toMatchObject({ disponible: false, perfil: null });
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedJson(t, PERFIL, "PUT"))).status).toBe(503);
    expect((await app.request(gestion(ctx.staff.repartidor.id), authedJson(t, undefined, "DELETE"))).status).toBe(503);
  });
});

describe("/internal/restaurantes/repartidor-licencias", () => {
  const llamar = (app: { request(i: string, init?: RequestInit): Promise<Resp> }, deps: AppDeps) =>
    app.request("/internal/restaurantes/repartidor-licencias", { method: "POST", headers: { "x-atiende-internal-secret": deps.env.internalSecret } });

  it("sin el secreto interno -> 401", async () => {
    const { app } = await construir();
    expect((await app.request("/internal/restaurantes/repartidor-licencias", { method: "POST" })).status).toBe(401);
  });

  it("revisa las licencias por vencer y reporta cuantas revisó (una por repartidor), sin PII", async () => {
    const { ctx, deps } = await construir();
    const repo = new InMemoryRepartidorPerfilRepository({ licencias: [{ organizationId: ctx.organizationId, userId: ctx.staff.repartidor.id, diasRestantes: 12 }, { organizationId: ctx.organizationId, userId: ctx.staff.owner.id, diasRestantes: -2 }] });
    const app = envolver(buildApp({ ...deps, repartidorPerfilRepo: () => repo }));
    const res = await llamar(app, deps);
    expect(res.status).toBe(200);
    const texto = JSON.stringify(await res.json());
    expect(JSON.parse(texto)).toMatchObject({ ok: true, status: "ok", revisadas: 2, fallos: 0 });
    expect(texto).not.toMatch(/@|LIC|Maria/);
  });

  it("base SIN migrar: 200 con status not_available, nunca 500; sin repo: 503", async () => {
    const { deps } = await construir();
    const app = envolver(buildApp({ ...deps, repartidorPerfilRepo: () => new InMemoryRepartidorPerfilRepository({ disponible: false }) }));
    expect(await (await llamar(app, deps)).json()).toMatchObject({ ok: true, status: "not_available", revisadas: 0 });
    const sin = envolver(buildApp({ ...deps, repartidorPerfilRepo: undefined }));
    expect((await llamar(sin, deps)).status).toBe(503);
  });
});

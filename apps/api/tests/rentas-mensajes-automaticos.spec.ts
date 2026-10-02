// Rn-24 / Rn-25 -- HTTP real (app.request) de las automatizaciones de mensajes por evento:
// configuracion de staff (roles finos, cross-tenant, aprobacion H-056), edicion de plantillas
// (editar el cuerpo quita la aprobacion) y el cron /internal/rentas/mensajes-automaticos
// (guard de secreto, kill switch, latido, borradores pendientes, aviso in-app, idempotencia y
// degradacion contra la base sin la migracion 029).
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryRentasMensajesAutomaticosRepository } from "@atiende/domain-rentas";
import type { CandidatoMensajeAutomatico } from "@atiende/domain-rentas";
import type { InMemorySaludRepository } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const CRON = { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } };
const RUTA_CRON = "/internal/rentas/mensajes-automaticos";
const OCUPACION = "33333333-3333-4333-8333-333333333333";
// 2030-06-08 00:30 CDMX: 30 min despues del disparo (-48 h antes del check-in del 10).
const AHORA = new Date("2030-06-08T06:30:00Z");

function enviar(method: "PUT" | "PATCH", token: string, body: unknown): RequestInit {
  const raw = JSON.stringify(body);
  return { method, body: raw, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) } };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const auto = new InMemoryRentasMensajesAutomaticosRepository();
  const { deps, emisiones } = conEmisiones({ ...ctx.deps, rentasMensajesAutomaticosRepo: () => auto });
  const app = buildApp(deps);
  const propia = await ctx.rentasMensajeriaRepo.insertPlantilla({ organizationId: ctx.organizationId, evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Hola {{huesped}}, te esperamos en {{propiedad}}.", aprobadaPorTenant: true, activa: true });
  const sinAprobar = await ctx.rentasMensajeriaRepo.insertPlantilla({ organizationId: ctx.organizationId, evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Borrador sin aprobar", aprobadaPorTenant: false, activa: true });
  const deCheckOut = await ctx.rentasMensajeriaRepo.insertPlantilla({ organizationId: ctx.organizationId, evento: "check_out", idioma: "es", canal: null, cuerpo: "Gracias {{huesped}}", aprobadaPorTenant: true, activa: true });
  const ajena = await ctx.rentasMensajeriaRepo.insertPlantilla({ organizationId: "99999999-9999-4999-8999-999999999999", evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Del tenant ajeno", aprobadaPorTenant: true, activa: true });
  const candidato = (extra: Partial<CandidatoMensajeAutomatico> = {}): CandidatoMensajeAutomatico => ({
    ocupacionId: OCUPACION,
    organizationId: ctx.organizationId,
    propertyId: ctx.propertyId,
    unidadId: ctx.unidadId,
    evento: "pre_llegada",
    offsetHoras: -48,
    plantillaId: propia.id,
    plantillaCuerpo: "Hola {{huesped}}, te esperamos en {{propiedad}}.",
    plantillaAprobada: true,
    plantillaActiva: true,
    canal: "airbnb",
    checkIn: "2030-06-10",
    checkOut: "2030-06-12",
    huespedNombre: "Ana",
    propiedadNombre: "Casa Mar",
    unidadNombre: "Depto 1",
    zonaHoraria: "America/Mexico_City",
    ...extra,
  });
  return { ctx, auto, app, emisiones, deps, base: `/rentas/${ctx.propertyId}/mensajes-automaticos`, plantillas: { propia, sinAprobar, deCheckOut, ajena }, candidato };
}

describe("GET /rentas/:propertyId/mensajes-automaticos", () => {
  it("sin nada programado devuelve los 4 eventos apagados con su offset sugerido y el catalogo de variables; cualquier staff lee, sin sesion 401", async () => {
    const { ctx, app, base } = await preparar();
    const res = await app.request(base, authedJson(ctx.staff.operadorSoloCalendario.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; eventos: Array<{ evento: string; programada: boolean; activo: boolean; offsetHoras: number; plantillaId: string | null }>; variables: Array<{ nombre: string }> };
    expect(body.disponible).toBe(true);
    expect(body.eventos.map((e) => [e.evento, e.programada, e.activo, e.offsetHoras])).toEqual([
      ["pre_llegada", false, false, -48],
      ["check_in", false, false, 10],
      ["check_out", false, false, 8],
      ["resena", false, false, 24],
    ]);
    expect(body.variables.map((v) => v.nombre)).toContain("fecha_check_in");
    expect((await app.request(base, { method: "GET" })).status).toBe(401);
  });

  it("base sin migrar: disponible:false con los eventos por defecto (nunca un 500)", async () => {
    const { ctx, app, auto, base } = await preparar();
    auto.migracion029Disponible = false;
    const res = await app.request(base, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false });
  });
});

describe("PUT /rentas/:propertyId/mensajes-automaticos/:evento", () => {
  it("admin_gestora programa un evento con una plantilla aprobada y la siguiente lectura lo refleja", async () => {
    const { ctx, app, base, plantillas } = await preparar();
    const put = await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: true, offsetHoras: -72, plantillaId: plantillas.propia.id }));
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ evento: "pre_llegada", activo: true, offsetHoras: -72, plantillaId: plantillas.propia.id });
    const leida = (await (await app.request(base, authedJson(ctx.staff.adminGestora.token, undefined, {}, "GET"))).json()) as { eventos: Array<{ evento: string; programada: boolean; offsetHoras: number }> };
    expect(leida.eventos.find((e) => e.evento === "pre_llegada")).toMatchObject({ programada: true, offsetHoras: -72 });
  });

  it("roles sin permiso de aprobacion (operadores, contador, limpieza) reciben 403", async () => {
    const { ctx, app, base, plantillas } = await preparar();
    for (const t of [ctx.staff.operadorAccesoTotal.token, ctx.staff.operadorSoloCalendario.token, ctx.staff.contador.token, ctx.staff.limpieza.token]) {
      const r = await app.request(`${base}/pre_llegada`, enviar("PUT", t, { activo: true, offsetHoras: -48, plantillaId: plantillas.propia.id }));
      expect(r.status).toBe(403);
    }
  });

  it("H-056: activar con una plantilla NO aprobada responde 409; apagar el evento con ella si se permite", async () => {
    const { ctx, app, base, plantillas } = await preparar();
    const activar = await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: true, offsetHoras: -48, plantillaId: plantillas.sinAprobar.id }));
    expect(activar.status).toBe(409);
    expect(await activar.json()).toMatchObject({ code: "aprobacion_requerida" });
    const apagar = await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: false, offsetHoras: -48, plantillaId: plantillas.sinAprobar.id }));
    expect(apagar.status).toBe(200);
  });

  it("una plantilla inactiva tampoco se puede activar", async () => {
    const { ctx, app, base, plantillas } = await preparar();
    await app.request(`/rentas/${ctx.propertyId}/plantillas/${plantillas.propia.id}`, enviar("PATCH", ctx.staff.adminGestora.token, { activa: false }));
    const r = await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: true, offsetHoras: -48, plantillaId: plantillas.propia.id }));
    expect(r.status).toBe(409);
  });

  it("cross-tenant: la plantilla de otra organizacion es 404; la de otro evento es 400", async () => {
    const { ctx, app, base, plantillas } = await preparar();
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: true, offsetHoras: -48, plantillaId: plantillas.ajena.id }))).status).toBe(404);
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: true, offsetHoras: -48, plantillaId: plantillas.deCheckOut.id }))).status).toBe(400);
  });

  it("valida evento, offset, banderas y UUID; una plantilla con variables desconocidas no se programa", async () => {
    const { ctx, app, base, plantillas } = await preparar();
    const t = ctx.staff.adminGestora.token;
    const ok = { activo: true, offsetHoras: -48, plantillaId: plantillas.propia.id };
    expect((await app.request(`${base}/confirmacion`, enviar("PUT", t, ok))).status).toBe(400);
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", t, { ...ok, offsetHoras: 721 }))).status).toBe(400);
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", t, { ...ok, offsetHoras: 1.5 }))).status).toBe(400);
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", t, { ...ok, activo: "si" }))).status).toBe(400);
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", t, { ...ok, plantillaId: "no-es-uuid" }))).status).toBe(400);
    const rara = await ctx.rentasMensajeriaRepo.insertPlantilla({ organizationId: ctx.organizationId, evento: "pre_llegada", idioma: "es", canal: null, cuerpo: "Tu wifi: {{codigo_wifi}}", aprobadaPorTenant: true, activa: true });
    expect((await app.request(`${base}/pre_llegada`, enviar("PUT", t, { ...ok, plantillaId: rara.id }))).status).toBe(400);
  });

  it("base sin migrar: 409 'aun no disponible' (nunca un 500)", async () => {
    const { ctx, app, auto, base, plantillas } = await preparar();
    auto.migracion029Disponible = false;
    const r = await app.request(`${base}/pre_llegada`, enviar("PUT", ctx.staff.adminGestora.token, { activo: true, offsetHoras: -48, plantillaId: plantillas.propia.id }));
    expect(r.status).toBe(409);
  });
});

describe("PATCH /rentas/:propertyId/plantillas/:id -- aprobacion (H-056)", () => {
  it("editar el cuerpo de una plantilla aprobada le quita la aprobacion", async () => {
    const { ctx, app, plantillas } = await preparar();
    const r = await app.request(`/rentas/${ctx.propertyId}/plantillas/${plantillas.propia.id}`, enviar("PATCH", ctx.staff.operadorAccesoTotal.token, { cuerpo: "Texto nuevo para {{huesped}}" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ aprobadaPorTenant: false, cuerpo: "Texto nuevo para {{huesped}}" });
  });

  it("no se puede editar y aprobar en la misma peticion (400); la aprobacion es un paso aparte y solo de admin_gestora", async () => {
    const { ctx, app, plantillas } = await preparar();
    const ruta = `/rentas/${ctx.propertyId}/plantillas/${plantillas.sinAprobar.id}`;
    expect((await app.request(ruta, enviar("PATCH", ctx.staff.adminGestora.token, { cuerpo: "Otro", aprobadaPorTenant: true }))).status).toBe(400);
    expect((await app.request(ruta, enviar("PATCH", ctx.staff.operadorAccesoTotal.token, { aprobadaPorTenant: true }))).status).toBe(403);
    const aprobada = await app.request(ruta, enviar("PATCH", ctx.staff.adminGestora.token, { aprobadaPorTenant: true }));
    expect(aprobada.status).toBe(200);
    expect(await aprobada.json()).toMatchObject({ aprobadaPorTenant: true });
  });

  it("no se aprueba una plantilla con variables que el sistema no sabe llenar", async () => {
    const { ctx, app } = await preparar();
    const rara = await ctx.rentasMensajeriaRepo.insertPlantilla({ organizationId: ctx.organizationId, evento: "check_in", idioma: "es", canal: null, cuerpo: "Precio {{precio}}", aprobadaPorTenant: false, activa: true });
    const r = await app.request(`/rentas/${ctx.propertyId}/plantillas/${rara.id}`, enviar("PATCH", ctx.staff.adminGestora.token, { aprobadaPorTenant: true }));
    expect(r.status).toBe(400);
  });
});

describe("GET/POST /internal/rentas/mensajes-automaticos (cron)", () => {
  it("rechaza sin el secreto interno o con uno incorrecto; GET con Bearer (forma de Vercel Cron) autentica", async () => {
    const { app } = await preparar();
    expect((await app.request(RUTA_CRON, { method: "POST" })).status).toBe(401);
    expect((await app.request(RUTA_CRON, { method: "POST", headers: { "x-atiende-internal-secret": "otro" } })).status).toBe(401);
    expect((await app.request(RUTA_CRON, { method: "GET", headers: { authorization: "Bearer otro" } })).status).toBe(401);
    const ok = await app.request(RUTA_CRON, { method: "GET", headers: { authorization: `Bearer ${TEST_ENV.internalSecret}` } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, disponible: true, candidatas: 0, borradores_creados: 0, omitidas_variable_faltante: 0, ya_procesadas: 0, fuera_de_ventana: 0, errores: 0, truncada: false });
  });

  it("crea un borrador PENDIENTE de aprobacion (nunca enviado) y un aviso in-app sin PII; la segunda corrida no repite ni el borrador ni la clave", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
    const { ctx, auto, app, emisiones, candidato } = await preparar();
    auto.candidatas.push(candidato({ huespedNombre: "Persona Privada" }));
    const res = await app.request(RUTA_CRON, CRON);
    expect(await res.json()).toMatchObject({ ok: true, candidatas: 1, borradores_creados: 1, errores: 0 });
    expect(auto.borradores).toHaveLength(1);
    expect(auto.borradores[0]).toMatchObject({ estado: "pendiente_aprobacion" });
    const mias = emisiones.filter((e) => e.evento === "rentas.aprobacion.pendiente");
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, categoria: "aprobaciones", enlace: "/rentas/{orgSlug}/aprobaciones" });
    expect(mias[0]!.dedupeKey).toBe(`rentas.aprobacion.pendiente:${auto.borradores[0]!.id}`);
    expect(JSON.stringify(mias[0])).not.toContain("Persona Privada");
    await app.request(RUTA_CRON, CRON);
    expect(auto.borradores).toHaveLength(1);
    expect(emisiones.filter((e) => e.evento === "rentas.aprobacion.pendiente")).toHaveLength(1);
  });

  it("fuera de la ventana (23:30 CDMX, el dia UTC ya es el siguiente) no crea nada", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-06-08T05:30:00Z"));
    const { auto, app, candidato } = await preparar();
    auto.candidatas.push(candidato());
    const body = (await (await app.request(RUTA_CRON, CRON)).json()) as { borradores_creados: number; fuera_de_ventana: number };
    expect(body).toMatchObject({ borradores_creados: 0, fuera_de_ventana: 1 });
    expect(auto.borradores).toHaveLength(0);
  });

  it("kill switch por cron: no toca nada, responde skipped y NO consulta candidatas", async () => {
    const { deps, auto, candidato } = await preparar();
    auto.candidatas.push(candidato());
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: RUTA_CRON }]);
    const app = buildApp({ ...deps, platformSwitchGuard: guard });
    const res = await app.request(RUTA_CRON, CRON);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect(auto.llamadas).toEqual([]);
    expect(auto.borradores).toHaveLength(0);
  });

  it("registra latido ok en /superadmin/salud/crons y un fallo parcial lo deja en error sin tumbar la respuesta (200 con ok:false)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
    const { deps, auto, app, candidato } = await preparar();
    const salud = deps.saludRepo as InMemorySaludRepository;
    salud.addPlatformSuperadmin("admin-1");
    await app.request(RUTA_CRON, CRON);
    expect((await salud.listCronHeartbeatsForSuperadmin("admin-1")).find((l) => l.cronName === RUTA_CRON)).toMatchObject({ lastStatus: "ok" });

    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    auto.candidatas.push(candidato());
    auto.fallaAlCrearPara.add(OCUPACION);
    const res = await app.request(RUTA_CRON, CRON);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, errores: 1 });
    expect((await salud.listCronHeartbeatsForSuperadmin("admin-1")).find((l) => l.cronName === RUTA_CRON)).toMatchObject({ lastStatus: "error" });
    log.mockRestore();
  });

  it("base sin la migracion 029: 200 con disponible:false, sin lanzar", async () => {
    const { auto, app } = await preparar();
    auto.migracion029Disponible = false;
    const res = await app.request(RUTA_CRON, CRON);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, disponible: false, borradores_creados: 0 });
  });
});

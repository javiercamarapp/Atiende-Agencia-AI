// paridad3 rentas: limpieza en piloto automatico por HTTP -- la tarea nace al confirmar la reserva desde la API, se reprograma y se
// cancela con ella; asignar a otra persona (403 para `limpieza`, 422 para quien no es miembro, cross-tenant); personas asignables;
// responsable por omision; avisos in-app solo desde el barrido; kill switch y base sin migrar.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, InMemoryCoreRepository } from "@atiende/db";
import { InMemoryRentasCatalogoRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { TEST_ENV } from "./fixtures.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import type { RentasTestContext } from "./rentas-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

afterEach(() => {
  vi.useRealTimers();
});

const sweep = (app: ReturnType<typeof buildApp>) => app.request("/internal/rentas/checkout-sweep", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

async function contexto() {
  const ctx = await buildRentasTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps);
  const app = buildApp(deps);
  return { ctx, app, deps, emisiones };
}

type Tarea = { id: string; asignadoA: string | null; estado: string; programadaPara: string; esProveedorExterno: boolean };
const listar = async (app: ReturnType<typeof buildApp>, ctx: RentasTestContext, token: string, query = "") => {
  const res = await app.request(`/rentas/${ctx.propertyId}/tareas${query}`, authedJson(token));
  return { status: res.status, tareas: res.status === 200 ? ((await res.json()) as { tareas: Tarea[] }).tareas : [] };
};
const reservar = (app: ReturnType<typeof buildApp>, ctx: RentasTestContext, rango: { inicio: string; fin: string }) =>
  app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas`, authedJson(ctx.staff.adminGestora.token, { rango }));

/** Otra organizacion con su admin (cross-tenant): login real contra el mismo coreRepo del fixture. */
async function otraOrganizacion(ctx: RentasTestContext, app: ReturnType<typeof buildApp>) {
  const coreRepo = ctx.deps.coreRepo as InMemoryCoreRepository;
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const id = randomUUID();
  const email = "admin-otra-org@otra-gestora.mx";
  const password = "correcto-caballo-batería";
  coreRepo.addOrganization({ id: organizationId, slug: "otra-gestora", name: "Otra Gestora", vertical: "rentas" });
  coreRepo.addStaff({ id, email, fullName: "admin-otra", passwordHash: await hashPassword(password), createdVia: "seed", emailVerifiedAt: new Date().toISOString() });
  coreRepo.addMembership({ userId: id, organizationId, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: null });
  ctx.engine.seedProperty({ id: propertyId, organizationId });
  ctx.engine.seedMembership({ userId: id, organizationId, platformRole: "owner", verticalRole: "admin_gestora", propertyIds: null });
  const res = await app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  const { token } = (await res.json()) as { token: string };
  return { id, organizationId, propertyId, token };
}

describe("la tarea de limpieza nace, se mueve y se cancela con la reserva (por la API)", () => {
  it("crear la reserva deja la tarea creada una sola vez y el barrido posterior no la duplica", async () => {
    const { ctx, app } = await contexto();
    expect((await reservar(app, ctx, { inicio: "2026-06-01", fin: "2026-06-05" })).status).toBe(201);

    const antes = await listar(app, ctx, ctx.staff.adminGestora.token);
    expect(antes.tareas).toHaveLength(1);
    expect(antes.tareas[0]).toMatchObject({ programadaPara: "2026-06-05", estado: "pendiente", asignadoA: null });

    const r = await sweep(app);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { tareasCreadas: string[] }).tareasCreadas).toHaveLength(0);
    expect((await listar(app, ctx, ctx.staff.adminGestora.token)).tareas).toHaveLength(1);
  });

  it("con responsable por omision en la unidad, la tarea nace ya asignada; el barrido avisa UNA vez a quien opera limpieza", async () => {
    const { ctx, app, emisiones } = await contexto();
    ctx.calendarStore.seedUnidad({ ...ctx.calendarStore.getUnidadById(ctx.unidadId)!, responsableLimpiezaDefaultId: ctx.staff.limpieza.id });

    await reservar(app, ctx, { inicio: "2026-06-01", fin: "2026-06-05" });
    const { tareas } = await listar(app, ctx, ctx.staff.adminGestora.token);
    expect(tareas[0]).toMatchObject({ asignadoA: ctx.staff.limpieza.id, estado: "asignada" });
    // Crear la reserva NO emite nada: los avisos salen del barrido (ningun GET ni escritura de reserva emite).
    expect(emisiones.filter((e) => e.evento.startsWith("rentas.limpieza."))).toHaveLength(0);

    await sweep(app);
    await sweep(app);
    const avisos = emisiones.filter((e) => e.evento === "rentas.limpieza.tarea_asignada");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, categoria: "operacion", roles: ["limpieza"], enlace: "/rentas/{orgSlug}/mis-tareas", cuerpo: null });
    expect(avisos[0]!.dedupeKey).toBe(`rentas.limpieza.tarea_asignada:${tareas[0]!.id}:${ctx.staff.limpieza.id}`);
    expect(JSON.stringify(avisos[0])).not.toContain("@");
  });

  it("si el responsable por omision ya no es miembro operativo, la tarea va a 'Sin asignar'", async () => {
    const { ctx, app } = await contexto();
    ctx.calendarStore.seedUnidad({ ...ctx.calendarStore.getUnidadById(ctx.unidadId)!, responsableLimpiezaDefaultId: ctx.staff.contador.id });
    await reservar(app, ctx, { inicio: "2026-06-01", fin: "2026-06-05" });
    expect((await listar(app, ctx, ctx.staff.adminGestora.token)).tareas[0]!.asignadoA).toBeNull();
  });

  it("modificar fechas (PATCH) reprograma la tarea y conserva al responsable; cancelar la cancela", async () => {
    const { ctx, app } = await contexto();
    ctx.calendarStore.seedUnidad({ ...ctx.calendarStore.getUnidadById(ctx.unidadId)!, responsableLimpiezaDefaultId: ctx.staff.limpieza.id });
    const { id } = (await (await reservar(app, ctx, { inicio: "2026-06-01", fin: "2026-06-05" })).json()) as { id: string };

    const patch = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}`, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2026-06-01", fin: "2026-06-09" } }, {}, "PATCH"));
    expect(patch.status).toBe(200);
    const movida = (await listar(app, ctx, ctx.staff.adminGestora.token)).tareas;
    expect(movida).toHaveLength(1);
    expect(movida[0]).toMatchObject({ programadaPara: "2026-06-09", asignadoA: ctx.staff.limpieza.id });

    const cancelar = await app.request(`/rentas/${ctx.propertyId}/unidades/${ctx.unidadId}/reservas/${id}/cancelar`, authedJson(ctx.staff.adminGestora.token, {}));
    expect(cancelar.status).toBe(200);
    expect((await listar(app, ctx, ctx.staff.adminGestora.token)).tareas[0]!.estado).toBe("cancelada");
  });
});

describe("POST .../tareas/:tareaId/asignar", () => {
  async function conTarea() {
    const s = await contexto();
    const tarea = s.ctx.rentasRepo.seedTareaOperativa({ organizationId: s.ctx.organizationId, propertyId: s.ctx.propertyId, unidadId: s.ctx.unidadId, programadaPara: "2026-07-01" });
    const asignar = (token: string, body: unknown) => s.app.request(`/rentas/${s.ctx.propertyId}/tareas/${tarea.id}/asignar`, authedJson(token, body));
    return { ...s, tarea, asignar };
  }

  it("el rol limpieza NO puede asignar la tarea a otra persona (403) y la tarea sigue sin responsable", async () => {
    const { ctx, tarea, asignar, app } = await conTarea();
    const res = await asignar(ctx.staff.limpieza.token, { asignadoA: ctx.staff.operadorAccesoTotal.id });
    expect(res.status).toBe(403);
    const detalle = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}`, authedJson(ctx.staff.adminGestora.token));
    expect(((await detalle.json()) as { tarea: Tarea }).tarea.asignadoA).toBeNull();
  });

  it("el rol limpieza si puede asignarse a si mismo, sin avisar a nadie", async () => {
    const { ctx, asignar, emisiones } = await conTarea();
    for (const body of [{}, { asignadoA: ctx.staff.limpieza.id }]) {
      const res = await asignar(ctx.staff.limpieza.token, body);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tarea: Tarea }).tarea.asignadoA).toBe(ctx.staff.limpieza.id);
    }
    expect(emisiones).toHaveLength(0);
  });

  it("admin_gestora y operador:acceso_total reparten la tarea a una persona de limpieza: 200, aviso inmediato con clave tarea+persona y sin PII", async () => {
    const { ctx, tarea, asignar, emisiones } = await conTarea();
    for (const token of [ctx.staff.adminGestora.token, ctx.staff.operadorAccesoTotal.token]) {
      const res = await asignar(token, { asignadoA: ctx.staff.limpieza.id, esProveedorExterno: true });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { tarea: Tarea }).tarea).toMatchObject({ asignadoA: ctx.staff.limpieza.id, estado: "asignada", esProveedorExterno: true });
    }
    const avisos = emisiones.filter((e) => e.evento === "rentas.limpieza.tarea_asignada");
    // El motor real dedupe por (destinatario, clave): aqui ambas emisiones llevan la MISMA clave, la base descartaria la segunda.
    expect(new Set(avisos.map((a) => a.dedupeKey))).toEqual(new Set([`rentas.limpieza.tarea_asignada:${tarea.id}:${ctx.staff.limpieza.id}`]));
    expect(JSON.stringify(avisos)).not.toContain("@");
  });

  it("asignar a quien NO es miembro con acceso a la propiedad -> 422 (un contador, un usuario de otra organizacion, un id inexistente)", async () => {
    const { ctx, tarea, asignar, app } = await conTarea();
    const ajena = await otraOrganizacion(ctx, app);
    for (const asignadoA of [ctx.staff.contador.id, ajena.id, randomUUID()]) {
      const res = await asignar(ctx.staff.adminGestora.token, { asignadoA });
      expect(res.status, asignadoA).toBe(422);
      expect(((await res.json()) as { code?: string }).code).toBe("asignado_no_valido");
    }
    const detalle = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}`, authedJson(ctx.staff.adminGestora.token));
    expect(((await detalle.json()) as { tarea: Tarea }).tarea.asignadoA).toBeNull();
  });

  it("cross-tenant: el admin de otra organizacion no ve la tarea ni puede asignarla", async () => {
    const { ctx, tarea, app } = await conTarea();
    const ajena = await otraOrganizacion(ctx, app);
    const asignar = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}/asignar`, authedJson(ajena.token, { asignadoA: ajena.id }));
    expect(asignar.status).toBeGreaterThanOrEqual(403);
    expect(asignar.status).toBeLessThan(500);
    const detalle = await app.request(`/rentas/${ctx.propertyId}/tareas/${tarea.id}`, authedJson(ajena.token));
    expect(detalle.status).toBeGreaterThanOrEqual(403);
    const lista = await app.request(`/rentas/${ctx.propertyId}/tareas`, authedJson(ajena.token));
    expect(lista.status).toBeGreaterThanOrEqual(403);
  });

  it("los roles sin operacion de limpieza (solo calendario, contador) no asignan: 403", async () => {
    const { ctx, asignar } = await conTarea();
    for (const rol of ["operadorSoloCalendario", "contador"] as const) expect((await asignar(ctx.staff[rol].token, {})).status, rol).toBe(403);
  });
});

describe("GET .../tareas: limpieza solo ve lo suyo; gestion ve al equipo", () => {
  it("limpieza no puede pedir las tareas de otra persona (403); sin filtro solo recibe las suyas y las libres; gestion ve todas", async () => {
    const { ctx, app } = await contexto();
    const base = { organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-07-01" };
    ctx.rentasRepo.seedTareaOperativa({ ...base, asignadoA: ctx.staff.limpieza.id });
    ctx.rentasRepo.seedTareaOperativa({ ...base, asignadoA: ctx.staff.operadorAccesoTotal.id });
    ctx.rentasRepo.seedTareaOperativa({ ...base });

    expect((await listar(app, ctx, ctx.staff.limpieza.token, `?asignadoA=${ctx.staff.operadorAccesoTotal.id}`)).status).toBe(403);
    expect((await listar(app, ctx, ctx.staff.limpieza.token, "?asignadoA=me")).tareas).toHaveLength(1);
    expect((await listar(app, ctx, ctx.staff.limpieza.token, "?asignadoA=sin_asignar")).tareas).toHaveLength(1);
    const sinFiltro = await listar(app, ctx, ctx.staff.limpieza.token, "?desde=2026-07-01&hasta=2026-07-07");
    expect(sinFiltro.tareas.map((t) => t.asignadoA).sort()).toEqual([ctx.staff.limpieza.id, null].sort());
    expect((await listar(app, ctx, ctx.staff.adminGestora.token, "?desde=2026-07-01&hasta=2026-07-07")).tareas).toHaveLength(3);
  });
});

describe("GET .../tareas/asignables", () => {
  it("la gestion lista a las personas que pueden operar limpieza (con su rol); limpieza, contador y solo-calendario -> 403", async () => {
    const { ctx, app } = await contexto();
    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/asignables`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; asignables: { id: string; nombre: string; rol: string }[] };
    expect(body.disponible).toBe(true);
    expect(body.asignables.map((a) => a.id).sort()).toEqual([ctx.staff.adminGestora.id, ctx.staff.operadorAccesoTotal.id, ctx.staff.limpieza.id].sort());
    for (const rol of ["limpieza", "contador", "operadorSoloCalendario"] as const) {
      expect((await app.request(`/rentas/${ctx.propertyId}/tareas/asignables`, authedJson(ctx.staff[rol].token))).status, rol).toBe(403);
    }
  });

  it("base sin migrar (42883): lista vacia con disponible:false, nunca un 500", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const engine = {
      withAppSession: ctx.deps.engine.withAppSession.bind(ctx.deps.engine) as typeof ctx.deps.engine.withAppSession,
    };
    const app = buildApp({
      ...ctx.deps,
      engine: {
        withAppSession: (claims, fn) =>
          engine.withAppSession(claims, (session) =>
            fn({
              exec: (sql) => session.exec(sql),
              query: async (sql, params) => {
                if (/listar_asignables_limpieza/.test(sql)) throw Object.assign(new Error("function rentas.listar_asignables_limpieza(uuid) does not exist"), { code: "42883" });
                return session.query(sql, params);
              },
            }),
          ),
      },
    });
    const res = await app.request(`/rentas/${ctx.propertyId}/tareas/asignables`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ asignables: [], disponible: false });
  });
});

describe("PUT .../admin/catalogo/unidades/:unidadId/responsable-limpieza", () => {
  async function preparar() {
    const ctx = await buildRentasTestContext(buildApp);
    const catalogo = new InMemoryRentasCatalogoRepository();
    catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Matriz", zonaHoraria: "America/Cancun", moneda: "MXN" });
    catalogo.seedUnidad({ id: ctx.unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Suite 1", duracionMinimaNoches: 1 });
    const app = buildApp({ ...ctx.deps, rentasCatalogoRepo: () => catalogo });
    const url = `/v1/rentas/${ctx.propertyId}/admin/catalogo/unidades/${ctx.unidadId}/responsable-limpieza`;
    const fijar = (token: string, responsableId: unknown, u = url) => app.request(u, { ...authedJson(token, { responsableId }), method: "PUT" });
    const unidades = async () => ((await (await app.request(`/v1/rentas/${ctx.propertyId}/admin/catalogo`, authedJson(ctx.staff.adminGestora.token))).json()) as { unidades: { responsableLimpiezaId: string | null }[] }).unidades;
    return { ctx, catalogo, app, fijar, unidades, url };
  }

  it("admin_gestora y operador:acceso_total lo fijan, el catalogo lo devuelve y null lo quita", async () => {
    const { ctx, fijar, unidades } = await preparar();
    expect((await fijar(ctx.staff.adminGestora.token, ctx.staff.limpieza.id)).status).toBe(200);
    expect((await unidades())[0]!.responsableLimpiezaId).toBe(ctx.staff.limpieza.id);
    expect((await fijar(ctx.staff.operadorAccesoTotal.token, ctx.staff.operadorAccesoTotal.id)).status).toBe(200);
    expect((await fijar(ctx.staff.adminGestora.token, null)).status).toBe(200);
    expect((await unidades())[0]!.responsableLimpiezaId).toBeNull();
  });

  it("limpieza, contador y solo-calendario -> 403", async () => {
    const { ctx, fijar } = await preparar();
    for (const rol of ["limpieza", "contador", "operadorSoloCalendario"] as const) expect((await fijar(ctx.staff[rol].token, ctx.staff.limpieza.id)).status, rol).toBe(403);
  });

  it("un responsable que no es miembro operativo (contador, otra organizacion, id inexistente) -> 422; un valor mal formado -> 400", async () => {
    const { ctx, app, fijar } = await preparar();
    const ajena = await otraOrganizacion(ctx, app);
    for (const id of [ctx.staff.contador.id, ajena.id, randomUUID()]) expect((await fijar(ctx.staff.adminGestora.token, id)).status, id).toBe(422);
    expect((await fijar(ctx.staff.adminGestora.token, "no-es-un-uuid")).status).toBe(400);
  });

  it("una unidad de otra propiedad responde 404 y el admin de otra organizacion no puede fijarla", async () => {
    const { ctx, app, fijar, url } = await preparar();
    expect((await fijar(ctx.staff.adminGestora.token, ctx.staff.limpieza.id, `/v1/rentas/${ctx.propertyId}/admin/catalogo/unidades/${randomUUID()}/responsable-limpieza`)).status).toBe(404);
    const ajena = await otraOrganizacion(ctx, app);
    const res = await app.request(url, { ...authedJson(ajena.token, { responsableId: ajena.id }), method: "PUT" });
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(res.status).toBeLessThan(500);
  });

  it("base sin la migracion 033 -> 503 honesto con la migracion que falta", async () => {
    const { ctx, catalogo, fijar } = await preparar();
    catalogo.migracion033Disponible = false;
    const res = await fijar(ctx.staff.adminGestora.token, ctx.staff.limpieza.id);
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("033");
  });
});

describe("GET/POST /internal/rentas/checkout-sweep: barrido, avisos y kill switch", () => {
  it("con el interruptor de plataforma apagado no hace nada (ni crea tareas ni avisa)", async () => {
    const { ctx, deps } = await contexto();
    ctx.calendarStore.insertOcupacionReserva({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, inicio: "2020-01-01", fin: "2020-01-05", estado: "confirmado", bloqueante: true, canalOrigenId: null, externalId: null });
    const app = buildApp({ ...deps, platformSwitchGuard: { cronBlockedBy: async () => "cron:/internal/rentas/checkout-sweep", agentBlockedBy: async () => null, invalidate: () => undefined } });
    const res = await sweep(app);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect((await listar(buildApp(deps), ctx, ctx.staff.adminGestora.token)).tareas).toHaveLength(0);
  });

  it("deja el latido del cron como ok cuando no hay fallas", async () => {
    const { ctx, app } = await contexto();
    const latido = vi.spyOn(ctx.deps.saludRepo, "recordCronHeartbeat");
    expect((await sweep(app)).status).toBe(200);
    expect(latido).toHaveBeenCalledWith(expect.objectContaining({ cronName: "/internal/rentas/checkout-sweep", status: "ok" }));
  });

  it("una reserva que falla queda aislada: el barrido responde 200 con ok:false, crea las demas tareas y el latido queda como error", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const otraUnidad = randomUUID();
    ctx.calendarStore.seedUnidad({ id: otraUnidad, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1 });
    ctx.calendarStore.insertOcupacionReserva({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, inicio: "2020-01-01", fin: "2020-01-05", estado: "confirmado", bloqueante: true, canalOrigenId: null, externalId: null });
    ctx.calendarStore.insertOcupacionReserva({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: otraUnidad, inicio: "2020-02-01", fin: "2020-02-05", estado: "confirmado", bloqueante: true, canalOrigenId: null, externalId: null });
    // El INSERT de la tarea de una de las dos unidades falla con un error real de Postgres (estado abortado como en produccion).
    let abortada = false;
    const base = ctx.deps.engine;
    const app = buildApp({
      ...ctx.deps,
      engine: {
        withAppSession: (claims, fn) =>
          base.withAppSession(claims, (session) =>
            fn({
              exec: async (sql) => {
                if (/^rollback to savepoint/i.test(sql.trim())) abortada = false;
                else if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
                return session.exec(sql);
              },
              query: async (sql, params) => {
                if (abortada) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
                if (/insert into rentas\.tarea_operativa/i.test(sql) && (params ?? []).includes(otraUnidad)) {
                  abortada = true;
                  throw Object.assign(new Error("check violation"), { code: "23514" });
                }
                return session.query(sql, params);
              },
            }),
          ),
      },
    });
    const latido = vi.spyOn(ctx.deps.saludRepo, "recordCronHeartbeat");
    const res = await sweep(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fallidos: number; tareasCreadas: string[] };
    expect(body).toMatchObject({ ok: false, fallidos: 1 });
    expect(body.tareasCreadas).toHaveLength(1);
    expect(latido).toHaveBeenCalledWith(expect.objectContaining({ cronName: "/internal/rentas/checkout-sweep", status: "error" }));
  });

  it("sin_asignar: solo el barrido avisa, solo pasadas las 18:00 locales y una vez por propiedad y dia; un GET nunca emite", async () => {
    const { ctx, app, emisiones } = await contexto();
    // 2026-06-11T00:00Z = 2026-06-10 18:00 en CDMX (zona por omision del barrido en este fixture).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
    ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-06-11" });
    ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-06-11" });

    await listar(app, ctx, ctx.staff.adminGestora.token);
    expect(emisiones).toHaveLength(0);

    expect((await sweep(app)).status).toBe(200);
    await sweep(app);
    const avisos = emisiones.filter((e) => e.evento === "rentas.limpieza.sin_asignar");
    expect(avisos).toHaveLength(2); // el segundo barrido repite la emision; la base deduplica por clave
    expect(new Set(avisos.map((a) => a.dedupeKey))).toEqual(new Set([`rentas.limpieza.sin_asignar:${ctx.propertyId}:2026-06-11`]));
    expect(avisos[0]).toMatchObject({ severidad: "atencion", cuerpo: "Tareas sin responsable: 2.", roles: ["admin_gestora", "operador:acceso_total"], enlace: "/rentas/{orgSlug}/mis-tareas" });
  });

  it("antes de las 18:00 locales no avisa", async () => {
    const { ctx, app, emisiones } = await contexto();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T23:30:00.000Z"));
    ctx.rentasRepo.seedTareaOperativa({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, programadaPara: "2026-06-11" });
    await sweep(app);
    expect(emisiones.filter((e) => e.evento === "rentas.limpieza.sin_asignar")).toHaveLength(0);
  });

  it("base sin migrar: una emision que falla no cambia el resultado del barrido (la tarea se crea igual)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const { deps } = conEmisiones(ctx.deps, {
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const app = buildApp(deps);
    ctx.calendarStore.insertOcupacionReserva({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, inicio: "2020-01-01", fin: "2020-01-05", estado: "confirmado", bloqueante: true, canalOrigenId: null, externalId: null });
    const res = await sweep(app);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tareasCreadas: string[] }).tareasCreadas).toHaveLength(1);
  });

  it("el tope por propiedad evita que una organizacion con 120 salidas atrasadas deje sin turno a la segunda", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const otraPropiedad = randomUUID();
    const otraOrg = randomUUID();
    const otraUnidad = randomUUID();
    ctx.calendarStore.seedUnidad({ id: otraUnidad, organizationId: otraOrg, propertyId: otraPropiedad, duracionMinimaNoches: 1 });
    for (let i = 0; i < 120; i += 1) {
      const dia = (n: number) => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10);
      ctx.calendarStore.insertOcupacionReserva({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, unidadId: ctx.unidadId, inicio: dia(i * 2), fin: dia(i * 2 + 1), estado: "confirmado", bloqueante: true, canalOrigenId: null, externalId: null });
    }
    ctx.calendarStore.insertOcupacionReserva({ organizationId: otraOrg, propertyId: otraPropiedad, unidadId: otraUnidad, inicio: "2025-01-01", fin: "2025-01-03", estado: "confirmado", bloqueante: true, canalOrigenId: null, externalId: null });

    const res = await sweep(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tareasCreadas: string[] };
    const porPropiedad = (propertyId: string) => [...ctx.calendarStore.tareas.values()].filter((t) => t.propertyId === propertyId).length;
    expect(porPropiedad(otraPropiedad)).toBe(1);
    expect(porPropiedad(ctx.propertyId)).toBe(40);
    expect(body.tareasCreadas).toHaveLength(41);
  });
});

describe("vercel.json: el barrido corre cada 15 minutos", () => {
  it("el path del barrido esta agendado cada 15 minutos (antes una vez al dia)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const aqui = path.dirname(fileURLToPath(import.meta.url));
    const vercel = JSON.parse(readFileSync(path.resolve(aqui, "..", "..", "..", "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.find((c) => c.path === "/internal/rentas/checkout-sweep")?.schedule).toBe("*/15 * * * *");
  });
});

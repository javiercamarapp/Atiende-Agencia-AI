// R-21 (migracion 028): rutas del panel de conversaciones, handoff, turnos y callbacks. Cada caso afirma el EFECTO
// (que se guardo, que NO se escribio, quien puede), no solo el status. Repositorio en memoria del dominio: las reglas
// de RLS/GRANT las verifica scripts/verify-restaurantes-conversaciones-handoff/ contra Postgres real.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryConversacionesRepository } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Resp = Omit<Response, "json"> & { json(): Promise<any> };
function envolver(app: ReturnType<typeof buildApp>): { request(input: string, init?: RequestInit): Promise<Resp> } {
  return { request: (input, init) => Promise.resolve(app.request(input, init)) as Promise<Resp> };
}

async function construir(opts: { sinRepo?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const store = new InMemoryConversacionesRepository({ actorUserId: ctx.staff.owner.id });
  let actor = ctx.staff.owner.id;
  let admin = true;
  const deps: AppDeps = { ...ctx.deps, ...(opts.sinRepo ? {} : { conversacionesRepo: () => store.comoActor(actor, admin) }) };
  const conv = randomUUID();
  store.conversaciones.push({ canal: "whatsapp", id: conv, organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, telefono: "+5219990000001", mensajes: [{ rol: "cliente", texto: "Hola, quiero hablar con alguien", createdAt: null }], actividadAt: new Date().toISOString() });
  store.numeroPorSucursal.add(ctx.propertyIdA);
  const app = envolver(buildApp(deps));
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin`;
  const como = (u: { id: string }, esAdmin: boolean) => {
    actor = u.id;
    admin = esAdmin;
  };
  return { ctx, store, app, base, conv, como };
}

describe("bandeja y detalle", () => {
  it("lista la conversacion con estado 'agente' y devuelve cobertura (sin turnos: sinCobertura)", async () => {
    const { ctx, app, base } = await construir();
    const r = await app.request(`${base}/conversaciones`, authedGet(ctx.staff.staffSucursalA.token));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ disponible: true, total: 1, cobertura: { sinCobertura: true } });
    expect(body.items[0]).toMatchObject({ canal: "whatsapp", estado: "agente", telefono: "+5219990000001", escalacion: null });
  });

  it("el repartidor y otra organizacion no entran; una sucursal fuera del alcance del staff tampoco", async () => {
    const { ctx, app, base } = await construir();
    expect((await app.request(`${base}/conversaciones`, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(`${base}/conversaciones`, authedGet(ctx.staff.otroOrgOwner.token))).status).toBeGreaterThanOrEqual(403);
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdB}/admin/conversaciones`, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    expect((await app.request(`${base}/conversaciones`)).status).toBe(401);
  });

  it("filtros invalidos -> 400", async () => {
    const { ctx, app, base } = await construir();
    for (const q of ["estado=inventado", "canal=sms", "limit=0", "offset=-1"]) {
      expect((await app.request(`${base}/conversaciones?${q}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    }
  });

  it("detalle: mensajes y toma; id mal formado 404; canal invalido 400", async () => {
    const { ctx, app, base, conv } = await construir();
    const d = await (await app.request(`${base}/conversaciones/whatsapp/${conv}`, authedGet(ctx.staff.owner.token))).json();
    expect(d).toMatchObject({ canal: "whatsapp", transcripcionDisponible: true, handoff: null, notas: [] });
    expect(d.mensajes[0]).toMatchObject({ rol: "cliente" });
    expect((await app.request(`${base}/conversaciones/whatsapp/no-es-uuid`, authedGet(ctx.staff.owner.token))).status).toBe(404);
    expect((await app.request(`${base}/conversaciones/sms/${conv}`, authedGet(ctx.staff.owner.token))).status).toBe(400);
    expect((await app.request(`${base}/conversaciones/whatsapp/${randomUUID()}`, authedGet(ctx.staff.owner.token))).status).toBe(404);
  });
});

describe("tomar / devolver / cerrar / notas / responder", () => {
  it("flujo completo: tomar -> nota -> responder -> devolver; el agente queda libre de nuevo", async () => {
    const { ctx, app, base, conv, store, como } = await construir();
    como(ctx.staff.staffSucursalA, false);
    const tomar = await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"));
    expect(tomar.status).toBe(201);
    const { handoffId } = await tomar.json();
    expect(store.handoffs[0]).toMatchObject({ estado: "tomada", tomadaPor: ctx.staff.staffSucursalA.id });

    const nota = await app.request(`${base}/handoffs/${handoffId}/notas`, authedJson(ctx.staff.staffSucursalA.token, { texto: "Quiere factura" }, "POST"));
    expect(nota.status).toBe(201);
    const resp = await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffSucursalA.token, { texto: "Ya le atiendo" }, "POST"));
    expect(resp.status).toBe(201);
    expect(store.outbox).toEqual([{ organizationId: ctx.organizationId, to: "+5219990000001", body: "Ya le atiendo" }]);

    const bandeja = await (await app.request(`${base}/conversaciones`, authedGet(ctx.staff.staffSucursalA.token))).json();
    expect(bandeja.items[0]).toMatchObject({ estado: "tomada", handoffId });

    const dev = await app.request(`${base}/handoffs/${handoffId}/devolver`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"));
    expect(await dev.json()).toMatchObject({ estado: "devuelta", cambio: true });
    expect(store.handoffs[0]!.estado).toBe("devuelta");
  });

  it("la segunda persona recibe 409; el repartidor 403; una nota vacia 400", async () => {
    const { ctx, app, base, conv, como } = await construir();
    como(ctx.staff.staffSucursalA, false);
    const tomar = await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"));
    const { handoffId } = await tomar.json();
    como(ctx.staff.owner, false); // otra persona (sin privilegio de administrador sobre la toma)
    expect((await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(409);
    expect((await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.repartidor.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(`${base}/handoffs/${handoffId}/notas`, authedJson(ctx.staff.owner.token, { texto: "   " }, "POST"))).status).toBe(400);
    expect((await app.request(`${base}/handoffs/${handoffId}/notas`, authedJson(ctx.staff.owner.token, { texto: "x".repeat(2001) }, "POST"))).status).toBe(400);
  });

  it("responder sin ser quien tomo -> 403; sin numero de WhatsApp -> 409", async () => {
    const { ctx, app, base, conv, store, como } = await construir();
    como(ctx.staff.staffSucursalA, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).json();
    como(ctx.staff.admin, true);
    expect((await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.admin.token, { texto: "hola" }, "POST"))).status).toBe(403);
    como(ctx.staff.staffSucursalA, false);
    store.numeroPorSucursal.clear();
    const r = await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffSucursalA.token, { texto: "hola" }, "POST"));
    expect(r.status).toBe(409);
  });

  // QA R1 agentes-20: fuera de la ventana de 24 h de WhatsApp el panel no puede decir "encolado" (Meta rechaza el texto libre).
  it("responder con el ultimo mensaje del cliente de hace mas de 24 h -> 409 con mensaje claro y nada se encola", async () => {
    const { ctx, app, base, conv, store, como } = await construir();
    como(ctx.staff.staffSucursalA, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).json();
    const hace25h = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const i = store.conversaciones.findIndex((x) => x.id === conv);
    const c = store.conversaciones[i]!;
    store.conversaciones[i] = { ...c, actividadAt: hace25h, mensajes: [{ ...c.mensajes[0]!, createdAt: hace25h }] };
    const r = await app.request(`${base}/handoffs/${handoffId}/responder`, authedJson(ctx.staff.staffSucursalA.token, { texto: "Una disculpa por la demora" }, "POST"));
    expect(r.status).toBe(409);
    expect(JSON.stringify(await r.json())).toMatch(/24 horas/);
    expect(store.outbox).toHaveLength(0);
  });

  it("un administrador puede cerrar una toma ajena", async () => {
    const { ctx, app, base, conv, como } = await construir();
    como(ctx.staff.staffSucursalA, false);
    const { handoffId } = await (await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).json();
    como(ctx.staff.admin, true);
    const r = await app.request(`${base}/handoffs/${handoffId}/cerrar`, authedJson(ctx.staff.admin.token, {}, "POST"));
    expect(await r.json()).toMatchObject({ estado: "cerrada", cambio: true });
  });
});

describe("turnos y cobertura", () => {
  const miembroFalso = () => randomUUID();

  it("PUT reemplaza los turnos (solo owner/admin) y GET devuelve cobertura; la bitacora registra el cambio", async () => {
    const { ctx, app, base } = await construir();
    const ana = miembroFalso();
    const turnos = [
      { nombre: "Turno 1", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "00:00", termina: "23:59", miembros: [{ userId: ana, orden: 1 }] },
      { nombre: "Turno 2", dias: [0, 1, 2, 3, 4, 5, 6], inicia: "18:00", termina: "01:00", miembros: [] },
    ];
    const put = await app.request(`${base}/turnos`, authedJson(ctx.staff.owner.token, { turnos }, "PUT"));
    expect(put.status).toBe(200);
    const get = await (await app.request(`${base}/turnos`, authedGet(ctx.staff.staffSucursalA.token))).json();
    expect(get.turnos).toHaveLength(2);
    expect(get.cobertura.sinCobertura).toBe(false);
    expect(get.cobertura.guardia[0]).toMatchObject({ userId: ana, orden: 1 });
    expect(ctx.restaurantesRepo.auditLog.some((r) => r.action === "configuracion.turnos_actualizados" && r.actorUserId === ctx.staff.owner.id)).toBe(true);
  });

  it("staff (rol staff) no escribe turnos (403) y datos invalidos -> 400 sin cambiar nada", async () => {
    const { ctx, app, base, store } = await construir();
    const ok = [{ nombre: "T1", dias: [1], inicia: "12:00", termina: "18:00", miembros: [] }];
    expect((await app.request(`${base}/turnos`, authedJson(ctx.staff.staffSucursalA.token, { turnos: ok }, "PUT"))).status).toBe(403);
    expect((await app.request(`${base}/turnos`, authedJson(ctx.staff.owner.token, { turnos: [{ ...ok[0], termina: "12:00" }] }, "PUT"))).status).toBe(400);
    expect((await app.request(`${base}/turnos`, authedJson(ctx.staff.owner.token, { turnos: "x" }, "PUT"))).status).toBe(400);
    expect(store.turnos).toHaveLength(0);
  });

  it("una toma pendiente sin personal de guardia escala directo a administracion en la bandeja", async () => {
    const { ctx, app, base, store, conv } = await construir();
    store.handoffs.push({ id: randomUUID(), organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, canal: "whatsapp", conversationId: conv, estado: "pendiente", solicitadoPor: "agente", motivo: "queja", solicitadaAt: new Date(Date.now() - 2 * 60000).toISOString(), ultimoClienteAt: null, tomadaPor: null, tomadaAt: null, createdAt: 1 });
    const b = await (await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token))).json();
    expect(b.items[0]).toMatchObject({ estado: "pendiente", motivo: "queja", escalacion: { nivel: 2, sinCobertura: true, avisarAdministracion: true } });
  });
});

describe("callbacks", () => {
  it("registra intentos: 'no_contesto' deja abierto, 'contactado' resuelve; validaciones", async () => {
    const { ctx, app, base, store } = await construir();
    const cb = randomUUID();
    store.callbacks.push({ organizationId: ctx.organizationId, id: cb, propertyId: ctx.propertyIdA, customerName: "Cliente", customerPhone: "+521", reason: "queja", message: null, source: "voice", resolved: false, createdAt: new Date().toISOString(), intentos: [] });
    const url = `${base}/callbacks/${cb}/intentos`;
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { resultado: "no_contesto", nota: "ocupado" }, "POST"))).status).toBe(201);
    expect((await (await app.request(`${base}/callbacks?soloAbiertos=1`, authedGet(ctx.staff.owner.token))).json()).items).toHaveLength(1);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { resultado: "contactado" }, "POST"))).status).toBe(201);
    const lista = await (await app.request(`${base}/callbacks`, authedGet(ctx.staff.owner.token))).json();
    expect(lista.items[0]).toMatchObject({ resuelto: true });
    expect(lista.items[0].intentos.map((i: { resultado: string }) => i.resultado)).toEqual(["contactado", "no_contesto"]);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { resultado: "inventado" }, "POST"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { resultado: "buzon", proximoIntentoEn: "no-fecha" }, "POST"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, { resultado: "buzon" }, "POST"))).status).toBe(403);
    expect((await app.request(`${base}/callbacks/${randomUUID()}/intentos`, authedJson(ctx.staff.owner.token, { resultado: "buzon" }, "POST"))).status).toBe(403);
  });
});

describe("despliegue sin migrar o sin repositorio", () => {
  it("base sin migrar: lecturas vacias con disponible=false, escrituras 503", async () => {
    const { ctx, app, base, store, conv } = await construir();
    store.disponible = false;
    const b = await (await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token))).json();
    expect(b).toMatchObject({ disponible: false, total: 0, items: [] });
    expect((await app.request(`${base}/turnos`, authedGet(ctx.staff.owner.token))).status).toBe(200);
    expect((await app.request(`${base}/conversaciones/whatsapp/${conv}/tomar`, authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(503);
    expect((await app.request(`${base}/conversaciones/whatsapp/${conv}`, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });

  it("sin conversacionesRepo en el despliegue: 503 honesto", async () => {
    const { ctx, app, base } = await construir({ sinRepo: true });
    expect((await app.request(`${base}/conversaciones`, authedGet(ctx.staff.owner.token))).status).toBe(503);
  });
});

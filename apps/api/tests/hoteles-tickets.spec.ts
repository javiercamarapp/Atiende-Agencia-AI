// H-05 -- tickets de huesped con SLA: integracion HTTP real (app.request) sobre el repositorio en
// memoria. RLS/GRANT/triggers/CHECK y la funcion de barrido las cubre scripts/verify-hoteles-tickets-sla
// contra Postgres real; el SAVEPOINT contra base sin migrar lo cubre
// packages/domain-hoteles/tests/tickets/postgres-repository-savepoint.spec.ts (AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryGuestTicketRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { runTicketsSlaSweep } from "../src/routes/verticals/hoteles/tickets-sla-cron.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

interface TicketBody {
  id: string;
  departamento: string;
  prioridad: string;
  estado: string;
  canal: string;
  slaMinutos: number;
  slaVenceEn: string;
  estadoSla: string;
  asignadoA: string | null;
  escaladoARoles: string[];
  notaResolucion: string | null;
  clasificadoAutomaticamente?: boolean;
  bitacora?: { tipo: string; sistema: boolean }[];
}

async function setup(opts: { migrated?: boolean; now?: () => Date } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const repo = new InMemoryGuestTicketRepository(opts);
  for (const s of Object.values(ctx.staff)) repo.seedStaff(ctx.propertyId, s.id);
  const deps = { ...ctx.deps, hotelesTicketsRepo: () => repo };
  const app = buildApp(deps);
  const base = `/hoteles/${ctx.propertyId}/tickets`;
  const post = (path: string, token: string, body: unknown = {}) => app.request(`${base}${path}`, authedJson(token, body));
  const get = (path: string, token: string) => app.request(`${base}${path}`, authedJson(token));
  const put = (path: string, token: string, body: unknown) => app.request(`${base}${path}`, { ...authedJson(token, body), method: "PUT" });
  async function crear(token: string, body: Record<string, unknown> = {}): Promise<TicketBody> {
    const res = await post("", token, { mensaje: "Necesito toallas", ...body });
    expect(res.status).toBe(201);
    return (await res.json()) as TicketBody;
  }
  return { ctx, repo, deps, app, base, post, get, put, crear };
}
type Setup = Awaited<ReturnType<typeof setup>>;

describe("crear tickets", () => {
  it("clasifica un mensaje libre (departamento y prioridad) y fija el SLA por prioridad", async () => {
    const s = await setup();
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Hay una fuga de agua, es urgente" });
    expect(t).toMatchObject({ departamento: "maintenance", prioridad: "alta", estado: "abierto", canal: "staff", slaMinutos: 30, clasificadoAutomaticamente: true });
  });

  it("respeta departamento/prioridad explicitos y cualquier rol hotelero puede registrar (accountant incluido)", async () => {
    const s = await setup();
    const t = await s.crear(s.ctx.staff.accountant.token, { mensaje: "Cobro duplicado", departamento: "accountant", prioridad: "baja", canal: "qr" });
    expect(t).toMatchObject({ departamento: "accountant", prioridad: "baja", canal: "qr", slaMinutos: 480, clasificadoAutomaticamente: false });
  });

  it("validacion: sin mensaje, canal 'resena' (solo lo produce desde-resena), departamento invalido -> 400; sin token -> 401", async () => {
    const s = await setup();
    const tk = s.ctx.staff.frontdesk.token;
    expect((await s.post("", tk, { mensaje: "  " })).status).toBe(400);
    expect((await s.post("", tk, { mensaje: "x", canal: "resena" })).status).toBe(400);
    expect((await s.post("", tk, { mensaje: "x", departamento: "ceo" })).status).toBe(400);
    expect((await s.app.request(s.base, { method: "GET" })).status).toBe(401);
  });

  it("asignar a OTRA persona al crear exige owner/gm/frontdesk (housekeeping 403; a si misma si)", async () => {
    const s = await setup();
    const hk = s.ctx.staff.housekeeping;
    expect((await s.post("", hk.token, { mensaje: "x", asignadoA: s.ctx.staff.fnb.id })).status).toBe(403);
    expect((await s.post("", hk.token, { mensaje: "x", asignadoA: hk.id })).status).toBe(201);
    expect((await s.post("", s.ctx.staff.frontdesk.token, { mensaje: "x", asignadoA: s.ctx.staff.fnb.id })).status).toBe(201);
  });
});

describe("politica de SLA", () => {
  it("owner la define; el ticket nuevo la usa; fnb no puede (403); rango invalido -> 400", async () => {
    const s = await setup();
    const res = await s.put("/sla", s.ctx.staff.owner.token, { departamento: "frontdesk", prioridad: "alta", minutos: 10 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ departamento: "frontdesk", prioridad: "alta", minutos: 10 });
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Hola", departamento: "frontdesk", prioridad: "alta" });
    expect(t.slaMinutos).toBe(10);
    expect((await s.put("/sla", s.ctx.staff.fnb.token, { departamento: "fnb", prioridad: "baja", minutos: 60 })).status).toBe(403);
    expect((await s.put("/sla", s.ctx.staff.frontdesk.token, { departamento: "fnb", prioridad: "baja", minutos: 60 })).status).toBe(403);
    for (const minutos of [0, 43201, 1.5, "10"]) {
      expect((await s.put("/sla", s.ctx.staff.gm.token, { departamento: "fnb", prioridad: "baja", minutos })).status).toBe(400);
    }
  });

  it("GET /sla devuelve la tabla efectiva (configurada vs default por prioridad)", async () => {
    const s = await setup();
    await s.put("/sla", s.ctx.staff.gm.token, { departamento: "fnb", prioridad: "media", minutos: 45 });
    const body = (await (await s.get("/sla", s.ctx.staff.fnb.token)).json()) as {
      disponible: boolean; porDefecto: Record<string, number>; efectiva: { departamento: string; prioridad: string; minutos: number; configurada: boolean }[];
    };
    expect(body.disponible).toBe(true);
    expect(body.porDefecto).toEqual({ alta: 30, media: 120, baja: 480 });
    expect(body.efectiva).toHaveLength(8 * 3);
    expect(body.efectiva.find((e) => e.departamento === "fnb" && e.prioridad === "media")).toMatchObject({ minutos: 45, configurada: true });
    expect(body.efectiva.find((e) => e.departamento === "fnb" && e.prioridad === "alta")).toMatchObject({ minutos: 30, configurada: false });
  });
});

describe("ciclo de vida", () => {
  it("iniciar -> cerrar con nota; un ticket cerrado no se reabre (409)", async () => {
    const s = await setup();
    const tk = s.ctx.staff.frontdesk.token;
    const t = await s.crear(tk);
    expect(await (await s.post(`/${t.id}/iniciar`, tk)).json()).toMatchObject({ estado: "en_progreso" });
    expect(await (await s.post(`/${t.id}/cerrar`, tk, { nota: "Entregadas" })).json()).toMatchObject({ estado: "cerrado", notaResolucion: "Entregadas", estadoSla: "cerrado" });
    expect((await s.post(`/${t.id}/iniciar`, tk)).status).toBe(409);
    expect((await s.post(`/${t.id}/cerrar`, tk)).status).toBe(409);
    expect((await s.post(`/${t.id}/cancelar`, tk)).status).toBe(409);
  });

  it("solo opera quien es manager, del departamento, o el responsable asignado", async () => {
    const s = await setup();
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Sabanas", departamento: "housekeeping" });
    expect((await s.post(`/${t.id}/iniciar`, s.ctx.staff.fnb.token)).status).toBe(403);
    expect((await s.post(`/${t.id}/iniciar`, s.ctx.staff.housekeeping.token)).status).toBe(200);
    const ajeno = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Menu", departamento: "fnb", asignadoA: s.ctx.staff.housekeeping.id });
    expect((await s.post(`/${ajeno.id}/iniciar`, s.ctx.staff.housekeeping.token)).status).toBe(200);
  });

  it("escalar a mano: solo manager; fija roles gm/owner", async () => {
    const s = await setup();
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Sabanas", departamento: "housekeeping" });
    expect((await s.post(`/${t.id}/escalar`, s.ctx.staff.housekeeping.token)).status).toBe(403);
    const res = await s.post(`/${t.id}/escalar`, s.ctx.staff.gm.token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: "escalado", escaladoARoles: ["gm", "owner"] });
    expect((await s.post(`/${t.id}/escalar`, s.ctx.staff.gm.token)).status).toBe(409);
  });

  it("reasignar departamento: solo manager, y el SLA no se reinicia", async () => {
    const s = await setup();
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Sabanas", departamento: "housekeeping" });
    expect((await s.post(`/${t.id}/reasignar`, s.ctx.staff.housekeeping.token, { departamento: "fnb" })).status).toBe(403);
    expect((await s.post(`/${t.id}/reasignar`, s.ctx.staff.frontdesk.token, { departamento: "ceo" })).status).toBe(400);
    const r = (await (await s.post(`/${t.id}/reasignar`, s.ctx.staff.frontdesk.token, { departamento: "maintenance" })).json()) as TicketBody;
    expect(r).toMatchObject({ departamento: "maintenance", slaMinutos: t.slaMinutos, slaVenceEn: t.slaVenceEn });
  });

  it("asignar responsable: manager a cualquiera; un departamento solo a si mismo; staff ajeno -> 400; quitar con null", async () => {
    const s = await setup();
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Sabanas", departamento: "housekeeping" });
    const hk = s.ctx.staff.housekeeping;
    expect((await s.post(`/${t.id}/asignar`, hk.token, { asignadoA: s.ctx.staff.fnb.id })).status).toBe(403);
    expect(await (await s.post(`/${t.id}/asignar`, hk.token, { asignadoA: hk.id })).json()).toMatchObject({ asignadoA: hk.id });
    expect(await (await s.post(`/${t.id}/asignar`, s.ctx.staff.gm.token, { asignadoA: s.ctx.staff.fnb.id })).json()).toMatchObject({ asignadoA: s.ctx.staff.fnb.id });
    expect((await s.post(`/${t.id}/asignar`, s.ctx.staff.gm.token, { asignadoA: randomUUID() })).status).toBe(400);
    expect(await (await s.post(`/${t.id}/asignar`, s.ctx.staff.gm.token, { asignadoA: null })).json()).toMatchObject({ asignadoA: null });
  });

  it("ticket inexistente -> 404; id mal formado -> 400", async () => {
    const s = await setup();
    expect((await s.post(`/${randomUUID()}/iniciar`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await s.get(`/${randomUUID()}`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await s.post(`/no-es-uuid/iniciar`, s.ctx.staff.owner.token)).status).toBe(400);
  });

  it("el detalle trae la bitacora (creado, en_progreso, cerrado) con actor", async () => {
    const s = await setup();
    const tk = s.ctx.staff.frontdesk.token;
    const t = await s.crear(tk);
    await s.post(`/${t.id}/iniciar`, tk);
    await s.post(`/${t.id}/cerrar`, tk, { nota: "ok" });
    const det = (await (await s.get(`/${t.id}`, tk)).json()) as TicketBody;
    expect(det.bitacora!.map((e) => e.tipo)).toEqual(["creado", "en_progreso", "cerrado"]);
  });
});

describe("listado", () => {
  it("filtra por estado/departamento/activos y marca el estado de SLA", async () => {
    const s = await setup();
    const tk = s.ctx.staff.frontdesk.token;
    const a = await s.crear(tk, { mensaje: "a", departamento: "fnb" });
    await s.crear(tk, { mensaje: "b", departamento: "housekeeping" });
    await s.post(`/${a.id}/cerrar`, tk);
    const lista = async (q: string) => ((await (await s.get(q, tk)).json()) as { disponible: boolean; tickets: TicketBody[] });
    expect((await lista("")).tickets).toHaveLength(2);
    expect((await lista("?activos=1")).tickets.map((t) => t.departamento)).toEqual(["housekeeping"]);
    expect((await lista("?estado=cerrado")).tickets).toHaveLength(1);
    expect((await lista("?departamento=fnb")).tickets).toHaveLength(1);
    expect((await lista("")).tickets.find((t) => t.departamento === "housekeeping")!.estadoSla).toBe("en_tiempo");
    expect((await s.get("?estado=raro", tk)).status).toBe(400);
  });
});

describe("crear ticket desde una resena", () => {
  async function seedReview(s: Setup, over: { sentiment?: "negativo" | "muy_negativo" | "positivo"; texto?: string; topics?: { topic: string }[] } = {}) {
    const topics = (over.topics ?? [{ topic: "aire_acondicionado" }]).map((t) => ({ topic: t.topic, esConocido: true, menciones: 1, palabrasClave: [] }));
    const sentiment = over.sentiment ?? "negativo";
    const review = await s.ctx.hotelesRepo.insertGuestReview({
      organizationId: s.ctx.organizationId, propertyId: s.ctx.propertyId, guestId: null, folioId: null, source: "google", externalId: randomUUID(),
      texto: over.texto ?? "El aire acondicionado no funciona", idioma: "es", calificacion: 2, stayState: "post_estancia", isPublic: true, topics,
      sentiment, sentimentScore: -0.6, createdBy: null,
    });
    // El repo en memoria de tickets es un espejo aparte: se siembra la misma resena para el listado de pendientes.
    s.repo.seedReview({ id: review.id, propertyId: s.ctx.propertyId, source: "google", texto: review.texto, calificacion: 2, sentiment, topics: topics.map((t) => ({ topic: t.topic, menciones: 1 })), createdAt: review.createdAt });
    return review;
  }

  it("lista las resenas con queja sin ticket, con la sugerencia de departamento/prioridad", async () => {
    const s = await setup();
    await seedReview(s);
    await seedReview(s, { sentiment: "positivo", texto: "Todo excelente" });
    const body = (await (await s.get("/resenas-pendientes", s.ctx.staff.frontdesk.token)).json()) as { disponible: boolean; resenas: { sentimiento: string; sugerencia: { departamento: string; prioridad: string } }[] };
    expect(body.disponible).toBe(true);
    expect(body.resenas).toHaveLength(1);
    expect(body.resenas[0]).toMatchObject({ sentimiento: "negativo", sugerencia: { departamento: "maintenance", prioridad: "media" } });
  });

  it("crea el ticket reutilizando la resena (canal resena, departamento por tema), una sola vez (409), y deja de estar pendiente", async () => {
    const s = await setup();
    const review = await seedReview(s, { sentiment: "muy_negativo" });
    const res = await s.post("/desde-resena", s.ctx.staff.frontdesk.token, { resenaId: review.id });
    expect(res.status).toBe(201);
    const t = (await res.json()) as TicketBody & { resenaId: string; mensaje: string };
    expect(t).toMatchObject({ canal: "resena", departamento: "maintenance", prioridad: "alta", resenaId: review.id });
    expect(t.mensaje.startsWith("Resena (google 2/5): ")).toBe(true);
    expect((await s.post("/desde-resena", s.ctx.staff.frontdesk.token, { resenaId: review.id })).status).toBe(409);
    expect(((await (await s.get("/resenas-pendientes", s.ctx.staff.frontdesk.token)).json()) as { resenas: unknown[] }).resenas).toEqual([]);
  });

  it("resena positiva -> 400; inexistente -> 404; resenaId mal formado -> 400; fnb/housekeeping -> 403", async () => {
    const s = await setup();
    const positiva = await seedReview(s, { sentiment: "positivo", texto: "Genial" });
    const negativa = await seedReview(s);
    const tk = s.ctx.staff.frontdesk.token;
    expect((await s.post("/desde-resena", tk, { resenaId: positiva.id })).status).toBe(400);
    expect((await s.post("/desde-resena", tk, { resenaId: randomUUID() })).status).toBe(404);
    expect((await s.post("/desde-resena", tk, { resenaId: "x" })).status).toBe(400);
    expect((await s.post("/desde-resena", s.ctx.staff.fnb.token, { resenaId: negativa.id })).status).toBe(403);
    expect((await s.get("/resenas-pendientes", s.ctx.staff.housekeeping.token)).status).toBe(403);
  });

  it("permite sobreescribir departamento y prioridad", async () => {
    const s = await setup();
    const review = await seedReview(s);
    const t = (await (await s.post("/desde-resena", s.ctx.staff.gm.token, { resenaId: review.id, departamento: "gm", prioridad: "alta" })).json()) as TicketBody;
    expect(t).toMatchObject({ departamento: "gm", prioridad: "alta" });
  });
});

describe("base SIN la migracion 034: honesta, nunca 500", () => {
  it("lecturas vacias con disponible:false y escrituras 503", async () => {
    const s = await setup({ migrated: false });
    const tk = s.ctx.staff.frontdesk.token;
    expect(await (await s.get("", tk)).json()).toMatchObject({ disponible: false, tickets: [] });
    expect(await (await s.get("/sla", tk)).json()).toMatchObject({ disponible: false, politicas: [] });
    expect(await (await s.get("/resenas-pendientes", tk)).json()).toMatchObject({ disponible: false, resenas: [] });
    expect((await s.post("", tk, { mensaje: "x" })).status).toBe(503);
    expect((await s.put("/sla", s.ctx.staff.owner.token, { departamento: "fnb", prioridad: "baja", minutos: 5 })).status).toBe(503);
    expect((await s.get(`/${randomUUID()}`, tk)).status).toBe(404);
  });
});

describe("cron de barrido de SLA (/internal/hoteles/tickets-sla)", () => {
  const cronHeaders = (ctx: HotelesTestContext) => ({ "x-atiende-internal-secret": ctx.deps.env.internalSecret });
  const HORAS = 3 * 3600_000;

  it("sin secreto: 401", async () => {
    const s = await setup();
    expect((await s.app.request("/internal/hoteles/tickets-sla", { method: "POST" })).status).toBe(401);
  });

  it("escala a gerente/dueno los vencidos (creados hace 3 h con SLA de 2 h) y es idempotente", async () => {
    const s = await setup({ now: () => new Date(Date.now() - HORAS) });
    const vencido = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Sabanas", departamento: "housekeeping" });
    const res = await s.app.request("/internal/hoteles/tickets-sla", { method: "POST", headers: cronHeaders(s.ctx) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; escalados_total: number; avisados_total: number; corridas: { omitida: string | null; error: string | null }[] };
    expect(body).toMatchObject({ ok: true, escalados_total: 1, avisados_total: 0 });
    const det = (await (await s.get(`/${vencido.id}`, s.ctx.staff.gm.token)).json()) as TicketBody;
    expect(det).toMatchObject({ estado: "escalado", escaladoARoles: ["gm", "owner"] });
    expect(det.bitacora!.find((e) => e.tipo === "escalado")).toMatchObject({ sistema: true });
    const again = (await (await s.app.request("/internal/hoteles/tickets-sla", { method: "POST", headers: cronHeaders(s.ctx) })).json()) as { escalados_total: number };
    expect(again.escalados_total).toBe(0);
  });

  it("avisa al 75% sin escalar (reloj inyectado)", async () => {
    const t0 = new Date("2026-03-10T10:00:00.000Z");
    const s = await setup({ now: () => t0 });
    const t = await s.crear(s.ctx.staff.frontdesk.token, { mensaje: "Hola", departamento: "frontdesk", prioridad: "media" }); // 120 min
    const results = await runTicketsSlaSweep(s.deps, new Date(t0.getTime() + 100 * 60_000));
    const mine = results.find((r) => r.propertyId === s.ctx.propertyId)!;
    expect(mine).toMatchObject({ escalados: 0, avisados: 1, omitida: null, error: null });
    expect((await s.repo.findTicket(s.ctx.propertyId, t.id))!.status).toBe("abierto");
  });

  it("base sin migrar: la property se omite (migracion_pendiente) sin fallar el latido", async () => {
    const s = await setup({ migrated: false });
    const body = (await (await s.app.request("/internal/hoteles/tickets-sla", { method: "POST", headers: cronHeaders(s.ctx) })).json()) as { ok: boolean; corridas: { omitida: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.corridas.every((c) => c.omitida === "migracion_pendiente")).toBe(true);
  });

  it("un fallo real de una property se reporta (ok:false) en vez de esconderse", async () => {
    const s = await setup();
    s.repo.sweepSla = async () => {
      throw new Error("boom");
    };
    const body = (await (await s.app.request("/internal/hoteles/tickets-sla", { method: "POST", headers: cronHeaders(s.ctx) })).json()) as { ok: boolean; corridas: { error: string | null }[] };
    expect(body.ok).toBe(false);
    expect(body.corridas.some((c) => c.error === "boom")).toBe(true);
  });
});

// H-06 -- grupos: cotizacion, bloqueo (allotment), pickup, rooming, anticipos registrados y liberacion por cutoff.
// Integracion HTTP real (app.request) sobre el repositorio en memoria. RLS/GRANT/triggers/funciones definer y la
// concurrencia los cubre scripts/verify-hoteles-grupos contra Postgres real; el SAVEPOINT contra base sin migrar lo cubre
// packages/domain-hoteles/tests/grupos/postgres-repository-savepoint.spec.ts (AbortAwareFakeSession).
import { describe, expect, it } from "vitest";
import { InMemoryGruposRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { runGruposLiberacion } from "../src/routes/verticals/hoteles/grupos-liberacion-cron.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

const NOW = new Date("2031-05-01T12:00:00Z");
const NIGHTS = ["2031-06-12", "2031-06-13", "2031-06-14"];

interface QuoteBody {
  id: string;
  estado: string;
  totalCentavos: number;
  brutoCentavos: number;
  anticipoRegistradoCentavos: number;
  anticipos: { referencia: string; montoCentavos: number }[];
  bloqueoId: string | null;
}
interface BlockBody {
  id: string;
  estado: string;
  fechaLiberacion: string;
  pickup: { cuartosNocheBloqueados: number; cuartosNocheConfirmados: number; cuartosNochePendientes: number; porcentaje: number };
  rooming: { id: string; estado: string }[];
  tipoLiberacion: string | null;
}

async function setup(opts: { migrated?: boolean; totalRooms?: number; bookedLastNight?: number } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const inventory = NIGHTS.map((date, i) => ({
    propertyId: ctx.propertyId, roomTypeId: ctx.roomTypeId, date, totalRooms: opts.totalRooms ?? 10, bookedRooms: i === 2 ? (opts.bookedLastNight ?? 0) : 0,
  }));
  const repo = new InMemoryGruposRepository({ migrated: opts.migrated, now: () => NOW, roomTypes: { [ctx.propertyId]: [ctx.roomTypeId] }, inventory });
  const deps = { ...ctx.deps, hotelesGruposRepo: () => repo };
  const app = buildApp(deps);
  const url = (p: string) => `/hoteles/${ctx.propertyId}/grupos${p}`;
  const get = (path: string, token: string) => app.request(url(path), authedJson(token));
  const post = (path: string, token: string, body: unknown = {}) => app.request(url(path), authedJson(token, body));
  const tk = (k: keyof HotelesTestContext["staff"]) => ctx.staff[k].token;
  const quoteBody = (over: Record<string, unknown> = {}) => ({
    nombreGrupo: "Boda Garcia", contacto: "Ana Garcia", correoContacto: "ana@example.com", llegada: "2031-06-12", salida: "2031-06-15", fechaLiberacion: "2031-06-05",
    vigenteHasta: "2031-05-08T18:00:00Z", descuentoBps: 0, anticipoRequeridoCentavos: 0,
    renglones: [{ tipoHabitacionId: ctx.roomTypeId, cuartos: 5, tarifaCentavos: 150000 }], ...over,
  });
  const createQuote = async (over: Record<string, unknown> = {}, token = tk("reservations")) => {
    const res = await post("/cotizaciones", token, quoteBody(over));
    expect(res.status).toBe(201);
    return (await res.json()) as QuoteBody;
  };
  const blockedQuote = async (over: Record<string, unknown> = {}) => {
    const q = await createQuote(over);
    expect((await post(`/cotizaciones/${q.id}/enviar`, tk("reservations"))).status).toBe(200);
    const res = await post(`/cotizaciones/${q.id}/aceptar`, tk("reservations"));
    expect(res.status).toBe(201);
    return { quote: q, block: (await res.json()) as BlockBody };
  };
  return { ctx, repo, deps, app, get, post, tk, quoteBody, createQuote, blockedQuote };
}

describe("cotizacion", () => {
  it("crea con total en centavos y exige rol: reservations/owner/gm si, frontdesk/accountant/housekeeping 403, sin token 401", async () => {
    const s = await setup();
    const q = await s.createQuote({ descuentoBps: 1000, anticipoRequeridoCentavos: 500000 });
    expect(q).toMatchObject({ brutoCentavos: 2250000, totalCentavos: 2025000, estado: "borrador" });
    for (const role of ["owner", "gm"] as const) expect((await s.post("/cotizaciones", s.tk(role), s.quoteBody())).status).toBe(201);
    for (const role of ["frontdesk", "accountant", "housekeeping", "fnb"] as const) expect((await s.post("/cotizaciones", s.tk(role), s.quoteBody())).status).toBe(403);
    expect((await s.app.request(`/hoteles/${s.ctx.propertyId}/grupos/cotizaciones`)).status).toBe(401);
  });

  it("lectura: owner/gm/frontdesk/reservations/accountant ven; housekeeping y fnb 403", async () => {
    const s = await setup();
    await s.createQuote();
    for (const role of ["owner", "gm", "frontdesk", "reservations", "accountant"] as const) expect((await s.get("/cotizaciones", s.tk(role))).status).toBe(200);
    expect((await s.get("/cotizaciones", s.tk("housekeeping"))).status).toBe(403);
    const body = (await (await s.get("/cotizaciones", s.tk("accountant"))).json()) as { disponible: boolean; cotizaciones: unknown[] };
    expect(body).toMatchObject({ disponible: true });
    expect(body.cotizaciones).toHaveLength(1);
  });

  it("centavos enteros: un decimal, un texto o un negativo responden 400 y no crean nada", async () => {
    const s = await setup();
    const row = (over: Record<string, unknown>) => s.quoteBody({ renglones: [{ tipoHabitacionId: s.ctx.roomTypeId, cuartos: 5, tarifaCentavos: 150000, ...over }] });
    for (const bad of [{ tarifaCentavos: 1500.5 }, { tarifaCentavos: "1500" }, { tarifaCentavos: -1 }, { cuartos: 0 }, { cuartos: 2.5 }, { tipoHabitacionId: "no-uuid" }]) {
      expect((await s.post("/cotizaciones", s.tk("owner"), row(bad))).status).toBe(400);
    }
    expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody({ descuentoBps: 10.5 }))).status).toBe(400);
    expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody({ anticipoRequeridoCentavos: 0.5 }))).status).toBe(400);
    expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody({ renglones: [] }))).status).toBe(400);
    expect((await (await s.get("/cotizaciones", s.tk("owner"))).json() as { cotizaciones: unknown[] }).cotizaciones).toHaveLength(0);
  });

  it("fechas, vigencia (con zona), cutoff y anticipo se validan", async () => {
    const s = await setup();
    const bad = [
      { llegada: "2031-02-30" }, { fechaLiberacion: "2031-06-13" }, { fechaLiberacion: "2031-04-30" }, { vigenteHasta: "2031-05-08T18:00:00" },
      { vigenteHasta: "2031-04-30T00:00:00Z" }, { salida: "2031-06-12" }, { anticipoRequeridoCentavos: 2250001 }, { nombreGrupo: "x" },
    ];
    for (const over of bad) expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody(over))).status, JSON.stringify(over)).toBe(400);
    expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody({ anticipoRequeridoCentavos: 2250000 }))).status).toBe(201);
  });

  it("descuento sobre el tope (30 %): reservations 403, owner 201; en el borde exacto reservations pasa", async () => {
    const s = await setup();
    expect((await s.post("/cotizaciones", s.tk("reservations"), s.quoteBody({ descuentoBps: 3001 }))).status).toBe(403);
    expect((await s.post("/cotizaciones", s.tk("reservations"), s.quoteBody({ descuentoBps: 3000 }))).status).toBe(201);
    expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody({ descuentoBps: 5000 }))).status).toBe(201);
  });

  it("enviar, reenviar (409), cerrar con motivo y detalle", async () => {
    const s = await setup();
    const q = await s.createQuote();
    expect((await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("frontdesk"))).status).toBe(403);
    expect((await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("reservations"))).status).toBe(200);
    expect((await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("reservations"))).status).toBe(409);
    expect((await s.post(`/cotizaciones/${q.id}/cerrar`, s.tk("owner"), { resultado: "rechazada", motivo: "abc" })).status).toBe(400);
    expect((await s.post(`/cotizaciones/${q.id}/cerrar`, s.tk("owner"), { resultado: "aceptada", motivo: "Motivo valido" })).status).toBe(400);
    const closed = await s.post(`/cotizaciones/${q.id}/cerrar`, s.tk("owner"), { resultado: "rechazada", motivo: "Muy caro para el cliente" });
    expect(closed.status).toBe(200);
    expect((await closed.json()) as QuoteBody).toMatchObject({ estado: "rechazada" });
    const detail = (await (await s.get(`/cotizaciones/${q.id}`, s.tk("accountant"))).json()) as { renglones: unknown[]; motivoCierre: string };
    expect(detail.renglones).toHaveLength(1);
    expect(detail.motivoCierre).toBe("Muy caro para el cliente");
    expect((await s.get(`/cotizaciones/00000000-0000-0000-0000-00000000dead`, s.tk("owner"))).status).toBe(404);
    expect((await s.get(`/cotizaciones/no-es-uuid`, s.tk("owner"))).status).toBe(400);
  });
});

describe("aceptar = bloquear cuartos (sin sobreventa)", () => {
  it("retiene cada noche, devuelve el bloqueo con su pickup y la cotizacion queda aceptada con bloqueoId", async () => {
    const s = await setup();
    const { quote, block } = await s.blockedQuote();
    expect(block).toMatchObject({ estado: "activo", fechaLiberacion: "2031-06-05", pickup: { cuartosNocheBloqueados: 15, cuartosNocheConfirmados: 0, cuartosNochePendientes: 15, porcentaje: 0 } });
    for (const d of NIGHTS) expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, d)).toBe(5);
    const detail = (await (await s.get(`/cotizaciones/${quote.id}`, s.tk("owner"))).json()) as QuoteBody;
    expect(detail).toMatchObject({ estado: "aceptada", bloqueoId: block.id });
  });

  it("sin cupo en UNA noche: 409, no retiene nada, la cotizacion sigue enviada; sin sobreventa", async () => {
    const s = await setup({ bookedLastNight: 8 });
    const q = await s.createQuote();
    await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("reservations"));
    const res = await s.post(`/cotizaciones/${q.id}/aceptar`, s.tk("reservations"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message?: string; error?: { message?: string } }).message ?? "").toMatch(/disponibilidad|cuartos/i);
    expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, "2031-06-12")).toBe(0);
    expect(((await (await s.get(`/cotizaciones/${q.id}`, s.tk("owner"))).json()) as QuoteBody).estado).toBe("enviada");
    expect(((await (await s.get("/bloqueos", s.tk("owner"))).json()) as { bloqueos: unknown[] }).bloqueos).toHaveLength(0);
  });

  it("dos agentes compiten por los ultimos cuartos: el primero bloquea, el segundo recibe 409", async () => {
    const s = await setup();
    const a = await s.createQuote({ renglones: [{ tipoHabitacionId: s.ctx.roomTypeId, cuartos: 6, tarifaCentavos: 100 }] });
    const b = await s.createQuote({ renglones: [{ tipoHabitacionId: s.ctx.roomTypeId, cuartos: 6, tarifaCentavos: 100 }] });
    for (const q of [a, b]) await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("reservations"));
    const [ra, rb] = await Promise.all([s.post(`/cotizaciones/${a.id}/aceptar`, s.tk("owner")), s.post(`/cotizaciones/${b.id}/aceptar`, s.tk("gm"))]);
    expect([ra.status, rb.status].sort()).toEqual([201, 409]);
    for (const d of NIGHTS) expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, d)).toBe(6);
  });

  it("solo owner/gm/reservations aceptan; aceptar dos veces es 409", async () => {
    const s = await setup();
    const q = await s.createQuote();
    await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("reservations"));
    expect((await s.post(`/cotizaciones/${q.id}/aceptar`, s.tk("frontdesk"))).status).toBe(403);
    expect((await s.post(`/cotizaciones/${q.id}/aceptar`, s.tk("owner"))).status).toBe(201);
    expect((await s.post(`/cotizaciones/${q.id}/aceptar`, s.tk("owner"))).status).toBe(409);
    expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, "2031-06-12")).toBe(5);
  });
});

describe("pickup, rooming y liberacion", () => {
  const guest = (s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) => ({ tipoHabitacionId: s.ctx.roomTypeId, huesped: "Luis Perez", llegada: "2031-06-12", salida: "2031-06-15", ...over });

  it("agrega y confirma huespedes (frontdesk puede, accountant/housekeeping 403); el pickup sube y el inventario no se mueve", async () => {
    const s = await setup();
    const { block } = await s.blockedQuote();
    expect((await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("accountant"), guest(s))).status).toBe(403);
    expect((await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("housekeeping"), guest(s))).status).toBe(403);
    const added = await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("frontdesk"), guest(s));
    expect(added.status).toBe(201);
    const entry = (await added.json()) as { id: string; estado: string };
    expect(entry.estado).toBe("pendiente");
    expect((await s.post(`/huespedes/${entry.id}/confirmar`, s.tk("frontdesk"))).status).toBe(200);
    expect((await s.post(`/huespedes/${entry.id}/confirmar`, s.tk("frontdesk"))).status).toBe(409);
    const detail = (await (await s.get(`/bloqueos/${block.id}`, s.tk("accountant"))).json()) as BlockBody;
    expect(detail.pickup).toMatchObject({ cuartosNocheConfirmados: 3, cuartosNochePendientes: 12, porcentaje: 20 });
    expect(detail.rooming).toHaveLength(1);
    expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, "2031-06-13")).toBe(5);
  });

  it("no se confirma mas pickup que cuartos bloqueados (409) y se valida fechas/tipo (400)", async () => {
    const s = await setup();
    const { block } = await s.blockedQuote({ renglones: [{ tipoHabitacionId: s.ctx.roomTypeId, cuartos: 1, tarifaCentavos: 100 }] });
    const ids: string[] = [];
    for (const name of ["Uno Perez", "Dos Perez"]) ids.push(((await (await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), guest(s, { huesped: name }))).json()) as { id: string }).id);
    expect((await s.post(`/huespedes/${ids[0]}/confirmar`, s.tk("owner"))).status).toBe(200);
    expect((await s.post(`/huespedes/${ids[1]}/confirmar`, s.tk("owner"))).status).toBe(409);
    expect((await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), guest(s, { llegada: "2031-06-11" }))).status).toBe(400);
    expect((await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), guest(s, { tipoHabitacionId: "00000000-0000-0000-0000-0000000d0009" }))).status).toBe(400);
    expect((await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), guest(s, { huesped: "x" }))).status).toBe(400);
  });

  it("liberar: devuelve solo lo no confirmado, una segunda vez 409, y frontdesk 403", async () => {
    const s = await setup();
    const { block } = await s.blockedQuote();
    const e = (await (await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), guest(s))).json()) as { id: string };
    await s.post(`/huespedes/${e.id}/confirmar`, s.tk("owner"));
    expect((await s.post(`/bloqueos/${block.id}/liberar`, s.tk("frontdesk"))).status).toBe(403);
    const rel = await s.post(`/bloqueos/${block.id}/liberar`, s.tk("reservations"));
    expect(rel.status).toBe(200);
    expect(await rel.json()).toEqual({ cuartosNocheLiberados: 12 });
    for (const d of NIGHTS) expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, d)).toBe(1);
    expect((await s.post(`/bloqueos/${block.id}/liberar`, s.tk("owner"))).status).toBe(409);
    expect(((await (await s.get(`/bloqueos/${block.id}`, s.tk("owner"))).json()) as BlockBody)).toMatchObject({ estado: "liberado", tipoLiberacion: "manual" });
  });

  it("cancelar bloqueo exige motivo y que no haya pickup confirmado; libera todo", async () => {
    const s = await setup();
    const { block } = await s.blockedQuote();
    const e = (await (await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), guest(s))).json()) as { id: string };
    await s.post(`/huespedes/${e.id}/confirmar`, s.tk("owner"));
    expect((await s.post(`/bloqueos/${block.id}/cancelar`, s.tk("owner"), { motivo: "abc" })).status).toBe(400);
    expect((await s.post(`/bloqueos/${block.id}/cancelar`, s.tk("owner"), { motivo: "Se cae el evento" })).status).toBe(409);
    await s.post(`/huespedes/${e.id}/cancelar`, s.tk("frontdesk"));
    const ok = await s.post(`/bloqueos/${block.id}/cancelar`, s.tk("owner"), { motivo: "Se cae el evento" });
    expect(await ok.json()).toEqual({ cuartosNocheLiberados: 15 });
    for (const d of NIGHTS) expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, d)).toBe(0);
  });

  it("un bloqueo u huesped inexistente (o de otra property) es 404; ids mal formados 400", async () => {
    const s = await setup();
    expect((await s.get("/bloqueos/00000000-0000-0000-0000-00000000dead", s.tk("owner"))).status).toBe(404);
    expect((await s.post("/bloqueos/00000000-0000-0000-0000-00000000dead/liberar", s.tk("owner"))).status).toBe(404);
    expect((await s.post("/huespedes/00000000-0000-0000-0000-00000000dead/confirmar", s.tk("owner"))).status).toBe(404);
    expect((await s.post("/huespedes/zzz/confirmar", s.tk("owner"))).status).toBe(400);
  });
});

describe("anticipos: solo registro", () => {
  it("accountant/owner/gm registran sobre una cotizacion aceptada; reservations y frontdesk 403; el acumulado no excede el total", async () => {
    const s = await setup();
    const { quote } = await s.blockedQuote({ renglones: [{ tipoHabitacionId: s.ctx.roomTypeId, cuartos: 1, tarifaCentavos: 100000 }], salida: "2031-06-13" });
    const path = `/cotizaciones/${quote.id}/anticipos`;
    expect((await s.post(path, s.tk("reservations"), { montoCentavos: 100, referencia: "REF-0001" })).status).toBe(403);
    expect((await s.post(path, s.tk("frontdesk"), { montoCentavos: 100, referencia: "REF-0001" })).status).toBe(403);
    for (const bad of [{ montoCentavos: 0 }, { montoCentavos: 10.5 }, { montoCentavos: "100" }, { montoCentavos: -5 }]) {
      expect((await s.post(path, s.tk("accountant"), { referencia: "REF-0001", ...bad })).status).toBe(400);
    }
    expect((await s.post(path, s.tk("accountant"), { montoCentavos: 100000, referencia: "ab" })).status).toBe(400);
    expect((await s.post(path, s.tk("accountant"), { montoCentavos: 100001, referencia: "REF-0001" })).status).toBe(400);
    const first = await s.post(path, s.tk("accountant"), { montoCentavos: 99999, referencia: "REF-0001" });
    expect(first.status).toBe(201);
    expect((await s.post(path, s.tk("owner"), { montoCentavos: 1, referencia: "REF-0001" })).status).toBe(409);
    const last = (await (await s.post(path, s.tk("gm"), { montoCentavos: 1, referencia: "REF-0002" })).json()) as QuoteBody;
    expect(last).toMatchObject({ anticipoRegistradoCentavos: 100000 });
    expect(last.anticipos.map((a) => a.referencia)).toEqual(["REF-0001", "REF-0002"]);
    expect((await s.post(path, s.tk("owner"), { montoCentavos: 1, referencia: "REF-0003" })).status).toBe(400);
  });

  it("una cotizacion sin aceptar (enviada) no admite anticipos: 409", async () => {
    const s = await setup();
    const q = await s.createQuote();
    await s.post(`/cotizaciones/${q.id}/enviar`, s.tk("owner"));
    expect((await s.post(`/cotizaciones/${q.id}/anticipos`, s.tk("owner"), { montoCentavos: 100, referencia: "REF-0001" })).status).toBe(409);
  });
});

describe("base sin la migracion 036", () => {
  it("lecturas con disponible:false y listas vacias; escrituras 503 (nunca 500)", async () => {
    const s = await setup({ migrated: false });
    expect(await (await s.get("/cotizaciones", s.tk("owner"))).json()).toEqual({ disponible: false, cotizaciones: [] });
    expect(await (await s.get("/bloqueos", s.tk("owner"))).json()).toEqual({ disponible: false, bloqueos: [] });
    expect((await s.post("/cotizaciones", s.tk("owner"), s.quoteBody())).status).toBe(503);
    expect((await s.get("/cotizaciones/00000000-0000-0000-0000-00000000dead", s.tk("owner"))).status).toBe(404);
  });
});

describe("liberacion por cutoff (/internal/hoteles/grupos-liberacion): invocable, sin cron programado", () => {
  it("exige el secreto interno; con el, corre y reporta; sin la migracion omite la property sin fallar", async () => {
    const s = await setup();
    const url = "/internal/hoteles/grupos-liberacion";
    expect((await s.app.request(url, { method: "POST" })).status).toBe(401);
    const ok = await s.app.request(url, { method: "POST", headers: { "x-atiende-internal-secret": s.ctx.deps.env.internalSecret } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, bloqueos_liberados_total: 0 });
    const old = await setup({ migrated: false });
    const res = await old.app.request(url, { method: "POST", headers: { "x-atiende-internal-secret": old.ctx.deps.env.internalSecret } });
    const body = (await res.json()) as { ok: boolean; corridas: { omitida: string | null; error: string | null }[] };
    expect(body.ok).toBe(true);
    expect(body.corridas.every((r) => r.omitida === "migracion_pendiente" && r.error === null)).toBe(true);
  });

  it("libera solo lo no confirmado de los bloqueos cuyo cutoff llego, e idempotente; vence propuestas", async () => {
    const s = await setup();
    const { block } = await s.blockedQuote();
    const e = (await (await s.post(`/bloqueos/${block.id}/huespedes`, s.tk("owner"), { tipoHabitacionId: s.ctx.roomTypeId, huesped: "Luis Perez", llegada: "2031-06-12", salida: "2031-06-15" })).json()) as { id: string };
    await s.post(`/huespedes/${e.id}/confirmar`, s.tk("owner"));
    await s.createQuote(); // borrador que vencera
    const before = await runGruposLiberacion(s.deps, new Date("2031-06-04T12:00:00Z"));
    expect(before.properties.every((p) => p.bloqueosLiberados === 0)).toBe(true);
    expect(before.cotizacionesVencidas).toBe(1); // el borrador cuya vigencia (8-may) ya paso
    const first = await runGruposLiberacion(s.deps, new Date("2031-06-05T12:00:00Z"));
    const mine = first.properties.find((p) => p.propertyId === s.ctx.propertyId)!;
    expect(mine).toMatchObject({ bloqueosLiberados: 1, cuartosNocheLiberados: 12, error: null, omitida: null });
    expect(first.cotizacionesVencidas).toBe(0);
    for (const d of NIGHTS) expect(s.repo.booked(s.ctx.propertyId, s.ctx.roomTypeId, d)).toBe(1);
    const again = await runGruposLiberacion(s.deps, new Date("2031-06-05T12:00:00Z"));
    expect(again.properties.find((p) => p.propertyId === s.ctx.propertyId)).toMatchObject({ bloqueosLiberados: 0 });
    expect(((await (await s.get(`/bloqueos/${block.id}`, s.tk("owner"))).json()) as BlockBody)).toMatchObject({ estado: "liberado", tipoLiberacion: "cutoff" });
  });
});

// H-12 -- lista de espera por la ruta HTTP COMPLETA (app.request) sobre los espejos en memoria. RLS/GRANT/triggers los cubre
// scripts/verify-hoteles-fechas-lista-espera contra Postgres real; el SAVEPOINT contra la base sin migrar lo cubre
// packages/domain-hoteles/tests/fechas-lista-espera-savepoint.spec.ts. Aqui: contrato HTTP, validaciones, ciclo de vida, expiracion
// de la oferta, aceptar crea la reserva con la cotizacion vigente (guardia de precio, idempotencia) y base sin migrar.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCambioFechasRepository, InMemoryListaEsperaRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

const NOW = new Date("2026-11-20T18:00:00Z");
afterEach(() => {
  vi.useRealTimers();
});

async function setup(opts: { migrated?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const ctx = await buildHotelesTestContext(buildApp);
  const dias = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 10, 19 + i)).toISOString().slice(0, 10));
  ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, dias.map((date) => ({ date, price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false })));
  for (const d of dias) ctx.hotelesRepo.seedAvailability(ctx.propertyId, ctx.roomTypeId, d, 1, 1); // hotel lleno
  const lista = new InMemoryListaEsperaRepository(opts);
  const fechas = new InMemoryCambioFechasRepository(ctx.hotelesRepo, opts);
  const app = buildApp({ ...ctx.deps, hotelesListaEsperaRepo: () => lista, hotelesFechasRepo: () => fechas });
  const base = `/hoteles/${ctx.propertyId}/lista-espera`;
  const post = (path: string, body: unknown, token = ctx.staff.frontdesk.token, headers: Record<string, string> = {}) => app.request(`${base}${path}`, authedJson(token, body, headers));
  const get = (query = "", token = ctx.staff.frontdesk.token) => app.request(`${base}${query}`, authedJson(token));
  const cuerpo = (over: Record<string, unknown> = {}) => ({ roomTypeId: ctx.roomTypeId, checkInDate: "2026-12-03", checkOutDate: "2026-12-05", huespedes: 2, nombre: "Carla Mena", telefono: "5599998888", ...over });
  const crear = async (over: Record<string, unknown> = {}) => (await post("", cuerpo(over))).json() as Promise<{ id: string; estado: string }>;
  const liberar = (noches: string[]) => noches.forEach((d) => ctx.hotelesRepo.seedAvailability(ctx.propertyId, ctx.roomTypeId, d, 1, 0));
  const aceptar = (id: string, body: unknown, key: string | null = randomUUID()) => post(`/${id}/aceptar`, body, ctx.staff.frontdesk.token, key ? { "idempotency-key": key } : {});
  return { ctx, app, lista, fechas, base, post, get, cuerpo, crear, liberar, aceptar };
}
const json = async <T>(res: Response) => (await res.json()) as T;
interface EntradaApi {
  id: string;
  estado: string;
  nombre: string;
  ofertaVenceEn: string | null;
  reservaId: string | null;
  cotizacionVigente: { total: number; noches: number } | null;
}

describe("POST /lista-espera (agregar)", () => {
  it("crea una entrada activa y la lista en orden de llegada", async () => {
    const s = await setup();
    const res = await s.post("", s.cuerpo());
    expect(res.status).toBe(201);
    expect(await json<EntradaApi>(res)).toMatchObject({ estado: "activa", nombre: "Carla Mena", tipoHabitacionId: s.ctx.roomTypeId, entrada: "2026-12-03", salida: "2026-12-05", huespedes: 2 });
    await s.crear({ nombre: "Dora Paz" });
    const lista = await json<{ disponible: boolean; entradas: EntradaApi[] }>(await s.get());
    expect(lista.disponible).toBe(true);
    expect(lista.entradas.map((e) => e.nombre)).toEqual(["Carla Mena", "Dora Paz"]);
    expect((await json<{ entradas: unknown[] }>(await s.get("?estado=cancelada"))).entradas).toHaveLength(0);
    expect((await s.get("?estado=rara")).status).toBe(400);
  });

  it("valida el cuerpo: fechas, llegada pasada, huespedes (y capacidad del tipo), nombre, contacto, notas, tipo inexistente", async () => {
    const s = await setup();
    const malos: [Record<string, unknown>, number][] = [
      [{ checkInDate: "03-12-2026" }, 400],
      [{ checkOutDate: "2026-12-03" }, 400],
      [{ checkInDate: "2026-11-19", checkOutDate: "2026-11-21" }, 400],
      [{ checkInDate: "2026-12-01", checkOutDate: "2027-03-01" }, 400],
      [{ huespedes: 0 }, 400],
      [{ huespedes: 3 }, 400], // el tipo del fixture admite 2
      [{ nombre: "A" }, 400],
      [{ telefono: undefined }, 400], // sin telefono ni correo
      [{ telefono: "abc" }, 400],
      [{ telefono: undefined, email: "no-es-correo" }, 400],
      [{ notas: "x".repeat(301) }, 400],
      [{ roomTypeId: randomUUID() }, 404],
    ];
    for (const [over, status] of malos) expect((await s.post("", s.cuerpo(over))).status, JSON.stringify(over)).toBe(status);
    expect((await s.post("", s.cuerpo({ telefono: undefined, email: "ana@example.com" }))).status).toBe(201);
  });

  it("roles: owner, gm, frontdesk y reservations; housekeeping, fnb y contabilidad 403; sin token 401", async () => {
    const s = await setup();
    for (const t of [s.ctx.staff.owner.token, s.ctx.staff.gm.token, s.ctx.staff.frontdesk.token, s.ctx.staff.reservations.token]) expect((await s.post("", s.cuerpo(), t)).status).toBe(201);
    for (const t of [s.ctx.staff.housekeeping.token, s.ctx.staff.fnb.token, s.ctx.staff.accountant.token]) {
      expect((await s.post("", s.cuerpo(), t)).status).toBe(403);
      expect((await s.get("", t)).status).toBe(403);
    }
    expect((await s.app.request(s.base, { method: "GET" })).status).toBe(401);
  });
});

describe("ciclo de vida: cancelar, ofrecer a mano, vencer", () => {
  it("cancelar una activa; no se cancela dos veces (409); una inexistente da 404", async () => {
    const s = await setup();
    const e = await s.crear();
    const ok = await s.post(`/${e.id}/cancelar`, {});
    expect(ok.status).toBe(200);
    expect((await json<EntradaApi>(ok)).estado).toBe("cancelada");
    expect((await s.post(`/${e.id}/cancelar`, {})).status).toBe(409);
    expect((await s.post(`/${randomUUID()}/cancelar`, {})).status).toBe(404);
  });

  it("ofrecer a mano solo si hoy hay cupo en TODAS sus noches; con vencimiento en horas", async () => {
    const s = await setup();
    const e = await s.crear();
    const sin = await s.post(`/${e.id}/ofrecer`, {});
    expect(sin.status).toBe(409);
    expect((await json<{ code: string }>(sin)).code).toBe("sin_disponibilidad");
    s.liberar(["2026-12-03", "2026-12-04"]);
    expect((await s.post(`/${e.id}/ofrecer`, { horas: 0 })).status).toBe(400);
    const ok = await s.post(`/${e.id}/ofrecer`, { horas: 12 });
    expect(ok.status).toBe(200);
    const o = await json<EntradaApi>(ok);
    expect(o.estado).toBe("ofrecida");
    expect(o.ofertaVenceEn).toBe(new Date(NOW.getTime() + 12 * 3_600_000).toISOString());
    expect((await s.post(`/${e.id}/ofrecer`, {})).status).toBe(409); // ya ofrecida
  });

  it("una oferta vencida se marca expirada al listar y ya no se puede aceptar (409 oferta_vencida)", async () => {
    const s = await setup();
    const e = await s.crear();
    s.liberar(["2026-12-03", "2026-12-04"]);
    // una oferta hecha hace 2 h con vencimiento hace 1 h (el reloj no se adelanta: los tokens de prueba tienen vida corta)
    const previa = (await s.lista.buscar(s.ctx.propertyId, e.id))!;
    s.lista.seed({ ...previa, estado: "ofrecida", ofrecidaEn: new Date(NOW.getTime() - 2 * 3_600_000).toISOString(), ofertaVenceEn: new Date(NOW.getTime() - 3_600_000).toISOString() });
    const lista = await json<{ entradas: EntradaApi[] }>(await s.get());
    expect(lista.entradas[0]?.estado).toBe("expirada");
    const res = await s.aceptar(e.id, { totalEsperado: 2380 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("oferta_vencida");
  });
});

describe("POST /lista-espera/:id/aceptar", () => {
  async function ofrecida(s: Awaited<ReturnType<typeof setup>>) {
    const e = await s.crear();
    s.liberar(["2026-12-03", "2026-12-04"]);
    expect((await s.post(`/${e.id}/ofrecer`, {})).status).toBe(200);
    return e;
  }

  it("la lista muestra la cotizacion VIGENTE de las ofertas (con impuestos)", async () => {
    const s = await setup();
    await ofrecida(s);
    const lista = await json<{ entradas: EntradaApi[] }>(await s.get());
    expect(lista.entradas[0]?.cotizacionVigente).toEqual({ total: 2380, noches: 2, moneda: "MXN" });
  });

  it("crea la reserva (neto), reserva las noches, crea al huesped y el folio, y marca la entrada aceptada", async () => {
    const s = await setup();
    const e = await ofrecida(s);
    const res = await s.aceptar(e.id, { totalEsperado: 2380 });
    expect(res.status).toBe(201);
    const out = await json<{ entrada: EntradaApi; reserva: { id: string; checkInDate: string; checkOutDate: string; estado: string; montoTotal: number } }>(res);
    expect(out.entrada).toMatchObject({ estado: "aceptada", reservaId: out.reserva.id });
    expect(out.reserva).toMatchObject({ checkInDate: "2026-12-03", checkOutDate: "2026-12-05", estado: "confirmada", montoTotal: 2000 });
    const disp = await s.fechas.cargarDisponibilidad(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-03", "2026-12-04");
    expect(disp.noches.map((n) => n.bookedRooms)).toEqual([1, 1]);
    expect(await s.ctx.hotelesRepo.listFoliosByReservation(s.ctx.propertyId, out.reserva.id)).toHaveLength(1);
    expect((await s.ctx.hotelesRepo.searchGuests(s.ctx.propertyId, "Carla Mena")).map((g) => g.fullName)).toContain("Carla Mena");
  });

  it("un reintento con la misma Idempotency-Key devuelve la misma reserva sin crear otra", async () => {
    const s = await setup();
    const e = await ofrecida(s);
    const key = randomUUID();
    const a = await json<{ reserva: { id: string } }>(await s.aceptar(e.id, { totalEsperado: 2380 }, key));
    const rr = await s.aceptar(e.id, { totalEsperado: 2380 }, key);
    expect(rr.status).toBe(201);
    expect((await json<{ reserva: { id: string } }>(rr)).reserva.id).toBe(a.reserva.id);
    expect((await s.ctx.hotelesRepo.listReservations(s.ctx.propertyId)).filter((r) => r.checkInDate === "2026-12-03" && r.status === "confirmada")).toHaveLength(1);
  });

  it("guardia de precio (409 precio_cambio), Idempotency-Key obligatoria (400) y totalEsperado obligatorio (400); nada cambia", async () => {
    const s = await setup();
    const e = await ofrecida(s);
    const caro = await s.aceptar(e.id, { totalEsperado: 1000 });
    expect(caro.status).toBe(409);
    expect((await json<{ code: string }>(caro)).code).toBe("precio_cambio");
    expect((await s.aceptar(e.id, { totalEsperado: 2380 }, null)).status).toBe(400);
    expect((await s.aceptar(e.id, {})).status).toBe(400);
    expect((await s.lista.buscar(s.ctx.propertyId, e.id))?.estado).toBe("ofrecida");
  });

  it("si el lugar ya no esta, 409 sin_disponibilidad y la oferta sigue vigente; una entrada activa (sin oferta) no se acepta", async () => {
    const s = await setup();
    const e = await ofrecida(s);
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-04", 1, 1); // alguien se quedo con la noche 4
    const res = await s.aceptar(e.id, { totalEsperado: 2380 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("sin_disponibilidad");
    expect((await s.lista.buscar(s.ctx.propertyId, e.id))?.estado).toBe("ofrecida");
    const otra = await s.crear({ nombre: "Eva Rey" });
    const act = await s.aceptar(otra.id, { totalEsperado: 2380 });
    expect(act.status).toBe(409);
    expect((await json<{ code: string }>(act)).code).toBe("estado_invalido");
  });
});

describe("base SIN migrar (041)", () => {
  it("listar responde 200 con lista vacia y disponible:false; escribir responde 503 (nunca 500)", async () => {
    const s = await setup({ migrated: false });
    const lista = await s.get();
    expect(lista.status).toBe(200);
    expect(await json<{ disponible: boolean; entradas: unknown[] }>(lista)).toEqual({ disponible: false, entradas: [] });
    expect((await s.post("", s.cuerpo())).status).toBe(503);
    expect((await s.post(`/${randomUUID()}/cancelar`, {})).status).toBe(503);
    expect((await s.post(`/${randomUUID()}/ofrecer`, {})).status).toBe(503);
    expect((await s.aceptar(randomUUID(), { totalEsperado: 1 })).status).toBe(503);
  });
});

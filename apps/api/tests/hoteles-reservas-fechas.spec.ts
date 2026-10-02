// H-28 -- cambio de fechas con recotizacion por la ruta HTTP COMPLETA (app.request) sobre los espejos en memoria. RLS/GRANT/
// triggers y la funcion atomica los cubre scripts/verify-hoteles-fechas-lista-espera contra Postgres real; el SAVEPOINT contra la
// base sin migrar lo cubre packages/domain-hoteles/tests/fechas-lista-espera-savepoint.spec.ts. Aqui: contrato HTTP, guardia de
// precio, idempotencia, noches posteadas, cupo, carrera por el ultimo cupo, base sin migrar y oferta a la lista de espera.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCambioFechasRepository, InMemoryListaEsperaRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

// "Hoy" de la property (America/Mexico_City): 2026-11-20 12:00 hora local.
const NOW = new Date("2026-11-20T18:00:00Z");
afterEach(() => {
  vi.useRealTimers();
});

async function setup(opts: { migrated?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const ctx = await buildHotelesTestContext(buildApp);
  const dias = Array.from({ length: 24 }, (_, i) => new Date(Date.UTC(2026, 10, 19 + i)).toISOString().slice(0, 10)); // 19 nov .. 12 dic
  ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, dias.map((date) => ({ date, price: 1000, minStay: 1, closedToArrival: false, closedToDeparture: false })));
  for (const d of dias) ctx.hotelesRepo.seedAvailability(ctx.propertyId, ctx.roomTypeId, d, 2, 0);
  const fechas = new InMemoryCambioFechasRepository(ctx.hotelesRepo, opts);
  const lista = new InMemoryListaEsperaRepository(opts);
  const { deps, emisiones } = conEmisiones({ ...ctx.deps, hotelesFechasRepo: () => fechas, hotelesListaEsperaRepo: () => lista } as typeof ctx.deps);
  const app = buildApp(deps);
  const reserva = async (over: { status?: "confirmada" | "en_estancia" | "cancelada"; in?: string; out?: string; neto?: number; sinInventario?: boolean } = {}) => {
    const id = randomUUID();
    const entrada = over.in ?? "2026-12-03";
    const salida = over.out ?? "2026-12-05";
    ctx.hotelesRepo.seedReservation({ id, organizationId: ctx.organizationId, propertyId: ctx.propertyId, roomTypeId: ctx.roomTypeId, guestId: ctx.guestId, checkInDate: entrada, checkOutDate: salida, status: over.status ?? "confirmada", totalAmount: over.neto ?? 2000, cancellationPenaltyAmount: null, canceledAt: null, createdAt: NOW.toISOString() });
    if (over.sinInventario) return id;
    for (let d = new Date(`${entrada}T00:00:00Z`); d < new Date(`${salida}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) await ctx.hotelesRepo.bookAvailability(ctx.propertyId, ctx.roomTypeId, d.toISOString().slice(0, 10), 1);
    return id;
  };
  const base = `/hoteles/${ctx.propertyId}/reservas`;
  const previsualizar = (id: string, body: unknown, token = ctx.staff.frontdesk.token) => app.request(`${base}/${id}/fechas/previsualizar`, authedJson(token, body));
  const patch = (id: string, body: unknown, key: string | null = randomUUID(), token = ctx.staff.frontdesk.token) =>
    app.request(`${base}/${id}/fechas`, { ...authedJson(token, body, key ? { "idempotency-key": key } : {}), method: "PATCH" });
  const booked = async (d: string) => (await fechas.cargarDisponibilidad(ctx.propertyId, ctx.roomTypeId, d, d)).noches[0]?.bookedRooms;
  return { ctx, app, fechas, lista, emisiones, reserva, previsualizar, patch, booked, base };
}
type S = Awaited<ReturnType<typeof setup>>;
const json = async <T>(res: Response) => (await res.json()) as T;

describe("POST /reservas/:id/fechas/previsualizar", () => {
  it("recotiza con el motor: total actual vs nuevo (neto + IVA 16% + ISH 3%), noches agregadas y sin penalidad", async () => {
    const s = await setup();
    const id = await s.reserva();
    const res = await s.previsualizar(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" });
    expect(res.status).toBe(200);
    const p = await json<{ puedeCambiar: boolean; actual: { total: number }; nueva: { neto: number; total: number; noches: number }; diferenciaTotal: number; nochesAgregadas: string[]; penalidad: { monto: number } }>(res);
    expect(p.puedeCambiar).toBe(true);
    expect(p.actual.total).toBe(2380);
    expect(p.nueva).toMatchObject({ neto: 3000, total: 3570, noches: 3 });
    expect(p.diferenciaTotal).toBe(1190);
    expect(p.nochesAgregadas).toEqual(["2026-12-05"]);
    expect(p.penalidad.monto).toBe(0);
  });

  it("no escribe nada y funciona contra la base SIN migrar (solo lee tablas anteriores)", async () => {
    const s = await setup({ migrated: false });
    const id = await s.reserva();
    const res = await s.previsualizar(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" });
    expect(res.status).toBe(200);
    expect((await json<{ puedeCambiar: boolean }>(res)).puedeCambiar).toBe(true);
    expect(await s.booked("2026-12-05")).toBe(0);
  });

  it("informa los bloqueos (cancelada, sin cupo) sin lanzar, y valida el cuerpo y la existencia", async () => {
    const s = await setup();
    const cancelada = await s.reserva({ status: "cancelada" });
    const p1 = await json<{ puedeCambiar: boolean; bloqueos: { codigo: string }[] }>(await s.previsualizar(cancelada, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" }));
    expect(p1).toMatchObject({ puedeCambiar: false, bloqueos: [{ codigo: "reserva_no_modificable" }] });
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-05", 2, 2);
    const id = await s.reserva();
    const p2 = await json<{ puedeCambiar: boolean; nochesSinCupo: string[] }>(await s.previsualizar(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" }));
    expect(p2).toMatchObject({ puedeCambiar: false, nochesSinCupo: ["2026-12-05"] });
    expect((await s.previsualizar(id, { checkInDate: "03/12/2026", checkOutDate: "2026-12-06" })).status).toBe(400);
    expect((await s.previsualizar(randomUUID(), { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" })).status).toBe(404);
  });

  it("housekeeping y contabilidad reciben 403; sin token 401", async () => {
    const s = await setup();
    const id = await s.reserva();
    for (const t of [s.ctx.staff.housekeeping.token, s.ctx.staff.accountant.token]) expect((await s.previsualizar(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" }, t)).status).toBe(403);
    const sin = await s.app.request(`${s.base}/${id}/fechas/previsualizar`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(sin.status).toBe(401);
  });
});

describe("PATCH /reservas/:id/fechas", () => {
  it("aplica el cambio con totalEsperado correcto: fechas, total NETO, inventario por noche y bitacora; un reintento con la misma llave no duplica", async () => {
    const s = await setup();
    const id = await s.reserva();
    const key = randomUUID();
    const body = { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570, motivo: "Extiende una noche" };
    const res = await s.patch(id, body, key);
    expect(res.status).toBe(200);
    const out = await json<{ reserva: { checkOutDate: string; montoTotal: number }; cambio: { nochesReservadas: number }; totalAnterior: number; totalNuevo: number }>(res);
    expect(out.reserva).toMatchObject({ checkOutDate: "2026-12-06", montoTotal: 3000 });
    expect(out).toMatchObject({ totalAnterior: 2380, totalNuevo: 3570, cambio: { nochesReservadas: 1 } });
    expect(await s.booked("2026-12-05")).toBe(1);
    expect(s.fechas.bitacora).toHaveLength(1);
    // reintento (mismo Idempotency-Key y mismo cuerpo): respuesta guardada, sin volver a reservar la noche
    const replay = await s.patch(id, body, key);
    expect(replay.status).toBe(200);
    expect(await s.booked("2026-12-05")).toBe(1);
    expect(s.fechas.bitacora).toHaveLength(1);
    // misma llave con otro cuerpo: 422
    expect((await s.patch(id, { ...body, checkOutDate: "2026-12-07", totalEsperado: 4760 }, key)).status).toBe(422);
  });

  it("exige Idempotency-Key (400) y valida el cuerpo", async () => {
    const s = await setup();
    const id = await s.reserva();
    expect((await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570 }, null)).status).toBe(400);
    expect((await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06" })).status).toBe(400);
    expect((await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570, motivo: "x" })).status).toBe(400);
    expect((await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-03", totalEsperado: 1 })).status).toBe(400);
  });

  it("guardia de precio: si el total recalculado difiere del que vio el staff, 409 precio_cambio y NO cambia nada", async () => {
    const s = await setup();
    const id = await s.reserva();
    const res = await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3000 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("precio_cambio");
    expect(await s.booked("2026-12-05")).toBe(0);
    expect((await s.ctx.hotelesRepo.findReservation(s.ctx.propertyId, id))?.checkOutDate).toBe("2026-12-05");
    // una tarifa que cambia entre la previsualizacion y la confirmacion dispara la misma guardia
    s.ctx.hotelesRepo.seedNightlyRates(s.ctx.propertyId, s.ctx.roomTypeId, ["2026-12-03", "2026-12-04", "2026-12-05"].map((date) => ({ date, price: 1200, minStay: 1, closedToArrival: false, closedToDeparture: false })));
    expect((await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570 })).status).toBe(409);
  });

  it("sin cupo en una noche agregada: 409 sin_disponibilidad", async () => {
    const s = await setup();
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-05", 2, 2);
    const id = await s.reserva();
    const res = await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570 });
    expect(res.status).toBe(409);
    expect((await json<{ code: string }>(res)).code).toBe("sin_disponibilidad");
  });

  it("huesped en casa: extiende la salida; no deja fuera una noche ya posteada por el night-audit (409 noches_posteadas)", async () => {
    const s = await setup();
    // el huesped ya ocupa 19-21 nov (3 noches reservadas): inventario sembrado de acuerdo a eso
    for (const d of ["2026-11-19", "2026-11-20", "2026-11-21"]) s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, d, 2, 1);
    const id = await s.reserva({ status: "en_estancia", in: "2026-11-19", out: "2026-11-22", neto: 3000, sinInventario: true });
    const folio = await s.ctx.hotelesRepo.ensurePrimaryFolio(s.ctx.propertyId, s.ctx.organizationId, id);
    for (const d of ["2026-11-19", "2026-11-20"]) await s.ctx.hotelesRepo.insertCharge({ organizationId: s.ctx.organizationId, propertyId: s.ctx.propertyId, folioId: folio.id, description: `Hospedaje ${d}`, amount: 1000, taxAmount: 160, concept: "hospedaje", stayDate: d });
    const extiende = await s.patch(id, { checkInDate: "2026-11-19", checkOutDate: "2026-11-23", totalEsperado: 4760 });
    expect(extiende.status).toBe(200);
    const recorta = await s.patch(id, { checkInDate: "2026-11-19", checkOutDate: "2026-11-20", totalEsperado: 1190 });
    expect(recorta.status).toBe(409);
    expect((await json<{ code: string }>(recorta)).code).toBe("noches_posteadas");
    expect((await s.ctx.hotelesRepo.findReservation(s.ctx.propertyId, id))?.checkOutDate).toBe("2026-11-23");
    const llegada = await s.patch(id, { checkInDate: "2026-11-20", checkOutDate: "2026-11-23", totalEsperado: 3570 });
    expect(llegada.status).toBe(409);
  });

  it("DOS cambios simultaneos por el ultimo cupo: uno entra (200) y el otro recibe 409 sin_disponibilidad (sin sobreventa)", async () => {
    const s = await setup();
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-05", 1, 0);
    const a = await s.reserva();
    const b = await s.reserva();
    const body = { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570 };
    const [ra, rb] = await Promise.all([s.patch(a, body), s.patch(b, body)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(await s.booked("2026-12-05")).toBe(1);
  });

  it("base SIN migrar: confirmar responde 503 'no disponible aun' (nunca 500) y no cambia la reserva", async () => {
    const s = await setup({ migrated: false });
    const id = await s.reserva();
    const res = await s.patch(id, { checkInDate: "2026-12-03", checkOutDate: "2026-12-06", totalEsperado: 3570 });
    expect(res.status).toBe(503);
    expect((await s.ctx.hotelesRepo.findReservation(s.ctx.propertyId, id))?.checkOutDate).toBe("2026-12-05");
  });

  it("roles: owner, gm, frontdesk y reservations cambian fechas; housekeeping y contabilidad no (403)", async () => {
    const s = await setup();
    const ids = [await s.reserva(), await s.reserva()];
    const body = { checkInDate: "2026-12-03", checkOutDate: "2026-12-04", totalEsperado: 1190 };
    expect((await s.patch(ids[0] as string, body, randomUUID(), s.ctx.staff.reservations.token)).status).toBe(200);
    expect((await s.patch(ids[1] as string, body, randomUUID(), s.ctx.staff.gm.token)).status).toBe(200);
    const otra = await s.reserva({ sinInventario: true });
    for (const t of [s.ctx.staff.housekeeping.token, s.ctx.staff.accountant.token, s.ctx.staff.fnb.token]) expect((await s.patch(otra, body, randomUUID(), t)).status).toBe(403);
  });

  it("acortar dentro de la ventana de la politica calcula la penalidad (informativa) y la guarda en la respuesta", async () => {
    const s = await setup();
    // hoy 20 nov 12:00 local: la primera noche quitada (22 nov 00:00Z) esta a 30 h, dentro de las 48 h de la politica -> 50% de 2 noches de 1000
    const id = await s.reserva({ in: "2026-11-21", out: "2026-11-24", neto: 3000 });
    const p = await json<{ penalidad: { monto: number; porcentaje: number } }>(await s.previsualizar(id, { checkInDate: "2026-11-21", checkOutDate: "2026-11-22" }));
    expect(p.penalidad).toMatchObject({ monto: 1000, porcentaje: 0.5 });
    const res = await s.patch(id, { checkInDate: "2026-11-21", checkOutDate: "2026-11-22", totalEsperado: 1190 });
    expect((await json<{ penalidad: { monto: number } }>(res)).penalidad.monto).toBe(1000);
    expect(s.fechas.bitacora[0]?.penalidad).toBe(1000);
  });

  it("acortar ofrece las noches liberadas a la lista de espera (FIFO) y emite la notificacion sin PII", async () => {
    const s = await setup();
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-05", 1, 1);
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-06", 1, 1);
    const id = await s.reserva({ in: "2026-12-05", out: "2026-12-07", neto: 2000, sinInventario: true });
    const espera = await s.lista.crear({ propertyId: s.ctx.propertyId, roomTypeId: s.ctx.roomTypeId, checkInDate: "2026-12-06", checkOutDate: "2026-12-07", huespedes: 2, nombre: "Carla Mena", telefono: "5599998888", email: null, notas: null });
    const res = await s.patch(id, { checkInDate: "2026-12-05", checkOutDate: "2026-12-06", totalEsperado: 1190 });
    expect(res.status).toBe(200);
    expect((await json<{ ofertasListaEspera: number }>(res)).ofertasListaEspera).toBe(1);
    expect((await s.lista.buscar(s.ctx.propertyId, espera.id))?.estado).toBe("ofrecida");
    expect(s.emisiones).toHaveLength(1);
    expect(s.emisiones[0]).toMatchObject({
      evento: "hoteles.lista_espera.disponible",
      categoria: "operacion",
      enlace: "/hoteles/{orgSlug}/reservas",
      dedupeKey: `hoteles.lista_espera.disponible:${espera.id}`,
      roles: ["gm", "frontdesk", "reservations"],
    });
    expect(JSON.stringify(s.emisiones[0])).not.toMatch(/Carla|5599998888/);
  });

  it("cancelar una reserva tambien ofrece las noches liberadas; contra la base sin migrar la cancelacion sigue funcionando", async () => {
    const s = await setup();
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-03", 1, 1);
    s.ctx.hotelesRepo.seedAvailability(s.ctx.propertyId, s.ctx.roomTypeId, "2026-12-04", 1, 1);
    const id = await s.reserva({ sinInventario: true });
    const espera = await s.lista.crear({ propertyId: s.ctx.propertyId, roomTypeId: s.ctx.roomTypeId, checkInDate: "2026-12-03", checkOutDate: "2026-12-05", huespedes: 1, nombre: "Dora", telefono: null, email: "dora@example.com", notas: null });
    const res = await s.app.request(`${s.base}/${id}/cancelar`, authedJson(s.ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(200);
    expect((await s.lista.buscar(s.ctx.propertyId, espera.id))?.estado).toBe("ofrecida");
    expect(s.emisiones.map((e) => e.evento)).toEqual(["hoteles.lista_espera.disponible"]);

    const sin = await setup({ migrated: false });
    const id2 = await sin.reserva();
    const res2 = await sin.app.request(`${sin.base}/${id2}/cancelar`, authedJson(sin.ctx.staff.frontdesk.token, {}));
    expect(res2.status).toBe(200);
    expect(sin.emisiones).toHaveLength(0);
  });
});

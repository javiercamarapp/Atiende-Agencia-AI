// H-28 -- recepcion / front desk: integracion HTTP real (app.request) sobre los repositorios en memoria. RLS/GRANT/
// triggers y la funcion atomica `change_reservation_room` los cubre scripts/verify-hoteles-recepcion-ficha contra
// Postgres real; el SAVEPOINT contra base sin migrar lo cubre packages/domain-hoteles/tests/recepcion-savepoint.spec.ts.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryHousekeepingRepository, InMemoryRecepcionRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

// "Hoy" de la property (America/Mexico_City): 2026-12-02 12:00 hora local. Solo se falsea Date (sin timers vivos).
const HOY = "2026-12-02";
const NOW = new Date("2026-12-02T18:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

async function setup(opts: { migrated?: boolean; identidadDisponible?: boolean } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const ctx = await buildHotelesTestContext(buildApp);
  const hk = new InMemoryHousekeepingRepository();
  const recep = new InMemoryRecepcionRepository(ctx.hotelesRepo, opts);
  const room = async (code: string, roomTypeId = ctx.roomTypeId) => {
    const r = await ctx.hotelesRepo.insertRoom({ propertyId: ctx.propertyId, organizationId: ctx.organizationId, roomTypeId, code });
    hk.seedRoom({ id: r.id, propertyId: ctx.propertyId, code, roomType: "Doble", status: "disponible" });
    return r.id;
  };
  const r101 = await room("101");
  const r102 = await room("102");
  const r103 = await room("103");
  const otherType = randomUUID();
  ctx.hotelesRepo.seedRoomType(ctx.propertyId, otherType, { name: "Suite", maxOccupancy: 4 });
  const r201 = await room("201", otherType);
  for (const s of Object.values(ctx.staff)) hk.seedStaff(ctx.propertyId, s.id);
  const app = buildApp({ ...ctx.deps, hotelesHousekeepingRepo: (_db) => hk, hotelesRecepcionRepo: (_db) => recep });
  const reserva = (over: { status?: "confirmada" | "check_in" | "en_estancia" | "check_out" | "cerrada" | "cancelada"; in?: string; out?: string; roomId?: string | null; guestId?: string | null; roomTypeId?: string }) => {
    const id = randomUUID();
    ctx.hotelesRepo.seedReservation({
      id,
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      roomTypeId: over.roomTypeId ?? ctx.roomTypeId,
      guestId: over.guestId === undefined ? ctx.guestId : over.guestId,
      checkInDate: over.in ?? HOY,
      checkOutDate: over.out ?? "2026-12-05",
      status: over.status ?? "confirmada",
      totalAmount: 3000,
      cancellationPenaltyAmount: null,
      canceledAt: null,
      createdAt: NOW.toISOString(),
      roomId: over.roomId ?? null,
    });
    return id;
  };
  const base = `/hoteles/${ctx.propertyId}/recepcion`;
  const setRoomStatus = (roomId: string, status: string) => {
    ((ctx.hotelesRepo as unknown as { rooms: Map<string, { status: string }> }).rooms.get(roomId) as { status: string }).status = status;
  };
  return { ctx, hk, recep, app, base, r101, r102, r103, r201, reserva, setRoomStatus };
}
type S = Awaited<ReturnType<typeof setup>>;

const post = (s: S, path: string, token: string, body: unknown = {}) => s.app.request(`${s.base}${path}`, authedJson(token, body));
const json = async <T>(res: Response) => (await res.json()) as T;

interface Tablero {
  fecha: string;
  tareasDisponibles: boolean;
  identidadDisponible: boolean;
  resumen: Record<string, number>;
  llegadas: { reservaId: string; estado: string; habitacion: { codigo: string } | null; huesped: { nombre: string } | null; identidadRegistrada: boolean | null; noches: number }[];
  salidas: { reservaId: string; estado: string }[];
  enCasa: { reservaId: string; estado: string; salidaVencida: boolean }[];
  rack: { codigo: string; ocupacion: string; estado: string; tipoHabitacionId: string | null; reserva: { huesped: string | null } | null }[];
}

describe("GET /recepcion -- tablero del dia", () => {
  it("clasifica llegadas, salidas y en casa con la fecha de hoy de la property y arma el rack con limpieza", async () => {
    const s = await setup();
    const llega = s.reserva({ roomId: s.r101 });
    const sinHab = s.reserva({});
    const sale = s.reserva({ status: "en_estancia", in: "2026-11-29", out: HOY, roomId: s.r102 });
    const casa = s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04", roomId: s.r103 });
    s.reserva({ status: "cancelada" });
    s.reserva({ in: "2026-12-10", out: "2026-12-12" });

    const res = await s.app.request(s.base, authedJson(s.ctx.staff.frontdesk.token));
    expect(res.status).toBe(200);
    const body = await json<Tablero>(res);
    expect(body.fecha).toBe(HOY);
    expect(body.llegadas.map((l) => l.reservaId).sort()).toEqual([llega, sinHab].sort());
    expect(body.llegadas.find((l) => l.reservaId === sinHab)!.habitacion).toBeNull();
    expect(body.llegadas.find((l) => l.reservaId === llega)).toMatchObject({ huesped: { nombre: "Ana Torres" }, noches: 3 });
    expect(body.salidas.map((x) => x.reservaId)).toEqual([sale]);
    expect(body.enCasa.map((x) => x.reservaId).sort()).toEqual([sale, casa].sort());
    expect(body.resumen).toMatchObject({ llegadas: 2, llegadasPendientes: 2, salidas: 1, salidasPendientes: 1, enCasa: 2 });
    const rack = Object.fromEntries(body.rack.map((r) => [r.codigo, r]));
    expect(rack["101"]).toMatchObject({ ocupacion: "llegada", reserva: { huesped: "Ana Torres" } });
    expect(rack["102"]!.ocupacion).toBe("ocupada");
    expect(rack["103"]!.ocupacion).toBe("ocupada");
    expect(rack["201"]).toMatchObject({ ocupacion: "libre", estado: "disponible" });
    expect(rack["201"]!.tipoHabitacionId).not.toBeNull();
  });

  it("marca como vencida una salida que no se registro y respeta ?fecha=", async () => {
    const s = await setup();
    s.reserva({ status: "en_estancia", in: "2026-11-28", out: "2026-12-01", roomId: s.r101 });
    const hoy = await json<Tablero>(await s.app.request(s.base, authedJson(s.ctx.staff.owner.token)));
    expect(hoy.enCasa[0]!.salidaVencida).toBe(true);
    const otroDia = await json<Tablero>(await s.app.request(`${s.base}?fecha=2026-12-01`, authedJson(s.ctx.staff.owner.token)));
    expect(otroDia.fecha).toBe("2026-12-01");
    expect(otroDia.enCasa[0]!.salidaVencida).toBe(false);
    expect(otroDia.salidas).toHaveLength(1);
  });

  it("valida la fecha, y solo owner/gm/frontdesk/reservations la ven (housekeeping, fnb y contabilidad reciben 403)", async () => {
    const s = await setup();
    expect((await s.app.request(`${s.base}?fecha=ayer`, authedJson(s.ctx.staff.owner.token))).status).toBe(400);
    for (const rol of ["owner", "gm", "frontdesk", "reservations"] as const) expect((await s.app.request(s.base, authedJson(s.ctx.staff[rol].token))).status).toBe(200);
    for (const rol of ["housekeeping", "fnb", "accountant"] as const) expect((await s.app.request(s.base, authedJson(s.ctx.staff[rol].token))).status).toBe(403);
    expect((await s.app.request(s.base)).status).toBe(401);
  });

  it("identidad: expone solo un booleano y 'null' cuando la boveda no esta disponible; no filtra documento ni telefono", async () => {
    const s = await setup();
    s.reserva({ roomId: s.r101 });
    s.recep.seedIdentidad(s.ctx.propertyId, s.ctx.guestId);
    const con = await json<Tablero>(await s.app.request(s.base, authedJson(s.ctx.staff.frontdesk.token)));
    expect(con.llegadas[0]!.identidadRegistrada).toBe(true);
    expect(con.identidadDisponible).toBe(true);
    expect(JSON.stringify(con)).not.toMatch(/5511112222|ana\.torres@/);

    const sinBoveda = await setup({ identidadDisponible: false });
    sinBoveda.reserva({ roomId: sinBoveda.r101 });
    const body = await json<Tablero>(await sinBoveda.app.request(sinBoveda.base, authedJson(sinBoveda.ctx.staff.frontdesk.token)));
    expect(body.identidadDisponible).toBe(false);
    expect(body.llegadas[0]!.identidadRegistrada).toBeNull();
  });
});

describe("POST /recepcion/reservas/:id/check-in", () => {
  it("de un clic: confirmada -> en_estancia con la habitacion ya asignada", async () => {
    const s = await setup();
    const id = s.reserva({ roomId: s.r101 });
    const res = await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token);
    expect(res.status).toBe(200);
    expect(await json<{ estado: string; habitacion: { codigo: string } }>(res)).toMatchObject({ estado: "en_estancia", habitacion: { codigo: "101" } });
    const tablero = await json<Tablero>(await s.app.request(s.base, authedJson(s.ctx.staff.frontdesk.token)));
    expect(tablero.enCasa.map((x) => x.reservaId)).toEqual([id]);
  });

  it("asigna la habitacion elegida en el mismo clic y la deja en la bitacora", async () => {
    const s = await setup();
    const id = s.reserva({});
    const res = await post(s, `/reservas/${id}/check-in`, s.ctx.staff.gm.token, { roomId: s.r102 });
    expect(res.status).toBe(200);
    expect(s.recep.cambios).toEqual([{ reservationId: id, fromRoomId: null, toRoomId: s.r102, reason: "Asignacion en el check-in" }]);
  });

  it("sin habitacion asignada ni elegida responde 400", async () => {
    const s = await setup();
    const id = s.reserva({});
    expect((await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token)).status).toBe(400);
  });

  it("sin sobreventa: otra reserva activa en la misma habitacion y fechas da 409 habitacion_ocupada y no cambia el estado", async () => {
    const s = await setup();
    s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04", roomId: s.r101 });
    const id = s.reserva({});
    const res = await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token, { roomId: s.r101 });
    expect(res.status).toBe(409);
    expect(await json<{ code: string }>(res)).toMatchObject({ code: "habitacion_ocupada" });
    expect((await s.ctx.hotelesRepo.findReservation(s.ctx.propertyId, id))!.status).toBe("confirmada");
  });

  it("una reserva asignada de antemano a una habitacion ya tomada tambien se rechaza", async () => {
    const s = await setup();
    s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04", roomId: s.r101 });
    const id = s.reserva({ roomId: s.r101 });
    expect((await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token)).status).toBe(409);
  });

  it("habitacion sucia o fuera de servicio no recibe huesped (409), tipo distinto 400", async () => {
    const s = await setup();
    const id = s.reserva({});
    s.setRoomStatus(s.r101, "sucia");
    s.setRoomStatus(s.r102, "fuera_de_servicio");
    const sucia = await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token, { roomId: s.r101 });
    expect(sucia.status).toBe(409);
    expect(await json<{ code: string }>(sucia)).toMatchObject({ code: "habitacion_no_lista" });
    const fuera = await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token, { roomId: s.r102 });
    expect(await json<{ code: string }>(fuera)).toMatchObject({ code: "habitacion_no_disponible" });
    expect((await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token, { roomId: s.r201 })).status).toBe(400);
  });

  it("llegada futura o estancia vencida se rechazan; solo reservas confirmadas", async () => {
    const s = await setup();
    const futura = s.reserva({ in: "2026-12-03", out: "2026-12-05", roomId: s.r101 });
    expect(await json<{ code: string }>(await post(s, `/reservas/${futura}/check-in`, s.ctx.staff.frontdesk.token))).toMatchObject({ code: "llegada_no_es_hoy" });
    const vencida = s.reserva({ in: "2026-11-28", out: "2026-12-02", roomId: s.r102 });
    expect(await json<{ code: string }>(await post(s, `/reservas/${vencida}/check-in`, s.ctx.staff.frontdesk.token))).toMatchObject({ code: "estancia_vencida" });
    const yaDentro = s.reserva({ status: "en_estancia", roomId: s.r103 });
    expect((await post(s, `/reservas/${yaDentro}/check-in`, s.ctx.staff.frontdesk.token)).status).toBe(409);
    expect((await post(s, `/reservas/${randomUUID()}/check-in`, s.ctx.staff.frontdesk.token)).status).toBe(404);
  });

  it("solo owner/gm/frontdesk operan: reservations, housekeeping y contabilidad reciben 403", async () => {
    const s = await setup();
    const id = s.reserva({ roomId: s.r101 });
    for (const rol of ["reservations", "housekeeping", "fnb", "accountant"] as const) {
      expect((await post(s, `/reservas/${id}/check-in`, s.ctx.staff[rol].token)).status).toBe(403);
    }
    expect((await s.ctx.hotelesRepo.findReservation(s.ctx.propertyId, id))!.status).toBe("confirmada");
  });

  it("contra una base sin la migracion 038 cae a la asignacion simple (con revision de traslape) y el check-in funciona", async () => {
    const s = await setup({ migrated: false });
    s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04", roomId: s.r101 });
    const id = s.reserva({});
    expect((await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token, { roomId: s.r101 })).status).toBe(409);
    const ok = await post(s, `/reservas/${id}/check-in`, s.ctx.staff.frontdesk.token, { roomId: s.r102 });
    expect(ok.status).toBe(200);
    expect(await json<{ estado: string }>(ok)).toMatchObject({ estado: "en_estancia" });
  });
});

describe("POST /recepcion/reservas/:id/check-out", () => {
  it("de un clic: en_estancia -> check_out y la habitacion queda sucia para limpieza", async () => {
    const s = await setup();
    const id = s.reserva({ status: "en_estancia", in: "2026-11-30", out: HOY, roomId: s.r101 });
    s.hk.seedRoom({ id: s.r101, propertyId: s.ctx.propertyId, code: "101", roomType: "Doble", status: "ocupada" });
    const res = await post(s, `/reservas/${id}/check-out`, s.ctx.staff.frontdesk.token);
    expect(res.status).toBe(200);
    expect(await json<{ estado: string; habitacionMarcadaSucia: boolean; foliosAbiertos: number }>(res)).toMatchObject({ estado: "check_out", habitacionMarcadaSucia: true, foliosAbiertos: 0 });
    expect(s.hk.roomStatus(s.r101)).toBe("sucia");
  });

  it("avisa cuantos folios siguen abiertos (no los cierra) y acepta una reserva en check_in", async () => {
    const s = await setup();
    const id = s.reserva({ status: "check_in", in: "2026-11-30", out: HOY, roomId: s.r102 });
    await s.ctx.hotelesRepo.ensurePrimaryFolio(s.ctx.propertyId, s.ctx.organizationId, id);
    const res = await post(s, `/reservas/${id}/check-out`, s.ctx.staff.owner.token);
    expect(await json<{ estado: string; foliosAbiertos: number }>(res)).toMatchObject({ estado: "check_out", foliosAbiertos: 1 });
  });

  it("no se hace check-out de una reserva que no esta en casa (409) ni inexistente (404); roles 403", async () => {
    const s = await setup();
    const confirmada = s.reserva({ roomId: s.r101 });
    expect((await post(s, `/reservas/${confirmada}/check-out`, s.ctx.staff.frontdesk.token)).status).toBe(409);
    expect((await post(s, `/reservas/${randomUUID()}/check-out`, s.ctx.staff.frontdesk.token)).status).toBe(404);
    const dentro = s.reserva({ status: "en_estancia", roomId: s.r102 });
    expect((await post(s, `/reservas/${dentro}/check-out`, s.ctx.staff.housekeeping.token)).status).toBe(403);
    expect((await s.ctx.hotelesRepo.findReservation(s.ctx.propertyId, dentro))!.status).toBe("en_estancia");
  });

  it("si no se pudo marcar la habitacion sucia el check-out sigue siendo valido", async () => {
    const s = await setup();
    // Habitacion que housekeeping no conoce: `markRoomDirty` no la encuentra y el check-out sigue siendo valido.
    const roomSinHk = await s.ctx.hotelesRepo.insertRoom({ propertyId: s.ctx.propertyId, organizationId: s.ctx.organizationId, roomTypeId: s.ctx.roomTypeId, code: "999" });
    const id2 = s.reserva({ status: "en_estancia", roomId: roomSinHk.id });
    const res = await post(s, `/reservas/${id2}/check-out`, s.ctx.staff.frontdesk.token);
    expect(res.status).toBe(200);
    expect(await json<{ estado: string; habitacionMarcadaSucia: boolean }>(res)).toMatchObject({ estado: "check_out", habitacionMarcadaSucia: false });
  });
});

describe("POST /recepcion/reservas/:id/cambiar-habitacion", () => {
  it("cambia a otra habitacion del mismo tipo y la bitacora registra de-a", async () => {
    const s = await setup();
    const id = s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04", roomId: s.r101 });
    const res = await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r102, motivo: "Ruido en el pasillo" });
    expect(res.status).toBe(200);
    expect(await json<{ roomId: string; habitacionAnteriorId: string; habitacionId: string }>(res)).toMatchObject({ roomId: s.r102, habitacionAnteriorId: s.r101, habitacionId: s.r102 });
    expect(s.recep.cambios).toEqual([{ reservationId: id, fromRoomId: s.r101, toRoomId: s.r102, reason: "Ruido en el pasillo" }]);
  });

  it("rechaza traslape (409 habitacion_ocupada), tipo distinto (400), misma habitacion (400) y estado no modificable (409)", async () => {
    const s = await setup();
    const id = s.reserva({ status: "en_estancia", in: "2026-12-01", out: "2026-12-04", roomId: s.r101 });
    s.reserva({ status: "confirmada", in: "2026-12-03", out: "2026-12-06", roomId: s.r102 });
    const traslape = await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r102 });
    expect(traslape.status).toBe(409);
    expect(await json<{ code: string }>(traslape)).toMatchObject({ code: "habitacion_ocupada" });
    expect((await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r201 })).status).toBe(400);
    expect((await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r101 })).status).toBe(400);
    const cerrada = s.reserva({ status: "check_out", roomId: s.r103 });
    const noMod = await post(s, `/reservas/${cerrada}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r101 });
    expect(await json<{ code: string }>(noMod)).toMatchObject({ code: "reserva_no_modificable" });
  });

  it("valida el body, la reserva y el rol", async () => {
    const s = await setup();
    const id = s.reserva({ roomId: s.r101 });
    expect((await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, {})).status).toBe(400);
    expect((await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: "no-uuid" })).status).toBe(400);
    expect((await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r102, motivo: "x" })).status).toBe(400);
    expect((await post(s, `/reservas/${randomUUID()}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r102 })).status).toBe(404);
    expect((await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.reservations.token, { roomId: s.r102 })).status).toBe(403);
  });

  it("contra una base sin la migracion 038 responde 503 honesto (no_disponible_aun), nunca 500", async () => {
    const s = await setup({ migrated: false });
    const id = s.reserva({ roomId: s.r101 });
    const res = await post(s, `/reservas/${id}/cambiar-habitacion`, s.ctx.staff.frontdesk.token, { roomId: s.r102 });
    expect(res.status).toBe(503);
    expect((await json<{ message: string }>(res)).message).toMatch(/migracion 038/);
  });
});

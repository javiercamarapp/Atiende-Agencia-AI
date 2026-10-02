// H-04 -- housekeeping completo: integracion HTTP real (app.request) sobre el repositorio en
// memoria. RLS/GRANT/triggers/CHECK los cubre scripts/verify-hoteles-housekeeping contra
// Postgres real; el SAVEPOINT contra base sin migrar lo cubre
// packages/domain-hoteles/tests/housekeeping-savepoint.spec.ts (AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHousekeepingRepository, InMemoryHousekeepingResidualRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

const FECHA = "2026-03-10";

async function setup(opts?: { migrated?: boolean }) {
  const ctx = await buildHotelesTestContext(buildApp);
  const hk = new InMemoryHousekeepingRepository(opts);
  const room101 = randomUUID();
  const room102 = randomUUID();
  hk.seedRoom({ id: room101, propertyId: ctx.propertyId, code: "101", roomType: "Doble", status: "sucia" });
  hk.seedRoom({ id: room102, propertyId: ctx.propertyId, code: "102", roomType: "Doble", status: "ocupada" });
  for (const s of Object.values(ctx.staff)) hk.seedStaff(ctx.propertyId, s.id);
  const residual = new InMemoryHousekeepingResidualRepository(hk, opts);
  const app = buildApp({ ...ctx.deps, hotelesHousekeepingRepo: (_db) => hk, hotelesHousekeepingResidualRepo: (_db) => residual });
  const base = `/hoteles/${ctx.propertyId}/housekeeping`;
  return { ctx, hk, app, base, room101, room102 };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function generar(s: Setup, token = s.ctx.staff.frontdesk.token) {
  const res = await s.app.request(`${s.base}/tareas/generar`, authedJson(token, { fecha: FECHA }));
  return res;
}
async function tareas(s: Setup, token = s.ctx.staff.frontdesk.token) {
  const res = await s.app.request(`${s.base}/tareas?fecha=${FECHA}`, authedJson(token));
  return ((await res.json()) as { tareas: { id: string; habitacion: string; estado: string; asignadoA: string | null }[] }).tareas;
}
function post(s: Setup, path: string, token: string, body: unknown = {}) {
  return s.app.request(`${s.base}${path}`, authedJson(token, body));
}

describe("generar el dia y tablero", () => {
  it("frontdesk genera tareas para sucias/ocupadas (201), idempotente, y el tablero las refleja", async () => {
    const s = await setup();
    const res = await generar(s);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ fecha: FECHA, creadas: 2 });
    expect(await (await generar(s)).json()).toEqual({ fecha: FECHA, creadas: 0 });

    const board = (await (await s.app.request(`${s.base}/tablero?fecha=${FECHA}`, authedJson(s.ctx.staff.housekeeping.token))).json()) as {
      tareasDisponibles: boolean;
      habitaciones: { codigo: string; estado: string; tarea: { tipo: string; estado: string } | null }[];
    };
    expect(board.tareasDisponibles).toBe(true);
    expect(board.habitaciones.map((h) => [h.codigo, h.estado, h.tarea?.tipo])).toEqual([["101", "sucia", "salida"], ["102", "ocupada", "estancia"]]);
  });

  it("fnb/accountant/reservations no ven el tablero ni generan (403)", async () => {
    const s = await setup();
    for (const t of [s.ctx.staff.fnb.token, s.ctx.staff.accountant.token, s.ctx.staff.reservations.token]) {
      expect((await s.app.request(`${s.base}/tablero?fecha=${FECHA}`, authedJson(t))).status).toBe(403);
      expect((await generar(s, t)).status).toBe(403);
    }
  });

  it("fecha mal formada -> 400; sin fecha usa el dia del negocio", async () => {
    const s = await setup();
    expect((await s.app.request(`${s.base}/tablero?fecha=10-03-2026`, authedJson(s.ctx.staff.owner.token))).status).toBe(400);
    const res = await s.app.request(`${s.base}/tablero`, authedJson(s.ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { fecha: string }).fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("ciclo de una tarea: iniciar -> terminar -> inspeccionar", () => {
  it("la camarista toma una tarea sin asignar, la termina; supervision aprueba y la habitacion queda disponible", async () => {
    const s = await setup();
    await generar(s);
    const t101 = (await tareas(s)).find((t) => t.habitacion === "101")!;

    const iniciada = await post(s, `/tareas/${t101.id}/iniciar`, s.ctx.staff.housekeeping.token);
    expect(iniciada.status).toBe(200);
    expect(await iniciada.json()).toMatchObject({ estado: "en_progreso", asignadoA: s.ctx.staff.housekeeping.id });
    expect((await post(s, `/tareas/${t101.id}/iniciar`, s.ctx.staff.housekeeping.token)).status).toBe(409);

    expect((await post(s, `/tareas/${t101.id}/terminar`, s.ctx.staff.housekeeping.token)).status).toBe(200);

    // quien limpio no inspecciona su propio trabajo
    const auto = await post(s, `/tareas/${t101.id}/inspeccionar`, s.ctx.staff.housekeeping.token, { aprobada: true });
    expect(auto.status).toBe(403);

    const aprobada = await post(s, `/tareas/${t101.id}/inspeccionar`, s.ctx.staff.frontdesk.token, { aprobada: true });
    expect(aprobada.status).toBe(200);
    expect(await aprobada.json()).toMatchObject({ estado: "inspeccionada", resultadoInspeccion: "aprobada" });
    expect(s.hk.roomStatus(s.room101)).toBe("disponible");
  });

  it("rechazar exige nota; el rechazo regresa la tarea a pendiente y la habitacion sigue sucia", async () => {
    const s = await setup();
    await generar(s);
    const t101 = (await tareas(s)).find((t) => t.habitacion === "101")!;
    await post(s, `/tareas/${t101.id}/iniciar`, s.ctx.staff.housekeeping.token);
    await post(s, `/tareas/${t101.id}/terminar`, s.ctx.staff.housekeeping.token);

    expect((await post(s, `/tareas/${t101.id}/inspeccionar`, s.ctx.staff.gm.token, { aprobada: false })).status).toBe(400);
    const rechazo = await post(s, `/tareas/${t101.id}/inspeccionar`, s.ctx.staff.gm.token, { aprobada: false, nota: "Falta polvo en repisas" });
    expect(rechazo.status).toBe(200);
    expect(await rechazo.json()).toMatchObject({ estado: "pendiente", rechazos: 1, resultadoInspeccion: "rechazada", notaInspeccion: "Falta polvo en repisas" });
    expect(s.hk.roomStatus(s.room101)).toBe("sucia");
  });

  it("la camarista no opera tareas asignadas a otra; terminar sin iniciar es 409; tarea inexistente 404", async () => {
    const s = await setup();
    await generar(s);
    const t102 = (await tareas(s)).find((t) => t.habitacion === "102")!;
    // supervision asigna a la camarista; una segunda camarista (rol housekeeping) no podria, aqui lo cubre frontdesk->otro
    const asignada = await post(s, `/tareas/${t102.id}/asignar`, s.ctx.staff.frontdesk.token, { asignadoA: s.ctx.staff.owner.id });
    expect(asignada.status).toBe(200);
    expect((await post(s, `/tareas/${t102.id}/iniciar`, s.ctx.staff.housekeeping.token)).status).toBe(403);
    expect((await post(s, `/tareas/${t102.id}/terminar`, s.ctx.staff.owner.token)).status).toBe(409);
    expect((await post(s, `/tareas/${randomUUID()}/iniciar`, s.ctx.staff.owner.token)).status).toBe(404);
    expect((await post(s, `/tareas/no-es-uuid/iniciar`, s.ctx.staff.owner.token)).status).toBe(400);
  });

  it("asignar a alguien que no es staff de la property -> 400; cancelar una tarea pendiente es valido y no se cancela dos veces", async () => {
    const s = await setup();
    await generar(s);
    const t101 = (await tareas(s)).find((t) => t.habitacion === "101")!;
    expect((await post(s, `/tareas/${t101.id}/asignar`, s.ctx.staff.owner.token, { asignadoA: randomUUID() })).status).toBe(400);
    expect((await post(s, `/tareas/${t101.id}/cancelar`, s.ctx.staff.owner.token)).status).toBe(200);
    expect((await post(s, `/tareas/${t101.id}/cancelar`, s.ctx.staff.owner.token)).status).toBe(409);
  });

  it("crear una tarea manual valida tipo/prioridad/habitacion y rechaza duplicados activos", async () => {
    const s = await setup();
    const ok = await post(s, "/tareas", s.ctx.staff.frontdesk.token, { roomId: s.room101, tipo: "profunda", prioridad: "alta", fecha: FECHA, notas: "VIP llega a las 3" });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ habitacion: "101", tipo: "profunda", prioridad: "alta", estado: "pendiente" });
    expect((await post(s, "/tareas", s.ctx.staff.frontdesk.token, { roomId: s.room101, tipo: "profunda", fecha: FECHA })).status).toBe(409);
    expect((await post(s, "/tareas", s.ctx.staff.frontdesk.token, { roomId: s.room101, tipo: "inventado" })).status).toBe(400);
    expect((await post(s, "/tareas", s.ctx.staff.frontdesk.token, { roomId: randomUUID(), fecha: FECHA })).status).toBe(404);
    expect((await post(s, "/tareas", s.ctx.staff.fnb.token, { roomId: s.room101 })).status).toBe(403);
  });
});

describe("habitaciones fuera de servicio", () => {
  it("frontdesk inhabilita (la habitacion cambia de estado), no una ocupada, y rehabilitar la deja sucia", async () => {
    const s = await setup();
    const res = await post(s, "/fuera-de-servicio", s.ctx.staff.frontdesk.token, { roomId: s.room101, tipo: "fuera_de_orden", motivo: "Fuga en el bano", desde: FECHA, regresoEstimado: "2026-03-14" });
    expect(res.status).toBe(201);
    const oos = (await res.json()) as { id: string; estado: string };
    expect(oos.estado).toBe("activo");
    expect(s.hk.roomStatus(s.room101)).toBe("mantenimiento");

    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.frontdesk.token, { roomId: s.room102, motivo: "Pintura" })).status).toBe(409);
    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.frontdesk.token, { roomId: s.room101, motivo: "Otra vez" })).status).toBe(409);

    const listed = (await (await s.app.request(`${s.base}/fuera-de-servicio`, authedJson(s.ctx.staff.housekeeping.token))).json()) as { fueraDeServicio: unknown[] };
    expect(listed.fueraDeServicio).toHaveLength(1);

    const back = await post(s, `/fuera-de-servicio/${oos.id}/rehabilitar`, s.ctx.staff.gm.token);
    expect(back.status).toBe(200);
    expect(s.hk.roomStatus(s.room101)).toBe("sucia");
    expect((await post(s, `/fuera-de-servicio/${oos.id}/rehabilitar`, s.ctx.staff.gm.token)).status).toBe(404);
  });

  it("housekeeping y fnb NO inhabilitan (403); motivo corto y fechas incoherentes -> 400", async () => {
    const s = await setup();
    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.housekeeping.token, { roomId: s.room101, motivo: "Pintura" })).status).toBe(403);
    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.fnb.token, { roomId: s.room101, motivo: "Pintura" })).status).toBe(403);
    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.owner.token, { roomId: s.room101, motivo: "x" })).status).toBe(400);
    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.owner.token, { roomId: s.room101, motivo: "Pintura", desde: FECHA, regresoEstimado: "2026-03-01" })).status).toBe(400);
  });

  it("una habitacion inhabilitada no genera tarea al generar el dia y el tablero la marca", async () => {
    const s = await setup();
    await post(s, "/fuera-de-servicio", s.ctx.staff.owner.token, { roomId: s.room101, motivo: "Renovacion", desde: FECHA });
    expect(await (await generar(s)).json()).toEqual({ fecha: FECHA, creadas: 1 });
    const board = (await (await s.app.request(`${s.base}/tablero?fecha=${FECHA}`, authedJson(s.ctx.staff.owner.token))).json()) as {
      habitaciones: { codigo: string; fueraDeServicio: { motivo: string } | null }[];
    };
    expect(board.habitaciones.find((h) => h.codigo === "101")?.fueraDeServicio?.motivo).toBe("Renovacion");
  });
});

describe("marcar sucia y reporte diario", () => {
  it("marca sucia una habitacion ocupada; una ya sucia da 409; inexistente 404", async () => {
    const s = await setup();
    const ok = await post(s, `/habitaciones/${s.room102}/sucia`, s.ctx.staff.housekeeping.token);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ roomId: s.room102, estado: "sucia" });
    expect((await post(s, `/habitaciones/${s.room101}/sucia`, s.ctx.staff.housekeeping.token)).status).toBe(409);
    expect((await post(s, `/habitaciones/${randomUUID()}/sucia`, s.ctx.staff.housekeeping.token)).status).toBe(404);
    expect((await post(s, `/habitaciones/${s.room102}/sucia`, s.ctx.staff.fnb.token)).status).toBe(403);
  });

  it("el reporte agrega por responsable, cuenta rechazos y habitaciones por estado", async () => {
    const s = await setup();
    await generar(s);
    const t101 = (await tareas(s)).find((t) => t.habitacion === "101")!;
    await post(s, `/tareas/${t101.id}/iniciar`, s.ctx.staff.housekeeping.token);
    await post(s, `/tareas/${t101.id}/terminar`, s.ctx.staff.housekeeping.token);
    await post(s, `/tareas/${t101.id}/inspeccionar`, s.ctx.staff.gm.token, { aprobada: false, nota: "Repasar bano" });
    const rep = (await (await s.app.request(`${s.base}/reporte?fecha=${FECHA}`, authedJson(s.ctx.staff.gm.token))).json()) as {
      tareasDisponibles: boolean;
      totales: { total: number; pendientes: number; rechazos: number };
      porResponsable: { assignedTo: string | null; rechazos: number }[];
      habitacionesPorEstado: Record<string, number>;
    };
    expect(rep.tareasDisponibles).toBe(true);
    expect(rep.totales).toMatchObject({ total: 2, pendientes: 2, rechazos: 1 });
    expect(rep.porResponsable.find((r) => r.assignedTo === s.ctx.staff.housekeeping.id)?.rechazos).toBe(1);
    expect(rep.habitacionesPorEstado).toMatchObject({ sucia: 1, ocupada: 1 });
  });
});

describe("compatibilidad con la base SIN migrar (migracion 033 pendiente)", () => {
  it("el tablero y el reporte responden 200 honestos; listas vacias; las escrituras 503, nunca 500", async () => {
    const s = await setup({ migrated: false });
    const board = await s.app.request(`${s.base}/tablero?fecha=${FECHA}`, authedJson(s.ctx.staff.owner.token));
    expect(board.status).toBe(200);
    const body = (await board.json()) as { tareasDisponibles: boolean; habitaciones: { estado: string; tarea: unknown }[] };
    expect(body.tareasDisponibles).toBe(false);
    expect(body.habitaciones.map((h) => [h.estado, h.tarea])).toEqual([["sucia", null], ["ocupada", null]]);

    const rep = await s.app.request(`${s.base}/reporte?fecha=${FECHA}`, authedJson(s.ctx.staff.owner.token));
    expect(rep.status).toBe(200);
    expect(((await rep.json()) as { tareasDisponibles: boolean }).tareasDisponibles).toBe(false);
    expect((await s.app.request(`${s.base}/fuera-de-servicio`, authedJson(s.ctx.staff.owner.token))).status).toBe(200);
    expect(await tareas(s, s.ctx.staff.owner.token)).toEqual([]);

    expect((await generar(s)).status).toBe(503);
    expect((await post(s, "/fuera-de-servicio", s.ctx.staff.owner.token, { roomId: s.room101, motivo: "Pintura" })).status).toBe(503);
  });

  it("las rutas anteriores (turnos y tickets de mantenimiento) siguen funcionando", async () => {
    const s = await setup({ migrated: false });
    const res = await s.app.request(`/hoteles/${s.ctx.propertyId}/mantenimiento/tickets`, authedJson(s.ctx.staff.frontdesk.token, { titulo: "Foco fundido", descripcion: "Pasillo 2" }));
    expect(res.status).toBe(201);
  });
});

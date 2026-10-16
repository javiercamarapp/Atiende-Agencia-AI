// H-P3-04 -- cron /internal/hoteles/housekeeping-dia: el dia de housekeeping arranca solo. Integracion sobre los repositorios en memoria
// (la regla de generacion es la MISMA del boton "Generar dia"). Las funciones SQL `hoteles.system_hk_*`, su guard de sistema, el ledger y
// el cross-tenant los cubre scripts/verify-hoteles-housekeeping-dia contra Postgres real; el SAVEPOINT contra base sin migrar,
// packages/domain-hoteles/tests/housekeeping-dia-savepoint.spec.ts (AbortAwareFakeSession).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHousekeepingDiaSistemaRepository, InMemoryHousekeepingRepository, InMemoryHousekeepingResidualRepository } from "@atiende/domain-hoteles";
import { buildApp } from "../src/app.ts";
import { fechaYHoraLocal, runHousekeepingDiaSweep } from "../src/routes/verticals/hoteles/housekeeping-dia-cron.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

// Enero 2026: CDMX UTC-6 (sin horario de verano), Cancun UTC-5, Tijuana UTC-8 (PST).
const utc = (hhmm: string) => new Date(`2026-01-15T${hhmm}:00.000Z`);

async function setup(opts: { migrated?: boolean; autoAssign?: boolean; maxTasks?: number; startHour?: number } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  const hk = new InMemoryHousekeepingRepository();
  const residual = new InMemoryHousekeepingResidualRepository(hk);
  const dia = new InMemoryHousekeepingDiaSistemaRepository(hk, residual);
  dia.migrated = opts.migrated !== false;
  const room101 = randomUUID();
  const room102 = randomUUID();
  hk.seedRoom({ id: room101, propertyId: ctx.propertyId, code: "101", status: "sucia" });
  hk.seedRoom({ id: room102, propertyId: ctx.propertyId, code: "102", status: "ocupada" });
  await residual.saveConfig(
    ctx.propertyId,
    { autoAssignEnabled: opts.autoAssign === true, startHour: opts.startHour ?? 7, ...(opts.maxTasks ? { maxTasksPerCamarista: opts.maxTasks } : {}) },
    ctx.staff.owner.id,
  );
  const { deps, emisiones } = conEmisiones({ ...ctx.deps, hotelesHousekeepingRepo: () => hk, hotelesHousekeepingResidualRepo: () => residual, hotelesHousekeepingDiaRepo: () => dia });
  const cron = (method = "POST") => buildApp(deps).request("/internal/hoteles/housekeeping-dia", { method, headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
  const mia = async (now: Date) => (await runHousekeepingDiaSweep(deps, now)).find((r) => r.propertyId === ctx.propertyId)!;
  return { ctx, hk, residual, dia, deps, emisiones, room101, room102, cron, mia };
}

describe("fechaYHoraLocal", () => {
  it("usa el dia y la hora de la zona, no los de UTC (incluida la medianoche local como hora 0)", () => {
    expect(fechaYHoraLocal(utc("13:30"), "America/Mexico_City")).toEqual({ fecha: "2026-01-15", hora: 7 });
    expect(fechaYHoraLocal(utc("06:05"), "America/Mexico_City")).toEqual({ fecha: "2026-01-15", hora: 0 });
    expect(fechaYHoraLocal(utc("05:59"), "America/Mexico_City")).toEqual({ fecha: "2026-01-14", hora: 23 });
    expect(fechaYHoraLocal(utc("13:30"), "America/Tijuana")).toEqual({ fecha: "2026-01-15", hora: 5 });
  });
});

describe("cron del arranque del dia de housekeeping", () => {
  it("sin secreto: 401, y no genera nada", async () => {
    const s = await setup();
    expect((await buildApp(s.deps).request("/internal/hoteles/housekeeping-dia", { method: "POST" })).status).toBe(401);
    expect(await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).toHaveLength(0);
  });

  it("a la hora de arranque local genera las tareas del dia (salida/estancia) y avisa en la campana, una vez por property y dia", async () => {
    const s = await setup();
    const r = await s.mia(utc("13:30")); // 07:30 en CDMX
    expect(r).toMatchObject({ fecha: "2026-01-15", omitida: null, generadas: 2, asignadas: 0, sinAsignar: 2, error: null });
    const tareas = await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" });
    expect(tareas.map((t) => [t.roomCode, t.taskType, t.status, t.createdBy])).toEqual([["101", "salida", "pendiente", "sistema"], ["102", "estancia", "pendiente", "sistema"]]);
    const aviso = s.emisiones.filter((e) => e.evento === "hoteles.housekeeping.dia_generado");
    expect(aviso).toHaveLength(1);
    expect(aviso[0]).toMatchObject({
      propertyId: s.ctx.propertyId,
      categoria: "automatizaciones",
      cuerpo: "Tareas generadas: 2. Sin asignar: 2.",
      enlace: "/hoteles/{orgSlug}/housekeeping",
      dedupeKey: `hoteles.housekeeping.dia_generado:${s.ctx.propertyId}:2026-01-15`,
    });
    expect(s.emisiones.some((e) => e.evento === "hoteles.housekeeping.sin_cupo")).toBe(false); // asignacion apagada: sin asignar es lo esperado
  });

  it("idempotente por (property, fecha): una segunda corrida no duplica tareas ni avisos", async () => {
    const s = await setup();
    await s.mia(utc("13:30"));
    const otra = await s.mia(utc("14:10"));
    expect(otra).toMatchObject({ omitida: "ya_arrancado", generadas: 0, asignadas: 0, error: null });
    expect(await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).toHaveLength(2);
    expect(s.emisiones.filter((e) => e.evento === "hoteles.housekeeping.dia_generado")).toHaveLength(1);
    // Y un dia nuevo SI arranca de nuevo.
    const manana = await s.mia(new Date("2026-01-16T13:30:00.000Z"));
    expect(manana).toMatchObject({ fecha: "2026-01-16", omitida: null });
  });

  it("antes de la hora local de arranque no hace nada; despues de la ventana de recuperacion tampoco", async () => {
    const s = await setup();
    expect(await s.mia(utc("12:30"))).toMatchObject({ omitida: "fuera_de_horario", generadas: 0 }); // 06:30 local
    expect(await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).toHaveLength(0);
    expect(await s.mia(utc("16:00"))).toMatchObject({ omitida: "fuera_de_horario" }); // 10:00 local: ya paso la ventana de 3 h
    expect(await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).toHaveLength(0);
  });

  it("recupera un arranque perdido dentro de la ventana (la corrida de las 07:00 fallo; la de las 09:00 lo arranca)", async () => {
    const s = await setup();
    expect(await s.mia(utc("15:05"))).toMatchObject({ omitida: null, generadas: 2 }); // 09:05 local
  });

  it("zona horaria por property: con las mismas 13:30 UTC arranca la de CDMX (07:30) y NO la de Tijuana (05:30)", async () => {
    const s = await setup();
    const tijuana = randomUUID();
    s.ctx.hotelesRepo.seedActiveHotelProperty(s.ctx.organizationId, tijuana, "America/Tijuana");
    s.hk.seedRoom({ id: randomUUID(), propertyId: tijuana, code: "201", status: "sucia" });
    const resultados = await runHousekeepingDiaSweep(s.deps, utc("13:30"));
    const cdmx = resultados.find((r) => r.propertyId === s.ctx.propertyId)!;
    const tj = resultados.find((r) => r.propertyId === tijuana)!;
    expect(cdmx).toMatchObject({ omitida: null, generadas: 2 });
    expect(tj).toMatchObject({ omitida: "fuera_de_horario", generadas: 0, fecha: "2026-01-15" });
    // Dos horas y media despues (15:30 UTC = 07:30 Tijuana) arranca la de Tijuana, y la de CDMX ya esta arrancada.
    const despues = await runHousekeepingDiaSweep(s.deps, utc("15:30"));
    expect(despues.find((r) => r.propertyId === tijuana)).toMatchObject({ omitida: null, generadas: 1 });
    expect(despues.find((r) => r.propertyId === s.ctx.propertyId)).toMatchObject({ omitida: "ya_arrancado", generadas: 0 });
  });

  it("respeta la hora de arranque configurada (09:00) en vez del 07:00 por omision", async () => {
    const s = await setup({ startHour: 9 });
    expect(await s.mia(utc("13:30"))).toMatchObject({ omitida: "fuera_de_horario" }); // 07:30 local
    expect(await s.mia(utc("15:30"))).toMatchObject({ omitida: null, generadas: 2 }); // 09:30 local
  });

  it("respeta el opt-out de limpieza: no genera la tarea de estancia de la habitacion que no quiere servicio", async () => {
    const s = await setup();
    await s.residual.registerOptOut({ propertyId: s.ctx.propertyId, roomId: s.room102, optOutDate: "2026-01-15", source: "recepcion", note: null, createdBy: s.ctx.staff.owner.id });
    const r = await s.mia(utc("13:30"));
    expect(r.generadas).toBe(1);
    expect((await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).map((t) => t.roomCode)).toEqual(["101"]);
  });

  it("asignacion apagada: genera pero NO asigna a nadie aunque haya camaristas", async () => {
    const s = await setup({ autoAssign: false });
    s.dia.seedCamarista(s.ctx.propertyId, { id: randomUUID(), nombre: "Ana" });
    const r = await s.mia(utc("13:30"));
    expect(r).toMatchObject({ generadas: 2, asignadas: 0, sinAsignar: 2 });
    expect((await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).every((t) => t.assignedTo === null)).toBe(true);
  });

  it("asignacion encendida: reparte las tareas entre las camaristas, cierra el ledger y no avisa de falta de cupo", async () => {
    const s = await setup({ autoAssign: true });
    const ana = randomUUID();
    const luis = randomUUID();
    s.dia.seedCamarista(s.ctx.propertyId, { id: ana, nombre: "Ana" });
    s.dia.seedCamarista(s.ctx.propertyId, { id: luis, nombre: "Luis" });
    const r = await s.mia(utc("13:30"));
    expect(r).toMatchObject({ generadas: 2, asignadas: 2, sinAsignar: 0, error: null });
    const asignados = (await s.hk.listTasks(s.ctx.propertyId, { workDate: "2026-01-15" })).map((t) => t.assignedTo).sort();
    expect(asignados).toEqual([ana, luis].sort()); // una a cada una: equilibra minutos
    expect(s.dia.ledgerOf(s.ctx.propertyId, "2026-01-15")).toEqual({ generadas: 2, asignadas: 2, sinAsignar: 0 });
    expect(s.emisiones.some((e) => e.evento === "hoteles.housekeeping.sin_cupo")).toBe(false);
  });

  it("asignacion encendida sin camaristas o sin cupo: lo que no cabe queda sin asignar y avisa 'sin_cupo' (una por propiedad por dia)", async () => {
    const s = await setup({ autoAssign: true, maxTasks: 1 });
    s.dia.seedCamarista(s.ctx.propertyId, { id: randomUUID(), nombre: "Ana" });
    const r = await s.mia(utc("13:30"));
    expect(r).toMatchObject({ generadas: 2, asignadas: 1, sinAsignar: 1 });
    const sinCupo = s.emisiones.filter((e) => e.evento === "hoteles.housekeeping.sin_cupo");
    expect(sinCupo).toHaveLength(1);
    expect(sinCupo[0]).toMatchObject({ cuerpo: "Tareas sin asignar: 1.", dedupeKey: `hoteles.housekeeping.sin_cupo:${s.ctx.propertyId}:2026-01-15` });
  });

  it("una property sin habitaciones sucias/ocupadas arranca (ledger) pero no genera ruido en la campana", async () => {
    const s = await setup();
    s.hk.seedRoom({ id: s.room101, propertyId: s.ctx.propertyId, code: "101", status: "disponible" });
    s.hk.seedRoom({ id: s.room102, propertyId: s.ctx.propertyId, code: "102", status: "disponible" });
    const r = await s.mia(utc("13:30"));
    expect(r).toMatchObject({ omitida: null, generadas: 0, asignadas: 0, sinAsignar: 0 });
    expect(s.emisiones).toHaveLength(0);
  });

  it("base sin la migracion 045: la property se omite (migracion_pendiente) sin fallar el latido", async () => {
    const s = await setup({ migrated: false });
    const res = await s.cron();
    const body = (await res.json()) as { ok: boolean; corridas: { omitida: string | null }[] };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.corridas.every((c) => c.omitida === "migracion_pendiente")).toBe(true);
  });

  it("la ruta HTTP responde el resumen con el secreto interno (GET y POST)", async () => {
    const s = await setup();
    for (const method of ["POST", "GET"]) {
      const res = await s.cron(method);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, properties_revisadas: 1 });
    }
  });

  it("un fallo real de una property se reporta (ok:false) en vez de esconderse", async () => {
    const s = await setup();
    s.dia.startDay = async () => {
      throw new Error("boom");
    };
    const r = await s.mia(utc("13:30"));
    expect(r).toMatchObject({ error: "boom", omitida: null, generadas: 0 });
  });
});

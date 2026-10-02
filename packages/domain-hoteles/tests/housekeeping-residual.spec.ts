// H-26 -- reglas puras del housekeeping residual (config, fotos con firma real, blancos, asignacion automatica) y el espejo
// en memoria (tope de fotos, opt-out que cancela tareas pendientes de estancia/repaso). RLS/GRANT/triggers: scripts/verify-hoteles-hk-canal.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOUSEKEEPING_CONFIG,
  HousekeepingConflictError,
  HousekeepingInvalidInputError,
  HousekeepingUnavailableError,
  InMemoryHousekeepingRepository,
  InMemoryHousekeepingResidualRepository,
  buildLinenReport,
  decodePhotoBase64,
  detectImageType,
  mergeHousekeepingConfig,
  parseHousekeepingConfigPatch,
  parseLinenInput,
  planAutoAssignment,
  type AutoAssignTask,
} from "../src/index.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

describe("parseHousekeepingConfigPatch", () => {
  it("acepta un patch parcial y lo mezcla sobre los valores por defecto", () => {
    const patch = parseHousekeepingConfigPatch({ asignacionAutomatica: true, minutosPorTipo: { salida: 55 } });
    const merged = mergeHousekeepingConfig(DEFAULT_HOUSEKEEPING_CONFIG, patch);
    expect(merged.autoAssignEnabled).toBe(true);
    expect(merged.minutesByType).toEqual({ salida: 55, estancia: 20, profunda: 90, repaso: 10 });
    expect(merged.maxTasksPerCamarista).toBe(14);
  });
  it.each([
    [{}, /Nada que actualizar/],
    [{ otraCosa: 1 }, /Campo desconocido/],
    [{ maxTareasPorCamarista: 0 }, /entre 1 y 60/],
    [{ minutosJornada: 30 }, /entre 60 y 720/],
    [{ maxFotosPorTarea: 11 }, /entre 1 y 10/],
    [{ minutosPorTipo: { limpiezaExtra: 10 } }, /tipo desconocido/],
    [{ minutosPorTipo: { salida: 2 } }, /entre 5 y 240/],
    [{ asignacionAutomatica: "si" }, /true o false/],
    [[], /objeto/],
  ])("rechaza %j", (body, msg) => {
    expect(() => parseHousekeepingConfigPatch(body)).toThrow(HousekeepingInvalidInputError);
    expect(() => parseHousekeepingConfigPatch(body)).toThrow(msg);
  });
});

describe("fotos: firma real, no el tipo declarado", () => {
  it("detecta jpeg/png/webp por magic bytes y rechaza lo demas", () => {
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(PNG)).toBe("image/png");
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(detectImageType(webp)).toBe("image/webp");
    expect(detectImageType(Uint8Array.from([0x3c, 0x73, 0x76, 0x67, 0x3e]))).toBeNull(); // <svg>
    expect(detectImageType(new Uint8Array(0))).toBeNull();
  });
  it("decodifica base64 con o sin prefijo data: y valida", () => {
    expect(decodePhotoBase64(b64(PNG)).contentType).toBe("image/png");
    expect(decodePhotoBase64(`data:image/jpeg;base64,${b64(JPEG)}`).contentType).toBe("image/jpeg");
    expect(() => decodePhotoBase64("")).toThrow(/requerida/);
    expect(() => decodePhotoBase64("no es base64!!")).toThrow(/base64 invalido/);
    expect(() => decodePhotoBase64(b64(Uint8Array.from([0x3c, 0x73, 0x76, 0x67])))).toThrow(/solo se aceptan/);
  });
  it("rechaza una cadena gigante ANTES de decodificarla", () => {
    expect(() => decodePhotoBase64("A".repeat(3_000_000))).toThrow(/maximo/);
  });
  it("rechaza una imagen valida que pasa de 1.5 MB", () => {
    const big = new Uint8Array(1_572_864 + 1);
    big.set(JPEG);
    expect(() => decodePhotoBase64(b64(big))).toThrow(/entre 1 y/);
  });
});

describe("conteo de blancos", () => {
  it("parsea y rechaza articulos fuera de la lista cerrada, fechas malas y cantidades negativas", () => {
    expect(parseLinenInput({ articulo: "sabanas", fecha: "2026-03-10", limpias: 10, sucias: 2 })).toMatchObject({ item: "sabanas", qtyClean: 10, qtyDirty: 2, qtyLaundry: 0, qtyDamaged: 0 });
    expect(() => parseLinenInput({ articulo: "mantel", fecha: "2026-03-10" })).toThrow(/articulo/);
    expect(() => parseLinenInput({ articulo: "sabanas", fecha: "10/03/2026" })).toThrow(/fecha/);
    expect(() => parseLinenInput({ articulo: "sabanas", fecha: "2026-03-10", limpias: -1 })).toThrow(/limpias/);
  });
  it("el reporte compara contra el ultimo conteo anterior y detecta faltantes", () => {
    const rec = (item: "sabanas" | "toallas_bano", countDate: string, c: number, d = 0) => ({ item, countDate, qtyClean: c, qtyDirty: d, qtyLaundry: 0, qtyDamaged: 0, countedBy: null, updatedAt: "x" });
    const rows = buildLinenReport([rec("sabanas", "2026-03-10", 90)], [rec("sabanas", "2026-03-08", 50), rec("sabanas", "2026-03-09", 100, 5)]);
    const sabanas = rows.find((r) => r.item === "sabanas")!;
    expect(sabanas.totalActual).toBe(90);
    expect(sabanas.anterior).toEqual({ countDate: "2026-03-09", total: 105 });
    expect(sabanas.diferencia).toBe(-15);
    const toallas = rows.find((r) => r.item === "toallas_bano")!;
    expect(toallas).toMatchObject({ actual: null, totalActual: null, diferencia: null });
    expect(rows).toHaveLength(7);
  });
});

describe("planAutoAssignment", () => {
  const cfg = { maxTasksPerCamarista: 3, shiftMinutes: 100, minutesByType: DEFAULT_HOUSEKEEPING_CONFIG.minutesByType };
  const task = (id: string, room: string, taskType: AutoAssignTask["taskType"], priority: AutoAssignTask["priority"] = "normal"): AutoAssignTask => ({ id, roomCode: room, taskType, priority });

  it("reparte equilibrando minutos, prioridad alta primero y es determinista", () => {
    const tasks = [task("t1", "101", "salida"), task("t2", "102", "salida"), task("t3", "103", "estancia", "alta"), task("t4", "104", "repaso")];
    const loads = [{ camaristaId: "a", tasks: 0, minutes: 0 }, { camaristaId: "b", tasks: 0, minutes: 0 }];
    const plan = planAutoAssignment(tasks, loads, cfg);
    expect(plan.unassigned).toEqual([]);
    expect(plan.assignments[0]).toEqual({ taskId: "t3", camaristaId: "a" }); // alta primero, desempate por id
    const minutes = (id: string) => plan.assignments.filter((a) => a.camaristaId === id).reduce((s, a) => s + cfg.minutesByType[tasks.find((t) => t.id === a.taskId)!.taskType], 0);
    expect(Math.abs(minutes("a") - minutes("b"))).toBeLessThanOrEqual(40);
    expect(planAutoAssignment(tasks, loads, cfg)).toEqual(plan);
  });
  it("respeta el tope de jornada y de tareas: lo que no cabe queda sin asignar", () => {
    const tasks = [task("t1", "101", "salida"), task("t2", "102", "salida"), task("t3", "103", "salida")];
    const plan = planAutoAssignment(tasks, [{ camaristaId: "a", tasks: 0, minutes: 0 }], cfg); // 40+40=80, el tercero (120) no cabe en 100
    expect(plan.assignments).toHaveLength(2);
    expect(plan.unassigned).toHaveLength(1);
    const full = planAutoAssignment([task("t9", "109", "repaso")], [{ camaristaId: "a", tasks: 3, minutes: 0 }], cfg);
    expect(full.unassigned).toEqual(["t9"]);
  });
  it("sin camaristas todo queda sin asignar", () => {
    expect(planAutoAssignment([task("t1", "101", "salida")], [], cfg)).toEqual({ assignments: [], unassigned: ["t1"] });
  });
  it("cuenta la carga existente de la camarista", () => {
    const plan = planAutoAssignment([task("t1", "101", "repaso")], [{ camaristaId: "a", tasks: 1, minutes: 60 }, { camaristaId: "b", tasks: 0, minutes: 0 }], cfg);
    expect(plan.assignments).toEqual([{ taskId: "t1", camaristaId: "b" }]);
  });
});

describe("InMemoryHousekeepingResidualRepository", () => {
  const P = randomUUID();
  const U = randomUUID();
  async function setup(migrated = true) {
    const hk = new InMemoryHousekeepingRepository();
    const room = randomUUID();
    hk.seedRoom({ id: room, propertyId: P, code: "101", status: "ocupada" });
    hk.seedStaff(P, U);
    return { hk, room, residual: new InMemoryHousekeepingResidualRepository(hk, { migrated }) };
  }

  it("tope de fotos por tarea segun la config y borrado", async () => {
    const { hk, room, residual } = await setup();
    const task = await hk.createTask({ propertyId: P, roomId: room, taskType: "salida", priority: "normal", workDate: "2026-03-10", assignedTo: null, notes: null, createdBy: U });
    await residual.saveConfig(P, parseHousekeepingConfigPatch({ maxFotosPorTarea: 1 }), U);
    const photo = await residual.addPhoto({ propertyId: P, taskId: task.id, contentType: "image/png", bytes: PNG, caption: null, takenBy: U });
    await expect(residual.addPhoto({ propertyId: P, taskId: task.id, contentType: "image/png", bytes: PNG, caption: null, takenBy: U })).rejects.toBeInstanceOf(HousekeepingConflictError);
    expect(await residual.deletePhoto(P, task.id, photo.id)).toBe(true);
    expect(await residual.deletePhoto(P, task.id, photo.id)).toBe(false);
  });

  it("el opt-out cancela las tareas PENDIENTES de estancia/repaso pero no la de salida; uno activo por dia; revertible", async () => {
    const { hk, room, residual } = await setup();
    const estancia = await hk.createTask({ propertyId: P, roomId: room, taskType: "estancia", priority: "normal", workDate: "2026-03-10", assignedTo: null, notes: null, createdBy: U });
    const salida = await hk.createTask({ propertyId: P, roomId: room, taskType: "salida", priority: "normal", workDate: "2026-03-10", assignedTo: null, notes: null, createdBy: U });
    const r = await residual.registerOptOut({ propertyId: P, roomId: room, optOutDate: "2026-03-10", source: "huesped", note: null, createdBy: U });
    expect(r.tareasCanceladas).toBe(1);
    expect((await hk.findTask(P, estancia.id))?.status).toBe("cancelada");
    expect((await hk.findTask(P, salida.id))?.status).toBe("pendiente");
    await expect(residual.registerOptOut({ propertyId: P, roomId: room, optOutDate: "2026-03-10", source: "huesped", note: null, createdBy: U })).rejects.toBeInstanceOf(HousekeepingConflictError);
    expect(await residual.hasActiveOptOut(P, room, "2026-03-10")).toBe(true);
    expect((await residual.revertOptOut(P, r.optOut.id, U))?.status).toBe("revertido");
    expect(await residual.hasActiveOptOut(P, room, "2026-03-10")).toBe(false);
    expect(await residual.revertOptOut(P, r.optOut.id, U)).toBeNull();
  });

  it("generateDay omite la tarea de estancia de las habitaciones con opt-out", async () => {
    const { hk, room } = await setup();
    expect(await hk.generateDay(P, "2026-03-10", U, [room])).toBe(0);
    expect(await hk.generateDay(P, "2026-03-10", U)).toBe(1);
  });

  it("base sin migrar: lecturas vacias honestas, escrituras HousekeepingUnavailableError", async () => {
    const { residual } = await setup(false);
    expect((await residual.getConfig(P)).disponible).toBe(false);
    expect(await residual.listOptOuts(P, "2026-03-10")).toEqual({ disponible: false, optOuts: [] });
    expect(await residual.hasActiveOptOut(P, randomUUID(), "2026-03-10")).toBe(false);
    await expect(residual.saveConfig(P, { autoAssignEnabled: true }, U)).rejects.toBeInstanceOf(HousekeepingUnavailableError);
  });
});

// L-04 -- dominio puro de la sala de guerra: validacion, semaforo y tablero.
import { describe, expect, it } from "vitest";
import {
  SalaGuerraValidationError,
  buildWarRoomBoard,
  deadlineSemaphore,
  parseWarRoomEntryCreate,
  parseWarRoomItemCreate,
  parseWarRoomItemPatch,
  worstSemaphore,
} from "../src/sala-guerra.ts";
import type { WarRoomItemRecord } from "../src/sala-guerra.ts";
import type { GoNoGoDecisionRecord } from "../src/types.ts";

const NOW = "2026-10-01T12:00:00.000Z";
const hoursFromNow = (h: number): string => new Date(Date.parse(NOW) + h * 3600_000).toISOString();
const UUID = "00000000-0000-4000-8000-000000000001";

function item(partial: Partial<WarRoomItemRecord> & Pick<WarRoomItemRecord, "kind">): WarRoomItemRecord {
  return {
    id: partial.id ?? crypto.randomUUID(),
    organizationId: "org",
    tenderId: "t1",
    title: "Item",
    description: null,
    status: "pendiente",
    severity: null,
    responsibleUserId: UUID,
    dueAt: null,
    requirementItemId: null,
    createdBy: UUID,
    createdAt: NOW,
    updatedBy: null,
    updatedAt: NOW,
    completedAt: null,
    ...partial,
  };
}

describe("deadlineSemaphore", () => {
  it("vencida -> rojo/vencido", () => {
    expect(deadlineSemaphore(hoursFromNow(-2), NOW)).toMatchObject({ color: "rojo", state: "vencido" });
  });
  it("menos de 24 h -> rojo/vence_hoy", () => {
    expect(deadlineSemaphore(hoursFromNow(23), NOW)).toMatchObject({ color: "rojo", state: "vence_hoy" });
  });
  it("entre 24 y 72 h -> amarillo", () => {
    expect(deadlineSemaphore(hoursFromNow(24), NOW)).toMatchObject({ color: "amarillo", state: "vence_pronto" });
    expect(deadlineSemaphore(hoursFromNow(71.9), NOW).color).toBe("amarillo");
  });
  it("72 h o mas -> verde", () => {
    expect(deadlineSemaphore(hoursFromNow(72), NOW)).toMatchObject({ color: "verde", state: "en_tiempo" });
  });
  it("sin fecha -> gris, nunca una urgencia inventada", () => {
    expect(deadlineSemaphore(null, NOW)).toEqual({ color: "gris", state: "sin_fecha", hoursRemaining: null });
  });
  it("cerrado gana sobre una fecha vencida", () => {
    expect(deadlineSemaphore(hoursFromNow(-100), NOW, true)).toMatchObject({ color: "gris", state: "cerrado" });
  });
  it("fecha basura -> gris, no lanza", () => {
    expect(deadlineSemaphore("no-es-fecha", NOW).color).toBe("gris");
  });
  it("worstSemaphore elige el mas urgente", () => {
    expect(worstSemaphore(["verde", "rojo", "amarillo"])).toBe("rojo");
    expect(worstSemaphore([])).toBe("gris");
  });
});

describe("parseWarRoomItemCreate", () => {
  it("un riesgo sin severidad queda en media", () => {
    expect(parseWarRoomItemCreate({ kind: "riesgo", title: "Fianza no tramitada" }).severity).toBe("media");
  });
  it("una tarea con severidad se rechaza (mismo CHECK que la base)", () => {
    expect(() => parseWarRoomItemCreate({ kind: "tarea", title: "Recabar firmas", severity: "alta" })).toThrow(SalaGuerraValidationError);
  });
  it("titulo corto, tipo desconocido, responsable no-UUID y fecha invalida se rechazan", () => {
    expect(() => parseWarRoomItemCreate({ kind: "tarea", title: "ab" })).toThrow(/title/);
    expect(() => parseWarRoomItemCreate({ kind: "otra", title: "Titulo valido" })).toThrow(/kind/);
    expect(() => parseWarRoomItemCreate({ kind: "tarea", title: "Titulo valido", responsibleUserId: "x" })).toThrow(/responsibleUserId/);
    expect(() => parseWarRoomItemCreate({ kind: "tarea", title: "Titulo valido", dueAt: "manana" })).toThrow(/dueAt/);
  });
  it("normaliza dueAt a ISO UTC", () => {
    expect(parseWarRoomItemCreate({ kind: "tarea", title: "Titulo valido", dueAt: "2026-10-05T10:00:00-06:00" }).dueAt).toBe("2026-10-05T16:00:00.000Z");
  });
});

describe("parseWarRoomItemPatch", () => {
  it("severidad solo en riesgos y un riesgo nunca la pierde", () => {
    expect(() => parseWarRoomItemPatch({ severity: "alta" }, "tarea")).toThrow(/solo los riesgos/);
    expect(() => parseWarRoomItemPatch({ severity: null }, "riesgo")).toThrow(/siempre lleva severidad/);
    expect(parseWarRoomItemPatch({ severity: "critica" }, "riesgo")).toEqual({ severity: "critica" });
  });
  it("un patch vacio se rechaza y el estado se valida", () => {
    expect(() => parseWarRoomItemPatch({}, "tarea")).toThrow(/ningun campo/);
    expect(() => parseWarRoomItemPatch({ status: "terminado" }, "tarea")).toThrow(/status/);
  });
});

describe("parseWarRoomEntryCreate", () => {
  it("los eventos no se capturan a mano", () => {
    expect(() => parseWarRoomEntryCreate({ entryKind: "evento", body: "x" })).toThrow(/entryKind/);
    expect(parseWarRoomEntryCreate({ entryKind: "decision", body: "Se decide participar." })).toEqual({ entryKind: "decision", body: "Se decide participar.", itemId: null });
  });
});

describe("buildWarRoomBoard", () => {
  const goNo = (decision: "go" | "no_go", decidedAt: string): GoNoGoDecisionRecord => ({
    id: decidedAt,
    organizationId: "org",
    tenderId: "t1",
    decision,
    reasons: ["x"],
    matchScore: 1,
    matchEligibilityStatus: "no_evaluable",
    matchInputsHash: "h",
    decidedBy: UUID,
    decidedAt,
  });

  it("calcula avance, riesgos abiertos y toma la ultima decision go/no-go ya registrada", () => {
    const board = buildWarRoomBoard({
      items: [
        item({ kind: "requisito", status: "listo" }),
        item({ kind: "requisito", status: "bloqueado" }),
        item({ kind: "tarea", status: "pendiente", responsibleUserId: null }),
        item({ kind: "riesgo", status: "pendiente", severity: "alta" }),
        item({ kind: "riesgo", status: "listo", severity: "critica" }),
        item({ kind: "requisito", status: "descartado" }),
      ],
      goNoGoDecisions: [goNo("no_go", "2026-09-01T00:00:00.000Z"), goNo("go", "2026-09-02T00:00:00.000Z")],
      submissionDeadline: hoursFromNow(200),
      nowIso: NOW,
    });
    expect(board.summary.requisitos).toEqual({ total: 2, listos: 1, bloqueados: 1 });
    expect(board.summary.avancePct).toBe(33);
    expect(board.summary.riesgosAbiertos).toBe(1);
    expect(board.summary.riesgosAltos).toBe(1);
    expect(board.summary.sinResponsable).toBe(1);
    expect(board.goNoGo?.decision).toBe("go");
  });

  it("sin items no inventa avance (null) ni 100%", () => {
    const board = buildWarRoomBoard({ items: [], goNoGoDecisions: [], submissionDeadline: null, nowIso: NOW });
    expect(board.summary.avancePct).toBeNull();
    expect(board.goNoGo).toBeNull();
    expect(board.summary.semaforoGeneral).toBe("gris");
  });

  it("el semaforo general toma el peor entre fechas de items, riesgo critico y plazo de presentacion", () => {
    const rojo = buildWarRoomBoard({ items: [item({ kind: "tarea", dueAt: hoursFromNow(-1) })], goNoGoDecisions: [], submissionDeadline: hoursFromNow(500), nowIso: NOW });
    expect(rojo.summary.semaforoGeneral).toBe("rojo");
    const critico = buildWarRoomBoard({ items: [item({ kind: "riesgo", severity: "critica" })], goNoGoDecisions: [], submissionDeadline: hoursFromNow(500), nowIso: NOW });
    expect(critico.summary.semaforoGeneral).toBe("rojo");
    const verde = buildWarRoomBoard({ items: [item({ kind: "tarea", dueAt: hoursFromNow(100) })], goNoGoDecisions: [], submissionDeadline: hoursFromNow(500), nowIso: NOW });
    expect(verde.summary.semaforoGeneral).toBe("verde");
  });

  it("un item cerrado con fecha vencida no pone el tablero en rojo", () => {
    const board = buildWarRoomBoard({ items: [item({ kind: "tarea", status: "listo", dueAt: hoursFromNow(-50) })], goNoGoDecisions: [], submissionDeadline: null, nowIso: NOW });
    expect(board.summary.semaforoGeneral).toBe("gris");
  });
});

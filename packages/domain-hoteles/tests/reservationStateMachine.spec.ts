import { describe, expect, it } from "vitest";
import {
  RESERVATION_STATUSES,
  isReservationStatus,
  canTransition,
  isCancellable,
  isModifiable,
  rolesAllowedForTransition,
  canRolePerformTransition,
  evaluateCancellation,
  type ReservationStatus,
} from "../src/reservationStateMachine.ts";

describe("canTransition", () => {
  it("acepta exactamente las 8 transiciones declaradas del ciclo de vida real", () => {
    const valid: Array<[ReservationStatus, ReservationStatus]> = [
      ["cotizada", "confirmada"],
      ["cotizada", "cancelada"],
      ["confirmada", "check_in"],
      ["confirmada", "cancelada"],
      ["confirmada", "no_show"],
      ["check_in", "en_estancia"],
      ["en_estancia", "check_out"],
      ["check_out", "cerrada"],
    ];
    for (const [from, to] of valid) {
      expect(canTransition(from, to), `${from} -> ${to} debería ser válida`).toBe(true);
    }
  });

  it("rechaza check_in -> cancelada (después de check-in ya no se puede cancelar)", () => {
    expect(canTransition("check_in", "cancelada")).toBe(false);
  });

  it("rechaza en_estancia -> cancelada", () => {
    expect(canTransition("en_estancia", "cancelada")).toBe(false);
  });

  it("rechaza saltarse pasos (confirmada -> en_estancia directo)", () => {
    expect(canTransition("confirmada", "en_estancia")).toBe(false);
  });

  it("rechaza retroceder (check_in -> confirmada)", () => {
    expect(canTransition("check_in", "confirmada")).toBe(false);
  });

  it("los estados terminales (cerrada/cancelada/no_show) no tienen ninguna transición de salida", () => {
    const terminal: ReservationStatus[] = ["cerrada", "cancelada", "no_show"];
    for (const from of terminal) {
      for (const to of RESERVATION_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to} debería ser inválida (estado terminal)`).toBe(false);
      }
    }
  });

  it("rechaza una transición a sí mismo (no está en la tabla)", () => {
    expect(canTransition("confirmada", "confirmada")).toBe(false);
  });
});

describe("isReservationStatus", () => {
  it("reconoce los 8 estados reales", () => {
    for (const status of RESERVATION_STATUSES) expect(isReservationStatus(status)).toBe(true);
  });
  it("rechaza un string arbitrario", () => {
    expect(isReservationStatus("pendiente")).toBe(false);
  });
});

describe("isCancellable", () => {
  it("cotizada y confirmada son cancelables", () => {
    expect(isCancellable("cotizada")).toBe(true);
    expect(isCancellable("confirmada")).toBe(true);
  });

  it("después de check_in NINGÚN estado es cancelable (verificado contra la tabla, no supuesto)", () => {
    const noCancelables: ReservationStatus[] = ["check_in", "en_estancia", "check_out", "cerrada", "cancelada", "no_show"];
    for (const status of noCancelables) expect(isCancellable(status), status).toBe(false);
  });
});

describe("isModifiable", () => {
  it("mismo criterio que isCancellable: solo cotizada/confirmada", () => {
    expect(isModifiable("cotizada")).toBe(true);
    expect(isModifiable("confirmada")).toBe(true);
    expect(isModifiable("check_in")).toBe(false);
  });
});

describe("rolesAllowedForTransition / canRolePerformTransition", () => {
  it("confirmada->check_in NUNCA incluye reservations ni accountant (solo owner/gm/frontdesk)", () => {
    const roles = rolesAllowedForTransition("confirmada", "check_in");
    expect(roles).toEqual(["owner", "gm", "frontdesk"]);
    expect(canRolePerformTransition("reservations", "confirmada", "check_in")).toBe(false);
    expect(canRolePerformTransition("frontdesk", "confirmada", "check_in")).toBe(true);
  });

  it("confirmada->no_show acepta el actor lógico 'system' además de los roles humanos", () => {
    expect(canRolePerformTransition("system", "confirmada", "no_show")).toBe(true);
    expect(canRolePerformTransition("system", "confirmada", "check_in")).toBe(false);
  });

  it("check_out->cerrada incluye accountant (a diferencia de las demás transiciones)", () => {
    expect(canRolePerformTransition("accountant", "check_out", "cerrada")).toBe(true);
    expect(canRolePerformTransition("accountant", "confirmada", "check_in")).toBe(false);
  });

  it("housekeeping/maintenance/fnb nunca aparecen en ninguna transición", () => {
    for (const [from, to] of [
      ["cotizada", "confirmada"],
      ["confirmada", "check_in"],
      ["check_in", "en_estancia"],
      ["en_estancia", "check_out"],
      ["check_out", "cerrada"],
    ] as const) {
      expect(canRolePerformTransition("housekeeping", from, to)).toBe(false);
      expect(canRolePerformTransition("maintenance", from, to)).toBe(false);
      expect(canRolePerformTransition("fnb", from, to)).toBe(false);
    }
  });

  it("una transición inexistente en la tabla no tiene roles permitidos", () => {
    expect(rolesAllowedForTransition("cerrada", "confirmada")).toEqual([]);
  });
});

describe("evaluateCancellation", () => {
  const policy = { freeUntilHours: 48, penaltyPct: 0.5 };

  it("cancelar con más anticipación que freeUntilHours no tiene penalización", () => {
    const result = evaluateCancellation({ checkInDate: "2026-12-10", now: new Date("2026-12-01T00:00:00Z"), policy });
    expect(result.penaltyPct).toBe(0);
    expect(result.hoursUntilCheckIn).toBeCloseTo(9 * 24, 5);
  });

  it("cancelar exactamente en el límite (freeUntilHours) todavía es libre", () => {
    const result = evaluateCancellation({ checkInDate: "2026-12-03", now: new Date("2026-12-01T00:00:00Z"), policy });
    expect(result.hoursUntilCheckIn).toBe(48);
    expect(result.penaltyPct).toBe(0);
  });

  it("cancelar dentro de la ventana de penalización cobra penaltyPct", () => {
    const result = evaluateCancellation({ checkInDate: "2026-12-01", now: new Date("2026-11-30T12:00:00Z"), policy });
    expect(result.hoursUntilCheckIn).toBe(12);
    expect(result.penaltyPct).toBe(0.5);
  });

  it("cancelar DESPUÉS de la fecha de check-in (no-show tardío autocancelado) también penaliza", () => {
    const result = evaluateCancellation({ checkInDate: "2026-12-01", now: new Date("2026-12-02T00:00:00Z"), policy });
    expect(result.hoursUntilCheckIn).toBe(-24);
    expect(result.penaltyPct).toBe(0.5);
  });
});

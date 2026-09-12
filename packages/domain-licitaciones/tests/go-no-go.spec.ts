// Pruebas de dominio, puras (sin IO) de `buildGoNoGoDecision` (§9 del diseño
// Fase 3: "rol insuficiente rechaza, motivo vacío rechaza, hash de insumos se
// sella con el match vigente en el momento exacto de decidir").
import { describe, expect, it } from "vitest";
import { buildGoNoGoDecision } from "../src/go-no-go.ts";
import { GoNoGoRejectedError } from "../src/errors.ts";
import { GO_NO_GO_ROLES, LICITACIONES_ROLES } from "../src/roles.ts";
import type { LicitacionesRole } from "../src/roles.ts";

function baseInput(overrides: Partial<Parameters<typeof buildGoNoGoDecision>[0]> = {}) {
  return {
    decision: "go" as const,
    reasons: ["Cumplimos el perfil técnico y el presupuesto es viable."],
    actorId: "user-1",
    actorRole: "owner" as LicitacionesRole,
    matchScore: 82.5,
    matchEligibilityStatus: "cumple" as const,
    matchInputsHash: "abc123",
    ...overrides,
  };
}

describe("buildGoNoGoDecision -- rol insuficiente rechaza SIEMPRE, sin excepción", () => {
  it.each(GO_NO_GO_ROLES)('permite decidir a "%s" (GO_NO_GO_ROLES = DECISION_ROLES + reviewer)', (role) => {
    expect(() => buildGoNoGoDecision(baseInput({ actorRole: role }))).not.toThrow();
  });

  it.each(LICITACIONES_ROLES.filter((r) => !GO_NO_GO_ROLES.includes(r)))('rechaza a "%s" (fuera de GO_NO_GO_ROLES: writer/viewer nunca deciden)', (role) => {
    expect(() => buildGoNoGoDecision(baseInput({ actorRole: role }))).toThrow(GoNoGoRejectedError);
    try {
      buildGoNoGoDecision(baseInput({ actorRole: role }));
    } catch (err) {
      expect((err as GoNoGoRejectedError).reasonCode).toBe("rol_no_autorizado_para_decidir_go_no_go");
    }
  });
});

describe("buildGoNoGoDecision -- motivo requerido, nunca una decisión sin justificación", () => {
  it("arreglo de reasons vacío -> GoNoGoRejectedError('motivo_requerido')", () => {
    expect(() => buildGoNoGoDecision(baseInput({ reasons: [] }))).toThrow(GoNoGoRejectedError);
    try {
      buildGoNoGoDecision(baseInput({ reasons: [] }));
    } catch (err) {
      expect((err as GoNoGoRejectedError).reasonCode).toBe("motivo_requerido");
    }
  });

  it("un motivo presente pero solo espacios en blanco también rechaza", () => {
    expect(() => buildGoNoGoDecision(baseInput({ reasons: ["   "] }))).toThrow(GoNoGoRejectedError);
  });

  it("al menos un motivo no vacío entre varios (aunque otro sea vacío) sigue rechazando -- TODOS deben ser no vacíos", () => {
    expect(() => buildGoNoGoDecision(baseInput({ reasons: ["Motivo válido", ""] }))).toThrow(GoNoGoRejectedError);
  });
});

describe("buildGoNoGoDecision -- el snapshot del match se sella tal cual, sin recalcularlo", () => {
  it("matchScore/matchEligibilityStatus/matchInputsHash pasan intactos al registro a persistir", () => {
    const result = buildGoNoGoDecision(baseInput({ matchScore: 47.3, matchEligibilityStatus: "no_evaluable", matchInputsHash: "deadbeef" }));
    expect(result.matchScore).toBe(47.3);
    expect(result.matchEligibilityStatus).toBe("no_evaluable");
    expect(result.matchInputsHash).toBe("deadbeef");
  });

  it("decidedBy/decidedByRole provienen del actor, decidedAt es un ISO 8601 con offset explícito ('Z')", () => {
    const result = buildGoNoGoDecision(baseInput({ actorId: "user-42", actorRole: "reviewer" }));
    expect(result.decidedBy).toBe("user-42");
    expect(result.decidedByRole).toBe("reviewer");
    expect(result.decidedAt).toMatch(/Z$/);
    expect(Number.isNaN(new Date(result.decidedAt).getTime())).toBe(false);
  });

  it("reasons se copia (no es la misma referencia del arreglo de entrada)", () => {
    const reasons = ["motivo A", "motivo B"];
    const result = buildGoNoGoDecision(baseInput({ reasons }));
    expect(result.reasons).toEqual(reasons);
    expect(result.reasons).not.toBe(reasons);
  });

  it("decision 'no_go' se preserva tal cual", () => {
    const result = buildGoNoGoDecision(baseInput({ decision: "no_go", reasons: ["Presupuesto insuficiente."] }));
    expect(result.decision).toBe("no_go");
  });
});

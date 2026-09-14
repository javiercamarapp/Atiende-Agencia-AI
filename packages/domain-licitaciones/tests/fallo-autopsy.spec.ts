import { describe, expect, it } from "vitest";
import { NO_DISPONIBLE, OWN_PROPOSAL_STATUSES, isOwnProposalStatus, normalizeOrNoDisponible, sanitizeCriteriaComparison } from "../src/fallo-autopsy.ts";

describe("fallo-autopsy.ts -- autopsia del fallo, sin inventar datos ausentes (REQ-054)", () => {
  it("4 estados posibles de la propuesta propia", () => {
    expect(OWN_PROPOSAL_STATUSES).toEqual(["ganadora", "desechada", "no_presentada", "desconocido"]);
  });

  it("isOwnProposalStatus distingue valores válidos de arbitrarios", () => {
    expect(isOwnProposalStatus("desechada")).toBe(true);
    expect(isOwnProposalStatus("perdida")).toBe(false);
  });

  it("normalizeOrNoDisponible: null/undefined/cadena vacía -> NO_DISPONIBLE, nunca ambiguo", () => {
    expect(normalizeOrNoDisponible(null)).toBe(NO_DISPONIBLE);
    expect(normalizeOrNoDisponible(undefined)).toBe(NO_DISPONIBLE);
    expect(normalizeOrNoDisponible("   ")).toBe(NO_DISPONIBLE);
  });

  it("normalizeOrNoDisponible: un valor real se conserva recortado", () => {
    expect(normalizeOrNoDisponible("  Proveedor Ganador S.A.  ")).toBe("Proveedor Ganador S.A.");
  });

  it("sanitizeCriteriaComparison filtra renglones inválidos sin lanzar", () => {
    const result = sanitizeCriteriaComparison([
      { criterio: "Experiencia", propio: "8/10", ganador: "9/10" },
      { criterio: "", propio: "x", ganador: "y" }, // criterio vacío -- se descarta.
      { criterio: "Precio" }, // faltan propio/ganador -- se descarta.
      "no es un objeto",
      null,
      { criterio: "Plazo", propio: "cumple", ganador: "cumple" },
    ]);
    expect(result).toEqual([
      { criterio: "Experiencia", propio: "8/10", ganador: "9/10" },
      { criterio: "Plazo", propio: "cumple", ganador: "cumple" },
    ]);
  });

  it("sanitizeCriteriaComparison con arreglo vacío -- arreglo vacío, nunca lanza", () => {
    expect(sanitizeCriteriaComparison([])).toEqual([]);
  });
});

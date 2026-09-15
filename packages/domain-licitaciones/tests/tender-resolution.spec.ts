import { describe, expect, it } from "vitest";
import { TENDER_RESOLUTIONS, TENDER_RESOLVABLE_FROM_STATUSES, checkTenderResolution, isTenderResolution } from "../src/tender-resolution.ts";
import { TENDER_STATUSES } from "../src/types.ts";
import type { TenderStatus } from "../src/types.ts";

describe("tender-resolution.ts -- máquina de validación de la resolución won/lost de una convocatoria", () => {
  it("2 resoluciones posibles: won/lost", () => {
    expect(TENDER_RESOLUTIONS).toEqual(["won", "lost"]);
  });

  it("isTenderResolution distingue valores válidos de arbitrarios", () => {
    expect(isTenderResolution("won")).toBe(true);
    expect(isTenderResolution("lost")).toBe(true);
    expect(isTenderResolution("go")).toBe(false);
    expect(isTenderResolution(42)).toBe(false);
  });

  it("solo se puede resolver desde go/in_progress/submitted -- nunca desde discovered/in_review (sin decisión go/no-go real)", () => {
    expect(checkTenderResolution("go").valid).toBe(true);
    expect(checkTenderResolution("in_progress").valid).toBe(true);
    expect(checkTenderResolution("submitted").valid).toBe(true);
    expect(checkTenderResolution("discovered").valid).toBe(false);
    expect(checkTenderResolution("in_review").valid).toBe(false);
  });

  it("nunca se puede resolver desde no_go (ya se decidió no participar) ni desde un estado ya terminal", () => {
    expect(checkTenderResolution("no_go").valid).toBe(false);
    expect(checkTenderResolution("cancelled").valid).toBe(false);
    expect(checkTenderResolution("won").valid).toBe(false);
    expect(checkTenderResolution("lost").valid).toBe(false);
  });

  it("checkTenderResolution nunca lanza -- devuelve valid:false con los estados permitidos", () => {
    const result = checkTenderResolution("discovered");
    expect(result.valid).toBe(false);
    expect(result.allowedFromStatuses).toEqual(TENDER_RESOLVABLE_FROM_STATUSES);
  });

  it("todo estado en TENDER_RESOLVABLE_FROM_STATUSES es un TenderStatus real del catálogo", () => {
    for (const s of TENDER_RESOLVABLE_FROM_STATUSES) expect(TENDER_STATUSES).toContain(s);
  });

  it("cobertura exhaustiva: cada TenderStatus real del catálogo tiene un veredicto determinista", () => {
    for (const status of TENDER_STATUSES as readonly TenderStatus[]) {
      const result = checkTenderResolution(status);
      expect(typeof result.valid).toBe("boolean");
    }
  });
});

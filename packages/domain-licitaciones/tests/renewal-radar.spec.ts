import { describe, expect, it } from "vitest";
import { DEFAULT_RENEWAL_LEAD_DAYS, daysBetween, computeRenewalAlertCandidates, urgencyForLeadDays, computeUpcomingRenewals } from "../src/renewal-radar.ts";

describe("renewal-radar.ts -- radar de renovaciones (REQ-055)", () => {
  it("daysBetween calcula días de calendario", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
  });

  it("un contrato ya vencido queda FUERA de alcance del radar", () => {
    const candidates = computeRenewalAlertCandidates([{ contractId: "c1", tenderId: "t1", endDate: "2025-12-01" }], "2026-01-01");
    expect(candidates).toEqual([]);
  });

  it("un contrato puede cruzar VARIOS umbrales a la vez -- nunca colapsa al más urgente", () => {
    // Faltan 20 días para el fin -- cruza 90, 60 y 30 simultáneamente.
    const candidates = computeRenewalAlertCandidates([{ contractId: "c1", tenderId: "t1", endDate: "2026-01-21" }], "2026-01-01", [90, 60, 30]);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.leadDays).sort((a, b) => a - b)).toEqual([30, 60, 90]);
  });

  it("un contrato con fin muy lejano no cruza ningún umbral", () => {
    const candidates = computeRenewalAlertCandidates([{ contractId: "c1", tenderId: "t1", endDate: "2027-01-01" }], "2026-01-01");
    expect(candidates).toEqual([]);
  });

  it("confianza nunca baja de 0.5 para una fecha de fin real y conocida, y es 1.0 justo en el umbral", () => {
    const exact = computeRenewalAlertCandidates([{ contractId: "c1", tenderId: "t1", endDate: "2026-01-31" }], "2026-01-01", [30]);
    expect(exact[0]!.confidence).toBe(1);
    for (const c of computeRenewalAlertCandidates([{ contractId: "c1", tenderId: "t1", endDate: "2026-01-01" }], "2026-01-01", [90])) {
      expect(c.confidence).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("DEFAULT_RENEWAL_LEAD_DAYS son 90/60/30", () => {
    expect(DEFAULT_RENEWAL_LEAD_DAYS).toEqual([90, 60, 30]);
  });

  it("urgencyForLeadDays: el umbral más chico es urgente, el más grande es seguimiento, el resto proxima", () => {
    const thresholds = [30, 60, 90];
    expect(urgencyForLeadDays(30, thresholds)).toBe("urgente");
    expect(urgencyForLeadDays(60, thresholds)).toBe("proxima");
    expect(urgencyForLeadDays(90, thresholds)).toBe("seguimiento");
  });

  it("urgencyForLeadDays con un único umbral -- siempre urgente", () => {
    expect(urgencyForLeadDays(45, [45])).toBe("urgente");
  });

  it("computeUpcomingRenewals agrega daysUntilEnd y urgency sin tocar ningún estado persistido", () => {
    const upcoming = computeUpcomingRenewals([{ contractId: "c1", tenderId: "t1", endDate: "2026-01-21" }], "2026-01-01", [90, 60, 30]);
    expect(upcoming).toHaveLength(3);
    for (const u of upcoming) {
      expect(u.daysUntilEnd).toBe(20);
      expect(["urgente", "proxima", "seguimiento"]).toContain(u.urgency);
    }
    const urgent = upcoming.find((u) => u.leadDays === 30)!;
    expect(urgent.urgency).toBe("urgente");
  });
});

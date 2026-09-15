import { describe, expect, it } from "vitest";
import { formatComplianceResult, formatContractFieldKey, formatContractFieldStatus, formatContractStatus, formatDate, formatDeadline, formatEligibility, formatMoney, formatTenderStatus } from "../src/verticals/licitaciones/lib/format.ts";

describe("formatMoney", () => {
  it("null -> mensaje honesto, nunca $0", () => {
    expect(formatMoney(null, "MXN")).toBe("Sin presupuesto declarado");
  });

  it("formatea con la moneda real, sin decimales", () => {
    expect(formatMoney(250000, "MXN")).toContain("250,000");
  });
});

describe("formatDeadline", () => {
  it("null -> mensaje honesto, nunca una fecha inventada", () => {
    expect(formatDeadline(null)).toBe("Sin fecha límite declarada");
  });

  it("formatea una fecha ISO real", () => {
    expect(formatDeadline("2026-12-15T18:00:00-06:00")).toContain("2026");
  });
});

describe("formatDate", () => {
  it("formatea una fecha ISO", () => {
    expect(formatDate("2026-01-02T00:00:00Z")).toContain("2026");
  });
});

describe("formatTenderStatus", () => {
  it("null -> 'Sin estatus'", () => {
    expect(formatTenderStatus(null)).toBe("Sin estatus");
  });

  it("mapea un estatus conocido", () => {
    expect(formatTenderStatus("discovered")).toBe("Descubierta");
  });

  it("un estatus desconocido se muestra tal cual (nunca oculta el dato real)", () => {
    expect(formatTenderStatus("algo_nuevo")).toBe("algo_nuevo");
  });
});

describe("formatEligibility / formatComplianceResult", () => {
  it("mapean los valores conocidos", () => {
    expect(formatEligibility("cumple")).toBe("Cumple");
    expect(formatComplianceResult("rojo")).toBe("Rojo");
  });
});

describe("formatContractStatus / formatContractFieldKey / formatContractFieldStatus", () => {
  it("mapean los valores conocidos", () => {
    expect(formatContractStatus("en_ejecucion")).toBe("En ejecución");
    expect(formatContractFieldKey("monto_total")).toBe("Monto total");
    expect(formatContractFieldStatus("sugerido")).toBe("Sugerido");
  });

  it("un valor desconocido se muestra tal cual (nunca oculta el dato real)", () => {
    expect(formatContractStatus("algo_nuevo")).toBe("algo_nuevo");
    expect(formatContractFieldKey("algo_nuevo")).toBe("algo_nuevo");
    expect(formatContractFieldStatus("algo_nuevo")).toBe("algo_nuevo");
  });
});

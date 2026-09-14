import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatMoney, formatPeriodStatus, formatPeriodo, formatTaskCategory, formatTaskStatus } from "../src/verticals/despachos/lib/format.ts";

describe("formatMoney", () => {
  it("null -> guion largo, nunca $0", () => {
    expect(formatMoney(null)).toBe("—");
  });

  it("formatea en pesos mexicanos", () => {
    expect(formatMoney(1160)).toContain("1,160");
  });
});

describe("formatPeriodo", () => {
  it("arma 'mes año' en español", () => {
    expect(formatPeriodo(2026, 3)).toBe("marzo 2026");
  });
});

describe("formatPeriodStatus", () => {
  it("mapea los 3 estatus conocidos", () => {
    expect(formatPeriodStatus("open")).toBe("Abierto");
    expect(formatPeriodStatus("closed")).toBe("Cerrado");
    expect(formatPeriodStatus("overdue")).toBe("Vencido");
  });
});

describe("formatTaskStatus / formatTaskCategory", () => {
  it("mapean valores conocidos", () => {
    expect(formatTaskStatus("done")).toBe("Completada");
    expect(formatTaskStatus("blocked")).toBe("Bloqueada");
    expect(formatTaskCategory("cfdi")).toBe("CFDI");
    expect(formatTaskCategory("electronica")).toBe("Contabilidad electrónica");
  });
});

describe("formatDate / formatDateTime", () => {
  it("null -> guion largo", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDateTime(null)).toBe("—");
  });

  it("formatea una fecha ISO real", () => {
    expect(formatDate("2026-03-01T00:00:00Z")).toContain("2026");
    expect(formatDateTime("2026-03-01T12:00:00Z")).toContain("2026");
  });

  it("fecha inválida -> guion largo, nunca 'Invalid Date'", () => {
    expect(formatDate("no-es-fecha")).toBe("—");
  });
});

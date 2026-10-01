import { describe, expect, it } from "vitest";
import { formatCentavos, formatDireccionCfdi, formatEstadoSat, formatFormaPago, formatMetodoPago, formatTasaImpuesto, tonoEstadoSat, formatDate, formatDateTime, formatEstadoVencimiento, formatMoney, formatPeriodStatus, formatPeriodo, formatPrioridadVencimiento, formatTaskCategory, formatTaskStatus } from "../src/verticals/despachos/lib/format.ts";

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

describe("formatPrioridadVencimiento / formatEstadoVencimiento", () => {
  it("mapean las 4 prioridades conocidas", () => {
    expect(formatPrioridadVencimiento("critica")).toBe("Crítica");
    expect(formatPrioridadVencimiento("alta")).toBe("Alta");
    expect(formatPrioridadVencimiento("media")).toBe("Media");
    expect(formatPrioridadVencimiento("baja")).toBe("Baja");
  });

  it("mapean los 5 estados conocidos", () => {
    expect(formatEstadoVencimiento("pendiente")).toBe("Pendiente");
    expect(formatEstadoVencimiento("en_proceso")).toBe("En proceso");
    expect(formatEstadoVencimiento("completado")).toBe("Completado");
    expect(formatEstadoVencimiento("vencido")).toBe("Vencido");
    expect(formatEstadoVencimiento("escalado")).toBe("Escalado");
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

describe("D-22 formatos de CFDI", () => {
  it("formatCentavos: enteros a pesos sin pasar por flotantes; null/undefined -> guion largo, nunca $0", () => {
    expect(formatCentavos(116000)).toBe("$1,160.00");
    expect(formatCentavos(5)).toBe("$0.05");
    expect(formatCentavos(0)).toBe("$0.00");
    expect(formatCentavos(123456789)).toBe("$1,234,567.89");
    expect(formatCentavos(-1999)).toBe("-$19.99");
    expect(formatCentavos(null)).toBe("—");
    expect(formatCentavos(undefined)).toBe("—");
    expect(formatCentavos(Number.NaN)).toBe("—");
  });
  it("sentido, estado SAT y tono", () => {
    expect(formatDireccionCfdi("emitido")).toBe("Emitido");
    expect(formatDireccionCfdi("recibido")).toBe("Recibido");
    expect(formatDireccionCfdi("indeterminado")).toBe("Sin clasificar");
    expect(formatDireccionCfdi(null)).toBe("Sin clasificar");
    expect(formatEstadoSat("pendiente")).toBe("Sin verificar");
    expect(formatEstadoSat(undefined)).toBe("Sin verificar");
    expect(formatEstadoSat("cancelado")).toBe("Cancelado");
    expect(tonoEstadoSat("vigente")).toBe("success");
    expect(tonoEstadoSat("cancelado")).toBe("danger");
    expect(tonoEstadoSat("no_encontrado")).toBe("warning");
    expect(tonoEstadoSat("pendiente")).toBe("neutral");
  });
  it("metodo y forma de pago con su clave del SAT; lo desconocido se muestra tal cual", () => {
    expect(formatMetodoPago("PUE")).toContain("Una sola exhibición");
    expect(formatMetodoPago("PPD")).toContain("Parcialidades");
    expect(formatMetodoPago(null)).toBe("—");
    expect(formatFormaPago("03")).toBe("03 · Transferencia electrónica de fondos");
    expect(formatFormaPago("77")).toBe("77");
    expect(formatFormaPago(undefined)).toBe("—");
  });
  it("tasa decimal del SAT a porcentaje", () => {
    expect(formatTasaImpuesto("0.160000")).toBe("16%");
    expect(formatTasaImpuesto("0.000000")).toBe("0%");
    expect(formatTasaImpuesto("0.106667")).toBe("10.6667%");
    expect(formatTasaImpuesto(null)).toBe("—");
  });
});

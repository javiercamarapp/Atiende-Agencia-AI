import { describe, expect, it } from "vitest";
import { formatAppointmentSource, formatAppointmentStatus, formatDayOfWeek, formatGoogleSyncStatus, formatHHMM, formatMoneyFromCents, googleSyncStatusNeedsAttention } from "../src/verticals/citas/lib/format.ts";

describe("formatMoneyFromCents — honestidad de null (nunca $0 fingido)", () => {
  it("null -> 'Sin precio', un valor real -> pesos con centavos", () => {
    expect(formatMoneyFromCents(null)).toBe("Sin precio");
    expect(formatMoneyFromCents(50000)).toBe("$500.00");
  });
});

describe("formatHHMM", () => {
  it("recorta segundos", () => {
    expect(formatHHMM("09:00:00")).toBe("09:00");
    expect(formatHHMM("09:00")).toBe("09:00");
  });
});

describe("formatDayOfWeek", () => {
  it("mapea 0-6 a nombres reales en español", () => {
    expect(formatDayOfWeek(0)).toBe("Domingo");
    expect(formatDayOfWeek(1)).toBe("Lunes");
    expect(formatDayOfWeek(6)).toBe("Sábado");
  });
});

describe("formatAppointmentStatus / formatAppointmentSource", () => {
  it("traduce los valores reales del dominio, nunca inventa uno desconocido en silencio", () => {
    expect(formatAppointmentStatus("pending")).toBe("Pendiente");
    expect(formatAppointmentStatus("cancelled")).toBe("Cancelada");
    expect(formatAppointmentStatus("algo_nuevo")).toBe("algo_nuevo");
    expect(formatAppointmentSource("whatsapp")).toBe("WhatsApp (agente)");
  });
});

// Fase 6 §2 (seguimiento, "citas-sync-errores-visibles")
describe("formatGoogleSyncStatus / googleSyncStatusNeedsAttention", () => {
  it("traduce 'invalid' a un mensaje claro, distinto de 'error' (backoff agotado)", () => {
    expect(formatGoogleSyncStatus("invalid")).toBe("No sincronizada");
    expect(formatGoogleSyncStatus("error")).toBe("Con problema de sincronización");
    expect(formatGoogleSyncStatus("synced")).toBe("Sincronizada");
    expect(formatGoogleSyncStatus(null)).toBe("");
  });

  it("solo 'error'/'invalid' ameritan un indicador visible -- el flujo normal nunca es ruido", () => {
    expect(googleSyncStatusNeedsAttention("invalid")).toBe(true);
    expect(googleSyncStatusNeedsAttention("error")).toBe(true);
    expect(googleSyncStatusNeedsAttention("pending")).toBe(false);
    expect(googleSyncStatusNeedsAttention("synced")).toBe(false);
    expect(googleSyncStatusNeedsAttention("skipped")).toBe(false);
    expect(googleSyncStatusNeedsAttention(null)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { formatAppointmentSource, formatAppointmentStatus, formatDayOfWeek, formatHHMM, formatMoneyFromCents } from "../src/verticals/citas/lib/format.ts";

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

// Port de citas-reservaciones/supabase/functions/_shared/availability-core.test.ts —
// mismos casos reales (conversión de timezone por punto fijo, slots con buffer,
// override que cierra el día, revalidación estricta de un slot exacto).
import { describe, expect, it } from "vitest";
import { computeAvailableSlots, isSlotWithinAvailability, zonedDateStr, zonedTimeToUtc } from "../src/availability.ts";
import type { AvailabilityOverride, AvailabilityRule } from "../src/types.ts";

describe("zonedTimeToUtc — fix de timezone real (nunca el del host)", () => {
  it("una cita a las 10:00 en America/Merida (UTC-6, sin DST) es 16:00 UTC", () => {
    const utc = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida");
    expect(utc.toISOString()).toBe("2026-09-14T16:00:00.000Z");
  });

  it("respeta un huso con offset distinto (America/Mexico_City) el mismo día calendario", () => {
    const utc = zonedTimeToUtc("2026-09-14", "10:00", "America/Mexico_City");
    // México central: UTC-6 en septiembre (sin horario de verano desde 2022).
    expect(utc.toISOString()).toBe("2026-09-14T16:00:00.000Z");
  });
});

describe("zonedDateStr", () => {
  it("devuelve la fecha civil correcta en la timezone del negocio, no en UTC", () => {
    // 2026-09-14T02:00:00Z es todavía 2026-09-13 en America/Merida (UTC-6).
    const date = new Date("2026-09-14T02:00:00.000Z");
    expect(zonedDateStr(date, "America/Merida")).toBe("2026-09-13");
  });
});

describe("computeAvailableSlots", () => {
  const rules: AvailabilityRule[] = [{ id: "r1", providerId: "p1", dayOfWeek: 1, startTime: "09:00", endTime: "10:00", isActive: true }]; // lunes 9-10am

  it("genera slots consecutivos respetando duración + buffer, sin traslapar con citas ocupadas", () => {
    // 2026-09-14 es lunes.
    const slots = computeAvailableSlots({
      dateStr: "2026-09-14",
      timeZone: "America/Merida",
      durationMinutes: 20,
      bufferAfterMinutes: 10,
      rules,
      busy: [],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    // Ventana de 60 min / bloques de 30 min (20 duración + 10 buffer) = 2 slots.
    expect(slots).toHaveLength(2);
    expect(slots[0]!.startsAt).toBe(zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString());
    expect(slots[1]!.startsAt).toBe(zonedTimeToUtc("2026-09-14", "09:30", "America/Merida").toISOString());
  });

  it("excluye un slot que se traslapa con una cita ya ocupada (busy)", () => {
    const busyStart = zonedTimeToUtc("2026-09-14", "09:00", "America/Merida");
    const busyEnd = zonedTimeToUtc("2026-09-14", "09:30", "America/Merida");
    const slots = computeAvailableSlots({
      dateStr: "2026-09-14",
      timeZone: "America/Merida",
      durationMinutes: 20,
      bufferAfterMinutes: 10,
      rules,
      busy: [{ start: busyStart, end: busyEnd }],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.startsAt).toBe(zonedTimeToUtc("2026-09-14", "09:30", "America/Merida").toISOString());
  });

  it("un override que cierra el día vence a las reglas recurrentes, sin ofrecer ningún slot", () => {
    const override: AvailabilityOverride = { providerId: "p1", overrideDate: "2026-09-14", isClosed: true, startTime: null, endTime: null, reason: null };
    const slots = computeAvailableSlots({ dateStr: "2026-09-14", timeZone: "America/Merida", durationMinutes: 20, rules, override, busy: [] });
    expect(slots).toEqual([]);
  });

  it("nunca ofrece un slot que ya pasó (now)", () => {
    const now = zonedTimeToUtc("2026-09-14", "09:15", "America/Merida");
    const slots = computeAvailableSlots({ dateStr: "2026-09-14", timeZone: "America/Merida", durationMinutes: 20, bufferAfterMinutes: 10, rules, busy: [], now });
    expect(slots).toHaveLength(1);
    expect(slots[0]!.startsAt).toBe(zonedTimeToUtc("2026-09-14", "09:30", "America/Merida").toISOString());
  });
});

describe("isSlotWithinAvailability — revalidación estricta antes de crear/reagendar", () => {
  const rules: AvailabilityRule[] = [{ id: "r1", providerId: "p1", dayOfWeek: 1, startTime: "09:00", endTime: "17:00", isActive: true }];

  it("acepta EXACTAMENTE un slot real calculado por el motor", () => {
    const start = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida");
    const end = new Date(start.getTime() + 30 * 60_000);
    expect(isSlotWithinAvailability(start, end, { timeZone: "America/Merida", durationMinutes: 30, rules })).toBe(true);
  });

  it("rechaza un horario fuera del horario de atención (3am — el EXCLUDE de la base de datos por sí solo lo aceptaría)", () => {
    const start = zonedTimeToUtc("2026-09-14", "03:00", "America/Merida");
    const end = new Date(start.getTime() + 30 * 60_000);
    expect(isSlotWithinAvailability(start, end, { timeZone: "America/Merida", durationMinutes: 30, rules })).toBe(false);
  });

  it("rechaza un horario que no cae en un punto exacto de la grilla de slots", () => {
    const start = zonedTimeToUtc("2026-09-14", "10:07", "America/Merida"); // no es múltiplo de la duración
    const end = new Date(start.getTime() + 30 * 60_000);
    expect(isSlotWithinAvailability(start, end, { timeZone: "America/Merida", durationMinutes: 30, rules })).toBe(false);
  });
});

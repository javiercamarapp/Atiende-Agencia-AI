// Prueba de contrato del puerto (ver diseño Fase 3 §6): cualquier
// GoogleCalendarPort real o falso debe cumplir el mismo flujo básico
// crear/actualizar/borrar evento — corrida aquí contra FakeGoogleCalendarPort
// (RealGoogleCalendarPort necesita credenciales OAuth reales que no existen en
// este entorno, ver comentario de archivo en google-calendar-port.ts).
import { describe, expect, it } from "vitest";
import { assertGoogleCalendarPortContract, CalendarEventNotFoundError, FakeGoogleCalendarPort, GoogleCalendarApiError, isInvalidGrantError } from "../src/google-calendar-port.ts";

describe("FakeGoogleCalendarPort cumple el contrato real", () => {
  it("crea, actualiza y borra un evento", async () => {
    const port = new FakeGoogleCalendarPort();
    await assertGoogleCalendarPortContract(port, "primary");
  });

  it("createEvent guarda exactamente lo que se le pidió", async () => {
    const port = new FakeGoogleCalendarPort();
    const result = await port.createEvent({
      calendarId: "primary",
      summary: "Consulta general - Ana Torres",
      description: "Tel: 9991112233\nAgendada por atiende.ai",
      startTime: "2026-09-14T16:00:00.000Z",
      endTime: "2026-09-14T16:30:00.000Z",
      timeZone: "America/Merida",
    });
    const stored = port.events.get(result.eventId);
    expect(stored?.summary).toBe("Consulta general - Ana Torres");
    expect(stored?.startTime).toBe("2026-09-14T16:00:00.000Z");
  });

  it("updateEvent contra un evento inexistente lanza CalendarEventNotFoundError", async () => {
    const port = new FakeGoogleCalendarPort();
    await expect(port.updateEvent({ calendarId: "primary", eventId: "no-existe", timeZone: "America/Merida" })).rejects.toBeInstanceOf(CalendarEventNotFoundError);
  });

  it("deleteEvent de un evento ya borrado es un no-op (idempotente)", async () => {
    const port = new FakeGoogleCalendarPort();
    const created = await port.createEvent({ calendarId: "primary", summary: "x", description: "x", startTime: "2026-09-14T16:00:00.000Z", endTime: "2026-09-14T16:30:00.000Z", timeZone: "America/Merida" });
    await port.deleteEvent({ calendarId: "primary", eventId: created.eventId });
    await expect(port.deleteEvent({ calendarId: "primary", eventId: created.eventId })).resolves.toBeUndefined();
  });

  it("failNextCall fuerza que la SIGUIENTE llamada falle (para probar reintentos)", async () => {
    const port = new FakeGoogleCalendarPort();
    port.failNextCall = new Error("boom");
    await expect(
      port.createEvent({ calendarId: "primary", summary: "x", description: "x", startTime: "2026-09-14T16:00:00.000Z", endTime: "2026-09-14T16:30:00.000Z", timeZone: "America/Merida" }),
    ).rejects.toThrow("boom");
    // La llamada siguiente ya no falla — failNextCall se consume una sola vez.
    await expect(
      port.createEvent({ calendarId: "primary", summary: "x", description: "x", startTime: "2026-09-14T16:00:00.000Z", endTime: "2026-09-14T16:30:00.000Z", timeZone: "America/Merida" }),
    ).resolves.toBeDefined();
  });
});

describe("isInvalidGrantError", () => {
  it("reconoce un invalid_grant real de Google", () => {
    const err = new GoogleCalendarApiError("no se pudo refrescar", 400, JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }));
    expect(isInvalidGrantError(err)).toBe(true);
  });

  it("no confunde un error transitorio (429/5xx) con invalid_grant", () => {
    const err = new GoogleCalendarApiError("rate limited", 429, JSON.stringify({ error: "rateLimitExceeded" }));
    expect(isInvalidGrantError(err)).toBe(false);
  });

  it("un Error genérico nunca cuenta como invalid_grant", () => {
    expect(isInvalidGrantError(new Error("invalid_grant"))).toBe(false);
  });
});

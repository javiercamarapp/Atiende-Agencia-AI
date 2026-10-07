// QA ronda 1 (citas, lente AUTOMATIZACION) -- alta de evento en Google idempotente (11). Reloj simulado (`now` explicito) sobre InMemoryCitasRepository
// (replica `citas.enqueue_messaging_outbox`: on conflict solo actualiza filas pending/failed).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelAppointment, createAppointment, rescheduleAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { RealGoogleCalendarPort } from "../src/google-calendar-port.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { runConfirmacionCitaCore, runOptimizadorCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";

const MERIDA = "America/Merida";

function payloadDe(repo: InMemoryCitasRepository, dedupeKey: string, channel = "whatsapp") {
  return repo.getOutbox().find((o) => o.dedupeKey === dedupeKey && o.channel === channel);
}

describe("QA-citas-R1-automatizacion-11: alta de evento en Google Calendar no idempotente", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("createEvent manda un id de evento determinista (reintento tras rollback/timeout no duplica el evento)", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: `ev${bodies.length}` }), { status: 200 });
    });
    const port = new RealGoogleCalendarPort({ clientId: "c", clientSecret: "s", refreshToken: "r" });
    const input = { calendarId: "primary", summary: "Consulta", description: "x", startTime: "2026-10-21T16:00:00.000Z", endTime: "2026-10-21T16:30:00.000Z", timeZone: MERIDA };
    // Mismo alta reintentada (la transaccion del cron que guardaba google_event_id se revirtio).
    await port.createEvent(input);
    await port.createEvent(input);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.id ?? bodies[0]?.iCalUID).toBeDefined();
    expect(bodies[0]?.id ?? bodies[0]?.iCalUID).toBe(bodies[1]?.id ?? bodies[1]?.iCalUID);
  });
});

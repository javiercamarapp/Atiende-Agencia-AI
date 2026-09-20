// Fix hallazgo CONFIRMADO de la auditoría a3 (#7,
// `auditoria-a3-resultado.json::confirmed`): el loop de recordatorios de 24h
// (`runConfirmacionCitaCore`) procesaba TODAS las citas pendientes de una
// organización en una sola pasada SIN aislamiento por cita -- un error REAL de
// Postgres en una cita (deadlock, timeout, o cualquier best-effort interno que en
// el futuro deje de tragar su propio error) dejaba la transacción de esa
// organización abortada (25P02) y los recordatorios de las CITAS SIGUIENTES,
// dentro de la MISMA corrida, nunca se encolaban -- ni siquiera se reintentaban
// hasta la corrida del día siguiente por la ventana de tolerancia de ±30 min con
// cron diario (`REMINDER_WINDOW_TOLERANCE_MS`).
//
// Arreglo: cada iteración del loop corre bajo su propio
// `repo.runWithRowSavepoint` (no-op en `InMemoryCitasRepository` -- este test
// ejercita el aislamiento a nivel de CONTROL DE FLUJO de JS, no de SAVEPOINT SQL;
// ver `waitlist-cancelar-savepoint.spec.ts` para el aislamiento real contra una
// sesión Postgres abortable) -- un error real en una cita se registra en
// `summary.failedAppointmentIds` y el loop SIGUE con las demás citas de la misma
// organización.
import { describe, expect, it, vi } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { runConfirmacionCitaCore } from "../src/reminders.ts";
import { buildCitasFixture } from "./fixtures.ts";

describe("runConfirmacionCitaCore — aislamiento por cita (fix auditoría a3, hallazgo confirmado #7)", () => {
  it("una cita falla con un error real de Postgres (deadlock/timeout simulado) => las DEMÁS citas de la misma organización SÍ se procesan y se reflejan en failedAppointmentIds", async () => {
    const fixture = buildCitasFixture();
    const now = new Date("2026-09-13T16:00:00.000Z");
    const startsAt = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();

    const citaEnvenenada = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Envenenado",
      customerPhone: "9990000001",
      startsAt,
      source: "web",
    });
    // Ventana real del cron: now+24h ± 30 min = [2026-09-14T15:30Z, 2026-09-14T16:30Z]
    // (America/Merida es UTC-6): 09:30 Merida = 15:30 UTC (borde inicial,
    // inclusive), 10:00 Merida = 16:00 UTC (centro, la envenenada). Slot
    // consecutivo de 30 min con el MISMO proveedor -- sin solaparse (anti-doble-
    // reserva de la propia cita envenenada) y sin salirse de la ventana real de
    // tolerancia (por eso solo 2 citas, no 3: 2 slots de 30 min es lo máximo que
    // cabe sin solaparse dentro de una ventana de 60 min).
    const citaSana1 = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cliente Sano Uno",
      customerPhone: "9990000002",
      startsAt: zonedTimeToUtc("2026-09-14", "09:30", "America/Merida").toISOString(),
      source: "web",
    });

    // Simula un error REAL de Postgres (nunca uno de datos/validación) SOLO para
    // la cita envenenada -- deadlock/timeout son exactamente el tipo de error que
    // el hallazgo confirmado describe como disparador real (a diferencia de un
    // "dato raro", que la propia auditoría descartó como disparador demostrable).
    const original = fixture.repo.enqueueMessagingOutbox.bind(fixture.repo);
    const spy = vi.spyOn(fixture.repo, "enqueueMessagingOutbox").mockImplementation(async (organizationId, channel, eventType, dedupeKey, payload) => {
      const to = (payload as { to?: string }).to;
      if (to === "9990000001") {
        const err = new Error("deadlock detected") as Error & { code: string };
        err.code = "40P01";
        throw err;
      }
      return original(organizationId, channel, eventType, dedupeKey, payload);
    });

    const summary = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, now);

    // La cita envenenada quedó aislada -- NO tumbó la corrida completa.
    expect(summary.failedAppointmentIds).toEqual([citaEnvenenada.id]);
    // La cita SANA sí se procesó -- 2 procesadas (envenenada + sana), 1 enviado.
    expect(summary.processed).toBe(2);
    expect(summary.sent).toBe(1);

    const outbox = fixture.repo.getOutbox();
    const destinatarios = outbox.map((m) => (m.payload as { to: string }).to);
    expect(destinatarios).not.toContain("9990000001");
    expect(destinatarios).toContain("9990000002");

    // `markReminderSent` SÍ corrió para las 2 citas sanas (no se reenvían en la
    // siguiente corrida) -- verificado indirectamente: una segunda corrida
    // inmediata ya no las reprocesa, pero SÍ vuelve a intentar la envenenada
    // (nunca se marcó `reminder24hSentAt`, sigue "pendiente" con buen criterio,
    // ver comentario de diseño de `runConfirmacionCitaCore`).
    spy.mockRestore();
    const second = await runConfirmacionCitaCore(fixture.repo, fixture.organizationId, new Date(now.getTime() + 5 * 60_000));
    expect(second.processed).toBe(1);
    expect(second.failedAppointmentIds).toEqual([]);
    expect(fixture.repo.getOutbox().map((m) => (m.payload as { to: string }).to)).toContain("9990000001");

    void citaSana1;
  });
});

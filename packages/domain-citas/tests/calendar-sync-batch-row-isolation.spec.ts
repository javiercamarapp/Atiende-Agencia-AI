// Hallazgo CRÍTICO de auditoría (a1, r3) — SAVEPOINT por fila en
// `syncPendingAppointmentsMultiProvider` (ver el comentario de cabecera de
// `CitasRepository.runWithRowSavepoint`, repository.ts, y el de
// `syncPendingAppointmentsMultiProvider`, calendar-sync.ts): una fila "venenosa"
// (un error que escapa de `syncOneAppointmentRow`, ej. la propia escritura de
// resultado fallando por una razón que su try/catch interno no anticipaba) NUNCA
// debe tumbar el resto del lote -- las citas de otros tenants YA procesadas en esta
// misma corrida deben quedar marcadas, y las que faltan por procesar deben seguir
// intentándose.
//
// `InMemoryCitasRepository.runWithRowSavepoint` es un no-op (sin transacción real
// que aislar, ver su propio comentario) -- este test prueba el nivel que SÍ le
// corresponde a `InMemoryCitasRepository`: que el LOOP de `syncPendingAppointments
// MultiProvider` atrapa el error de `runWithRowSavepoint`/`syncOneAppointmentRow` y
// sigue con la siguiente fila, en vez de dejar que un `throw` tumbe todo el `for`.
// El aislamiento real a nivel SAVEPOINT de Postgres (que la transacción del lote NO
// quede abortada) ya lo prueba `savepoint-fallback.spec.ts` (packages/db) contra el
// helper genérico que `PostgresCitasRepository.runWithRowSavepoint` reutiliza.
import { describe, expect, it } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { syncPendingAppointmentsMultiProvider } from "../src/calendar-sync.ts";
import type { ResolveCalendarSyncPort } from "../src/calendar-sync.ts";
import { FakeCalendarSyncPort } from "../src/calendar-sync-port.ts";
import { InMemoryCitasRepository } from "../src/in-memory-repository.ts";
import { buildCitasFixture } from "./fixtures.ts";
import { zonedTimeToUtc } from "../src/availability.ts";

const NEXT_MONDAY_9AM_MERIDA = zonedTimeToUtc("2026-09-14", "09:00", "America/Merida").toISOString();
const NEXT_MONDAY_10AM_MERIDA = zonedTimeToUtc("2026-09-14", "10:00", "America/Merida").toISOString();

/** Envuelve un `InMemoryCitasRepository` real para que UNA escritura concreta
 *  (`markAppointmentGoogleSynced` de una cita específica) lance un error no
 *  anticipado -- simula el residual real que motiva el SAVEPOINT por fila: la
 *  propia escritura de resultado falla por algo que el try/catch de
 *  `syncOneAppointmentRow` no captura como "fallo de sincronización normal". Todos
 *  los demás métodos delegan tal cual al repo real -- nunca un mock de propósito
 *  general, solo el punto de falla que este test necesita. */
function withPoisonedWrite(repo: InMemoryCitasRepository, poisonedAppointmentId: string): InMemoryCitasRepository {
  return new Proxy(repo, {
    get(target, prop, receiver) {
      if (prop === "markAppointmentGoogleSynced") {
        return async (appointmentId: string, googleEventId: string, attempts: number) => {
          if (appointmentId === poisonedAppointmentId) {
            throw new Error("fila venenosa: la escritura de resultado falló por una razón no anticipada");
          }
          return target.markAppointmentGoogleSynced(appointmentId, googleEventId, attempts);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as InMemoryCitasRepository;
}

describe("syncPendingAppointmentsMultiProvider — SAVEPOINT por fila: una fila venenosa no revierte el batch", () => {
  it("2 citas pendientes, la primera envenenada: la segunda SÍ queda synced y el batch termina (no lanza)", async () => {
    const fixture = buildCitasFixture();
    const poisoned = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cita venenosa",
      customerPhone: "9991110000",
      startsAt: NEXT_MONDAY_9AM_MERIDA,
      source: "web",
    });
    const healthy = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      serviceId: fixture.serviceId,
      customerName: "Cita sana",
      customerPhone: "9991110001",
      startsAt: NEXT_MONDAY_10AM_MERIDA,
      source: "web",
    });

    const repo = withPoisonedWrite(fixture.repo, poisoned.id);
    const fake = new FakeCalendarSyncPort("calcom");
    const resolver: ResolveCalendarSyncPort = async (providerId) =>
      providerId === fixture.providerId ? { port: fake, externalCalendarRef: "555" } : null;

    const summary = await syncPendingAppointmentsMultiProvider(repo, resolver);

    expect(summary.processed).toBe(2);
    // La fila venenosa quedó registrada como error, aislada -- nunca tumbó el resto.
    expect(summary.errors.some((e) => e.appointmentId === poisoned.id)).toBe(true);
    // La cita sana SÍ se sincronizó -- prueba directa de que el batch continuó.
    const healthyRow = await fixture.repo.loadAppointmentSyncRow(healthy.id);
    expect(healthyRow?.googleSyncStatus).toBe("synced");
    expect(fake.events.size).toBe(2); // ambas llamaron createEvent -- el fallo fue solo en la escritura de resultado
  });
});

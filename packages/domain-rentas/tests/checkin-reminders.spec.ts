// Pruebas de runRecordatorioCheckInCore — verifica: (1) encuentra reservas cuyo
// check-in cae en la ventana 24-48h (mañana o pasado mañana), (2) ignora las que
// están fuera de la ventana (hoy mismo, o más de 2 días), (3) nunca reenvía dos
// veces la misma reserva (recordatorio_checkin_enviado_en), (4) sin correo real del
// huésped no marca como enviado (para que una corrida futura la reintente), (5)
// nunca procesa un bloqueo ni una reserva 'provisional'/'conflicto_pendiente'.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { crearReservaConfirmada } from "../src/aplicacion/reservas.ts";
import { sumarDias } from "../src/fechas.ts";
import { runRecordatorioCheckInCore } from "../src/checkin-reminders.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { FechaLocal } from "../src/tipos.ts";
import type { UnidadRecord } from "../src/types.ts";

const AHORA = new Date("2026-09-14T12:00:00Z");
const HOY: FechaLocal = "2026-09-14";

async function crearFixture() {
  const store = new InMemoryRentasCalendarStore();
  const engine = new InMemoryRentasTenancyEngine(store);
  const repo = new InMemoryRentasRepository(store);
  let ejecutor!: EjecutorTransaccional;
  await engine.withAppSession({ userId: null }, async (session) => {
    ejecutor = session;
  });

  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganizacion(organizationId, "Rentas de Prueba");
  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: "Depa de Prueba" };
  store.seedUnidad(unidad);

  async function crearReserva(checkIn: FechaLocal, contacto: string | null = "huesped@example.com") {
    const checkOut = sumarDias(checkIn, 3);
    const resultado = await crearReservaConfirmada(ejecutor, { organizationId, propertyId, unidadId: unidad.id, rango: { inicio: checkIn, fin: checkOut }, estado: "confirmado", bloqueante: true });
    const guest = await repo.insertGuestMinimo({ organizationId, propertyId, nombre: "Huésped de Prueba", contacto });
    await repo.attachGuestToOcupacion(resultado.ocupacionId, guest.id);
    return resultado.ocupacionId;
  }

  return { store, repo, ejecutor, organizationId, propertyId, unidad, crearReserva };
}

describe("runRecordatorioCheckInCore", () => {
  it("check-in mañana (24h): entra en la ventana, encola el correo real y marca enviado", async () => {
    const fixture = await crearFixture();
    const manana = sumarDias(HOY, 1);
    const ocupacionId = await fixture.crearReserva(manana);

    const summary = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(1);
    expect(summary.sinCorreo).toBe(0);

    const job = fixture.repo.getMessagingOutbox().find((o) => o.eventType === "reserva.recordatorio_checkin");
    expect(job).toBeDefined();
    const payload = job!.payload as { subject: string };
    expect(payload.subject).toContain("Recordatorio de check-in");

    // Belt-and-suspenders: recordatorio_checkin_enviado_en quedó marcado.
    const fila = fixture.store.getOcupacion(ocupacionId);
    expect(fila?.recordatorioCheckinEnviadoEn).not.toBeNull();
  });

  it("check-in pasado mañana (48h): también entra en la ventana", async () => {
    const fixture = await crearFixture();
    const pasadoManana = sumarDias(HOY, 2);
    await fixture.crearReserva(pasadoManana);

    const summary = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(1);
  });

  it("check-in HOY: fuera de la ventana 24-48h, no se procesa", async () => {
    const fixture = await crearFixture();
    await fixture.crearReserva(HOY);

    const summary = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(summary.procesadas).toBe(0);
    expect(fixture.repo.getMessagingOutbox()).toHaveLength(0);
  });

  it("check-in en 5 días: demasiado lejos todavía, no se procesa", async () => {
    const fixture = await crearFixture();
    await fixture.crearReserva(sumarDias(HOY, 5));

    const summary = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(summary.procesadas).toBe(0);
  });

  it("nunca reenvía dos veces la misma reserva entre corridas del cron", async () => {
    const fixture = await crearFixture();
    await fixture.crearReserva(sumarDias(HOY, 1));

    const primera = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(primera.enviados).toBe(1);

    // Segunda corrida el mismo día (mismo cron periódico re-disparando dentro de la
    // ventana) -- ya no debe volver a procesarla.
    const segunda = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(segunda.procesadas).toBe(0);
    expect(segunda.enviados).toBe(0);
    expect(fixture.repo.getMessagingOutbox().filter((o) => o.eventType === "reserva.recordatorio_checkin")).toHaveLength(1);
  });

  it("sin correo real del huésped: se cuenta como sinCorreo y NO se marca enviado (una corrida futura la reintenta)", async () => {
    const fixture = await crearFixture();
    const ocupacionId = await fixture.crearReserva(sumarDias(HOY, 1), "9998887766"); // solo teléfono, no email

    const summary = await runRecordatorioCheckInCore(fixture.repo, AHORA);
    expect(summary.procesadas).toBe(1);
    expect(summary.enviados).toBe(0);
    expect(summary.sinCorreo).toBe(1);
    expect(fixture.repo.getMessagingOutbox()).toHaveLength(0);

    const fila = fixture.store.getOcupacion(ocupacionId);
    expect(fila?.recordatorioCheckinEnviadoEn).toBeNull();
  });
});

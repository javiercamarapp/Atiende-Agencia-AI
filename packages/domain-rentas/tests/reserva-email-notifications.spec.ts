// Pruebas de enqueueReservaEmailCore/tryEnqueueReservaEmail — mismo criterio que
// domain-citas::tests/appointment-email-notifications.spec.ts: (1) arma el correo
// real (to/subject/html) a partir de solo el ocupacionId, (2) sin correo real del
// huésped en `contacto` no encola nada (no es un error), (3) cada evento tiene su
// dedupe_key real, (4) es best-effort de verdad (tryEnqueueReservaEmail nunca lanza),
// (5) nunca encola para un bloqueo ni para una reserva no confirmada.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCalendarStore } from "../src/calendar-store.ts";
import { InMemoryRentasRepository } from "../src/in-memory-repository.ts";
import { InMemoryRentasTenancyEngine } from "../src/in-memory-tenancy-engine.ts";
import { crearBloqueo, crearReservaConfirmada } from "../src/aplicacion/reservas.ts";
import { enqueueReservaEmailCore, tryEnqueueReservaEmail } from "../src/reserva-email-notifications.ts";
import type { EjecutorTransaccional } from "../src/ejecutor.ts";
import type { UnidadRecord } from "../src/types.ts";

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
  repo.seedOrganizacion(organizationId, "Casa Sol de Prueba");

  const unidad: UnidadRecord = { id: randomUUID(), organizationId, propertyId, duracionMinimaNoches: 1, name: "Depa Reforma 2" };
  store.seedUnidad(unidad);

  return { store, repo, ejecutor, organizationId, propertyId, unidad };
}

async function crearReservaConHuesped(fixture: Awaited<ReturnType<typeof crearFixture>>, contacto: string | null, nombre = "María López") {
  const { ejecutor, organizationId, propertyId, unidad, repo } = fixture;
  const resultado = await crearReservaConfirmada(ejecutor, {
    organizationId,
    propertyId,
    unidadId: unidad.id,
    rango: { inicio: "2026-10-01", fin: "2026-10-05" },
    estado: "confirmado",
    bloqueante: true,
  });
  const guest = await repo.insertGuestMinimo({ organizationId, propertyId, nombre, contacto });
  await repo.attachGuestToOcupacion(resultado.ocupacionId, guest.id);
  return resultado.ocupacionId;
}

describe("enqueueReservaEmailCore", () => {
  it("reserva.creada: arma el correo real con to/subject/html a partir de solo el ocupacionId", async () => {
    const fixture = await crearFixture();
    const ocupacionId = await crearReservaConHuesped(fixture, "maria@example.com");

    const resultado = await enqueueReservaEmailCore(fixture.repo, fixture.organizationId, "reserva.creada", ocupacionId);
    expect(resultado.enqueued).toBe(true);

    const job = fixture.repo.getMessagingOutbox().find((o) => o.channel === "email" && o.eventType === "reserva.creada");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`creada:${ocupacionId}`);
    expect(job!.propertyId).toBe(fixture.propertyId);
    const payload = job!.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("maria@example.com");
    expect(payload.subject).toContain("Reserva confirmada");
    expect(payload.subject).toContain("Casa Sol de Prueba");
    expect(payload.html).toContain("María López");
    expect(payload.html).toContain("Depa Reforma 2");
    expect(payload.text).toContain("María López");
  });

  it("sin correo real del huésped (solo teléfono en contacto): no encola nada, y NO es un error", async () => {
    const fixture = await crearFixture();
    const ocupacionId = await crearReservaConHuesped(fixture, "9998887766");

    const resultado = await enqueueReservaEmailCore(fixture.repo, fixture.organizationId, "reserva.creada", ocupacionId);
    expect(resultado).toEqual({ enqueued: false, reason: "sin_correo" });
    expect(fixture.repo.getMessagingOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });

  it("sin huésped adjunto en absoluto: no encola nada", async () => {
    const fixture = await crearFixture();
    const resultado = await crearReservaConfirmada(fixture.ejecutor, {
      organizationId: fixture.organizationId,
      propertyId: fixture.propertyId,
      unidadId: fixture.unidad.id,
      rango: { inicio: "2026-10-01", fin: "2026-10-05" },
      estado: "confirmado",
      bloqueante: true,
    });

    const emailResultado = await enqueueReservaEmailCore(fixture.repo, fixture.organizationId, "reserva.creada", resultado.ocupacionId);
    expect(emailResultado).toEqual({ enqueued: false, reason: "sin_correo" });
  });

  it("ocupacionId inexistente: no encola nada", async () => {
    const fixture = await crearFixture();
    const resultado = await enqueueReservaEmailCore(fixture.repo, fixture.organizationId, "reserva.creada", "00000000-0000-0000-0000-000000000000");
    expect(resultado).toEqual({ enqueued: false, reason: "reserva_no_encontrada" });
  });

  it("un bloqueo (capa='bloqueo') nunca dispara un correo al huésped", async () => {
    const fixture = await crearFixture();
    const resultado = await crearBloqueo(fixture.ejecutor, {
      organizationId: fixture.organizationId,
      propertyId: fixture.propertyId,
      unidadId: fixture.unidad.id,
      rango: { inicio: "2026-10-01", fin: "2026-10-05" },
      razon: "MANTENIMIENTO",
    });

    const emailResultado = await enqueueReservaEmailCore(fixture.repo, fixture.organizationId, "reserva.creada", resultado.ocupacionId);
    expect(emailResultado).toEqual({ enqueued: false, reason: "no_es_reserva_confirmada" });
  });

  it("reserva.recordatorio_checkin: dedupe_key propio, distinto del de creación", async () => {
    const fixture = await crearFixture();
    const ocupacionId = await crearReservaConHuesped(fixture, "cliente@example.com");

    const resultado = await enqueueReservaEmailCore(fixture.repo, fixture.organizationId, "reserva.recordatorio_checkin", ocupacionId);
    expect(resultado.enqueued).toBe(true);
    const job = fixture.repo.getMessagingOutbox().find((o) => o.eventType === "reserva.recordatorio_checkin");
    expect(job!.dedupeKey).toBe(`recordatorio-checkin:${ocupacionId}`);
    const payload = job!.payload as { subject: string };
    expect(payload.subject).toContain("Recordatorio de check-in");
  });

  it("otra organización nunca puede resolver la ocupación de un tenant distinto (defensa en profundidad)", async () => {
    const fixture = await crearFixture();
    const ocupacionId = await crearReservaConHuesped(fixture, "cliente@example.com");
    const resultado = await enqueueReservaEmailCore(fixture.repo, randomUUID(), "reserva.creada", ocupacionId);
    expect(resultado).toEqual({ enqueued: false, reason: "reserva_no_encontrada" });
  });
});

describe("tryEnqueueReservaEmail", () => {
  it("es best-effort real: nunca lanza, aunque el ocupacionId no exista", async () => {
    const fixture = await crearFixture();
    const resultado = await tryEnqueueReservaEmail(fixture.repo, fixture.organizationId, "reserva.creada", "no-existe");
    expect(resultado).toEqual({ enqueued: false, reason: "reserva_no_encontrada" });
  });
});

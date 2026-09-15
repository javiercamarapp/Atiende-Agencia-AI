// Pruebas de enqueueGuestEmailCore/tryEnqueueGuestEmail — mismo patrón que
// packages/domain-citas/tests/appointment-email-notifications.spec.ts. Verifica:
// (1) arma el correo real (to/subject/html) a partir de solo el reservationId +
// extra propio del evento, (2) sin huésped ligado / sin correo en archivo no
// encola nada (no es un error), (3) cada evento tiene su dedupe_key real, (4) es
// best-effort de verdad (tryEnqueueGuestEmail nunca lanza).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryHotelesRepository } from "../src/in-memory-repository.ts";
import { enqueueGuestEmailCore, tryEnqueueGuestEmail } from "../src/guest-email-notifications.ts";
import type { NewReservationInput } from "../src/types.ts";

function buildFixture() {
  const repo = new InMemoryHotelesRepository();
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const roomTypeId = randomUUID();
  const guestId = randomUUID();

  repo.seedPropertySummary(organizationId, { propertyId, name: "Hotel de Prueba" });
  repo.seedTaxConfig(propertyId, { ivaRate: 0.16, ishRate: 0.03, discountThreshold: 500 });
  repo.seedRoomType(propertyId, roomTypeId, { name: "Habitación Doble Vista al Mar", maxOccupancy: 2 });
  repo.seedGuest({ id: guestId, propertyId, fullName: "María López", email: "maria@example.com", phone: "9998887766" });

  return { repo, organizationId, propertyId, roomTypeId, guestId };
}

async function seedReservation(fixture: ReturnType<typeof buildFixture>, guestId: string | null) {
  const input: NewReservationInput = {
    organizationId: fixture.organizationId,
    propertyId: fixture.propertyId,
    roomTypeId: fixture.roomTypeId,
    guestId,
    checkInDate: "2026-12-01",
    checkOutDate: "2026-12-03",
    totalAmount: 3000, // neto -- con ivaRate=0.16/ishRate=0.03 el total con impuestos real es 3570.
    idempotencyKey: null,
  };
  return fixture.repo.insertReservation(input);
}

describe("enqueueGuestEmailCore", () => {
  it("reservation.created: arma el correo real con to/subject/html a partir de solo el reservationId, con el total YA con impuestos", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);

    const result = await enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.created", reservation.id);
    expect(result.enqueued).toBe(true);

    const job = fixture.repo.getOutbox().find((o) => o.channel === "email" && o.eventType === "reservation.created");
    expect(job).toBeDefined();
    expect(job!.dedupeKey).toBe(`reservation-created:${reservation.id}`);
    const payload = job!.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("maria@example.com");
    expect(payload.subject).toContain("Reserva confirmada");
    expect(payload.subject).toContain("Hotel de Prueba");
    expect(payload.html).toContain("María López");
    expect(payload.html).toContain("Habitación Doble Vista al Mar");
    // 3000 neto + 16% IVA (480) + 3% ISH (90) = 3570 -- NUNCA el neto crudo.
    expect(payload.html).toContain("3,570.00");
    expect(payload.text).toContain("María López");
  });

  it("sin guestId (walk-in): no encola nada, y NO es un error", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, null);

    const result = await enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.created", reservation.id);
    expect(result).toEqual({ enqueued: false, reason: "no_guest" });
    expect(fixture.repo.getOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });

  it("guestId ligado pero sin correo en archivo: no encola nada", async () => {
    const fixture = buildFixture();
    fixture.repo.seedGuest({ id: fixture.guestId, propertyId: fixture.propertyId, fullName: "Sin Correo", email: null, phone: "123" });
    const reservation = await seedReservation(fixture, fixture.guestId);

    const result = await enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.created", reservation.id);
    expect(result).toEqual({ enqueued: false, reason: "no_email" });
  });

  it("reservationId inexistente: no encola nada", async () => {
    const fixture = buildFixture();
    const result = await enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.created", "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ enqueued: false, reason: "reservation_not_found" });
  });

  it("folio.closed: arma el recibo real con los totales del folio, dedupe_key por folioId (no por reservationId)", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);

    const result = await enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "folio.closed", reservation.id, {
      folio: { folioId: "folio-abc", label: "Principal", closeReason: "saldo_cero", totalCargos: 3570, totalPagos: 3570, saldo: 0 },
    });
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "folio.closed");
    expect(job!.dedupeKey).toBe("folio-closed:folio-abc");
    const payload = job!.payload as { subject: string; html: string };
    expect(payload.subject).toContain("Recibo de tu cuenta");
    expect(payload.html).toContain("Saldo en cero");
    expect(payload.html).toContain("Principal");
  });

  it("folio.closed sin extra.folio lanza (nunca un correo sin datos reales del folio)", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);
    await expect(enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "folio.closed", reservation.id)).rejects.toThrow(/extra\.folio/);
  });

  it("cfdi.issued: arma el aviso real con el UUID fiscal, dedupe_key por uuidFiscal (no por reservationId ni folioId)", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);

    const result = await enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "cfdi.issued", reservation.id, {
      cfdi: { uuidFiscal: "uuid-real-123", total: 3570, folioLabel: "Principal" },
    });
    expect(result.enqueued).toBe(true);
    const job = fixture.repo.getOutbox().find((o) => o.eventType === "cfdi.issued");
    expect(job!.dedupeKey).toBe("cfdi-issued:uuid-real-123");
    const payload = job!.payload as { subject: string; html: string };
    expect(payload.subject).toContain("CFDI disponible");
    expect(payload.html).toContain("uuid-real-123");
  });

  it("cfdi.issued sin extra.cfdi lanza (nunca un aviso de CFDI sin UUID real)", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);
    await expect(enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "cfdi.issued", reservation.id)).rejects.toThrow(/extra\.cfdi/);
  });

  it("evento desconocido lanza (nunca envía un correo sin plantilla real)", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);
    // @ts-expect-error -- evento inválido a propósito, para probar el default del switch.
    await expect(enqueueGuestEmailCore(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.unknown", reservation.id)).rejects.toThrow(/desconocido/);
  });
});

describe("tryEnqueueGuestEmail", () => {
  it("es best-effort real: nunca lanza, aunque el reservationId no exista", async () => {
    const fixture = buildFixture();
    const result = await tryEnqueueGuestEmail(fixture.repo, fixture.propertyId, fixture.organizationId, "reservation.created", "no-existe");
    expect(result).toEqual({ enqueued: false, reason: "reservation_not_found" });
  });

  it("es best-effort real: 'folio.closed' sin extra.folio captura el error interno y devuelve null, nunca lanza", async () => {
    const fixture = buildFixture();
    const reservation = await seedReservation(fixture, fixture.guestId);
    const result = await tryEnqueueGuestEmail(fixture.repo, fixture.propertyId, fixture.organizationId, "folio.closed", reservation.id);
    expect(result).toBeNull();
  });
});

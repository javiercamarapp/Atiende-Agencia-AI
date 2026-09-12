import { describe, expect, it } from "vitest";
import { InMemoryHotelesRepository } from "../src/in-memory-repository.ts";
import { IdempotencyConflictError } from "../src/errors.ts";

const ORG = "org-1";
const PROPERTY = "prop-1";
const FOLIO = "folio-1";

function repoWithFolio(): InMemoryHotelesRepository {
  const repo = new InMemoryHotelesRepository();
  repo.seedFolio({
    id: FOLIO,
    organizationId: ORG,
    propertyId: PROPERTY,
    reservationId: "res-1",
    status: "abierto",
    label: "Principal",
    isPrimary: true,
    closedAt: null,
    closeReason: null,
    arApprovedBy: null,
  });
  return repo;
}

describe("InMemoryHotelesRepository.withIdempotency", () => {
  it("misma key + mismo body -> devuelve la MISMA respuesta sin volver a correr run()", async () => {
    const repo = repoWithFolio();
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { status: 201, body: { id: "x" } };
    };
    const first = await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k1", body: { a: 1 } }, run);
    const second = await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k1", body: { a: 1 } }, run);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
  });

  it("misma key + body DISTINTO -> conflicto explícito, nunca ejecuta la mutación de nuevo en silencio", async () => {
    const repo = repoWithFolio();
    await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k2", body: { a: 1 } }, async () => ({ status: 201, body: {} }));
    await expect(
      repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "k2", body: { a: 2 } }, async () => ({ status: 201, body: {} })),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it("distintos scopes con la misma key no chocan entre sí", async () => {
    const repo = repoWithFolio();
    const a = await repo.withIdempotency({ organizationId: ORG, scope: "charge.create", key: "same", body: 1 }, async () => ({ status: 201, body: "a" }));
    const b = await repo.withIdempotency({ organizationId: ORG, scope: "payment.create", key: "same", body: 1 }, async () => ({ status: 201, body: "b" }));
    expect(a.body).toBe("a");
    expect(b.body).toBe("b");
  });
});

describe("InMemoryHotelesRepository -- guardia anti-doble-captura (charge_folio_stay_date_hospedaje_idx)", () => {
  it("bloquea un segundo cargo de hospedaje para la misma noche del mismo folio (simula el índice único parcial)", async () => {
    const repo = repoWithFolio();
    await repo.insertCharge({
      organizationId: ORG,
      propertyId: PROPERTY,
      folioId: FOLIO,
      description: "Hospedaje 2026-10-01",
      amount: 1000,
      taxAmount: 190,
      concept: "hospedaje",
      stayDate: "2026-10-01",
    });
    await expect(
      repo.insertCharge({
        organizationId: ORG,
        propertyId: PROPERTY,
        folioId: FOLIO,
        description: "Hospedaje 2026-10-01 (duplicado del night-audit)",
        amount: 1000,
        taxAmount: 190,
        concept: "hospedaje",
        stayDate: "2026-10-01",
      }),
    ).rejects.toThrow(/charge_folio_stay_date_hospedaje_idx/);
  });

  it("un reverso de un cargo de hospedaje NUNCA choca contra el índice (no lleva stay_date real)", async () => {
    const repo = repoWithFolio();
    const original = await repo.insertCharge({
      organizationId: ORG,
      propertyId: PROPERTY,
      folioId: FOLIO,
      description: "Hospedaje 2026-10-01",
      amount: 1000,
      taxAmount: 190,
      concept: "hospedaje",
      stayDate: "2026-10-01",
    });
    await expect(
      repo.insertCharge({
        organizationId: ORG,
        propertyId: PROPERTY,
        folioId: FOLIO,
        description: "Reverso de hospedaje",
        amount: -1000,
        taxAmount: -190,
        concept: "reverso",
        reversesChargeId: original.id,
        stayDate: "2026-10-01",
      }),
    ).resolves.toBeDefined();
  });

  it("permite el mismo concepto hospedaje en noches distintas", async () => {
    const repo = repoWithFolio();
    await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "n1", amount: 1000, taxAmount: 190, concept: "hospedaje", stayDate: "2026-10-01" });
    await expect(
      repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "n2", amount: 1000, taxAmount: 190, concept: "hospedaje", stayDate: "2026-10-02" }),
    ).resolves.toBeDefined();
  });
});

describe("InMemoryHotelesRepository -- payment_token_ref_not_pan", () => {
  it("rechaza un token_ref que parece un PAN (12-19 dígitos)", async () => {
    const repo = repoWithFolio();
    await expect(
      repo.insertPayment({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, amount: 100, method: "tarjeta", status: "capturado", tokenRef: "4111111111111111" }),
    ).rejects.toThrow(/payment_token_ref_not_pan/);
  });

  it("acepta un token opaco de procesador", async () => {
    const repo = repoWithFolio();
    await expect(
      repo.insertPayment({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, amount: 100, method: "tarjeta", status: "capturado", tokenRef: "tok_abc123" }),
    ).resolves.toBeDefined();
  });
});

describe("InMemoryHotelesRepository -- reverso de cargo", () => {
  it("no permite reversar dos veces el mismo cargo", async () => {
    const repo = repoWithFolio();
    const original = await repo.insertCharge({ organizationId: ORG, propertyId: PROPERTY, folioId: FOLIO, description: "extra", amount: 100, taxAmount: 16, concept: "extras" });
    await repo.markChargeReversed(original.id, "reversal-1");
    await expect(repo.markChargeReversed(original.id, "reversal-2")).rejects.toThrow(/reverso_invalido/);
  });
});

// ---------------------------------------------------------------------------
// Fase 3 (H02) — reservas/disponibilidad. Mismo criterio que las suites de arriba:
// prueban el ADAPTADOR (espejo de las reglas SQL reales de migrations/005), no el
// motor puro (eso ya lo cubre reservationStateMachine.spec.ts).
// ---------------------------------------------------------------------------
const ROOM_TYPE = "room-type-1";

function repoWithReservationSupport(): InMemoryHotelesRepository {
  const repo = new InMemoryHotelesRepository();
  repo.seedRoomType(PROPERTY, ROOM_TYPE);
  repo.seedAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1, 0);
  return repo;
}

describe("InMemoryHotelesRepository -- bookAvailability/releaseAvailability", () => {
  it("reserva la última habitación disponible", async () => {
    const repo = repoWithReservationSupport();
    await expect(repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1)).resolves.toBeUndefined();
  });

  it("rechaza reservar sin disponibilidad (sin sobreventa configurada)", async () => {
    const repo = repoWithReservationSupport();
    await repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1);
    await expect(repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1)).rejects.toThrow(/sin_disponibilidad/);
  });

  it("permite sobreventa controlada cuando la ocupación ya superó el umbral configurado", async () => {
    const repo = new InMemoryHotelesRepository();
    repo.seedRoomType(PROPERTY, ROOM_TYPE, { maxOverbookRooms: 1, overbookingOccupancyThresholdPct: 100 });
    repo.seedAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1, 1); // ya 100% ocupado
    await expect(repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1)).resolves.toBeUndefined(); // usa la 1 de sobreventa
    await expect(repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1)).rejects.toThrow(/sin_disponibilidad/); // sobreventa agotada
  });

  it("releaseAvailability libera inventario y nunca lo deja negativo (greatest(booked-qty,0))", async () => {
    const repo = repoWithReservationSupport();
    await repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1);
    await repo.releaseAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 5); // libera de más a propósito
    await expect(repo.bookAvailability(PROPERTY, ROOM_TYPE, "2026-12-01", 1)).resolves.toBeUndefined(); // volvió a quedar disponible
  });

  it("liberar disponibilidad que nunca se sembró es un no-op silencioso (mismo criterio que un UPDATE sin match)", async () => {
    const repo = new InMemoryHotelesRepository();
    await expect(repo.releaseAvailability(PROPERTY, "otro-room-type", "2026-01-01", 1)).resolves.toBeUndefined();
  });
});

describe("InMemoryHotelesRepository -- ciclo de vida de reserva", () => {
  function seedReservation(status: Parameters<InMemoryHotelesRepository["seedReservation"]>[0]["status"], overrides: Partial<Parameters<InMemoryHotelesRepository["seedReservation"]>[0]> = {}) {
    const repo = new InMemoryHotelesRepository();
    repo.seedReservation({
      id: "res-1",
      organizationId: ORG,
      propertyId: PROPERTY,
      roomTypeId: ROOM_TYPE,
      guestId: null,
      checkInDate: "2026-12-01",
      checkOutDate: "2026-12-03",
      status,
      totalAmount: 3000,
      cancellationPenaltyAmount: null,
      canceledAt: null,
      createdAt: new Date().toISOString(),
      ...overrides,
    });
    return repo;
  }

  it("transitionReservation aplica la transición cuando el estado actual coincide con fromStatuses", async () => {
    const repo = seedReservation("confirmada");
    const updated = await repo.transitionReservation(PROPERTY, "res-1", ["confirmada"], "check_in", "user-1");
    expect(updated?.status).toBe("check_in");
  });

  it("transitionReservation devuelve null (reclamo atómico fallido) si el estado ya cambió -- nunca lanza", async () => {
    const repo = seedReservation("check_in");
    const updated = await repo.transitionReservation(PROPERTY, "res-1", ["confirmada"], "check_in", "user-1");
    expect(updated).toBeNull();
  });

  it("transitionReservation devuelve null para una reserva de otra property", async () => {
    const repo = seedReservation("confirmada");
    const updated = await repo.transitionReservation("otra-property", "res-1", ["confirmada"], "check_in", "user-1");
    expect(updated).toBeNull();
  });

  it("cancelReservation cancela y registra la penalización cuando el estado es cancelable", async () => {
    const repo = seedReservation("confirmada");
    const canceled = await repo.cancelReservation(PROPERTY, "res-1", 1500, "user-1");
    expect(canceled?.status).toBe("cancelada");
    expect(canceled?.cancellationPenaltyAmount).toBe(1500);
    expect(canceled?.canceledAt).not.toBeNull();
  });

  it("cancelReservation devuelve null después de check_in (no cancelable) -- nunca lanza, el caller decide el 409", async () => {
    const repo = seedReservation("check_in");
    const canceled = await repo.cancelReservation(PROPERTY, "res-1", 0, "user-1");
    expect(canceled).toBeNull();
  });

  it("findDueNoShowReservations solo trae confirmadas cuyo check-in ya pasó respecto a asOfDate", async () => {
    const repo = seedReservation("confirmada", { checkInDate: "2025-01-10", checkOutDate: "2025-01-12" });
    const dueSoon = await repo.findDueNoShowReservations(PROPERTY, "2025-01-09");
    expect(dueSoon).toHaveLength(0);
    const due = await repo.findDueNoShowReservations(PROPERTY, "2025-01-10");
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe("res-1");
  });

  it("findDueNoShowReservations nunca trae una reserva que ya no está confirmada", async () => {
    const repo = seedReservation("check_in", { checkInDate: "2025-01-01" });
    const due = await repo.findDueNoShowReservations(PROPERTY, "2025-06-01");
    expect(due).toHaveLength(0);
  });
});

describe("InMemoryHotelesRepository -- insertReservation / ensurePrimaryFolio", () => {
  it("insertReservation aterriza directo en confirmada (esta fase salta cotizada)", async () => {
    const repo = new InMemoryHotelesRepository();
    const reservation = await repo.insertReservation({
      organizationId: ORG,
      propertyId: PROPERTY,
      roomTypeId: ROOM_TYPE,
      guestId: null,
      checkInDate: "2026-12-01",
      checkOutDate: "2026-12-03",
      totalAmount: 3000,
    });
    expect(reservation.status).toBe("confirmada");
  });

  it("insertReservation con el mismo idempotencyKey devuelve la MISMA reserva, nunca crea una segunda", async () => {
    const repo = new InMemoryHotelesRepository();
    const input = { organizationId: ORG, propertyId: PROPERTY, roomTypeId: ROOM_TYPE, guestId: null, checkInDate: "2026-12-01", checkOutDate: "2026-12-03", totalAmount: 3000, idempotencyKey: "req-1" };
    const first = await repo.insertReservation(input);
    const second = await repo.insertReservation(input);
    expect(second.id).toBe(first.id);
  });

  it("ensurePrimaryFolio crea el folio primario UNA sola vez, aunque se llame dos veces", async () => {
    const repo = new InMemoryHotelesRepository();
    const first = await repo.ensurePrimaryFolio(PROPERTY, ORG, "res-1");
    const second = await repo.ensurePrimaryFolio(PROPERTY, ORG, "res-1");
    expect(second.id).toBe(first.id);
    const folio = await repo.findFolio(PROPERTY, first.id);
    expect(folio?.isPrimary).toBe(true);
  });
});

// Auditoría a3 (hallazgos confirmados #5 y #2) — regresión para el SAVEPOINT que
// faltaba alrededor de `tryEnqueueGuestEmail` (único `try*` de este dominio).
// `enqueueGuestEmailCore` termina en `select hoteles.enqueue_messaging_outbox(...)`
// (postgres-repository.ts ~1399), llamado SIEMPRE en la MISMA transacción que ya
// persistió la reserva/folio/CFDI (reservas.ts:289, folios.ts:576, cfdi.ts:322): un
// `try/catch` plano sin SAVEPOINT deja esa transacción COMPLETA abortada (25P02) si
// el encolado falla, y esa escritura de negocio ya hecha se pierde con el `commit;`
// convertido en `ROLLBACK` silencioso (`AbortedTransactionCommitError`,
// managed-postgres-engine.ts).
//
// Se prueba contra `PostgresHotelesRepository` real (no el doble en memoria, cuyo
// `runWithRowSavepoint` es un no-op que no reproduce el estado abortado de Postgres)
// + `AbortAwareFakeSession` (packages/domain-hoteles/tests/support, mismo doble que
// usa `whatsapp-llm-turn-handler-savepoint.spec.ts` de este paquete). Las
// resoluciones previas (reserva/huésped/property) se stubbean con `vi.spyOn` sobre
// el propio repo -- lo único que de verdad toca la sesión real es el intento de
// encolado que falla y el SAVEPOINT/ROLLBACK TO SAVEPOINT que debe envolverlo. Cada
// test de este archivo FALLA contra el código anterior (try/catch sin
// `repo.runWithRowSavepoint`): sin el SAVEPOINT, la consulta posterior sobre la
// MISMA sesión lanza 25P02 en vez de resolver.
import { describe, expect, it, vi } from "vitest";
import { PostgresHotelesRepository } from "../src/postgres-repository.ts";
import { tryEnqueueGuestEmail } from "../src/guest-email-notifications.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { GuestSummary, ReservationRecord } from "../src/types.ts";

const PROPERTY_ID = "00000000-0000-0000-0000-0000000000p1";
const ORGANIZATION_ID = "00000000-0000-0000-0000-0000000000o1";
const RESERVATION_ID = "00000000-0000-0000-0000-0000000000r1";

const RESERVATION: ReservationRecord = {
  id: RESERVATION_ID,
  organizationId: ORGANIZATION_ID,
  propertyId: PROPERTY_ID,
  roomTypeId: "00000000-0000-0000-0000-0000000000t1",
  guestId: "00000000-0000-0000-0000-0000000000g1",
  checkInDate: "2026-12-01",
  checkOutDate: "2026-12-03",
  status: "confirmada",
  totalAmount: 3000,
  cancellationPenaltyAmount: null,
  canceledAt: null,
  createdAt: new Date().toISOString(),
  roomId: null,
};

const GUEST: GuestSummary = { id: "00000000-0000-0000-0000-0000000000g1", fullName: "María López", email: "maria@example.com", phone: "9998887766" };

function pgPermissionDenied(): Error & { code: string } {
  const err = new Error("permission denied for function enqueue_messaging_outbox") as Error & { code: string };
  err.code = "42501";
  return err;
}

/** Arma un `PostgresHotelesRepository` con las resoluciones previas a
 *  `enqueue_messaging_outbox` ya stubbeadas (reserva/huésped/property reales),
 *  dejando la sesión libre para ejercitar solo el SAVEPOINT del best-effort. */
function buildRepo(session: AbortAwareFakeSession) {
  const repo = new PostgresHotelesRepository(session);
  vi.spyOn(repo, "findReservation").mockResolvedValue(RESERVATION);
  vi.spyOn(repo, "findGuestById").mockResolvedValue(GUEST);
  vi.spyOn(repo, "findPropertyById").mockResolvedValue({ id: PROPERTY_ID, name: "Hotel de Prueba", organizationId: ORGANIZATION_ID });
  return repo;
}

describe("tryEnqueueGuestEmail — SAVEPOINT (auditoría a3, hallazgo confirmado #5)", () => {
  it("un 42501 real de enqueue_messaging_outbox NUNCA deja la sesión abortada -- la reserva/folio/CFDI ya persistido sobrevive", async () => {
    const session = new AbortAwareFakeSession([
      { match: /enqueue_messaging_outbox/, respond: () => pgPermissionDenied() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = buildRepo(session);

    // No lanza -- best-effort real.
    const result = await tryEnqueueGuestEmail(repo, PROPERTY_ID, ORGANIZATION_ID, "folio.closed", RESERVATION_ID, {
      folio: { folioId: "f1", label: "Folio 1", closeReason: "saldo_cero", totalCargos: 1000, totalPagos: 1000, saldo: 0 },
    });
    expect(result).toBeNull();

    // La prueba real: el SAVEPOINT interno recuperó la transacción -- una consulta
    // POSTERIOR sobre la MISMA sesión (aquí, la que haría el `commit;` real de
    // managed-postgres-engine.ts) resuelve en vez de lanzar 25P02
    // (AbortedTransactionCommitError). Contra el código anterior (sin
    // `repo.runWithRowSavepoint`) esta aserción falla: la sesión queda abortada.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);
  });

  it("éxito real: encola el correo sin dejar rastro de SAVEPOINT sin liberar", async () => {
    const session = new AbortAwareFakeSession([{ match: /enqueue_messaging_outbox/, respond: () => [] }]);
    const repo = buildRepo(session);

    const result = await tryEnqueueGuestEmail(repo, PROPERTY_ID, ORGANIZATION_ID, "folio.closed", RESERVATION_ID, {
      folio: { folioId: "f1", label: "Folio 1", closeReason: "saldo_cero", totalCargos: 1000, totalPagos: 1000, saldo: 0 },
    });

    expect(result).toEqual({ enqueued: true });
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });

  it("sin correo en archivo: nunca llama a enqueue_messaging_outbox, nunca deja un SAVEPOINT abierto", async () => {
    const session = new AbortAwareFakeSession([{ match: /enqueue_messaging_outbox/, respond: () => pgPermissionDenied() }]);
    const repo = new PostgresHotelesRepository(session);
    vi.spyOn(repo, "findReservation").mockResolvedValue(RESERVATION);
    vi.spyOn(repo, "findGuestById").mockResolvedValue({ ...GUEST, email: null });

    const result = await tryEnqueueGuestEmail(repo, PROPERTY_ID, ORGANIZATION_ID, "folio.closed", RESERVATION_ID, {
      folio: { folioId: "f1", label: "Folio 1", closeReason: "saldo_cero", totalCargos: 1000, totalPagos: 1000, saldo: 0 },
    });

    expect(result).toEqual({ enqueued: false, reason: "no_email" });
    expect(session.calls.some((c) => c.startsWith("release savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(false);
  });
});

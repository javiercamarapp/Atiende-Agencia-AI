// H-05 -- REGLA DURA de compatibilidad con la base sin migrar contra PostgresGuestTicketRepository
// REAL + AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un
// error, toda consulta posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana
// NO sirve. Cada test FALLA si se quita el SAVEPOINT.
import { describe, expect, it } from "vitest";
import {
  PostgresGuestTicketRepository,
  TicketAccessDeniedError,
  TicketConflictError,
  TicketInvalidInputError,
  TicketNotFoundError,
  TicketUnavailableError,
} from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const TK = "00000000-0000-0000-0000-0000000000d1";
const U = "00000000-0000-0000-0000-0000000000c1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedTable = () => pgError("42P01", 'relation "hoteles.guest_ticket" does not exist');
const after = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

describe("lecturas con base sin migrar 034 (42P01)", () => {
  it("listTickets, listEvents, listSlaPolicies y listReviewsPendingTicket degradan a vacio y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.guest_ticket t left join/i, respond: undefinedTable },
      { match: /from hoteles\.guest_ticket_event e/i, respond: undefinedTable },
      { match: /from hoteles\.ticket_sla_policy/i, respond: undefinedTable },
      { match: /from hoteles\.guest_review r/i, respond: undefinedTable },
      after,
    ]);
    const repo = new PostgresGuestTicketRepository(session);
    expect(await repo.listTickets(P, {})).toEqual({ disponible: false, tickets: [] });
    expect(await repo.findTicket(P, TK)).toBeNull();
    expect(await repo.listEvents(P, TK)).toEqual([]);
    expect(await repo.listSlaPolicies(P)).toEqual({ disponible: false, politicas: [] });
    expect(await repo.listReviewsPendingTicket(P, 10)).toEqual({ disponible: false, resenas: [] });
    // la MISMA transaccion sigue sirviendo consultas (sin ROLLBACK TO SAVEPOINT lanzaria 25P02)
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.guest_ticket t left join/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresGuestTicketRepository(session).listTickets(P, {})).rejects.toMatchObject({ code: "57014" });
  });
});

describe("escrituras: errores de Postgres -> errores de dominio, con la sesion recuperada", () => {
  const newTicket = { propertyId: P, roomId: null, guestReviewId: null, department: "frontdesk", priority: "media", channel: "staff", guestMessage: "x", slaMinutes: 120, assignedTo: null, createdBy: U } as const;

  it("createTicket sin migracion 034 -> TicketUnavailableError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.guest_ticket/i, respond: undefinedTable }, after]);
    await expect(new PostgresGuestTicketRepository(session).createTicket(newTicket)).rejects.toBeInstanceOf(TicketUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("sweepSla sin la funcion (42883) -> TicketUnavailableError, y la sesion sigue utilizable (barrido por unidad)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /sweep_guest_ticket_sla/i, respond: () => pgError("42883", "function hoteles.sweep_guest_ticket_sla(uuid, timestamp with time zone) does not exist") },
      after,
    ]);
    await expect(new PostgresGuestTicketRepository(session).sweepSla(P, new Date())).rejects.toBeInstanceOf(TicketUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("mapea 23503 -> NotFound, 23505 -> Conflict, 23514 -> InvalidInput, 42501 -> AccessDenied", async () => {
    const cases: Array<[string, new (...a: never[]) => Error]> = [
      ["23503", TicketNotFoundError], ["23505", TicketConflictError], ["23514", TicketInvalidInputError], ["42501", TicketAccessDeniedError],
    ];
    for (const [code, klass] of cases) {
      const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.guest_ticket/i, respond: () => pgError(code, "x") }, after]);
      await expect(new PostgresGuestTicketRepository(session).createTicket(newTicket)).rejects.toBeInstanceOf(klass);
      await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    }
  });

  it("setStatus: 0 filas actualizadas (no visible / no existe) -> null, sin error", async () => {
    const session = new AbortAwareFakeSession([{ match: /update hoteles\.guest_ticket\s+set status/i, respond: () => [] }]);
    expect(await new PostgresGuestTicketRepository(session).setStatus(P, TK, "cerrado", null)).toBeNull();
  });

  it("sweepSla mapea las columnas out_* y manda el reloj como parametro", async () => {
    const session = new AbortAwareFakeSession([
      { match: /sweep_guest_ticket_sla/i, respond: () => [{ out_ticket_id: TK, out_kind: "escalado", out_department: "fnb", out_priority: "alta", out_assigned_to: null }] },
    ]);
    expect(await new PostgresGuestTicketRepository(session).sweepSla(P, new Date("2026-03-10T10:00:00.000Z"))).toEqual([
      { ticketId: TK, kind: "escalado", department: "fnb", priority: "alta", assignedTo: null },
    ]);
  });
});

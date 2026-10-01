// H-06 -- REGLA DURA de compatibilidad con la base sin migrar contra PostgresGruposRepository REAL +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un error, toda consulta
// posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve. Cada test FALLA si se quita
// el SAVEPOINT. Tambien cubre la traduccion de SQLSTATE a errores de dominio.
import { describe, expect, it } from "vitest";
import {
  GruposAccessDeniedError,
  GruposConflictError,
  GruposInvalidInputError,
  GruposNotFoundError,
  GruposUnavailableError,
  PostgresGruposRepository,
  mapGruposPgError,
  type NewQuoteInput,
} from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const Q = "00000000-0000-0000-0000-0000000000c1";
const B = "00000000-0000-0000-0000-0000000000b1";
const E = "00000000-0000-0000-0000-0000000000e1";
const actor = { userId: "u", role: "owner" } as const;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedTable = () => pgError("42P01", 'relation "hoteles.group_quote" does not exist');
const undefinedFn = (name: string) => () => pgError("42883", `function hoteles.${name} does not exist`);
const after = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const input: NewQuoteInput = {
  propertyId: P, groupName: "Boda", checkInDate: "2031-06-12", checkOutDate: "2031-06-15", cutoffDate: "2031-06-05", validUntil: "2031-05-08T12:00:00Z",
  discountBps: 0, depositRequiredCents: 0, lines: [{ roomTypeId: "00000000-0000-0000-0000-0000000d0001", rooms: 1, rateCents: 100 }],
};

describe("lecturas con base sin migrar 036 (42P01)", () => {
  it("degradan a vacio honesto y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.group_quote /i, respond: undefinedTable },
      { match: /from hoteles\.group_block /i, respond: undefinedTable },
      after,
    ]);
    const repo = new PostgresGruposRepository(session);
    expect(await repo.listQuotes(P)).toEqual({ disponible: false, cotizaciones: [] });
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(await repo.getQuote(P, Q)).toBeNull();
    expect(await repo.listBlocks(P)).toEqual({ disponible: false, bloqueos: [] });
    expect(await repo.getBlock(P, B)).toBeNull();
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.group_quote/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresGruposRepository(session).listQuotes(P)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("escrituras sin migracion: GruposUnavailableError y la sesion recuperada", () => {
  it("crear, enviar, aceptar, anticipo, rooming, liberar y barrido responden 503 sin romper la transaccion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /group_quote_create/i, respond: undefinedFn("group_quote_create(uuid, text, text, text, date, date, date, timestamp with time zone, integer, bigint, jsonb)") },
      { match: /from hoteles\.group_(quote|block|rooming_entry) where id/i, respond: undefinedTable },
      { match: /group_release_due/i, respond: undefinedFn("group_release_due(uuid, timestamp with time zone)") },
      { match: /group_expire_quotes/i, respond: undefinedFn("group_expire_quotes(timestamp with time zone)") },
      after,
    ]);
    const repo = new PostgresGruposRepository(session);
    await expect(repo.createQuote(input, actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await expect(repo.sendQuote(P, Q, actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(repo.acceptQuote(P, Q, actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(repo.registerDeposit(P, Q, 100, "REF-0001", actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(repo.addRoomingEntry(P, B, { roomTypeId: Q, guestName: "Luis", checkInDate: "2031-06-12", checkOutDate: "2031-06-13" }, actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(repo.confirmRoomingEntry(P, E, null, actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(repo.releaseBlock(P, B, actor)).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await expect(repo.releaseDueBlocks(null, new Date())).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(repo.expireQuotes(new Date())).rejects.toBeInstanceOf(GruposUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("escrituras con la migracion aplicada", () => {
  it("una entidad de otra property se trata como no encontrada ANTES de llamar a la funcion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.group_quote where id/i, respond: () => [] },
      { match: /group_quote_accept/i, respond: () => { throw new Error("no debe llamarse"); } },
    ]);
    await expect(new PostgresGruposRepository(session).acceptQuote(P, Q, actor)).rejects.toBeInstanceOf(GruposNotFoundError);
    expect(session.calls.some((c) => /group_quote_accept/i.test(c))).toBe(false);
  });

  it("aceptar devuelve el bloqueo con su resumen de pickup (confirmados vs bloqueados)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.group_quote where id/i, respond: () => [{ ok: 1 }] },
      { match: /group_quote_accept/i, respond: () => [{ id: B }] },
      {
        match: /from hoteles\.group_block b/i,
        respond: () => [{
          id: B, property_id: P, quote_id: Q, group_name: "Boda", status: "activo", check_in_date: "2031-06-12", check_out_date: "2031-06-15", cutoff_date: "2031-06-05",
          released_at: null, release_kind: null, created_at: "2031-05-01T12:00:00Z", blocked: "15", picked: "3", released: "0",
        }],
      },
      { match: /from hoteles\.group_block_night/i, respond: () => [{ room_type_id: "rt", date: "2031-06-12", blocked_rooms: 5, picked_up_rooms: 1, released_rooms: 0 }] },
      { match: /from hoteles\.group_rooming_entry/i, respond: () => [] },
    ]);
    const block = await new PostgresGruposRepository(session).acceptQuote(P, Q, actor);
    expect(block.pickup).toMatchObject({ blockedRoomNights: 15, pickedUpRoomNights: 3, pendingRoomNights: 12, pickupPct: 20 });
    expect(block.nights).toHaveLength(1);
  });

  it("el barrido por cutoff devuelve los bloqueos liberados con cuartos-noche enteros", async () => {
    const session = new AbortAwareFakeSession([{ match: /group_release_due/i, respond: () => [{ block_id: B, released_rooms: "12" }] }]);
    expect(await new PostgresGruposRepository(session).releaseDueBlocks(null, new Date("2031-06-05T06:00:00Z"))).toEqual([{ blockId: B, releasedRoomNights: 12 }]);
  });
});

describe("mapGruposPgError", () => {
  it("traduce SQLSTATE a errores de dominio sin filtrar identificadores de inventario", () => {
    const sinDisp = mapGruposPgError(pgError("P0001", "sin_disponibilidad: room_type=abc, fecha=2031-06-14, libres=2, pedidos=5"), "x") as Error;
    expect(sinDisp).toBeInstanceOf(GruposConflictError);
    expect(sinDisp.message).not.toMatch(/room_type|abc|libres=|pedidos/);
    expect(mapGruposPgError(pgError("P0001", "sin_cupo_en_bloque: noche 2031-06-12"), "x")).toBeInstanceOf(GruposConflictError);
    expect(mapGruposPgError(pgError("55000", "propuesta_vencida: la vigencia ya paso"), "x")).toBeInstanceOf(GruposConflictError);
    expect(mapGruposPgError(pgError("42501", "sin permiso para esta operacion sobre grupos"), "x")).toBeInstanceOf(GruposAccessDeniedError);
    expect(mapGruposPgError(pgError("22023", "el motivo es obligatorio"), "x")).toBeInstanceOf(GruposInvalidInputError);
    expect(mapGruposPgError(pgError("23514", 'new row for relation "group_block_night" violates check constraint'), "x")).toMatchObject({ message: expect.not.stringMatching(/new row/) });
    expect(mapGruposPgError(pgError("P0002", "bloqueo_no_encontrado"), "x")).toBeInstanceOf(GruposNotFoundError);
    expect(mapGruposPgError(pgError("23505", "duplicate key value violates unique constraint"), "x")).toBeInstanceOf(GruposConflictError);
    expect(mapGruposPgError(pgError("42883", "function does not exist"), "x")).toBeInstanceOf(GruposUnavailableError);
    const unknown = pgError("57014", "statement timeout");
    expect(mapGruposPgError(unknown, "x")).toBe(unknown);
  });
});

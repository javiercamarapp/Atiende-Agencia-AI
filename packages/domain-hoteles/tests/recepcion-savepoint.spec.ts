// H-28 -- regresion de la REGLA DURA de compatibilidad con la base sin migrar contra PostgresRecepcionRepository REAL +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un error, cualquier consulta
// posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve. Cada test FALLA si se quita el
// SAVEPOINT: la consulta de respaldo / la siguiente consulta del request lanzaria 25P02 en vez de resolver.
import { describe, expect, it } from "vitest";
import {
  PostgresRecepcionRepository,
  RecepcionAccessDeniedError,
  RecepcionConflictError,
  RecepcionInvalidInputError,
  RecepcionNotFoundError,
  RecepcionUnavailableError,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const R = "00000000-0000-0000-0000-0000000000b1";
const ROOM = "00000000-0000-0000-0000-0000000000c1";
const G = "00000000-0000-0000-0000-0000000000d1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
// La reserva pertenece a la property (seguimiento #302: cambiarHabitacion ya no ignora la property).
const propia = { match: /select id from hoteles\.reservation where id = \$1::uuid and property_id = \$2::uuid/i, respond: () => [{ id: R }] };

describe("lecturas con base sin migrar", () => {
  it("listarReservasDelDia cae a la consulta sin room_id (42703) y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /rm\.code as room_code/i, respond: () => pgError("42703", 'column r.room_id does not exist') },
      {
        match: /null::uuid as room_id/i,
        respond: () => [{ id: R, status: "confirmada", check_in_date: "2026-12-02", check_out_date: "2026-12-05", room_type_id: null, room_type_name: "Doble", room_id: null, room_code: null, guest_id: G, guest_name: "Ana" }],
      },
      siguiente,
    ]);
    const rows = await new PostgresRecepcionRepository(session).listarReservasDelDia(P, "2026-12-02");
    expect(rows).toEqual([{ reservationId: R, status: "confirmada", checkInDate: "2026-12-02", checkOutDate: "2026-12-05", roomTypeId: null, roomTypeName: "Doble", roomId: null, roomCode: null, guestId: G, guestName: "Ana" }]);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("buscarTraslapeDeHabitacion degrada a 'sin traslape' si no existe la columna room_id (42703)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.reservation/i, respond: () => pgError("42703", "column room_id does not exist") }, siguiente]);
    await expect(new PostgresRecepcionRepository(session).buscarTraslapeDeHabitacion(P, ROOM, "2026-12-02", "2026-12-05", R)).resolves.toBeNull();
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("huespedesConIdentidad devuelve null (no 'sin identidad') si la boveda no existe (42P01)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.identity_vault/i, respond: () => pgError("42P01", 'relation "hoteles.identity_vault" does not exist') }, siguiente]);
    await expect(new PostgresRecepcionRepository(session).huespedesConIdentidad(P, [G])).resolves.toBeNull();
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await expect(new PostgresRecepcionRepository(session).huespedesConIdentidad(P, [])).resolves.toEqual(new Set());
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /rm\.code as room_code/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresRecepcionRepository(session).listarReservasDelDia(P, "2026-12-02")).rejects.toMatchObject({ code: "57014" });
  });
});

describe("cambiarHabitacion (funcion change_reservation_room)", () => {
  it("base sin la migracion 038 (42883) -> RecepcionUnavailableError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([propia, { match: /change_reservation_room/i, respond: () => pgError("42883", "function hoteles.change_reservation_room(uuid, uuid, text) does not exist") }, siguiente]);
    await expect(new PostgresRecepcionRepository(session).cambiarHabitacion(P, R, ROOM, null)).rejects.toBeInstanceOf(RecepcionUnavailableError);
    // la MISMA transaccion sigue sirviendo consultas (sin ROLLBACK TO SAVEPOINT lanzaria 25P02)
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("traduce los SQLSTATE de la funcion a errores de dominio (nunca un 500 crudo)", async () => {
    const casos: [string, string, new (...a: never[]) => Error, string?][] = [
      ["42501", "rol sin permiso para asignar habitaciones", RecepcionAccessDeniedError],
      ["P0002", "reserva no encontrada", RecepcionNotFoundError],
      ["22023", "tipo_distinto: la habitacion es de otro tipo que la reserva", RecepcionInvalidInputError],
      ["23P01", "habitacion_ocupada: la habitacion 102 tiene otra reserva en esas fechas", RecepcionConflictError, "habitacion_ocupada"],
      ["55000", "habitacion_no_disponible: la habitacion 104 esta fuera de servicio", RecepcionConflictError, "habitacion_no_disponible"],
      ["55000", "habitacion_no_lista: la habitacion 105 esta sucia", RecepcionConflictError, "habitacion_no_lista"],
      ["55000", "reserva_no_modificable: la reserva esta en estado cancelada", RecepcionConflictError, "reserva_no_modificable"],
    ];
    for (const [code, message, clase, conflictCode] of casos) {
      const session = new AbortAwareFakeSession([propia, { match: /change_reservation_room/i, respond: () => pgError(code, message) }, siguiente]);
      const err = await new PostgresRecepcionRepository(session).cambiarHabitacion(P, R, ROOM, "motivo").catch((e: unknown) => e);
      expect(err, `${code} ${message}`).toBeInstanceOf(clase);
      if (conflictCode) expect((err as RecepcionConflictError).code).toBe(conflictCode);
      await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    }
  });

  it("el mensaje al usuario no lleva el prefijo tecnico del codigo", async () => {
    const session = new AbortAwareFakeSession([propia, { match: /change_reservation_room/i, respond: () => pgError("23P01", "habitacion_ocupada: la habitacion 102 tiene otra reserva en esas fechas") }]);
    const err = await new PostgresRecepcionRepository(session).cambiarHabitacion(P, R, ROOM, null).catch((e: unknown) => e);
    expect((err as Error).message).toBe("la habitacion 102 tiene otra reserva en esas fechas");
  });

  it("una reserva de OTRA property es 'no encontrada' y NUNCA llega a la funcion SQL (no bloquea ni toca filas ajenas)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select id from hoteles\.reservation where id = \$1::uuid and property_id = \$2::uuid/i, respond: () => [] },
      { match: /change_reservation_room/i, respond: () => [{ from_room_id: null, to_room_id: ROOM }] },
      siguiente,
    ]);
    await expect(new PostgresRecepcionRepository(session).cambiarHabitacion(P, R, ROOM, null)).rejects.toBeInstanceOf(RecepcionNotFoundError);
    expect(session.calls.some((c) => /change_reservation_room/i.test(c))).toBe(false);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("exito: devuelve de-a", async () => {
    const session = new AbortAwareFakeSession([propia, { match: /change_reservation_room/i, respond: () => [{ from_room_id: null, to_room_id: ROOM }] }]);
    await expect(new PostgresRecepcionRepository(session).cambiarHabitacion(P, R, ROOM, null)).resolves.toEqual({ fromRoomId: null, toRoomId: ROOM });
  });
});

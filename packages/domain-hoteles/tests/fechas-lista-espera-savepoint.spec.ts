// H-28 / H-12 -- regresion de la REGLA DURA de compatibilidad con la base sin migrar (041) contra los adaptadores Postgres REALES +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un error, cualquier consulta posterior
// lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Cada test FALLA si se quita el SAVEPOINT: la consulta siguiente lanzaria 25P02.
import { describe, expect, it } from "vitest";
import {
  CambioFechasAccessDeniedError,
  CambioFechasConflictError,
  CambioFechasInvalidInputError,
  CambioFechasNotFoundError,
  CambioFechasUnavailableError,
  ListaEsperaConflictError,
  ListaEsperaInvalidInputError,
  ListaEsperaUnavailableError,
  PostgresCambioFechasRepository,
  PostgresListaEsperaRepository,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const R = "00000000-0000-0000-0000-0000000000b1";
const T = "00000000-0000-0000-0000-0000000000c1";
const E = "00000000-0000-0000-0000-0000000000e1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const despues = (s: AbortAwareFakeSession) => expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
const input = { propertyId: P, reservationId: R, esperadaEntrada: "2031-07-03", esperadaSalida: "2031-07-05", nuevaEntrada: "2031-07-03", nuevaSalida: "2031-07-06", nuevoTotalNeto: 3000, penalidad: 0, motivo: null };

describe("PostgresCambioFechasRepository.aplicarCambio", () => {
  it("base sin la migracion 041 (42883) -> CambioFechasUnavailableError y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /change_reservation_dates/i, respond: () => pgError("42883", "function hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text) does not exist") }, siguiente]);
    await expect(new PostgresCambioFechasRepository(s).aplicarCambio(input)).rejects.toBeInstanceOf(CambioFechasUnavailableError);
    await despues(s);
    expect(s.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("traduce los SQLSTATE de la funcion a errores de dominio con su codigo (nunca un 500 crudo)", async () => {
    const casos: [string, string, new (...a: never[]) => Error, string?][] = [
      ["42501", "rol sin permiso para cambiar fechas de reservas", CambioFechasAccessDeniedError],
      ["P0002", "reserva no encontrada", CambioFechasNotFoundError],
      ["22023", "sin_cambio: las fechas son las mismas", CambioFechasInvalidInputError],
      ["55006", "reserva_modificada: las fechas de la reserva cambiaron mientras tanto", CambioFechasConflictError, "reserva_modificada"],
      ["55000", "noches_posteadas: hay noches ya cargadas al folio fuera de las fechas nuevas", CambioFechasConflictError, "noches_posteadas"],
      ["55000", "reserva_no_modificable: la reserva esta en estado cancelada", CambioFechasConflictError, "reserva_no_modificable"],
      ["23P01", "habitacion_ocupada: la habitacion asignada tiene otra reserva", CambioFechasConflictError, "habitacion_ocupada"],
      ["P0001", "sin_disponibilidad: no hay habitaciones libres para property=x", CambioFechasConflictError, "sin_disponibilidad"],
    ];
    for (const [code, message, clase, conflictCode] of casos) {
      const s = new AbortAwareFakeSession([{ match: /change_reservation_dates/i, respond: () => pgError(code, message) }, siguiente]);
      const err = await new PostgresCambioFechasRepository(s).aplicarCambio(input).catch((e: unknown) => e);
      expect(err, `${code} ${message}`).toBeInstanceOf(clase);
      if (conflictCode) expect((err as CambioFechasConflictError).code).toBe(conflictCode);
      await despues(s);
    }
  });

  it("un error que no es de dominio se repropaga y la sesion queda utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /change_reservation_dates/i, respond: () => pgError("57014", "statement timeout") }, siguiente]);
    await expect(new PostgresCambioFechasRepository(s).aplicarCambio(input)).rejects.toMatchObject({ code: "57014" });
    await despues(s);
  });

  it("exito: devuelve el cambio con fechas como texto y montos numericos", async () => {
    const fila = { out_reservation_id: R, out_old_check_in: "2031-07-03", out_old_check_out: "2031-07-05", out_new_check_in: "2031-07-03", out_new_check_out: "2031-07-06", out_new_total: "3000.00", out_noches_liberadas: 0, out_noches_reservadas: 1, out_penalty_amount: "0.00" };
    const s = new AbortAwareFakeSession([{ match: /change_reservation_dates/i, respond: () => [fila] }]);
    await expect(new PostgresCambioFechasRepository(s).aplicarCambio(input)).resolves.toEqual({ reservationId: R, entradaAnterior: "2031-07-03", salidaAnterior: "2031-07-05", entradaNueva: "2031-07-03", salidaNueva: "2031-07-06", totalNeto: 3000, nochesLiberadas: 0, nochesReservadas: 1, penalidad: 0 });
  });
});

describe("PostgresListaEsperaRepository contra la base sin migrar (42P01)", () => {
  const sinTabla = () => pgError("42P01", 'relation "hoteles.waitlist_entry" does not exist');

  it("listar degrada a lista vacia con disponible:false; expirarVencidas a 0; listarActivasCompatibles a [] y la sesion sigue utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /waitlist_entry/i, respond: sinTabla }, siguiente]);
    const repo = new PostgresListaEsperaRepository(s);
    await expect(repo.listar(P, null)).resolves.toEqual({ disponible: false, entradas: [] });
    await despues(s);
    await expect(repo.expirarVencidas(P, new Date())).resolves.toBe(0);
    await despues(s);
    await expect(repo.listarActivasCompatibles(P, T, "2031-07-03", "2031-07-05")).resolves.toEqual([]);
    await despues(s);
    expect(s.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(3);
  });

  it("las escrituras responden ListaEsperaUnavailableError (503) y dejan la sesion utilizable", async () => {
    const s = new AbortAwareFakeSession([{ match: /waitlist_entry/i, respond: sinTabla }, siguiente]);
    const repo = new PostgresListaEsperaRepository(s);
    const nueva = { propertyId: P, roomTypeId: T, checkInDate: "2031-07-03", checkOutDate: "2031-07-05", huespedes: 1, nombre: "Ana", telefono: "5511112222", email: null, notas: null };
    await expect(repo.crear(nueva)).rejects.toBeInstanceOf(ListaEsperaUnavailableError);
    await despues(s);
    await expect(repo.ofrecer(P, E, new Date())).rejects.toBeInstanceOf(ListaEsperaUnavailableError);
    await despues(s);
    await expect(repo.cancelar(P, E)).rejects.toBeInstanceOf(ListaEsperaUnavailableError);
    await despues(s);
  });

  it("traduce los errores de la base: transicion/oferta vencida -> conflicto con codigo; CHECK -> entrada invalida", async () => {
    const s1 = new AbortAwareFakeSession([{ match: /update hoteles\.waitlist_entry/i, respond: () => pgError("55000", "oferta_vencida: la oferta ya vencio") }, siguiente]);
    const err1 = await new PostgresListaEsperaRepository(s1).marcarAceptada(P, E, R).catch((e: unknown) => e);
    expect(err1).toBeInstanceOf(ListaEsperaConflictError);
    expect((err1 as ListaEsperaConflictError).code).toBe("oferta_vencida");
    await despues(s1);
    const s2 = new AbortAwareFakeSession([{ match: /insert into hoteles\.waitlist_entry/i, respond: () => pgError("23514", "violates check constraint") }, siguiente]);
    const nueva = { propertyId: P, roomTypeId: T, checkInDate: "2031-07-03", checkOutDate: "2031-07-05", huespedes: 1, nombre: "Ana", telefono: null, email: null, notas: null };
    await expect(new PostgresListaEsperaRepository(s2).crear(nueva)).rejects.toBeInstanceOf(ListaEsperaInvalidInputError);
    await despues(s2);
  });
});

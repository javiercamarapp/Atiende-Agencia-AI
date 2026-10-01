// H-27 -- regresion de la REGLA DURA de compatibilidad con la base sin migrar contra PostgresHuespedesRepository REAL +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un error, cualquier consulta
// posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve. Cada test FALLA si se quita el
// SAVEPOINT. Ademas cubre reglas puras (resumen de estancias, clave de telefono, deteccion de datos sensibles).
import { describe, expect, it } from "vitest";
import {
  HuespedesAccessDeniedError,
  HuespedesArcoRestrictionError,
  HuespedesInvalidInputError,
  HuespedesNotFoundError,
  HuespedesUnavailableError,
  PostgresHuespedesRepository,
  claveTelefono,
  notaTieneDatoSensible,
  resumirEstancias,
  type GuestStayRow,
} from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const G = "00000000-0000-0000-0000-0000000000d1";
const N = "00000000-0000-0000-0000-0000000000e1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const siguiente = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };
const sigueUtil = async (session: AbortAwareFakeSession) => {
  await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
};

describe("lecturas con base sin migrar: vacio honesto, no 'sin datos'", () => {
  it("consentimientos, identidad y bandera ARCO devuelven null (42P01/42883) y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.identity_consent/i, respond: () => pgError("42P01", "no existe identity_consent") },
      { match: /from hoteles\.identity_vault/i, respond: () => pgError("42P01", "no existe identity_vault") },
      { match: /guest_has_arco_restriction/i, respond: () => pgError("42883", "function hoteles.guest_has_arco_restriction(uuid) does not exist") },
      siguiente,
    ]);
    const repo = new PostgresHuespedesRepository(session);
    await expect(repo.listarConsentimientos(P, G)).resolves.toBeNull();
    await expect(repo.tieneIdentidadActiva(P, G)).resolves.toBeNull();
    await expect(repo.tieneRestriccionArco(G)).resolves.toBeNull();
    await sigueUtil(session);
  });

  it("listarNotas -> available:false y contactos -> [] sin las tablas", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.guest_note/i, respond: () => pgError("42P01", "no existe guest_note") },
      { match: /from hoteles\.contacto_no_operativo/i, respond: () => pgError("42P01", "no existe") },
      siguiente,
    ]);
    const repo = new PostgresHuespedesRepository(session);
    await expect(repo.listarNotas(P, G)).resolves.toEqual({ available: false, items: [] });
    await expect(repo.listarContactos(P, "5511112222", 10)).resolves.toEqual([]);
    await expect(repo.listarContactos(P, null, 10)).resolves.toEqual([]);
    await sigueUtil(session);
  });

  it("listarEstancias cae a la consulta sin room_id/total_amount (42703)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /rm\.code as room_code/i, respond: () => pgError("42703", "column r.room_id does not exist") },
      {
        match: /null::text as room_code/i,
        respond: () => [{ id: "r1", status: "check_out", check_in_date: "2026-10-01", check_out_date: "2026-10-04", room_type_name: "Doble", room_code: null, total_amount: "0" }],
      },
      siguiente,
    ]);
    const rows = await new PostgresHuespedesRepository(session).listarEstancias(P, G, 50);
    expect(rows).toEqual([{ reservationId: "r1", status: "check_out", checkInDate: "2026-10-01", checkOutDate: "2026-10-04", roomTypeName: "Doble", roomCode: null, netAmountCents: 0 }]);
    await sigueUtil(session);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.guest_note/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresHuespedesRepository(session).listarNotas(P, G)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("escrituras de notas", () => {
  it("sin la migracion 038 -> HuespedesUnavailableError y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.guest_note/i, respond: () => pgError("42P01", "no existe guest_note") }, siguiente]);
    await expect(new PostgresHuespedesRepository(session).agregarNota({ propertyId: P, guestId: G, kind: "nota", body: "x" })).rejects.toBeInstanceOf(HuespedesUnavailableError);
    await sigueUtil(session);
  });

  it("traduce los SQLSTATE de la base a errores de dominio", async () => {
    const casos: [string, string, new (...a: never[]) => Error][] = [
      ["42501", "permission denied", HuespedesAccessDeniedError],
      ["23503", "guest_invalido: el huesped no pertenece a la property", HuespedesNotFoundError],
      ["22023", "nota_con_dato_sensible: no captures numeros de tarjeta ni de documento en una nota", HuespedesInvalidInputError],
      ["23514", "check constraint", HuespedesInvalidInputError],
      ["55000", "arco_en_curso: el huesped ejercio cancelacion u oposicion", HuespedesArcoRestrictionError],
    ];
    for (const [code, message, clase] of casos) {
      const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.guest_note/i, respond: () => pgError(code, message) }, siguiente]);
      await expect(new PostgresHuespedesRepository(session).agregarNota({ propertyId: P, guestId: G, kind: "nota", body: "x" }), code).rejects.toBeInstanceOf(clase);
      await sigueUtil(session);
    }
  });

  it("archivar: devuelve la nota, null si ya estaba archivada, y 503 sin migracion", async () => {
    const fila = { id: N, kind: "nota", body: "x", created_by: null, created_at: "2026-12-02T10:00:00Z" };
    const ok = new AbortAwareFakeSession([{ match: /update hoteles\.guest_note/i, respond: () => [fila] }]);
    await expect(new PostgresHuespedesRepository(ok).archivarNota(P, G, N)).resolves.toMatchObject({ id: N });
    const vacio = new AbortAwareFakeSession([{ match: /update hoteles\.guest_note/i, respond: () => [] }]);
    await expect(new PostgresHuespedesRepository(vacio).archivarNota(P, G, N)).resolves.toBeNull();
    const sinMigrar = new AbortAwareFakeSession([{ match: /update hoteles\.guest_note/i, respond: () => pgError("42P01", "no existe") }]);
    await expect(new PostgresHuespedesRepository(sinMigrar).archivarNota(P, G, N)).rejects.toBeInstanceOf(HuespedesUnavailableError);
  });
});

describe("reglas puras", () => {
  const stay = (status: GuestStayRow["status"], i: string, o: string): GuestStayRow => ({ reservationId: i + o, status, checkInDate: i, checkOutDate: o, roomTypeName: null, roomCode: null, netAmountCents: 0 });

  it("resumirEstancias cuenta solo estancias efectivas y busca la proxima llegada confirmada", () => {
    const r = resumirEstancias(
      [stay("cerrada", "2026-01-01", "2026-01-03"), stay("check_out", "2026-06-10", "2026-06-11"), stay("cancelada", "2026-07-01", "2026-07-09"), stay("confirmada", "2027-02-01", "2027-02-03"), stay("confirmada", "2027-01-01", "2027-01-02")],
      "2026-12-02",
    );
    expect(r).toEqual({ stays: 2, nights: 3, lastStay: "2026-06-10", nextArrival: "2027-01-01" });
    expect(resumirEstancias([], "2026-12-02")).toEqual({ stays: 0, nights: 0, lastStay: null, nextArrival: null });
  });

  it("claveTelefono une el formato de WhatsApp con el del mostrador (ultimos 10 digitos) y rechaza lo corto", () => {
    expect(claveTelefono("5215511112222")).toBe("5511112222");
    expect(claveTelefono("+52 (55) 1111-2222")).toBe("5511112222");
    expect(claveTelefono("12345")).toBeNull();
    expect(claveTelefono(null)).toBeNull();
  });

  it("notaTieneDatoSensible detecta 13 a 19 digitos aunque vengan con espacios o guiones", () => {
    expect(notaTieneDatoSensible("Tarjeta 4111 1111 1111 1111")).toBe(true);
    expect(notaTieneDatoSensible("Pasaporte 1234-5678-9012-345")).toBe(true);
    expect(notaTieneDatoSensible("Habitacion 1203, ext 2200, vuelo AM 405")).toBe(false);
  });
});

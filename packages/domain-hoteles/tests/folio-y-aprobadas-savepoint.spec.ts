// H-P3-01 / H-P3-02 -- REGLA DURA de compatibilidad con la base sin migrar, contra el repositorio Postgres REAL +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion: tras un error toda consulta lanza 25P02 salvo
// ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve.
import { describe, expect, it } from "vitest";
import { FolioCerradoError, FolioCierreSaldoError, PostgresHotelesRepository, translateFolioTriggerError } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const O = "00000000-0000-0000-0000-0000000000a0";
const F = "00000000-0000-0000-0000-0000000000f1";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const after = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

describe("aprobadas por aplicar (H-P3-02) con la base sin la migracion 029", () => {
  it("42P01 -> lista vacia honesta y la sesion sigue utilizable (SAVEPOINT real), nunca 25P02", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.rate_recommendation/i, respond: () => pgError("42P01", 'relation "hoteles.rate_recommendation" does not exist') },
      after,
    ]);
    const repo = new PostgresHotelesRepository(session);
    expect(await repo.listApprovedRateRecommendationsAsSystem(P, "2026-10-04")).toEqual([]);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.rate_recommendation/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresHotelesRepository(session).listApprovedRateRecommendationsAsSystem(P, "2026-10-04")).rejects.toMatchObject({ code: "57014" });
  });
});

describe("folio cerrado (H-P3-01): el rechazo de los triggers de la 045 se traduce a errores de dominio", () => {
  const charge = { organizationId: O, propertyId: P, folioId: F, description: "x", amount: 1, taxAmount: 0, concept: "extras" as const };

  it("insertCharge / insertPayment: P0001 folio_cerrado -> FolioCerradoError", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into hoteles\.charge/i, respond: () => pgError("P0001", `folio_cerrado: el folio ${F} esta cerrado y no admite nuevos movimientos`) },
      { match: /insert into hoteles\.payment/i, respond: () => pgError("P0001", `folio_cerrado: el folio ${F} esta cerrado y no admite nuevos movimientos`) },
    ]);
    const repo = new PostgresHotelesRepository(session);
    await expect(repo.insertCharge(charge)).rejects.toBeInstanceOf(FolioCerradoError);
  });

  it("insertPayment: P0001 folio_cerrado -> FolioCerradoError", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.payment/i, respond: () => pgError("P0001", "folio_cerrado: x") }]);
    await expect(new PostgresHotelesRepository(session).insertPayment({ organizationId: O, propertyId: P, folioId: F, amount: 1, method: "efectivo", status: "capturado" })).rejects.toBeInstanceOf(FolioCerradoError);
  });

  it("closeFolio: 0 filas (ya cerrado por otro) -> FolioCerradoError; el UPDATE lleva la guarda status = 'abierto'", async () => {
    let sqlVisto = "";
    const session = new AbortAwareFakeSession([{ match: /update hoteles\.folio/i, respond: () => [] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => {
      sqlVisto = sql;
      return original(sql, params);
    }) as typeof session.query;
    await expect(new PostgresHotelesRepository(session).closeFolio(F, "saldo_cero", null)).rejects.toBeInstanceOf(FolioCerradoError);
    expect(sqlVisto).toMatch(/where id = \$3 and status = 'abierto'\s+returning id/);
  });

  it("closeFolio: P0001 cierre_saldo_distinto_de_cero -> FolioCierreSaldoError", async () => {
    const session = new AbortAwareFakeSession([{ match: /update hoteles\.folio/i, respond: () => pgError("P0001", "cierre_saldo_distinto_de_cero: el folio x tiene saldo 116") }]);
    await expect(new PostgresHotelesRepository(session).closeFolio(F, "saldo_cero", null)).rejects.toBeInstanceOf(FolioCierreSaldoError);
  });

  it("un error que NO es de estos triggers se relanza intacto", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into hoteles\.charge/i, respond: () => pgError("23503", "violates foreign key constraint") }]);
    await expect(new PostgresHotelesRepository(session).insertCharge(charge)).rejects.toMatchObject({ code: "23503" });
  });

  it("translateFolioTriggerError ignora errores ajenos (otro SQLSTATE, mensaje distinto, valores raros)", () => {
    expect(translateFolioTriggerError(pgError("23505", "folio_cerrado: x"))).toBeNull();
    expect(translateFolioTriggerError(pgError("P0001", "otra_cosa: x"))).toBeNull();
    expect(translateFolioTriggerError(new Error("folio_cerrado: sin SQLSTATE"))).toBeNull();
    expect(translateFolioTriggerError(null)).toBeNull();
    expect(translateFolioTriggerError("folio_cerrado")).toBeNull();
  });
});

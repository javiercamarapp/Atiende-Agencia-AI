// Migración 036 -- adaptador Postgres de aprobación de datos de empresa contra la base SIN migrar (42703/42883) y
// contra el rechazo de rol de la función (42501), con AbortAwareFakeSession: una sesión plana NO reproduce el estado
// abortado de la transacción única del request (25P02), que es justo lo que hay que ejercitar.
import { describe, expect, it } from "vitest";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const ITEM = "00000000-0000-0000-0000-0000000000b1";
const ACTOR = "00000000-0000-0000-0000-0000000000c1";

function pgError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingColumn = () => pgError("42703", 'column "proposed_by" does not exist');
const missingFunction = () => pgError("42883", "function licitaciones.decide_company_item(uuid, uuid, text, uuid, text) does not exist");

const rateLegacy = { id: ITEM, concept: "c", unit_price: "10.00", approval_status: "aprobado", valid_from: "2026-01-01", valid_until: null };

describe("listas de datos de empresa contra la base sin migrar", () => {
  it("tarifas: 42703 cae a la consulta anterior con la sesión RECUPERADA", async () => {
    const session = new AbortAwareFakeSession([
      { match: /proposed_by.*from licitaciones\.approved_rate/s, respond: missingColumn },
      { match: /from licitaciones\.approved_rate/, respond: () => [rateLegacy] },
    ]);
    const rates = await new PostgresLicitacionesRepository(session).listAllApprovedRates(ORG);
    expect(rates).toHaveLength(1);
    expect(rates[0]!.proposedBy).toBeUndefined();
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("firmantes: sin columna approval_status un firmante existente cuenta como 'aprobado'", async () => {
    const session = new AbortAwareFakeSession([
      { match: /approval_status.*from licitaciones\.company_signer/s, respond: () => pgError("42703", 'column "approval_status" does not exist') },
      { match: /from licitaciones\.company_signer/, respond: () => [{ id: ITEM, name: "Ana", role: "rep", authorized: true }] },
    ]);
    const signers = await new PostgresLicitacionesRepository(session).listCompanySigners(ORG);
    expect(signers[0]).toMatchObject({ approvalStatus: "aprobado", authorized: true });
  });

  it("base migrada: devuelve autoría y estado", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from licitaciones\.company_capability/, respond: () => [{ id: ITEM, name: "n", description: "d", evidence_doc_id: null, approval_status: "pendiente_aprobacion", proposed_by: ACTOR, approved_by: null, approved_at: null }] },
    ]);
    const [cap] = await new PostgresLicitacionesRepository(session).listCompanyCapabilities(ORG);
    expect(cap).toMatchObject({ approvalStatus: "pendiente_aprobacion", proposedBy: ACTOR, approvedBy: null });
  });
});

describe("updateApprovedRate contra la base sin migrar (DB-03 en la misma sentencia)", () => {
  it("42703 en la sentencia nueva cae a la sentencia que regresa a pendiente cuando cambia el dato", async () => {
    const session = new AbortAwareFakeSession([
      { match: /proposed_by, approved_by/, respond: missingColumn },
      { match: /case when \(unit_price is distinct from/, respond: () => [{ ...rateLegacy, approval_status: "pendiente_aprobacion" }] },
      { match: /record_field_provenance/, respond: () => [{ record_field_provenance: 2 }] },
    ]);
    const rate = await new PostgresLicitacionesRepository(session).updateApprovedRate(ORG, ITEM, { unitPrice: "20.00" });
    expect(rate.approvalStatus).toBe("pendiente_aprobacion");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });
});

describe("decideCompanyItem", () => {
  const input = { kind: "rate", itemId: ITEM, decision: "aprobado", actorId: ACTOR, actorRole: "owner" } as const;

  it("base migrada: devuelve el resultado de la función SQL", async () => {
    for (const outcome of ["ok", "not_found", "conflict", "autor"] as const) {
      const session = new AbortAwareFakeSession([{ match: /licitaciones\.decide_company_item/, respond: () => [{ outcome }] }]);
      expect(await new PostgresLicitacionesRepository(session).decideCompanyItem(ORG, input)).toBe(outcome);
    }
  });

  it("la función rechaza el rol (42501): resultado 'rol' y sesión recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /licitaciones\.decide_company_item/, respond: () => pgError("42501", "decide_company_item: rol sin permiso de decision") },
      { match: /select 1/, respond: () => [] },
    ]);
    expect(await new PostgresLicitacionesRepository(session).decideCompanyItem(ORG, input)).toBe("rol");
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] }); // sesión utilizable: nada de 25P02
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("base sin migrar (42883): transición condicional anterior, con el rol validado en TypeScript", async () => {
    const session = new AbortAwareFakeSession([
      { match: /licitaciones\.decide_company_item/, respond: missingFunction },
      { match: /update licitaciones\.approved_rate set approval_status = \$1/, respond: () => [{ id: ITEM }] },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    expect(await repo.decideCompanyItem(ORG, input)).toBe("ok");
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(await repo.decideCompanyItem(ORG, { ...input, actorRole: "analyst" })).toBe("rol");
  });

  it("base sin migrar: una decisión que ya no encuentra fila pendiente distingue 'conflict' de 'not_found'", async () => {
    const make = (exists: boolean) =>
      new AbortAwareFakeSession([
        { match: /licitaciones\.decide_company_item/, respond: missingFunction },
        { match: /update licitaciones\.approved_rate/, respond: () => [] },
        { match: /select id from licitaciones\.approved_rate/, respond: () => (exists ? [{ id: ITEM }] : []) },
      ]);
    expect(await new PostgresLicitacionesRepository(make(true)).decideCompanyItem(ORG, input)).toBe("conflict");
    expect(await new PostgresLicitacionesRepository(make(false)).decideCompanyItem(ORG, input)).toBe("not_found");
  });

  it("base sin migrar: los firmantes no tenían aprobación -> 'no_disponible' (nunca un 500)", async () => {
    const session = new AbortAwareFakeSession([{ match: /licitaciones\.decide_company_item/, respond: missingFunction }]);
    expect(await new PostgresLicitacionesRepository(session).decideCompanyItem(ORG, { ...input, kind: "signer" })).toBe("no_disponible");
  });
});

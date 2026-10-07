// Migracion 040 -- adaptador Postgres del perfil completo y de la procedencia contra la base SIN migrar (42P01/42703/42883) y contra
// un fallo REAL de la procedencia, con AbortAwareFakeSession: una sesion plana NO reproduce el estado abortado de la transaccion unica
// del request (25P02), que es justo lo que hay que ejercitar.
import { describe, expect, it } from "vitest";
import { PostgresLicitacionesRepository } from "../src/postgres-repository.ts";
import { CompanyProfileNotAvailableError } from "../src/errors.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const ID = "00000000-0000-0000-0000-0000000000b1";

function pgError(code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const missingTable = (name: string) => () => pgError("42P01", `relation "licitaciones.${name}" does not exist`);
const authCols = { approval_status: "pendiente_aprobacion", proposed_by: "u1", approved_by: null, approved_at: null };
const locationRow = { id: ID, kind: "matriz", name: "Matriz", state: "Yucatán", municipality: null, address: null, ...authCols };

describe("lecturas contra la base sin migrar: vacio honesto, sesion recuperada", () => {
  it("listas vacias y perfil null cuando faltan las tablas (42P01)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /company_profile/, respond: missingTable("company_profile") },
      { match: /company_product_service/, respond: missingTable("company_product_service") },
      { match: /company_location/, respond: missingTable("company_location") },
      { match: /company_restriction/, respond: missingTable("company_restriction") },
      { match: /company_stakeholder/, respond: missingTable("company_stakeholder") },
      { match: /field_provenance/, respond: missingTable("field_provenance") },
    ]);
    const repo = new PostgresLicitacionesRepository(session);
    expect(await repo.getCompanyProfile(ORG)).toBeNull();
    expect(await repo.listCompanyProductsServices(ORG)).toEqual([]);
    expect(await repo.listCompanyLocations(ORG)).toEqual([]);
    expect(await repo.listCompanyRestrictions(ORG)).toEqual([]);
    expect(await repo.listCompanyStakeholders(ORG)).toEqual([]);
    expect(await repo.listFieldProvenance(ORG)).toEqual([]);
    // Cada fallo se recupero con ROLLBACK TO SAVEPOINT: la siguiente lectura no recibio 25P02.
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(6);
  });

  it("firmantes: la consulta con vigencia (040) cae a la de la 036 y esta a la original, siempre con la sesion recuperada", async () => {
    const session = new AbortAwareFakeSession([
      { match: /valid_from/, respond: () => pgError("42703", 'column "valid_from" does not exist') },
      { match: /proposed_by/, respond: () => pgError("42703", 'column "proposed_by" does not exist') },
      { match: /from licitaciones\.company_signer/, respond: () => [{ id: ID, name: "Ana", role: "rep", authorized: true }] },
    ]);
    const [signer] = await new PostgresLicitacionesRepository(session).listCompanySigners(ORG);
    expect(signer).toMatchObject({ approvalStatus: "aprobado", authorized: true });
    expect(signer!.validFrom).toBeUndefined();
  });

  it("firmantes con la base migrada: trae vigencia, documento de identidad y limites", async () => {
    const session = new AbortAwareFakeSession([
      { match: /valid_from/, respond: () => [{ id: ID, name: "Ana", role: "rep", authorized: true, approval_status: "aprobado", proposed_by: null, approved_by: null, approved_at: null, valid_from: "2026-01-01", valid_until: "2026-12-31", identity_doc_id: ID, action_limits: "hasta 1 mdp" }] },
    ]);
    const [signer] = await new PostgresLicitacionesRepository(session).listCompanySigners(ORG);
    expect(signer).toMatchObject({ validFrom: "2026-01-01", validUntil: "2026-12-31", identityDocId: ID, actionLimits: "hasta 1 mdp" });
  });
});

describe("escrituras contra la base sin migrar: 'no disponible aun', nunca un 500 ni un dato descartado en silencio", () => {
  it("crear una ubicacion sin la tabla lanza CompanyProfileNotAvailableError con la sesion recuperada", async () => {
    const session = new AbortAwareFakeSession([{ match: /insert into licitaciones\.company_location/, respond: missingTable("company_location") }]);
    await expect(new PostgresLicitacionesRepository(session).createCompanyLocation(ORG, { kind: "matriz", name: "Matriz", state: "Yucatán" })).rejects.toBeInstanceOf(CompanyProfileNotAvailableError);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("crear un firmante CON vigencia sin las columnas lanza NotAvailable; SIN vigencia sigue el camino anterior", async () => {
    const sinColumnas = () => pgError("42703", 'column "valid_from" of relation "company_signer" does not exist');
    const conVigencia = new AbortAwareFakeSession([
      { match: /select id from licitaciones\.company_signer/, respond: () => [] },
      { match: /insert into licitaciones\.company_signer.*valid_from/s, respond: sinColumnas },
    ]);
    await expect(new PostgresLicitacionesRepository(conVigencia).createCompanySigner(ORG, { name: "Ana", role: "rep", validFrom: "2026-01-01" })).rejects.toBeInstanceOf(CompanyProfileNotAvailableError);

    const sinVigencia = new AbortAwareFakeSession([
      { match: /select id from licitaciones\.company_signer/, respond: () => [] },
      { match: /insert into licitaciones\.company_signer.*valid_from/s, respond: sinColumnas },
      { match: /insert into licitaciones\.company_signer.*approval_status/s, respond: () => [{ id: ID, name: "Ana", role: "rep", authorized: false, approval_status: "pendiente_aprobacion" }] },
      { match: /record_field_provenance/, respond: () => pgError("42883", "function licitaciones.record_field_provenance(uuid, uuid, unknown, uuid, text[], unknown) does not exist") },
    ]);
    const signer = await new PostgresLicitacionesRepository(sinVigencia).createCompanySigner(ORG, { name: "Ana", role: "rep" });
    expect(signer.approvalStatus).toBe("pendiente_aprobacion");
  });
});

describe("procedencia en la MISMA sesion que el dato (REQ-142)", () => {
  it("alta: primero el insert y despues record_field_provenance con los campos escritos, ambos en la misma sesion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into licitaciones\.company_location/, respond: () => [locationRow] },
      { match: /record_field_provenance/, respond: () => [{ record_field_provenance: 4 }] },
    ]);
    const loc = await new PostgresLicitacionesRepository(session).createCompanyLocation(ORG, { kind: "matriz", name: "Matriz", state: "Yucatán", actorId: "u1" });
    expect(loc.id).toBe(ID);
    const insertAt = session.calls.findIndex((c) => /insert into licitaciones\.company_location/.test(c));
    const provenanceAt = session.calls.findIndex((c) => /record_field_provenance/.test(c));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(provenanceAt).toBeGreaterThan(insertAt);
  });

  it("si la procedencia falla con un error REAL de Postgres, el error SUBE (no se traga): la transaccion del request se revierte con el dato", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into licitaciones\.company_location/, respond: () => [locationRow] },
      { match: /record_field_provenance/, respond: () => pgError("42501", "record_field_provenance: rol sin permiso de escritura") },
    ]);
    await expect(new PostgresLicitacionesRepository(session).createCompanyLocation(ORG, { kind: "matriz", name: "Matriz", state: "Yucatán" })).rejects.toMatchObject({ code: "42501" });
  });

  it("la procedencia pasa los campos escritos al llamar la funcion (el '*' lo agrega la propia funcion)", async () => {
    const captured: unknown[][] = [];
    const session: AbortAwareFakeSession = new AbortAwareFakeSession([
      { match: /insert into licitaciones\.company_stakeholder/, respond: () => [{ id: ID, kind: "socio", full_name: "Ana", rfc: null, participation_pct: "50.00", ...authCols }] },
      { match: /record_field_provenance/, respond: () => [{ n: 1 }] },
    ]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params: unknown[] = []) => {
      if (/record_field_provenance/.test(sql)) captured.push(params);
      return original(sql, params);
    }) as typeof session.query;
    await new PostgresLicitacionesRepository(session).createCompanyStakeholder(ORG, { kind: "socio", fullName: "Ana", participationPct: "50.00" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual([ORG, "stakeholder", ID, ["kind", "fullName", "participationPct"], "manual"]);
  });
});

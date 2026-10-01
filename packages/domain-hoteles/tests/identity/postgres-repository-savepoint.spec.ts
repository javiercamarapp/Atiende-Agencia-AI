// REGLA DURA de compatibilidad con la base sin migrar: `dbSession` es UNA transaccion por
// request, y un error de Postgres la deja ABORTADA (25P02). Estos tests usan
// AbortAwareFakeSession (reproduce el estado abortado; una sesion falsa plana NO sirve)
// con el PostgresIdentityRepository REAL: la migracion 031 no aplicada (42P01/42883/42703)
// debe degradar sin romper la transaccion compartida.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IdentityAccessDeniedError,
  IdentityConflictError,
  IdentityDoubleControlError,
  IdentityInvalidInputError,
  IdentityPurgedError,
  IdentityUnavailableError,
} from "../../src/identity/errors.ts";
import { PostgresIdentityRepository, mapIdentityPgError } from "../../src/identity/postgres-repository.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const tableMissing = () => pgError("42P01", 'relation "hoteles.identity_vault" does not exist');
const functionMissing = (fn: string, sig: string) => pgError("42883", `function hoteles.${fn}(${sig}) does not exist`);
const PROPERTY = randomUUID();
const ID = randomUUID();

describe("PostgresIdentityRepository -- base sin la migracion 031 (AbortAwareFakeSession)", () => {
  it("LECTURA con 42P01: degrada a vacio 'no disponible aun' y la sesion queda UTILIZABLE (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.identity_vault/, respond: () => tableMissing() },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresIdentityRepository(session);
    expect(await repo.listIdentities(PROPERTY, { limit: 10 })).toEqual({ available: false, items: [] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    // Consulta ajena en la MISMA sesion: con un try/catch simple fallaria con 25P02.
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("las demas lecturas (bitacora, solicitudes, registro migratorio, find) tambien degradan sin abortar", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.identity_access_log/, respond: () => tableMissing() },
      { match: /from hoteles\.identity_purge_request/, respond: () => tableMissing() },
      { match: /from hoteles\.migratory_registration/, respond: () => pgError("42703", 'column "status" does not exist') },
      { match: /from hoteles\.identity_vault/, respond: () => tableMissing() },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresIdentityRepository(session);
    expect(await repo.listAccessLog(PROPERTY, { limit: 5 })).toEqual({ available: false, items: [] });
    expect(await repo.listPurgeRequests(PROPERTY, { limit: 5 })).toEqual({ available: false, items: [] });
    expect(await repo.findPurgeRequest(PROPERTY, ID)).toBeNull();
    expect(await repo.listMigratoryRegistrations(PROPERTY, { limit: 5 })).toEqual({ available: false, items: [] });
    expect(await repo.findIdentity(PROPERTY, ID)).toBeNull();
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("ESCRITURA con 42P01/42883: lanza IdentityUnavailableError (503) y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into hoteles\.identity_vault/, respond: () => tableMissing() },
      { match: /hoteles\.reveal_identity/, respond: () => functionMissing("reveal_identity", "uuid, text") },
      { match: /hoteles\.decide_identity_purge/, respond: () => functionMissing("decide_identity_purge", "uuid, boolean, text") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresIdentityRepository(session);
    await expect(
      repo.captureIdentity({
        id: ID, propertyId: PROPERTY, guestId: randomUUID(), reservationId: null, documentType: "ine", nationality: null, documentLast4: null,
        payloadEnc: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVy", keyVersion: 1, retentionUntil: "2027-01-01", actorUserId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(repo.revealIdentity(ID, "motivo suficientemente largo", randomUUID())).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(repo.decidePurge(ID, true, null, randomUUID())).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error NO recuperable (no es migracion pendiente) se repropaga mapeado y tambien deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.decide_identity_purge/, respond: () => pgError("42501", "doble_control: quien solicita la purga no puede aprobarla ni rechazarla") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresIdentityRepository(session);
    await expect(repo.decidePurge(ID, true, null, randomUUID())).rejects.toBeInstanceOf(IdentityDoubleControlError);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("camino feliz: revealIdentity lee out_payload_enc/out_key_version de la funcion", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.reveal_identity/, respond: () => [{ out_payload_enc: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVy", out_key_version: 1 }] },
    ]);
    expect(await new PostgresIdentityRepository(session).revealIdentity(ID, "motivo suficientemente largo", randomUUID())).toEqual({
      envelope: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVy",
      keyVersion: 1,
    });
  });
});

describe("mapIdentityPgError", () => {
  it("traduce los errores de las funciones/triggers de la migracion 031", () => {
    expect(mapIdentityPgError(pgError("42501", "identidad no disponible"), "reveal")).toBeInstanceOf(IdentityAccessDeniedError);
    expect(mapIdentityPgError(pgError("42501", "new row violates row-level security policy"), "capture")).toBeInstanceOf(IdentityAccessDeniedError);
    expect(mapIdentityPgError(pgError("42501", "doble_control: x"), "d")).toBeInstanceOf(IdentityDoubleControlError);
    expect(mapIdentityPgError(pgError("P0001", "identidad_purgada: x"), "r")).toBeInstanceOf(IdentityPurgedError);
    expect(mapIdentityPgError(pgError("42501", "identidad_purgada: una identidad purgada es inmutable"), "r")).toBeInstanceOf(IdentityPurgedError);
    expect(mapIdentityPgError(pgError("22023", "motivo_invalido: el motivo debe tener entre 10 y 300 caracteres"), "r")).toMatchObject({ name: "IdentityInvalidInputError", message: "el motivo debe tener entre 10 y 300 caracteres" });
    expect(mapIdentityPgError(pgError("23503", "guest_invalido: el huesped no pertenece a la property"), "c")).toBeInstanceOf(IdentityInvalidInputError);
    expect(mapIdentityPgError(pgError("23505", 'duplicate key value violates unique constraint "identity_purge_request_one_pending_idx"'), "p")).toBeInstanceOf(IdentityConflictError);
    expect(mapIdentityPgError(pgError("42501", "registro_migratorio: un registro ya reportado no se modifica"), "m")).toBeInstanceOf(IdentityConflictError);
  });
  it("un error desconocido se repropaga tal cual (nunca se enmascara)", () => {
    const weird = pgError("XX000", "boom");
    expect(mapIdentityPgError(weird, "x")).toBe(weird);
  });
});

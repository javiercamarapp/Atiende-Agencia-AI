// REGLA DURA de compatibilidad con la base sin migrar (migracion 032 = bloqueo previo a la purga).
// `dbSession` es UNA transaccion por request: un error de Postgres la deja ABORTADA (25P02).
// AbortAwareFakeSession reproduce ese estado; una sesion falsa plana NO sirve. Cubre una base
// con 031 pero SIN 032 (42703/42883) usando el PostgresIdentityRepository REAL.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityBlockedError, IdentityConflictError, IdentityUnavailableError } from "../../src/identity/errors.ts";
import { PostgresIdentityRepository, mapIdentityPgError } from "../../src/identity/postgres-repository.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const PROPERTY = randomUUID();
const ID = randomUUID();
const columnMissing = () => pgError("42703", 'column "blocked_at" does not exist');
const legacyRow = {
  id: ID, property_id: PROPERTY, guest_id: randomUUID(), reservation_id: null, document_type: "ine", nationality: "MEX", document_last4: "1234", key_version: 1,
  status: "activo", retention_until: "2026-05-01", verified_at: null, verified_by: null, captured_by: null, created_at: "2026-04-01T00:00:00Z", purged_at: null,
};
// Una consulta de la boveda que NO menciona las columnas de bloqueo = la version de 031.
const LEGACY_VAULT = /^(?![\s\S]*blocked_at)[\s\S]*hoteles\.identity_vault/i;
const EXTENDED_VAULT = /blocked_at[\s\S]*hoteles\.identity_vault|hoteles\.identity_vault[\s\S]*blocked_at/i;

describe("PostgresIdentityRepository -- base con 031 pero SIN 032 (AbortAwareFakeSession)", () => {
  it("LECTURA con 42703 por las columnas de bloqueo: repite con las columnas de 031, devuelve la identidad con bloqueo en null y la sesion queda utilizable (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: EXTENDED_VAULT, respond: () => columnMissing() },
      { match: LEGACY_VAULT, respond: () => [legacyRow] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresIdentityRepository(session);
    const list = await repo.listIdentities(PROPERTY, { limit: 10 });
    expect(list.available).toBe(true);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id: ID, status: "activo", blockedAt: null, blockedUntil: null, blockWindowDays: null, blockReason: null, blockedBy: null });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(await repo.findIdentity(PROPERTY, ID)).toMatchObject({ id: ID, blockReason: null });
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("con 032 aplicada la lectura trae las columnas de bloqueo (camino primario)", async () => {
    const session = new AbortAwareFakeSession([
      { match: EXTENDED_VAULT, respond: () => [{ ...legacyRow, status: "bloqueada", blocked_at: "2026-04-02T00:00:00Z", blocked_until: "2026-04-09T00:00:00Z", block_window_days: 7, block_reason: "retencion_vencida", blocked_by: null }] },
    ]);
    const found = await new PostgresIdentityRepository(session).findIdentity(PROPERTY, ID);
    expect(found).toMatchObject({ status: "bloqueada", blockWindowDays: 7, blockReason: "retencion_vencida", blockedUntil: "2026-04-09T00:00:00Z" });
  });

  it("ESCRITURA (captura) con 42703 en el RETURNING: repite con las columnas de 031 y la captura SI se guarda", async () => {
    const session = new AbortAwareFakeSession([
      { match: /insert into hoteles\.identity_vault[\s\S]*blocked_at/i, respond: () => columnMissing() },
      { match: /insert into hoteles\.identity_vault/i, respond: () => [legacyRow] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const rec = await new PostgresIdentityRepository(session).captureIdentity({
      id: ID, propertyId: PROPERTY, guestId: randomUUID(), reservationId: null, documentType: "ine", nationality: "MEX", documentLast4: "1234",
      payloadEnc: "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVy", keyVersion: 1, retentionUntil: "2026-05-01", actorUserId: randomUUID(),
    });
    expect(rec).toMatchObject({ id: ID, status: "activo", blockedAt: null });
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("sweepRetention con 42883 (sin la funcion de 032): cae al camino anterior (purge_expired_identities de 031) y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /sweep_identity_retention/, respond: () => pgError("42883", "function hoteles.sweep_identity_retention(uuid, date) does not exist") },
      { match: /purge_expired_identities/, respond: () => [{ n: 2 }] },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const result = await new PostgresIdentityRepository(session).sweepRetention(PROPERTY, "2026-04-01");
    expect(result).toEqual({ blocked: 0, purged: 2, viaBloqueo: false });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("sweepRetention con 032: bloquea y purga via la funcion nueva (viaBloqueo = true)", async () => {
    const session = new AbortAwareFakeSession([{ match: /sweep_identity_retention/, respond: () => [{ out_blocked: 3, out_purged: 1 }] }]);
    expect(await new PostgresIdentityRepository(session).sweepRetention(PROPERTY, "2026-04-01")).toEqual({ blocked: 3, purged: 1, viaBloqueo: true });
  });

  it("sweepRetention sin NINGUNA de las dos funciones (ni 031): IdentityUnavailableError (el cron lo reporta como omitida)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /sweep_identity_retention/, respond: () => pgError("42883", "function hoteles.sweep_identity_retention(uuid, date) does not exist") },
      { match: /purge_expired_identities/, respond: () => pgError("42883", "function hoteles.purge_expired_identities(uuid, date) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresIdentityRepository(session).sweepRetention(PROPERTY, "2026-04-01")).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("revealBlockedIdentity sin 032 (42883): IdentityUnavailableError (503) y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /reveal_blocked_identity/, respond: () => pgError("42883", "function hoteles.reveal_blocked_identity(uuid) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresIdentityRepository(session).revealBlockedIdentity(ID, randomUUID())).rejects.toBeInstanceOf(IdentityUnavailableError);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("mapIdentityPgError -- errores de 032", () => {
  it("traduce el bloqueo y las guardas de datos", () => {
    expect(mapIdentityPgError(pgError("P0001", "identidad_bloqueada: la identidad esta bloqueada"), "reveal")).toBeInstanceOf(IdentityBlockedError);
    expect(mapIdentityPgError(pgError("42501", "identidad_bloqueada: el bloqueo no se revierte"), "x")).toBeInstanceOf(IdentityBlockedError);
    for (const msg of ["purga_sin_bloqueo: una identidad solo se purga despues de su ventana", "bloqueo_vigente: la ventana de bloqueo aun no vence", "retencion_legal: la identidad tiene una retencion legal activa"]) {
      expect(mapIdentityPgError(pgError("42501", msg), "purge")).toBeInstanceOf(IdentityConflictError);
    }
    expect(mapIdentityPgError(pgError("P0001", "acceso_no_vigente: la aprobacion no esta vigente"), "reveal-blocked")).toBeInstanceOf(IdentityConflictError);
  });
});

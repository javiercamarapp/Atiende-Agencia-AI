// REGLA DURA de compatibilidad con la base sin migrar: `dbSession` es UNA transaccion por request y
// un error de Postgres la deja ABORTADA (25P02). Estos tests usan AbortAwareFakeSession (reproduce el
// estado abortado; una sesion falsa plana NO sirve) con el PostgresPrivacyRepository REAL: la
// migracion 032 no aplicada (42P01/42883/42703) debe degradar sin romper la transaccion compartida.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityBlockedError, IdentityPurgedError } from "../../src/identity/errors.ts";
import { PostgresPrivacyRepository, mapPrivacyPgError } from "../../src/privacy/postgres-repository.ts";
import { PrivacyAccessDeniedError, PrivacyConflictError, PrivacyDoubleControlError, PrivacyInvalidInputError, PrivacyUnavailableError } from "../../src/privacy/errors.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const tableMissing = (t: string) => pgError("42P01", `relation "hoteles.${t}" does not exist`);
const fnMissing = (fn: string) => pgError("42883", `function hoteles.${fn}(uuid) does not exist`);
const PROPERTY = randomUUID();
const ID = randomUUID();
const USER = randomUUID();
const ping = { match: /select 1/, respond: () => [{ ok: 1 }] };

describe("PostgresPrivacyRepository -- base sin la migracion 032 (AbortAwareFakeSession)", () => {
  it("LECTURAS con 42P01: degradan a vacio 'no disponible aun' y la sesion queda UTILIZABLE (nunca 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.privacy_notice/, respond: () => tableMissing("privacy_notice") },
      { match: /from hoteles\.identity_consent/, respond: () => tableMissing("identity_consent") },
      { match: /from hoteles\.arco_request/, respond: () => tableMissing("arco_request") },
      { match: /from hoteles\.privacy_incident/, respond: () => tableMissing("privacy_incident") },
      { match: /from hoteles\.legal_hold/, respond: () => tableMissing("legal_hold") },
      { match: /from hoteles\.identity_blocked_access_request/, respond: () => tableMissing("identity_blocked_access_request") },
      { match: /from hoteles\.privacy_event_log/, respond: () => pgError("42703", 'column "subject_type" does not exist') },
      { match: /from hoteles\.privacy_settings/, respond: () => tableMissing("privacy_settings") },
      ping,
    ]);
    const repo = new PostgresPrivacyRepository(session);
    const empty = { available: false, items: [] };
    expect(await repo.listNotices(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.listConsents(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.listArco(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.listIncidents(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.listLegalHolds(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.listBlockedAccess(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.listEvents(PROPERTY, { limit: 5 })).toEqual(empty);
    expect(await repo.findArco(PROPERTY, ID)).toBeNull();
    expect(await repo.findNotice(PROPERTY, ID)).toBeNull();
    expect(await repo.getSettings(PROPERTY)).toEqual({ available: false, settings: { blockWindowDays: 7, isDefault: true, updatedBy: null, updatedAt: null } });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBeGreaterThanOrEqual(10);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("ESCRITURAS con 42883/42P01: lanzan PrivacyUnavailableError (503) y la sesion queda utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.open_arco_request/, respond: () => fnMissing("open_arco_request") },
      { match: /hoteles\.publish_privacy_notice/, respond: () => fnMissing("publish_privacy_notice") },
      { match: /hoteles\.report_privacy_incident/, respond: () => fnMissing("report_privacy_incident") },
      { match: /hoteles\.place_legal_hold/, respond: () => fnMissing("place_legal_hold") },
      { match: /hoteles\.block_identity/, respond: () => fnMissing("block_identity") },
      { match: /hoteles\.request_blocked_access/, respond: () => fnMissing("request_blocked_access") },
      { match: /insert into hoteles\.identity_consent/, respond: () => tableMissing("identity_consent") },
      ping,
    ]);
    const repo = new PostgresPrivacyRepository(session);
    await expect(repo.openArco(PROPERTY, { rightType: "acceso", requesterName: "Juan Perez", requesterContact: null, channel: "correo", description: null, receivedOn: "2026-03-01", guestId: null, vaultId: null }, USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(repo.publishNotice(PROPERTY, { version: "v1", simplifiedText: "x".repeat(30), integralUrl: null, mandatoryPurposes: ["identificar"], optionalPurposes: [], contentSha256: null }, USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(repo.reportIncident(PROPERTY, { incidentType: "otro", severity: "baja", title: "Titulo", description: "Descripcion larga", detectedAt: "2026-03-01T00:00:00Z", affectedCount: null, significantRisk: false }, USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(repo.placeLegalHold({ vaultId: ID, folio: "CASO-1", reason: "Motivo suficiente", authorizationRef: "Direccion", incidentId: null }, USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(repo.blockIdentity(ID, "Motivo suficiente para bloquear", USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(repo.requestBlockedAccess(ID, "Motivo suficiente para el acceso", USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(repo.recordConsent(PROPERTY, { id: ID, guestId: ID, vaultId: null, noticeId: ID, acceptedMandatory: ["identificar"], acceptedOptional: [], channel: "mostrador", evidenceMethod: "casilla_electronica", sensitiveData: false }, USER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("un error NO recuperable se repropaga mapeado y tambien deja la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.decide_blocked_access/, respond: () => pgError("42501", "doble_control: quien solicita el acceso excepcional no puede aprobarlo ni rechazarlo") },
      { match: /hoteles\.advance_arco_request/, respond: () => pgError("P0001", "estado_invalido: no se puede pasar de recibida a ejecutada") },
      ping,
    ]);
    const repo = new PostgresPrivacyRepository(session);
    await expect(repo.decideBlockedAccess(ID, true, null, USER)).rejects.toBeInstanceOf(PrivacyDoubleControlError);
    await expect(repo.advanceArco(ID, "ejecutada", "Nota suficiente de prueba", "2026-03-01", USER)).rejects.toBeInstanceOf(PrivacyConflictError);
    await expect(session.query("select 1 as ok")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("camino feliz: mapea filas (fechas como texto, arreglos) y devuelve el id/resultado de las funciones", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.open_arco_request/, respond: () => [{ id: ID }] },
      { match: /hoteles\.advance_arco_request/, respond: () => [{ result: "procedente" }] },
      { match: /hoteles\.update_privacy_incident/, respond: () => [{ result: "contenida" }] },
      { match: /hoteles\.decide_blocked_access/, respond: () => [{ result: "aprobada" }] },
      { match: /from hoteles\.privacy_settings/, respond: () => [{ block_window_days: 14, updated_by: USER, updated_at: "2026-03-01 10:00:00+00" }] },
      {
        match: /from hoteles\.arco_request/,
        respond: () => [{
          id: ID, property_id: PROPERTY, folio: "ARCO-20260301-ABC123", right_type: "acceso", guest_id: null, vault_id: null, requester_name: "Juan", requester_contact: null, channel: "correo",
          description: null, received_on: "2026-03-01", response_due_on: "2026-03-21", execution_due_on: null, status: "recibida", decided_on: null, decision_note: null,
          extension_phase: null, extension_reason: null, extended_at: null, extended_by: null, executed_at: null, created_by: USER, created_at: "2026-03-01 10:00:00+00",
        }],
      },
    ]);
    const repo = new PostgresPrivacyRepository(session);
    expect(await repo.openArco(PROPERTY, { rightType: "acceso", requesterName: "Juan", requesterContact: null, channel: "correo", description: null, receivedOn: "2026-03-01", guestId: null, vaultId: null }, USER)).toBe(ID);
    expect(await repo.advanceArco(ID, "procedente", "Nota suficiente de prueba", "2026-03-02", USER)).toBe("procedente");
    expect(await repo.updateIncident(ID, { action: "contener", note: null, channel: null, ref: null }, USER)).toBe("contenida");
    expect(await repo.decideBlockedAccess(ID, true, null, USER)).toBe("aprobada");
    expect(await repo.getSettings(PROPERTY)).toMatchObject({ available: true, settings: { blockWindowDays: 14, isDefault: false, updatedBy: USER } });
    const list = await repo.listArco(PROPERTY, { limit: 10 });
    expect(list.available).toBe(true);
    expect(list.items[0]).toMatchObject({ folio: "ARCO-20260301-ABC123", rightType: "acceso", responseDueOn: "2026-03-21", extensionPhase: null, status: "recibida" });
  });
});

describe("mapPrivacyPgError", () => {
  it("traduce los errores de las funciones/triggers de la migracion 032", () => {
    expect(mapPrivacyPgError(pgError("42501", "doble_control: x"), "d")).toBeInstanceOf(PrivacyDoubleControlError);
    expect(mapPrivacyPgError(pgError("42501", "identidad no disponible"), "d")).toBeInstanceOf(PrivacyAccessDeniedError);
    expect(mapPrivacyPgError(pgError("42501", "new row violates row-level security policy"), "d")).toBeInstanceOf(PrivacyAccessDeniedError);
    expect(mapPrivacyPgError(pgError("42501", "retencion_legal: la identidad tiene una retencion legal activa"), "d")).toBeInstanceOf(PrivacyConflictError);
    expect(mapPrivacyPgError(pgError("42501", "consentimiento_revocado: x"), "d")).toBeInstanceOf(PrivacyConflictError);
    expect(mapPrivacyPgError(pgError("P0001", "identidad_bloqueada: x"), "d")).toBeInstanceOf(IdentityBlockedError);
    expect(mapPrivacyPgError(pgError("P0001", "identidad_purgada: x"), "d")).toBeInstanceOf(IdentityPurgedError);
    expect(mapPrivacyPgError(pgError("P0001", "prorroga_agotada: la prorroga solo se puede usar una vez"), "d")).toMatchObject({ name: "PrivacyConflictError", message: "la prorroga solo se puede usar una vez" });
    expect(mapPrivacyPgError(pgError("22023", "ventana_invalida: la ventana de bloqueo debe estar entre 3 y 30 dias"), "d")).toMatchObject({ name: "PrivacyInvalidInputError", message: "la ventana de bloqueo debe estar entre 3 y 30 dias" });
    expect(mapPrivacyPgError(pgError("23503", "aviso_invalido: el aviso no pertenece a la property"), "d")).toBeInstanceOf(PrivacyInvalidInputError);
    expect(mapPrivacyPgError(pgError("23505", "duplicate key"), "d")).toBeInstanceOf(PrivacyConflictError);
    expect(mapPrivacyPgError(pgError("23514", "check"), "d")).toBeInstanceOf(PrivacyInvalidInputError);
  });
  it("un error desconocido se repropaga tal cual (nunca se enmascara)", () => {
    const weird = pgError("XX000", "boom");
    expect(mapPrivacyPgError(weird, "x")).toBe(weird);
  });
});

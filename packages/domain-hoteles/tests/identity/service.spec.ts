import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIdentityCipher } from "../../src/identity/cipher.ts";
import {
  IdentityAccessDeniedError,
  IdentityConflictError,
  IdentityDoubleControlError,
  IdentityInvalidInputError,
  IdentityPurgedError,
  IdentityRequestResolvedError,
  IdentityUnavailableError,
} from "../../src/identity/errors.ts";
import { InMemoryIdentityRepository } from "../../src/identity/in-memory-repository.ts";
import { IdentityVaultService, addDaysYmd, documentLast4, parseCaptureIdentityInput, parseReason } from "../../src/identity/service.ts";

const PROPERTY = randomUUID();
const OTHER_PROPERTY = randomUUID();
const GUEST = randomUUID();
const OWNER = randomUUID();
const GM = randomUUID();
const FRONTDESK = randomUUID();

function setup(withKey = true) {
  const repo = new InMemoryIdentityRepository();
  repo.seedGuest(PROPERTY, GUEST);
  const cipher = withKey ? createIdentityCipher(randomBytes(32), 1) : null;
  return { repo, service: new IdentityVaultService(repo, cipher) };
}

const rawInput = () => ({
  guestId: GUEST,
  documentType: "pasaporte",
  nationality: "usa",
  fullName: "  Ana Torres  ",
  documentNumber: "G-1234 5678",
  birthDate: "1990-05-17",
  mrz: "P<USATORRES<<ANA<<<<<<<<<<<<<<<<<<<<<<<<<<<<",
});

describe("parseCaptureIdentityInput", () => {
  it("normaliza (trim, nacionalidad en mayusculas) y aplica la retencion por defecto", () => {
    const parsed = parseCaptureIdentityInput(rawInput());
    expect(parsed.payload.fullName).toBe("Ana Torres");
    expect(parsed.nationality).toBe("USA");
    expect(parsed.retentionDays).toBe(365);
    expect(parsed.reservationId).toBeNull();
  });

  it.each([
    ["guestId no UUID", { guestId: "abc" }],
    ["documentType desconocido", { documentType: "cedula" }],
    ["nombre vacio", { fullName: " " }],
    ["documento demasiado corto", { documentNumber: "1" }],
    ["documento con caracteres raros", { documentNumber: "<script>" }],
    ["nacionalidad no ISO3", { nationality: "Mexico" }],
    ["fecha imposible", { birthDate: "1990-02-31" }],
    ["retencion fuera de rango", { retentionDays: 5 }],
    ["retencion no entera", { retentionDays: 40.5 }],
    ["mrz con minusculas", { mrz: "abc" }],
  ])("rechaza %s", (_name, patch) => {
    expect(() => parseCaptureIdentityInput({ ...rawInput(), ...patch })).toThrow(IdentityInvalidInputError);
  });

  it("rechaza un cuerpo que no es objeto", () => {
    expect(() => parseCaptureIdentityInput(null)).toThrow(IdentityInvalidInputError);
    expect(() => parseCaptureIdentityInput([])).toThrow(IdentityInvalidInputError);
  });
});

describe("utilidades", () => {
  it("addDaysYmd suma dias de calendario (cruza mes/anio/bisiesto)", () => {
    expect(addDaysYmd("2026-01-01", 365)).toBe("2027-01-01");
    expect(addDaysYmd("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01");
    expect(() => addDaysYmd("2026-13-01", 1)).toThrow();
  });
  it("documentLast4 toma los ultimos 4 alfanumericos", () => {
    expect(documentLast4("G-1234 5678")).toBe("5678");
    expect(documentLast4("AB")).toBe("AB");
    expect(documentLast4("---")).toBeNull();
  });
  it("parseReason exige 10 a 300 caracteres", () => {
    expect(parseReason("  motivo valido  ")).toBe("motivo valido");
    expect(() => parseReason("corto")).toThrow(IdentityInvalidInputError);
    expect(() => parseReason("x".repeat(301))).toThrow(IdentityInvalidInputError);
    expect(() => parseReason(undefined)).toThrow(IdentityInvalidInputError);
  });
});

describe("IdentityVaultService", () => {
  it("captura: guarda SOLO el sobre cifrado (nunca el texto plano), last4 y retencion = hoy + dias", async () => {
    const { repo, service } = setup();
    const record = await service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) });
    expect(record).toMatchObject({ propertyId: PROPERTY, guestId: GUEST, documentType: "pasaporte", nationality: "USA", documentLast4: "5678", status: "activo", retentionUntil: "2027-03-01", keyVersion: 1 });
    const stored = repo.storedEnvelope(record.id)!;
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain("Torres");
    expect(JSON.stringify(record)).not.toContain("Torres");
    expect(JSON.stringify(record)).not.toContain("payload");
  });

  it("sin llave configurada: captura y revelacion lanzan IdentityUnavailableError (nunca se guarda en claro)", async () => {
    const { service } = setup(false);
    await expect(service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) })).rejects.toMatchObject({ name: "IdentityUnavailableError", reason: "llave_no_configurada" });
    await expect(service.reveal({ propertyId: PROPERTY, vaultId: randomUUID(), reason: "motivo suficientemente largo", actorUserId: FRONTDESK })).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it("huesped de otra property: rechazado (guarda cross-tenant)", async () => {
    const { service } = setup();
    await expect(service.capture({ propertyId: OTHER_PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) })).rejects.toBeInstanceOf(IdentityInvalidInputError);
  });

  it("revela: devuelve el documento descifrado y deja huella con el motivo", async () => {
    const { repo, service } = setup();
    const rec = await service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) });
    const out = await service.reveal({ propertyId: PROPERTY, vaultId: rec.id, reason: "Verificacion en mostrador", actorUserId: FRONTDESK });
    expect(out.payload).toMatchObject({ fullName: "Ana Torres", documentNumber: "G-1234 5678", birthDate: "1990-05-17" });
    const log = await repo.listAccessLog(PROPERTY, { limit: 10 });
    expect(log.items.map((l) => l.action)).toEqual(["revelacion", "captura"]);
    expect(log.items[0]).toMatchObject({ actorUserId: FRONTDESK, reason: "Verificacion en mostrador" });
  });

  it("revelar una identidad que no es de esa property responde 'sin permiso' (sin oraculo de existencia)", async () => {
    const { service } = setup();
    const rec = await service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) });
    await expect(service.reveal({ propertyId: OTHER_PROPERTY, vaultId: rec.id, reason: "motivo suficientemente largo", actorUserId: FRONTDESK })).rejects.toBeInstanceOf(IdentityAccessDeniedError);
    await expect(service.reveal({ propertyId: PROPERTY, vaultId: randomUUID(), reason: "motivo suficientemente largo", actorUserId: FRONTDESK })).rejects.toBeInstanceOf(IdentityAccessDeniedError);
  });

  it("revelar sin motivo valido falla y NO deja huella", async () => {
    const { repo, service } = setup();
    const rec = await service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) });
    await expect(service.reveal({ propertyId: PROPERTY, vaultId: rec.id, reason: "corto", actorUserId: FRONTDESK })).rejects.toBeInstanceOf(IdentityInvalidInputError);
    expect((await repo.listAccessLog(PROPERTY, { limit: 10 })).items.map((l) => l.action)).toEqual(["captura"]);
  });
});

describe("purga con doble control (adaptador en memoria)", () => {
  async function captured() {
    const { repo, service } = setup();
    const rec = await service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) });
    return { repo, service, rec };
  }

  it("quien solicita no puede aprobar ni rechazar; otra persona aprueba y la identidad queda purgada e irrecuperable", async () => {
    const { repo, service, rec } = await captured();
    const requestId = await repo.requestPurge(rec.id, "Solicitud ARCO de cancelacion", OWNER);
    await expect(repo.decidePurge(requestId, true, null, OWNER)).rejects.toBeInstanceOf(IdentityDoubleControlError);
    await expect(repo.decidePurge(requestId, false, null, OWNER)).rejects.toBeInstanceOf(IdentityDoubleControlError);
    expect((await repo.findIdentity(PROPERTY, rec.id))?.status).toBe("activo");

    expect(await repo.decidePurge(requestId, true, "Aprobada", GM)).toBe("ejecutada");
    const after = await repo.findIdentity(PROPERTY, rec.id);
    expect(after).toMatchObject({ status: "purgado", documentLast4: null, nationality: null });
    expect(after?.purgedAt).not.toBeNull();
    expect(repo.storedEnvelope(rec.id)).toBeNull();
    await expect(service.reveal({ propertyId: PROPERTY, vaultId: rec.id, reason: "motivo suficientemente largo", actorUserId: GM })).rejects.toBeInstanceOf(IdentityPurgedError);
    await expect(repo.verifyIdentity(rec.id, GM)).rejects.toBeInstanceOf(IdentityPurgedError);
  });

  it("rechazar deja la identidad intacta; una solicitud resuelta no se decide dos veces; una pendiente por identidad", async () => {
    const { repo, rec } = await captured();
    const requestId = await repo.requestPurge(rec.id, "Solicitud que sera rechazada", OWNER);
    await expect(repo.requestPurge(rec.id, "Segunda solicitud duplicada", GM)).rejects.toBeInstanceOf(IdentityConflictError);
    expect(await repo.decidePurge(requestId, false, "Retencion vigente", GM)).toBe("rechazada");
    expect((await repo.findIdentity(PROPERTY, rec.id))?.status).toBe("activo");
    await expect(repo.decidePurge(requestId, true, null, GM)).rejects.toBeInstanceOf(IdentityRequestResolvedError);
  });

  it("purgeExpired purga solo lo vencido de esa property, cierra solicitudes pendientes y deja huella con actor null", async () => {
    const { repo, rec } = await captured();
    const requestId = await repo.requestPurge(rec.id, "Solicitud pendiente de prueba", OWNER);
    expect(await repo.purgeExpired(PROPERTY, "2027-03-01")).toBe(0); // retention_until = 2027-03-01 NO es < hoy
    expect(await repo.purgeExpired(OTHER_PROPERTY, "2030-01-01")).toBe(0);
    expect(await repo.purgeExpired(PROPERTY, "2027-03-02")).toBe(1);
    expect((await repo.findIdentity(PROPERTY, rec.id))?.status).toBe("purgado");
    expect((await repo.findPurgeRequest(PROPERTY, requestId))?.status).toBe("ejecutada");
    const log = await repo.listAccessLog(PROPERTY, { vaultId: rec.id, limit: 10 });
    expect(log.items[0]).toMatchObject({ action: "purga_por_retencion", actorUserId: null });
    expect(await repo.purgeExpired(PROPERTY, "2030-01-01")).toBe(0);
  });
});

describe("registro migratorio (adaptador en memoria)", () => {
  it("copia fechas de la reserva y nacionalidad de la identidad; unico por reserva+huesped; reportado exige constancia y no se repite", async () => {
    const { repo, service } = setup();
    const reservationId = randomUUID();
    repo.seedReservation(PROPERTY, reservationId, "2026-03-10", "2026-03-12");
    const rec = await service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) });
    const reg = await repo.createMigratoryRegistration({ propertyId: PROPERTY, reservationId, guestId: GUEST, vaultId: rec.id, actorUserId: FRONTDESK });
    expect(reg).toMatchObject({ arrivalDate: "2026-03-10", departureDate: "2026-03-12", nationality: "USA", status: "pendiente", constanciaRef: null });
    await expect(repo.createMigratoryRegistration({ propertyId: PROPERTY, reservationId, guestId: GUEST, vaultId: null, actorUserId: FRONTDESK })).rejects.toBeInstanceOf(IdentityConflictError);

    expect(await repo.reportMigratoryRegistration(OTHER_PROPERTY, reg.id, "INM-1", FRONTDESK)).toBeNull();
    const done = await repo.reportMigratoryRegistration(PROPERTY, reg.id, "INM-2026-0042", FRONTDESK);
    expect(done).toMatchObject({ status: "reportado", constanciaRef: "INM-2026-0042", reportedBy: FRONTDESK });
    await expect(repo.reportMigratoryRegistration(PROPERTY, reg.id, "INM-otra", FRONTDESK)).rejects.toBeInstanceOf(IdentityConflictError);
  });

  it("reserva u otro huesped de otra property: rechazado", async () => {
    const { repo } = setup();
    const reservationId = randomUUID();
    repo.seedReservation(OTHER_PROPERTY, reservationId, "2026-03-10", "2026-03-12");
    await expect(repo.createMigratoryRegistration({ propertyId: PROPERTY, reservationId, guestId: GUEST, vaultId: null, actorUserId: FRONTDESK })).rejects.toBeInstanceOf(IdentityInvalidInputError);
  });
});

describe("base sin migrar (adaptador en memoria con unavailable=true)", () => {
  it("las lecturas degradan a vacio con available:false; las escrituras lanzan IdentityUnavailableError", async () => {
    const { repo, service } = setup();
    repo.unavailable = true;
    expect(await repo.listIdentities(PROPERTY, { limit: 10 })).toEqual({ available: false, items: [] });
    expect(await repo.listMigratoryRegistrations(PROPERTY, { limit: 10 })).toEqual({ available: false, items: [] });
    await expect(service.capture({ propertyId: PROPERTY, actorUserId: FRONTDESK, today: "2026-03-01", input: parseCaptureIdentityInput(rawInput()) })).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});

// Flujos de privacidad sobre el adaptador en memoria coordinado con la boveda en memoria
// (bloqueo, retencion legal, acceso excepcional). RLS/GRANT/triggers: los cubre
// scripts/verify-hoteles-privacidad-arco contra Postgres real.
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IdentityAccessDeniedError,
  IdentityBlockedError,
  IdentityVaultService,
  InMemoryIdentityRepository,
  InMemoryPrivacyRepository,
  PrivacyConflictError,
  PrivacyDoubleControlError,
  PrivacyInvalidInputError,
  PrivacyUnavailableError,
  createIdentityCipher,
  parseCaptureIdentityInput,
} from "../../src/index.ts";

const PROPERTY = randomUUID();
const GUEST = randomUUID();
const OWNER = randomUUID();
const GM = randomUUID();
const FRONT = randomUUID();

function setup() {
  const identity = new InMemoryIdentityRepository();
  identity.seedGuest(PROPERTY, GUEST);
  const privacy = new InMemoryPrivacyRepository(identity);
  const service = new IdentityVaultService(identity, createIdentityCipher(randomBytes(32), 1));
  return { identity, privacy, service };
}
async function captured(s: ReturnType<typeof setup>) {
  return s.service.capture({
    propertyId: PROPERTY, actorUserId: FRONT, today: "2026-03-01",
    input: parseCaptureIdentityInput({ guestId: GUEST, documentType: "pasaporte", nationality: "USA", fullName: "Ana Torres", documentNumber: "G-1234 5678" }),
  });
}
const NOTICE = { version: "v1", simplifiedText: "Usamos tus datos para identificarte y facturar.", integralUrl: null, mandatoryPurposes: ["identificar", "facturacion"], optionalPurposes: ["promociones"], contentSha256: null };

describe("aviso y ledger de consentimientos", () => {
  it("publicar una version nueva deja una sola vigente; el consentimiento copia la version aceptada y exige TODAS las obligatorias", async () => {
    const { privacy } = setup();
    const v1 = await privacy.publishNotice(PROPERTY, NOTICE, OWNER);
    const v2 = await privacy.publishNotice(PROPERTY, { ...NOTICE, version: "v2" }, OWNER);
    const list = await privacy.listNotices(PROPERTY, { limit: 10 });
    expect(list.items.filter((n) => n.isCurrent).map((n) => n.id)).toEqual([v2]);
    await expect(privacy.publishNotice(PROPERTY, NOTICE, OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);

    const base = { id: randomUUID(), guestId: GUEST, vaultId: null, noticeId: v1, acceptedOptional: [], channel: "mostrador" as const, evidenceMethod: "casilla_electronica" as const, sensitiveData: false };
    await expect(privacy.recordConsent(PROPERTY, { ...base, acceptedMandatory: ["identificar"] }, FRONT)).rejects.toBeInstanceOf(PrivacyInvalidInputError);
    await expect(privacy.recordConsent(PROPERTY, { ...base, acceptedMandatory: ["identificar", "facturacion"], acceptedOptional: ["venta de datos"] }, FRONT)).rejects.toBeInstanceOf(PrivacyInvalidInputError);
    await expect(privacy.recordConsent(PROPERTY, { ...base, acceptedMandatory: ["identificar", "facturacion"], sensitiveData: true }, FRONT)).rejects.toBeInstanceOf(PrivacyInvalidInputError);
    const ok = await privacy.recordConsent(PROPERTY, { ...base, acceptedMandatory: ["facturacion", "identificar"], acceptedOptional: ["promociones"] }, FRONT);
    expect(ok).toMatchObject({ noticeVersion: "v1", capturedBy: FRONT, revokedAt: null });
  });

  it("revocar: una sola vez, conserva el registro y deja bitacora", async () => {
    const { privacy } = setup();
    const notice = await privacy.publishNotice(PROPERTY, NOTICE, OWNER);
    const c = await privacy.recordConsent(PROPERTY, { id: randomUUID(), guestId: GUEST, vaultId: null, noticeId: notice, acceptedMandatory: ["identificar", "facturacion"], acceptedOptional: [], channel: "qr", evidenceMethod: "casilla_electronica", sensitiveData: false }, FRONT);
    await privacy.revokeConsent(c.id, "El titular retira su consentimiento", FRONT);
    await expect(privacy.revokeConsent(c.id, "Segunda revocacion de prueba", FRONT)).rejects.toBeInstanceOf(PrivacyConflictError);
    expect((await privacy.listConsents(PROPERTY, { guestId: GUEST, limit: 5 })).items[0]).toMatchObject({ revokedBy: FRONT });
    expect((await privacy.listEvents(PROPERTY, { subjectType: "consentimiento", limit: 5 })).items).toHaveLength(1);
  });
});

describe("ARCO con plazos y prorroga", () => {
  const input = { rightType: "rectificacion" as const, requesterName: "Juan Perez", requesterContact: null, channel: "correo" as const, description: null, receivedOn: "2026-03-01", guestId: GUEST, vaultId: null };

  it("recibida -> procedente (ejecucion = decision + 15) -> ejecutada; transiciones invalidas son conflicto; improcedente es terminal", async () => {
    const { privacy } = setup();
    const id = await privacy.openArco(PROPERTY, input, OWNER);
    expect(await privacy.findArco(PROPERTY, id)).toMatchObject({ status: "recibida", responseDueOn: "2026-03-21", executionDueOn: null });
    await expect(privacy.advanceArco(id, "ejecutada", "Intento de saltar la procedencia", "2026-03-05", GM)).rejects.toBeInstanceOf(PrivacyConflictError);
    await privacy.advanceArco(id, "procedente", "Procede la rectificacion solicitada", "2026-03-05", GM);
    expect(await privacy.findArco(PROPERTY, id)).toMatchObject({ status: "procedente", decidedOn: "2026-03-05", executionDueOn: "2026-03-20" });
    await privacy.advanceArco(id, "ejecutada", "Se corrigieron los datos del titular", "2026-03-06", GM);
    expect((await privacy.findArco(PROPERTY, id))?.executedAt).not.toBeNull();

    const other = await privacy.openArco(PROPERTY, input, OWNER);
    await privacy.advanceArco(other, "improcedente", "No se acredita la identidad del solicitante", "2026-03-05", GM);
    await expect(privacy.advanceArco(other, "procedente", "Un estado terminal no se reabre", "2026-03-05", GM)).rejects.toBeInstanceOf(PrivacyConflictError);
  });

  it("prorroga unica por igual plazo de la fase abierta (+20 respuesta / +15 ejecucion) y nunca sobre una solicitud resuelta", async () => {
    const { privacy } = setup();
    const id = await privacy.openArco(PROPERTY, input, OWNER);
    await privacy.extendArco(id, "Se requiere recabar informacion de varias areas", OWNER);
    expect(await privacy.findArco(PROPERTY, id)).toMatchObject({ responseDueOn: "2026-04-10", extensionPhase: "respuesta" });
    await expect(privacy.extendArco(id, "Segunda prorroga que no esta permitida", OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);

    const b = await privacy.openArco(PROPERTY, input, OWNER);
    await privacy.advanceArco(b, "procedente", "Procede la rectificacion solicitada", "2026-03-05", GM);
    await privacy.extendArco(b, "La correccion requiere validar documentos", OWNER);
    expect(await privacy.findArco(PROPERTY, b)).toMatchObject({ executionDueOn: "2026-04-04", extensionPhase: "ejecucion" });
    const c = await privacy.openArco(PROPERTY, input, OWNER);
    await privacy.advanceArco(c, "improcedente", "No se acredita la identidad del solicitante", "2026-03-05", GM);
    await expect(privacy.extendArco(c, "No se puede prorrogar una solicitud resuelta", OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);
  });

  it("una CANCELACION procedente BLOQUEA la identidad (ligada, o las activas del huesped) y no la purga de golpe", async () => {
    const s = setup();
    const rec = await captured(s);
    const id = await s.privacy.openArco(PROPERTY, { ...input, rightType: "cancelacion", vaultId: rec.id }, OWNER);
    await s.privacy.advanceArco(id, "procedente", "Procede la cancelacion de los datos", "2026-03-05", GM);
    expect(await s.identity.findIdentity(PROPERTY, rec.id)).toMatchObject({ status: "bloqueada", blockReason: "arco", blockedBy: GM });
    expect(s.identity.storedEnvelope(rec.id)).not.toBeNull();

    const s2 = setup();
    const r2 = await captured(s2);
    const r3 = await captured(s2);
    const id2 = await s2.privacy.openArco(PROPERTY, { ...input, rightType: "cancelacion", vaultId: null }, OWNER);
    await s2.privacy.advanceArco(id2, "procedente", "Procede la cancelacion de los datos", "2026-03-05", GM);
    expect((await s2.identity.findIdentity(PROPERTY, r2.id))?.status).toBe("bloqueada");
    expect((await s2.identity.findIdentity(PROPERTY, r3.id))?.status).toBe("bloqueada");

    const s3 = setup();
    const r4 = await captured(s3);
    const acc = await s3.privacy.openArco(PROPERTY, { ...input, rightType: "acceso", vaultId: r4.id }, OWNER);
    await s3.privacy.advanceArco(acc, "procedente", "Procede el acceso a los datos", "2026-03-05", GM);
    expect((await s3.identity.findIdentity(PROPERTY, r4.id))?.status).toBe("activo");
  });
});

describe("incidentes", () => {
  const inc = { incidentType: "divulgacion" as const, severity: "alta" as const, title: "Correo al huesped equivocado", description: "Se envio una confirmacion a otra persona.", detectedAt: "2026-03-01T10:00:00.000Z", affectedCount: 1, significantRisk: true };

  it("cerrar con riesgo significativo exige la notificacion registrada o el motivo de no notificar; cerrado no admite acciones", async () => {
    const { privacy } = setup();
    const id = await privacy.reportIncident(PROPERTY, inc, FRONT);
    await privacy.updateIncident(id, { action: "contener", note: null, channel: null, ref: null }, OWNER);
    await expect(privacy.updateIncident(id, { action: "contener", note: null, channel: null, ref: null }, OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);
    await expect(privacy.updateIncident(id, { action: "cerrar", note: "Se cierra el incidente tras la revision", channel: null, ref: null }, OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);
    await privacy.updateIncident(id, { action: "registrar_notificacion", note: null, channel: "correo", ref: "Constancia 0007" }, OWNER);
    await expect(privacy.updateIncident(id, { action: "registrar_notificacion", note: null, channel: "correo", ref: "Otra" }, OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);
    expect(await privacy.updateIncident(id, { action: "cerrar", note: "Se cierra con el titular notificado", channel: null, ref: null }, OWNER)).toBe("cerrada");
    await expect(privacy.updateIncident(id, { action: "contener", note: null, channel: null, ref: null }, OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);
    const closed = await privacy.findIncident(PROPERTY, id);
    expect(closed).toMatchObject({ status: "cerrada", noNotificationReason: null });

    const id2 = await privacy.reportIncident(PROPERTY, inc, FRONT);
    await privacy.updateIncident(id2, { action: "cerrar", note: "Se cierra el incidente tras la revision", channel: null, ref: "Los datos expuestos no permiten dano alguno" }, OWNER);
    expect((await privacy.findIncident(PROPERTY, id2))?.noNotificationReason).toBe("Los datos expuestos no permiten dano alguno");
  });
});

describe("retencion legal y acceso excepcional con la boveda", () => {
  it("el hold impide la purga mientras dure; liberarlo la permite; la bitacora de privacidad lo registra", async () => {
    const s = setup();
    const rec = await captured(s);
    await s.identity.sweepRetention(PROPERTY, "2026-04-01"); // bloquea (retention 2026-03-31)
    const hold = await s.privacy.placeLegalHold({ vaultId: rec.id, folio: "FGR-2026-1", reason: "Carpeta de investigacion abierta", authorizationRef: "Direccion juridica", incidentId: null }, OWNER);
    expect((await s.identity.sweepRetention(PROPERTY, "2027-06-01")).purged).toBe(0);
    await s.privacy.releaseLegalHold(hold, "Caso cerrado por la autoridad", OWNER);
    await expect(s.privacy.releaseLegalHold(hold, "Segunda liberacion de la misma retencion", OWNER)).rejects.toBeInstanceOf(PrivacyConflictError);
    expect((await s.identity.sweepRetention(PROPERTY, "2027-06-01")).purged).toBe(1);
    const actions = (await s.privacy.listEvents(PROPERTY, { subjectType: "retencion_legal", limit: 10 })).items.map((e) => e.action);
    expect(actions).toEqual(["retencion_liberada", "retencion_aplicada"]);
  });

  it("DOBLE CONTROL del acceso excepcional: quien pide no aprueba; aprobado, solo quien pidio lo consume y una vez", async () => {
    const s = setup();
    const rec = await captured(s);
    await expect(s.privacy.requestBlockedAccess(rec.id, "Requerimiento de autoridad con oficio 123", OWNER)).rejects.toBeInstanceOf(PrivacyConflictError); // aun activa
    await s.privacy.blockIdentity(rec.id, "Bloqueo preventivo por solicitud del titular", OWNER);
    await expect(s.service.reveal({ propertyId: PROPERTY, vaultId: rec.id, reason: "motivo suficientemente largo", actorUserId: GM })).rejects.toBeInstanceOf(IdentityBlockedError);
    const req = await s.privacy.requestBlockedAccess(rec.id, "Requerimiento de autoridad con oficio 123", OWNER);
    await expect(s.privacy.decideBlockedAccess(req, true, null, OWNER)).rejects.toBeInstanceOf(PrivacyDoubleControlError);
    await expect(s.service.revealBlocked({ propertyId: PROPERTY, vaultId: rec.id, accessRequestId: req, actorUserId: OWNER })).rejects.toBeInstanceOf(IdentityAccessDeniedError); // sin aprobar
    expect(await s.privacy.decideBlockedAccess(req, true, "Aprobado con el oficio a la vista", GM)).toBe("aprobada");
    await expect(s.service.revealBlocked({ propertyId: PROPERTY, vaultId: rec.id, accessRequestId: req, actorUserId: GM })).rejects.toBeInstanceOf(IdentityAccessDeniedError); // otra persona
    const { payload } = await s.service.revealBlocked({ propertyId: PROPERTY, vaultId: rec.id, accessRequestId: req, actorUserId: OWNER });
    expect(payload.fullName).toBe("Ana Torres");
    await expect(s.service.revealBlocked({ propertyId: PROPERTY, vaultId: rec.id, accessRequestId: req, actorUserId: OWNER })).rejects.toBeInstanceOf(IdentityAccessDeniedError); // un solo uso
  });

  it("la ventana de bloqueo editable (3-30) se aplica a los bloqueos nuevos y queda en la bitacora", async () => {
    const s = setup();
    await expect(s.privacy.setBlockWindow(PROPERTY, 2, OWNER)).rejects.toBeInstanceOf(PrivacyInvalidInputError);
    await s.privacy.setBlockWindow(PROPERTY, 14, GM);
    expect(await s.privacy.getSettings()).toMatchObject({ settings: { blockWindowDays: 14, isDefault: false, updatedBy: GM } });
    const rec = await captured(s);
    await s.privacy.blockIdentity(rec.id, "Bloqueo preventivo por solicitud del titular", OWNER);
    expect((await s.identity.findIdentity(PROPERTY, rec.id))?.blockWindowDays).toBe(14);
    expect((await s.privacy.listEvents(PROPERTY, { subjectType: "configuracion", limit: 5 })).items[0]).toMatchObject({ action: "ventana_bloqueo", note: "de 7 a 14 dias", actorUserId: GM });
  });
});

describe("base sin 032", () => {
  it("las lecturas degradan a vacio 'no disponible aun' y las escrituras a PrivacyUnavailableError", async () => {
    const { privacy } = setup();
    privacy.unavailable = true;
    expect(await privacy.listArco(PROPERTY, { limit: 5 })).toEqual({ available: false, items: [] });
    expect(await privacy.listIncidents(PROPERTY, { limit: 5 })).toEqual({ available: false, items: [] });
    expect((await privacy.getSettings()).available).toBe(false);
    await expect(privacy.publishNotice(PROPERTY, NOTICE, OWNER)).rejects.toBeInstanceOf(PrivacyUnavailableError);
  });
});

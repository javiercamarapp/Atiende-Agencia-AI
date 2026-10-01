// Reglas puras y validacion de entrada de privacidad (H-02): plazos ARCO, recordatorio de
// vulneraciones, revision de retenciones y parsers. Sin I/O.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ARCO_DUE_SOON_DAYS,
  PRIVACY_LAWYER_CHECKLIST,
  PRIVACY_LEGAL_DISCLAIMER,
  PrivacyInvalidInputError,
  arcoDeadline,
  arcoExtensionAvailable,
  computeArcoExecutionDue,
  computeArcoResponseDue,
  daysBetweenYmd,
  incidentNotificationReminder,
  legalHoldReviewState,
  parseArcoAdvance,
  parseArcoInput,
  parseBlockWindowDays,
  parseConsentFields,
  parseIncidentAction,
  parseIncidentInput,
  parseLegalHoldInput,
  parsePrivacyNoticeInput,
  parsePrivacyReason,
} from "../../src/privacy/index.ts";

describe("plazos ARCO (20 dias de respuesta + 15 de ejecucion, naturales)", () => {
  it("respuesta = recepcion + 20; ejecucion = decision + 15; cruza fin de mes y de anio", () => {
    expect(computeArcoResponseDue("2026-03-01")).toBe("2026-03-21");
    expect(computeArcoResponseDue("2026-12-20")).toBe("2027-01-09");
    expect(computeArcoExecutionDue("2026-02-20")).toBe("2026-03-07");
    expect(daysBetweenYmd("2026-03-01", "2026-03-21")).toBe(20);
    expect(() => daysBetweenYmd("2026-02-30", "2026-03-01")).toThrow();
  });

  it("estado del plazo: en_plazo, por_vencer (<= 5 dias), vencida y cerrada segun la fase abierta", () => {
    const base = { responseDueOn: "2026-03-21", executionDueOn: null as string | null };
    expect(arcoDeadline({ ...base, status: "recibida" }, "2026-03-01")).toEqual({ phase: "respuesta", dueOn: "2026-03-21", daysRemaining: 20, state: "en_plazo" });
    expect(arcoDeadline({ ...base, status: "en_revision" }, `2026-03-${21 - ARCO_DUE_SOON_DAYS}`).state).toBe("por_vencer");
    expect(arcoDeadline({ ...base, status: "recibida" }, "2026-03-21").state).toBe("por_vencer"); // vence hoy: todavia en plazo
    expect(arcoDeadline({ ...base, status: "recibida" }, "2026-03-22")).toMatchObject({ state: "vencida", daysRemaining: -1 });
    expect(arcoDeadline({ ...base, status: "procedente", executionDueOn: "2026-04-05" }, "2026-03-25")).toMatchObject({ phase: "ejecucion", dueOn: "2026-04-05", state: "en_plazo" });
    expect(arcoDeadline({ ...base, status: "ejecutada" }, "2026-03-25")).toEqual({ phase: null, dueOn: null, daysRemaining: null, state: "cerrada" });
    expect(arcoDeadline({ ...base, status: "improcedente" }, "2030-01-01").state).toBe("cerrada");
  });

  it("la prorroga es unica y extiende la fase abierta por igual plazo", () => {
    expect(arcoExtensionAvailable({ status: "recibida", extendedAt: null })).toEqual({ available: true, days: 20 });
    expect(arcoExtensionAvailable({ status: "en_revision", extendedAt: null })).toEqual({ available: true, days: 20 });
    expect(arcoExtensionAvailable({ status: "procedente", extendedAt: null })).toEqual({ available: true, days: 15 });
    expect(arcoExtensionAvailable({ status: "recibida", extendedAt: "2026-03-02T00:00:00Z" }).available).toBe(false);
    expect(arcoExtensionAvailable({ status: "ejecutada", extendedAt: null }).available).toBe(false);
  });
});

describe("recordatorio de vulneraciones (art. 19): solo avisa, nunca envia", () => {
  const detectedAt = "2026-03-01T10:00:00.000Z";
  const now = new Date("2026-03-01T15:30:00.000Z");
  it("riesgo significativo sin notificacion en un incidente abierto: requerido y vencido (es 'de inmediato'), con las horas transcurridas", () => {
    const r = incidentNotificationReminder({ significantRisk: true, notifiedAt: null, status: "detectada", detectedAt }, now);
    expect(r).toMatchObject({ required: true, overdue: true, hoursSinceDetection: 5 });
    expect(r.message).toMatch(/DE INMEDIATO/);
    expect(r.message).toMatch(/NO envia/);
  });
  it("sin recordatorio si ya se notifico, si esta cerrado o si no hay riesgo significativo", () => {
    expect(incidentNotificationReminder({ significantRisk: true, notifiedAt: "2026-03-01T11:00:00Z", status: "contenida", detectedAt }, now)).toMatchObject({ required: false, message: null });
    expect(incidentNotificationReminder({ significantRisk: true, notifiedAt: null, status: "cerrada", detectedAt }, now).required).toBe(false);
    expect(incidentNotificationReminder({ significantRisk: false, notifiedAt: null, status: "detectada", detectedAt }, now).required).toBe(false);
  });
});

describe("revision anual de la retencion legal", () => {
  it("vigente, revision proxima (<= 30 dias), vencida y liberada", () => {
    expect(legalHoldReviewState({ status: "activa", reviewDueOn: "2027-03-01" }, "2026-03-01")).toBe("vigente");
    expect(legalHoldReviewState({ status: "activa", reviewDueOn: "2026-03-31" }, "2026-03-01")).toBe("revision_proxima");
    expect(legalHoldReviewState({ status: "activa", reviewDueOn: "2026-02-28" }, "2026-03-01")).toBe("revision_vencida");
    expect(legalHoldReviewState({ status: "liberada", reviewDueOn: "2026-02-28" }, "2026-03-01")).toBe("liberada");
  });
});

describe("aviso de no-asesoria-legal y lista para el abogado", () => {
  it("declara que NO es asesoria legal y lista lo que un abogado debe confirmar", () => {
    expect(PRIVACY_LEGAL_DISCLAIMER).toMatch(/NO es asesoria legal/);
    expect(PRIVACY_LAWYER_CHECKLIST.length).toBeGreaterThanOrEqual(8);
    expect(PRIVACY_LAWYER_CHECKLIST.join(" ")).toMatch(/habiles/);
    expect(PRIVACY_LAWYER_CHECKLIST.join(" ")).toMatch(/art\. 19/);
  });
});

describe("parsers", () => {
  const validNotice = {
    version: "v1",
    textoSimplificado: "Usamos tus datos para identificarte y facturar. Aviso integral en el enlace.",
    finalidadesObligatorias: ["identificar al huesped", "facturacion"],
    finalidadesOpcionales: ["promociones"],
    urlIntegral: "https://hotel.example.com/aviso",
  };

  it("aviso: valida, normaliza y rechaza finalidades repetidas/solapadas, enlaces no https y sha256 invalido", () => {
    expect(parsePrivacyNoticeInput(validNotice)).toMatchObject({ version: "v1", mandatoryPurposes: ["identificar al huesped", "facturacion"], optionalPurposes: ["promociones"], contentSha256: null });
    expect(() => parsePrivacyNoticeInput({ ...validNotice, finalidadesObligatorias: [] })).toThrow(PrivacyInvalidInputError);
    expect(() => parsePrivacyNoticeInput({ ...validNotice, finalidadesObligatorias: ["facturacion", "Facturacion"] })).toThrow(/repetidas/);
    expect(() => parsePrivacyNoticeInput({ ...validNotice, finalidadesOpcionales: ["Facturacion"] })).toThrow(/obligatoria y opcional/);
    expect(() => parsePrivacyNoticeInput({ ...validNotice, urlIntegral: "http://hotel.example.com/aviso" })).toThrow(/https/);
    expect(() => parsePrivacyNoticeInput({ ...validNotice, sha256: "xyz" })).toThrow();
    expect(() => parsePrivacyNoticeInput({ ...validNotice, textoSimplificado: "corto" })).toThrow();
    expect(() => parsePrivacyNoticeInput(null)).toThrow(PrivacyInvalidInputError);
  });

  it("consentimiento: datos sensibles exigen firma o mecanismo de autenticacion (expreso y por escrito)", () => {
    const base = { avisoId: randomUUID(), finalidadesObligatorias: ["identificar al huesped"], canal: "tableta", metodo: "casilla_electronica" };
    expect(parseConsentFields(base)).toMatchObject({ channel: "tableta", evidenceMethod: "casilla_electronica", sensitiveData: false, acceptedOptional: [] });
    expect(() => parseConsentFields({ ...base, datosSensibles: true })).toThrow(/expreso y por escrito/);
    expect(parseConsentFields({ ...base, datosSensibles: true, metodo: "firma_electronica" }).sensitiveData).toBe(true);
    expect(() => parseConsentFields({ ...base, avisoId: "x" })).toThrow(/UUID/);
    expect(() => parseConsentFields({ ...base, canal: "paloma" })).toThrow(/canal/);
    expect(() => parseConsentFields({ ...base, datosSensibles: "si" })).toThrow();
  });

  it("ventana de bloqueo: entero de 3 a 30", () => {
    expect(parseBlockWindowDays(3)).toBe(3);
    expect(parseBlockWindowDays(30)).toBe(30);
    for (const bad of [2, 31, 7.5, "7", null]) expect(() => parseBlockWindowDays(bad)).toThrow(PrivacyInvalidInputError);
  });

  it("ARCO: default de recepcion = hoy; no futura ni de mas de 365 dias; derecho y canal del catalogo", () => {
    const body = { derecho: "acceso", solicitante: "Juan Perez", canal: "correo" };
    expect(parseArcoInput(body, "2026-03-10")).toMatchObject({ rightType: "acceso", receivedOn: "2026-03-10", guestId: null, vaultId: null });
    expect(parseArcoInput({ ...body, recibidaEn: "2026-03-01" }, "2026-03-10").receivedOn).toBe("2026-03-01");
    expect(() => parseArcoInput({ ...body, recibidaEn: "2026-03-11" }, "2026-03-10")).toThrow(/futuro/);
    expect(() => parseArcoInput({ ...body, recibidaEn: "2025-03-09" }, "2026-03-10")).toThrow(/365/);
    expect(() => parseArcoInput({ ...body, derecho: "borrado" }, "2026-03-10")).toThrow(/derecho/);
    expect(() => parseArcoInput({ ...body, recibidaEn: "2026-02-30" }, "2026-03-10")).toThrow(/inexistente/);
  });

  it("ARCO avance: estado destino valido y nota de 10 a 300 caracteres", () => {
    expect(parseArcoAdvance({ estado: "procedente", nota: "Se verifica la identidad del titular" })).toEqual({ to: "procedente", note: "Se verifica la identidad del titular" });
    expect(() => parseArcoAdvance({ estado: "recibida", nota: "Se verifica la identidad del titular" })).toThrow();
    expect(() => parseArcoAdvance({ estado: "procedente", nota: "corto" })).toThrow();
  });

  it("incidente: la deteccion no puede estar en el futuro; severidad/tipo del catalogo; riesgo significativo booleano", () => {
    const now = new Date("2026-03-10T12:00:00Z");
    const body = { tipo: "divulgacion", severidad: "alta", titulo: "Correo al huesped equivocado", descripcion: "Se envio una confirmacion a otra persona.", riesgoSignificativo: true, afectados: 1 };
    expect(parseIncidentInput(body, now)).toMatchObject({ incidentType: "divulgacion", significantRisk: true, affectedCount: 1, detectedAt: "2026-03-10T12:00:00.000Z" });
    expect(parseIncidentInput({ ...body, detectadoEn: "2026-03-09T08:00:00Z" }, now).detectedAt).toBe("2026-03-09T08:00:00.000Z");
    expect(() => parseIncidentInput({ ...body, detectadoEn: "2026-03-12T08:00:00Z" }, now)).toThrow(/futuro/);
    expect(() => parseIncidentInput({ ...body, severidad: "critica" }, now)).toThrow(/severidad/);
    expect(() => parseIncidentInput({ ...body, afectados: -1 }, now)).toThrow(/afectados/);
    expect(() => parseIncidentInput({ ...body, riesgoSignificativo: "si" }, now)).toThrow();
  });

  it("accion sobre incidente: notificar exige canal y constancia; cerrar exige nota", () => {
    expect(parseIncidentAction({ accion: "contener" })).toEqual({ action: "contener", note: null, channel: null, ref: null });
    expect(parseIncidentAction({ accion: "registrar_notificacion", canal: "correo", constancia: "Folio 123" })).toMatchObject({ channel: "correo", ref: "Folio 123" });
    expect(() => parseIncidentAction({ accion: "registrar_notificacion", canal: "correo" })).toThrow();
    expect(parseIncidentAction({ accion: "cerrar", nota: "Se cierra el caso tras la revision", motivoNoNotificar: "No hay dano patrimonial ni moral" })).toMatchObject({ action: "cerrar", ref: "No hay dano patrimonial ni moral" });
    expect(() => parseIncidentAction({ accion: "cerrar" })).toThrow();
    expect(() => parseIncidentAction({ accion: "borrar" })).toThrow();
  });

  it("retencion legal: folio, motivo y autorizacion obligatorios; incidente opcional UUID", () => {
    const vault = randomUUID();
    expect(parseLegalHoldInput({ folio: "FGR-2026-1", motivo: "Carpeta de investigacion abierta", autorizacion: "Direccion juridica" }, vault)).toMatchObject({ vaultId: vault, incidentId: null });
    expect(() => parseLegalHoldInput({ folio: "FGR-2026-1", motivo: "Carpeta de investigacion abierta" }, vault)).toThrow(/autorizacion/);
    expect(() => parseLegalHoldInput({ folio: "ab", motivo: "Carpeta de investigacion abierta", autorizacion: "Dir" }, vault)).toThrow(/folio/);
    expect(() => parseLegalHoldInput({ folio: "FGR-1", motivo: "Carpeta de investigacion abierta", autorizacion: "Dir", incidenteId: "x" }, vault)).toThrow(/UUID/);
    expect(parsePrivacyReason({ motivo: "Motivo suficiente para el caso" })).toBe("Motivo suficiente para el caso");
    expect(() => parsePrivacyReason({ motivo: "corto" })).toThrow();
  });
});

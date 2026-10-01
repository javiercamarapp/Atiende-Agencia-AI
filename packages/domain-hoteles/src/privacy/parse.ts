// Validacion de entrada de privacidad (H-02). Mismos rangos que los CHECK/funciones de la
// migracion 032: la base es la autoridad; esto da errores claros (422) antes de llegar a ella.
// Los nombres de campo del cuerpo HTTP van en espanol (como `motivo`/`nota`/`aprobar` de la boveda).
import { PrivacyInvalidInputError } from "./errors.ts";
import { BLOCK_WINDOW_DAYS_MAX, BLOCK_WINDOW_DAYS_MIN } from "./rules.ts";
import {
  ARCO_CHANNELS,
  ARCO_RIGHTS,
  CONSENT_CHANNELS,
  CONSENT_EVIDENCE_METHODS,
  CONSENT_WRITTEN_METHODS,
  INCIDENT_SEVERITIES,
  INCIDENT_TYPES,
  type ArcoChannel,
  type ArcoRight,
  type ArcoTargetStatus,
  type ConsentChannel,
  type ConsentEvidenceMethod,
  type IncidentAction,
  type IncidentSeverity,
  type IncidentType,
  type NewArcoRequestInput,
  type NewIncidentInput,
  type NewLegalHoldInput,
  type NewPrivacyNoticeInput,
  type PrivacyNoticeRecord,
} from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PrivacyInvalidInputError("El cuerpo debe ser un objeto JSON.");
  return raw as Record<string, unknown>;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new PrivacyInvalidInputError(`${field}: requerido (${min} a ${max} caracteres).`);
  const t = value.trim();
  if (t.length < min || t.length > max) throw new PrivacyInvalidInputError(`${field}: debe tener entre ${min} y ${max} caracteres.`);
  return t;
}

function optionalText(value: unknown, field: string, min: number, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new PrivacyInvalidInputError(`${field}: se esperaba texto.`);
  if (value.trim() === "") return null;
  return text(value, field, min, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new PrivacyInvalidInputError(`${field}: se esperaba uno de ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function parseUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new PrivacyInvalidInputError(`${field}: se esperaba un UUID.`);
  return value;
}
function optionalUuid(value: unknown, field: string): string | null {
  return value === undefined || value === null ? null : parseUuid(value, field);
}

function ymd(value: unknown, field: string): string {
  if (typeof value !== "string" || !YMD_RE.test(value)) throw new PrivacyInvalidInputError(`${field}: se esperaba una fecha YYYY-MM-DD.`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new PrivacyInvalidInputError(`${field}: fecha inexistente.`);
  return value;
}

function purposes(value: unknown, field: string, min: number): string[] {
  if (!Array.isArray(value)) throw new PrivacyInvalidInputError(`${field}: se esperaba una lista de finalidades.`);
  if (value.length < min || value.length > 10) throw new PrivacyInvalidInputError(`${field}: ${min === 0 ? "hasta 10" : `de ${min} a 10`} finalidades.`);
  const out = value.map((v, i) => text(v, `${field}[${i}]`, 3, 120));
  if (new Set(out.map((p) => p.toLowerCase())).size !== out.length) throw new PrivacyInvalidInputError(`${field}: hay finalidades repetidas.`);
  return out;
}

/** Aviso de privacidad nuevo (version, texto simplificado, finalidades obligatorias/opcionales, enlace al integral). */
export function parsePrivacyNoticeInput(raw: unknown): NewPrivacyNoticeInput {
  const b = asObject(raw);
  const mandatory = purposes(b.finalidadesObligatorias, "finalidadesObligatorias", 1);
  const optional = b.finalidadesOpcionales === undefined || b.finalidadesOpcionales === null ? [] : purposes(b.finalidadesOpcionales, "finalidadesOpcionales", 0);
  const lower = new Set(mandatory.map((p) => p.toLowerCase()));
  if (optional.some((p) => lower.has(p.toLowerCase()))) throw new PrivacyInvalidInputError("Una finalidad no puede ser obligatoria y opcional a la vez.");
  const integralUrl = optionalText(b.urlIntegral, "urlIntegral", 10, 500);
  if (integralUrl !== null && !/^https:\/\//i.test(integralUrl)) throw new PrivacyInvalidInputError("urlIntegral: debe ser un enlace https.");
  const sha = optionalText(b.sha256, "sha256", 64, 64);
  if (sha !== null && !/^[0-9a-f]{64}$/.test(sha)) throw new PrivacyInvalidInputError("sha256: se esperaban 64 caracteres hexadecimales en minuscula.");
  return {
    version: text(b.version, "version", 1, 40),
    simplifiedText: text(b.textoSimplificado, "textoSimplificado", 20, 2000),
    integralUrl,
    mandatoryPurposes: mandatory,
    optionalPurposes: optional,
    contentSha256: sha,
  };
}

export interface ConsentFields {
  readonly noticeId: string;
  readonly acceptedMandatory: readonly string[];
  readonly acceptedOptional: readonly string[];
  readonly channel: ConsentChannel;
  readonly evidenceMethod: ConsentEvidenceMethod;
  readonly sensitiveData: boolean;
}

/** Consentimiento (aviso aceptado, finalidades aceptadas, canal y evidencia). Con datos sensibles exige firma o autenticacion. */
export function parseConsentFields(raw: unknown): ConsentFields {
  const b = asObject(raw);
  const evidenceMethod = oneOf(b.metodo, CONSENT_EVIDENCE_METHODS, "metodo");
  const sensitiveData = b.datosSensibles === undefined ? false : b.datosSensibles;
  if (typeof sensitiveData !== "boolean") throw new PrivacyInvalidInputError("datosSensibles: se esperaba true o false.");
  if (sensitiveData && !CONSENT_WRITTEN_METHODS.includes(evidenceMethod)) {
    throw new PrivacyInvalidInputError("Datos sensibles exigen consentimiento expreso y por escrito: metodo debe ser firma_electronica, firma_autografa o mecanismo_autenticacion.");
  }
  return {
    noticeId: parseUuid(b.avisoId, "avisoId"),
    acceptedMandatory: purposes(b.finalidadesObligatorias, "finalidadesObligatorias", 1),
    acceptedOptional: b.finalidadesOpcionales === undefined || b.finalidadesOpcionales === null ? [] : purposes(b.finalidadesOpcionales, "finalidadesOpcionales", 0),
    channel: oneOf(b.canal, CONSENT_CHANNELS, "canal"),
    evidenceMethod,
    sensitiveData,
  };
}

/** Ventana de bloqueo previa a la purga: entero de 3 a 30 dias. */
export function parseBlockWindowDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < BLOCK_WINDOW_DAYS_MIN || value > BLOCK_WINDOW_DAYS_MAX) {
    throw new PrivacyInvalidInputError(`dias: entero entre ${BLOCK_WINDOW_DAYS_MIN} y ${BLOCK_WINDOW_DAYS_MAX}.`);
  }
  return value;
}

/** Solicitud ARCO nueva. `today` = fecha de negocio; la recepcion no puede estar en el futuro ni tener mas de 365 dias. */
export function parseArcoInput(raw: unknown, today: string): NewArcoRequestInput {
  const b = asObject(raw);
  const receivedOn = b.recibidaEn === undefined || b.recibidaEn === null ? today : ymd(b.recibidaEn, "recibidaEn");
  const diff = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${receivedOn}T00:00:00Z`)) / 86_400_000);
  if (diff < 0) throw new PrivacyInvalidInputError("recibidaEn: no puede estar en el futuro.");
  if (diff > 365) throw new PrivacyInvalidInputError("recibidaEn: no puede ser anterior a 365 dias.");
  return {
    rightType: oneOf(b.derecho, ARCO_RIGHTS, "derecho") as ArcoRight,
    requesterName: text(b.solicitante, "solicitante", 2, 200),
    requesterContact: optionalText(b.contacto, "contacto", 3, 200),
    channel: oneOf(b.canal, ARCO_CHANNELS, "canal") as ArcoChannel,
    description: optionalText(b.descripcion, "descripcion", 1, 1000),
    receivedOn,
    guestId: optionalUuid(b.huespedId, "huespedId"),
    vaultId: optionalUuid(b.identidadId, "identidadId"),
  };
}

const ARCO_TARGETS = ["en_revision", "procedente", "improcedente", "ejecutada"] as const;
/** Avance de una solicitud ARCO: estado destino + nota de 10 a 300 caracteres. */
export function parseArcoAdvance(raw: unknown): { to: ArcoTargetStatus; note: string } {
  const b = asObject(raw);
  return { to: oneOf(b.estado, ARCO_TARGETS, "estado"), note: text(b.nota, "nota", 10, 300) };
}

/** Motivo (prorroga, bloqueo, liberacion...) de 10 a 300 caracteres. */
export function parsePrivacyReason(raw: unknown, field = "motivo"): string {
  return text(asObject(raw)[field], field, 10, 300);
}

/** Incidente nuevo. `now` = reloj del servidor: la deteccion no puede estar en el futuro. */
export function parseIncidentInput(raw: unknown, now: Date): NewIncidentInput {
  const b = asObject(raw);
  let detectedAt = now.toISOString();
  if (b.detectadoEn !== undefined && b.detectadoEn !== null) {
    if (typeof b.detectadoEn !== "string" || Number.isNaN(Date.parse(b.detectadoEn))) throw new PrivacyInvalidInputError("detectadoEn: se esperaba una fecha-hora ISO.");
    if (Date.parse(b.detectadoEn) > now.getTime() + 5 * 60_000) throw new PrivacyInvalidInputError("detectadoEn: no puede estar en el futuro.");
    detectedAt = new Date(b.detectadoEn).toISOString();
  }
  let affected: number | null = null;
  if (b.afectados !== undefined && b.afectados !== null) {
    if (typeof b.afectados !== "number" || !Number.isInteger(b.afectados) || b.afectados < 0 || b.afectados > 10_000_000) throw new PrivacyInvalidInputError("afectados: entero mayor o igual a 0.");
    affected = b.afectados;
  }
  const significant = b.riesgoSignificativo === undefined ? false : b.riesgoSignificativo;
  if (typeof significant !== "boolean") throw new PrivacyInvalidInputError("riesgoSignificativo: se esperaba true o false.");
  return {
    incidentType: oneOf(b.tipo, INCIDENT_TYPES, "tipo") as IncidentType,
    severity: oneOf(b.severidad, INCIDENT_SEVERITIES, "severidad") as IncidentSeverity,
    title: text(b.titulo, "titulo", 3, 120),
    description: text(b.descripcion, "descripcion", 10, 1000),
    detectedAt,
    affectedCount: affected,
    significantRisk: significant,
  };
}

export interface IncidentActionInput {
  readonly action: IncidentAction;
  readonly note: string | null;
  readonly channel: string | null;
  /** Constancia de la notificacion; en `cerrar` con riesgo significativo sin notificacion, el motivo de no notificar. */
  readonly ref: string | null;
}

export function parseIncidentAction(raw: unknown): IncidentActionInput {
  const b = asObject(raw);
  const action = oneOf(b.accion, ["contener", "registrar_notificacion", "cerrar"] as const, "accion");
  if (action === "registrar_notificacion") {
    return { action, note: null, channel: text(b.canal, "canal", 2, 60), ref: text(b.constancia, "constancia", 1, 200) };
  }
  if (action === "cerrar") {
    return { action, note: text(b.nota, "nota", 10, 300), channel: null, ref: optionalText(b.motivoNoNotificar, "motivoNoNotificar", 10, 300) };
  }
  return { action, note: optionalText(b.nota, "nota", 1, 300), channel: null, ref: null };
}

/** Retencion legal: folio del caso, motivo y quien autoriza (los tres obligatorios). */
export function parseLegalHoldInput(raw: unknown, vaultId: string): NewLegalHoldInput {
  const b = asObject(raw);
  return {
    vaultId,
    folio: text(b.folio, "folio", 3, 60),
    reason: text(b.motivo, "motivo", 10, 300),
    authorizationRef: text(b.autorizacion, "autorizacion", 3, 200),
    incidentId: optionalUuid(b.incidenteId, "incidenteId"),
  };
}

/** Verifica contra el aviso (ANTES de capturar): se aceptan EXACTAMENTE las finalidades obligatorias y las opcionales son un subconjunto.
 *  La base lo vuelve a exigir con un trigger; aqui da un error claro y evita capturas a medias en adaptadores sin transaccion real. */
export function assertConsentMatchesNotice(fields: Pick<ConsentFields, "acceptedMandatory" | "acceptedOptional">, notice: Pick<PrivacyNoticeRecord, "version" | "mandatoryPurposes" | "optionalPurposes">): void {
  const accepted = new Set(fields.acceptedMandatory);
  const missing = notice.mandatoryPurposes.filter((p) => !accepted.has(p));
  const extra = fields.acceptedMandatory.filter((p) => !notice.mandatoryPurposes.includes(p));
  if (missing.length > 0 || extra.length > 0) {
    throw new PrivacyInvalidInputError(`finalidadesObligatorias: se deben aceptar exactamente las del aviso ${notice.version} (${notice.mandatoryPurposes.join("; ")}).`);
  }
  const unknown = fields.acceptedOptional.filter((p) => !notice.optionalPurposes.includes(p));
  if (unknown.length > 0) throw new PrivacyInvalidInputError(`finalidadesOpcionales: no estan en el aviso ${notice.version}: ${unknown.join("; ")}.`);
}

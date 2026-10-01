// Servicio de la boveda de identidad (H-01): validacion de entrada, cifrado/descifrado y
// calculo de retencion, sobre el puerto `IdentityRepository`. El documento en claro solo
// existe aqui en memoria; al repositorio solo llega el sobre cifrado.
import { randomUUID } from "node:crypto";
import { identityAad, type IdentityCipher } from "./cipher.ts";
import { IdentityAccessDeniedError, IdentityBlockedError, IdentityInvalidInputError, IdentityPurgedError, IdentityUnavailableError } from "./errors.ts";
import type { IdentityRepository } from "./repository.ts";
import { IDENTITY_DOCUMENT_TYPES, type IdentityDocumentType, type IdentityPayload, type IdentityVaultRecord } from "./types.ts";

// POLITICA DE RETENCION (ajuste segun Mexico). DECISIONES DE PRODUCTO, NO MANDATO LEGAL:
// el informe de investigacion (atiende-loop/expertos/retencion-identidad-hoteles-mx.md, 30-sep-2026,
// borrador SIN valor de asesoria legal) no encontro una norma federal verificada que obligue a
// conservar la IMAGEN del documento; por minimizacion (LFPDPPP arts. 10-12) se purga pronto. Un
// abogado debe confirmar estos plazos antes de presentarlos al hotel como cumplimiento.

/** Dias DESPUES DEL CHECK-OUT que se conserva la imagen/documento cifrado (informe, seccion 4).
 *  Sin reserva o sin fecha de salida, se cuentan desde la captura. Default editable por captura. */
export const IDENTITY_IMAGE_RETENTION_DAYS_DEFAULT = 30;
/** 0 = la imagen vence el mismo dia del check-out (la purga corre en el primer barrido posterior). */
export const IDENTITY_IMAGE_RETENTION_DAYS_MIN = 0;
export const IDENTITY_IMAGE_RETENTION_DAYS_MAX = 365;

/** Registro de huespedes / registro migratorio SIN imagen (`migratory_registration`): solo datos
 *  textuales minimos (nacionalidad, fechas de llegada y salida, constancia). La purga de la
 *  imagen NO lo toca (purge_expired_identities solo anula el sobre en `identity_vault`).
 *  Default de 365 dias desde la fecha de salida: CDMX, Ley de Establecimientos Mercantiles art. 23
 *  fr. II, pide llevar control de llegadas y salidas (texto verificado, sin plazo). Un decreto
 *  CDMX de dic-2025 que fijaria 1 ano NO esta verificado en fuente primaria (solo despachos). */
export const MIGRATORY_RETENTION_DAYS_DEFAULT = 365;
/** Maximo parametrizable (informe: 5 anos con justificacion, CFF art. 30 si se integra a contabilidad). */
export const MIGRATORY_RETENTION_DAYS_MAX = 1825;
/** Minimo por entidad federativa (clave de estado en mayusculas). Solo CDMX tiene piso sugerido por
 *  el informe; el resto no tiene minimo verificado. */
export const MIGRATORY_RETENTION_MIN_DAYS_BY_STATE: Readonly<Record<string, number>> = { CDMX: 365 };

export interface CaptureIdentityInput {
  readonly guestId: string;
  readonly reservationId: string | null;
  readonly documentType: IdentityDocumentType;
  readonly nationality: string | null;
  /** Dias tras el check-out indicados por el usuario; `null` = usar el default (30). */
  readonly retentionDays: number | null;
  readonly payload: IdentityPayload;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(ymd: string): boolean {
  if (!YMD_RE.test(ymd)) return false;
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new IdentityInvalidInputError(`${field}: se esperaba texto.`);
  const t = value.trim();
  if (t === "") return null;
  if (t.length > max) throw new IdentityInvalidInputError(`${field}: maximo ${max} caracteres.`);
  return t;
}

function optionalDate(value: unknown, field: string): string | null {
  const t = optionalText(value, field, 10);
  if (t === null) return null;
  if (!isRealDate(t)) throw new IdentityInvalidInputError(`${field}: se esperaba una fecha real YYYY-MM-DD.`);
  return t;
}

function optionalIso3(value: unknown, field: string): string | null {
  const t = optionalText(value, field, 3);
  if (t === null) return null;
  const up = t.toUpperCase();
  if (!/^[A-Z]{3}$/.test(up)) throw new IdentityInvalidInputError(`${field}: se esperaba un codigo de pais ISO 3166-1 alfa-3 (ej. MEX, USA).`);
  return up;
}

/** Valida el cuerpo crudo de captura. Lanza `IdentityInvalidInputError` (-> 400/422). */
export function parseCaptureIdentityInput(raw: unknown): CaptureIdentityInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IdentityInvalidInputError("El cuerpo debe ser un objeto JSON.");
  const b = raw as Record<string, unknown>;
  if (typeof b.guestId !== "string" || !UUID_RE.test(b.guestId)) throw new IdentityInvalidInputError("guestId: se esperaba un UUID.");
  let reservationId: string | null = null;
  if (b.reservationId !== undefined && b.reservationId !== null) {
    if (typeof b.reservationId !== "string" || !UUID_RE.test(b.reservationId)) throw new IdentityInvalidInputError("reservationId: se esperaba un UUID.");
    reservationId = b.reservationId;
  }
  if (typeof b.documentType !== "string" || !(IDENTITY_DOCUMENT_TYPES as readonly string[]).includes(b.documentType)) {
    throw new IdentityInvalidInputError(`documentType: se esperaba uno de ${IDENTITY_DOCUMENT_TYPES.join(", ")}.`);
  }
  const fullName = optionalText(b.fullName, "fullName", 200);
  if (!fullName || fullName.length < 2) throw new IdentityInvalidInputError("fullName: requerido (2 a 200 caracteres).");
  const documentNumber = optionalText(b.documentNumber, "documentNumber", 40);
  if (!documentNumber || documentNumber.length < 3) throw new IdentityInvalidInputError("documentNumber: requerido (3 a 40 caracteres).");
  if (!/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/.test(documentNumber)) throw new IdentityInvalidInputError("documentNumber: solo letras, numeros, espacios y . / -");
  const mrz = optionalText(b.mrz, "mrz", 200);
  if (mrz !== null && !/^[A-Z0-9<\n ]+$/.test(mrz)) throw new IdentityInvalidInputError("mrz: solo A-Z, 0-9, < y saltos de linea.");
  let retentionDays: number | null = null;
  if (b.retentionDays !== undefined && b.retentionDays !== null) {
    if (typeof b.retentionDays !== "number" || !Number.isInteger(b.retentionDays) || b.retentionDays < IDENTITY_IMAGE_RETENTION_DAYS_MIN || b.retentionDays > IDENTITY_IMAGE_RETENTION_DAYS_MAX) {
      throw new IdentityInvalidInputError(`retentionDays: entero entre ${IDENTITY_IMAGE_RETENTION_DAYS_MIN} y ${IDENTITY_IMAGE_RETENTION_DAYS_MAX} dias despues del check-out.`);
    }
    retentionDays = b.retentionDays;
  }
  return {
    guestId: b.guestId,
    reservationId,
    documentType: b.documentType as IdentityDocumentType,
    nationality: optionalIso3(b.nationality, "nationality"),
    retentionDays,
    payload: {
      fullName,
      documentNumber,
      birthDate: optionalDate(b.birthDate, "birthDate"),
      issuingCountry: optionalIso3(b.issuingCountry, "issuingCountry"),
      expiryDate: optionalDate(b.expiryDate, "expiryDate"),
      mrz,
    },
  };
}

/** Motivo de acceso/purga/decision: texto de 10 a 300 caracteres (mismo rango que el SQL). */
export function parseReason(value: unknown, field = "motivo"): string {
  if (typeof value !== "string") throw new IdentityInvalidInputError(`${field}: requerido (10 a 300 caracteres).`);
  const t = value.trim();
  if (t.length < 10 || t.length > 300) throw new IdentityInvalidInputError(`${field}: debe tener entre 10 y 300 caracteres.`);
  return t;
}

/** Suma `days` a una fecha YYYY-MM-DD (aritmetica de calendario en UTC, sin zona horaria). */
export function addDaysYmd(ymd: string, days: number): string {
  if (!isRealDate(ymd)) throw new Error(`addDaysYmd: fecha invalida ${ymd}`);
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Ultimos 4 caracteres alfanumericos del numero de documento (metadato NO secreto para
 *  mostrar "****1234" sin descifrar). */
export function documentLast4(documentNumber: string): string | null {
  const alnum = documentNumber.replace(/[^A-Za-z0-9]/g, "");
  return alnum.length === 0 ? null : alnum.slice(-4);
}

/** Fecha limite de la imagen cifrada: `retentionDays` (default 30) despues del check-out; sin
 *  fecha de salida, despues de la captura (`today`). `retention_until` se compara con `<` en la
 *  purga, asi que la imagen se purga el primer barrido posterior a esa fecha. */
export function computeImageRetentionUntil(args: { readonly today: string; readonly checkOutDate: string | null; readonly retentionDays: number | null }): string {
  const days = args.retentionDays ?? IDENTITY_IMAGE_RETENTION_DAYS_DEFAULT;
  if (!Number.isInteger(days) || days < IDENTITY_IMAGE_RETENTION_DAYS_MIN || days > IDENTITY_IMAGE_RETENTION_DAYS_MAX) {
    throw new IdentityInvalidInputError(`retentionDays: entero entre ${IDENTITY_IMAGE_RETENTION_DAYS_MIN} y ${IDENTITY_IMAGE_RETENTION_DAYS_MAX} dias despues del check-out.`);
  }
  const base = args.checkOutDate !== null && isRealDate(args.checkOutDate) ? args.checkOutDate : args.today;
  return addDaysYmd(base, days);
}

/** Dias de retencion del registro migratorio/de huespedes (sin imagen). `stateCode` (ej. "CDMX")
 *  aplica el piso de la entidad; un `overrideDays` por debajo del piso se rechaza. */
export function resolveMigratoryRetentionDays(opts: { readonly stateCode?: string | null; readonly overrideDays?: number | null } = {}): number {
  const floor = MIGRATORY_RETENTION_MIN_DAYS_BY_STATE[(opts.stateCode ?? "").trim().toUpperCase()] ?? 0;
  const days = opts.overrideDays ?? Math.max(MIGRATORY_RETENTION_DAYS_DEFAULT, floor);
  if (!Number.isInteger(days) || days < floor || days > MIGRATORY_RETENTION_DAYS_MAX) {
    throw new IdentityInvalidInputError(`retencion del registro: entero entre ${floor} y ${MIGRATORY_RETENTION_DAYS_MAX} dias.`);
  }
  return days;
}

/** Fecha hasta la que se conserva el registro migratorio: salida + dias de retencion. */
export function computeMigratoryRetentionUntil(departureDate: string, days: number = MIGRATORY_RETENTION_DAYS_DEFAULT): string {
  return addDaysYmd(departureDate, days);
}

export class IdentityVaultService {
  constructor(
    private readonly repo: IdentityRepository,
    /** `null` = llave no configurada: captura/revelacion responden 503 (nunca se guarda en claro). */
    private readonly cipher: IdentityCipher | null,
  ) {}

  /** `today` = fecha de negocio (YYYY-MM-DD) calculada por el llamador con la zona de la property.
   *  `checkOutDate` = salida de la reserva ligada (o `null`: el plazo cuenta desde `today`). */
  async capture(args: { propertyId: string; actorUserId: string; today: string; checkOutDate?: string | null; input: CaptureIdentityInput }): Promise<IdentityVaultRecord> {
    if (!this.cipher) throw new IdentityUnavailableError("llave_no_configurada", "capture");
    const { propertyId, actorUserId, today, input } = args;
    const checkOutDate = args.checkOutDate ?? null;
    const id = randomUUID();
    const payloadEnc = this.cipher.encrypt(JSON.stringify(input.payload), identityAad(id, propertyId));
    return this.repo.captureIdentity({
      id,
      propertyId,
      guestId: input.guestId,
      reservationId: input.reservationId,
      documentType: input.documentType,
      nationality: input.nationality,
      documentLast4: documentLast4(input.payload.documentNumber),
      payloadEnc,
      keyVersion: this.cipher.keyVersion,
      retentionUntil: computeImageRetentionUntil({ today, checkOutDate, retentionDays: input.retentionDays }),
      actorUserId,
    });
  }

  /** Revela el documento: verifica que la identidad sea de ESA property, pide el sobre a la
   *  base (que autoriza, exige motivo y deja huella en la misma transaccion) y lo descifra. */
  async reveal(args: { propertyId: string; vaultId: string; reason: string; actorUserId: string }): Promise<{ record: IdentityVaultRecord; payload: IdentityPayload }> {
    if (!this.cipher) throw new IdentityUnavailableError("llave_no_configurada", "reveal");
    const record = await this.repo.findIdentity(args.propertyId, args.vaultId);
    if (!record) throw new IdentityAccessDeniedError("reveal");
    if (record.status === "bloqueada") throw new IdentityBlockedError();
    if (record.status !== "activo") throw new IdentityPurgedError();
    const { envelope } = await this.repo.revealIdentity(args.vaultId, args.reason, args.actorUserId);
    const plaintext = this.cipher.decrypt(envelope, identityAad(record.id, record.propertyId));
    return { record, payload: JSON.parse(plaintext) as IdentityPayload };
  }

  /** Acceso EXCEPCIONAL a una identidad bloqueada (migracion 032): consume una aprobacion vigente de doble control
   *  (la base valida que la pidio quien llama, que no caduco y que no se uso) y descifra el sobre. */
  async revealBlocked(args: { propertyId: string; vaultId: string; accessRequestId: string; actorUserId: string }): Promise<{ record: IdentityVaultRecord; payload: IdentityPayload }> {
    if (!this.cipher) throw new IdentityUnavailableError("llave_no_configurada", "reveal-blocked");
    const record = await this.repo.findIdentity(args.propertyId, args.vaultId);
    if (!record) throw new IdentityAccessDeniedError("reveal-blocked");
    if (record.status === "purgado") throw new IdentityPurgedError();
    if (record.status !== "bloqueada") throw new IdentityAccessDeniedError("reveal-blocked");
    const { envelope } = await this.repo.revealBlockedIdentity(args.accessRequestId, args.actorUserId);
    const plaintext = this.cipher.decrypt(envelope, identityAad(record.id, record.propertyId));
    return { record, payload: JSON.parse(plaintext) as IdentityPayload };
  }
}

// Servicio de la boveda de identidad (H-01): validacion de entrada, cifrado/descifrado y
// calculo de retencion, sobre el puerto `IdentityRepository`. El documento en claro solo
// existe aqui en memoria; al repositorio solo llega el sobre cifrado.
import { randomUUID } from "node:crypto";
import { identityAad, type IdentityCipher } from "./cipher.ts";
import { IdentityAccessDeniedError, IdentityInvalidInputError, IdentityPurgedError, IdentityUnavailableError } from "./errors.ts";
import type { IdentityRepository } from "./repository.ts";
import { IDENTITY_DOCUMENT_TYPES, type IdentityDocumentType, type IdentityPayload, type IdentityVaultRecord } from "./types.ts";

/** Retencion por defecto del documento. DECISION DE PRODUCTO/LEGAL PENDIENTE DE CONFIRMAR
 *  (plazo exigible al hotel por la normativa migratoria y de datos personales): es solo el
 *  default editable por captura (30..3650 dias), no una afirmacion legal. */
export const IDENTITY_RETENTION_DAYS_DEFAULT = 365;
export const IDENTITY_RETENTION_DAYS_MIN = 30;
export const IDENTITY_RETENTION_DAYS_MAX = 3650;

export interface CaptureIdentityInput {
  readonly guestId: string;
  readonly reservationId: string | null;
  readonly documentType: IdentityDocumentType;
  readonly nationality: string | null;
  readonly retentionDays: number;
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
  let retentionDays = IDENTITY_RETENTION_DAYS_DEFAULT;
  if (b.retentionDays !== undefined && b.retentionDays !== null) {
    if (typeof b.retentionDays !== "number" || !Number.isInteger(b.retentionDays) || b.retentionDays < IDENTITY_RETENTION_DAYS_MIN || b.retentionDays > IDENTITY_RETENTION_DAYS_MAX) {
      throw new IdentityInvalidInputError(`retentionDays: entero entre ${IDENTITY_RETENTION_DAYS_MIN} y ${IDENTITY_RETENTION_DAYS_MAX}.`);
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

export class IdentityVaultService {
  constructor(
    private readonly repo: IdentityRepository,
    /** `null` = llave no configurada: captura/revelacion responden 503 (nunca se guarda en claro). */
    private readonly cipher: IdentityCipher | null,
  ) {}

  /** `today` = fecha de negocio (YYYY-MM-DD) calculada por el llamador con la zona de la property. */
  async capture(args: { propertyId: string; actorUserId: string; today: string; input: CaptureIdentityInput }): Promise<IdentityVaultRecord> {
    if (!this.cipher) throw new IdentityUnavailableError("llave_no_configurada", "capture");
    const { propertyId, actorUserId, today, input } = args;
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
      retentionUntil: addDaysYmd(today, input.retentionDays),
      actorUserId,
    });
  }

  /** Revela el documento: verifica que la identidad sea de ESA property, pide el sobre a la
   *  base (que autoriza, exige motivo y deja huella en la misma transaccion) y lo descifra. */
  async reveal(args: { propertyId: string; vaultId: string; reason: string; actorUserId: string }): Promise<{ record: IdentityVaultRecord; payload: IdentityPayload }> {
    if (!this.cipher) throw new IdentityUnavailableError("llave_no_configurada", "reveal");
    const record = await this.repo.findIdentity(args.propertyId, args.vaultId);
    if (!record) throw new IdentityAccessDeniedError("reveal");
    if (record.status !== "activo") throw new IdentityPurgedError();
    const { envelope } = await this.repo.revealIdentity(args.vaultId, args.reason, args.actorUserId);
    const plaintext = this.cipher.decrypt(envelope, identityAad(record.id, record.propertyId));
    return { record, payload: JSON.parse(plaintext) as IdentityPayload };
  }
}

// H-30 -- superficie PUBLICA de privacidad del huesped: contratos y utilidades puras (sin I/O).
// Modelo en packages/domain-hoteles/migrations/041_hoteles_privacidad_publica_huesped.sql.
//
// Dos repositorios con sesiones distintas:
//   - PublicPrivacyRepository: SESION DE SISTEMA (sin usuario). Aviso vigente, alta publica de ARCO, verificacion del
//     codigo y el snapshot "mis datos". Solo funciones `security definer` que exigen auth.uid() nulo.
//   - GuestDataRepository: SESION DE STAFF (owner/gm). Exportacion de datos del huesped y emision del enlace
//     "mis datos"; la base autoriza y deja huella en la bitacora de privacidad.
import { PrivacyInvalidInputError } from "./errors.ts";
import { ARCO_RIGHTS, type ArcoRight } from "./types.ts";

export interface PublicNotice {
  readonly id: string;
  readonly version: string;
  readonly simplifiedText: string;
  readonly integralUrl: string | null;
  readonly mandatoryPurposes: readonly string[];
  readonly optionalPurposes: readonly string[];
  readonly publishedAt: string;
}
export interface PublicNoticeProperty {
  readonly propertyId: string;
  readonly propertyName: string;
  /** `null`: el hotel aun no publica un aviso vigente (nunca se inventa uno). */
  readonly notice: PublicNotice | null;
}
export interface PublicNoticesResult {
  /** `false`: base sin la migracion 042 -- "no disponible aun". */
  readonly available: boolean;
  readonly organizationName: string | null;
  readonly properties: readonly PublicNoticeProperty[];
}

export interface VerificationEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}
export interface SubmitPublicArcoInput {
  readonly requestId: string;
  readonly propertyId: string;
  readonly rightType: ArcoRight;
  readonly name: string;
  readonly contact: string;
  readonly description: string | null;
  /** HMAC-SHA256 hex del codigo (nunca el codigo). */
  readonly codeHash: string;
  readonly ttlSeconds: number;
  readonly email: VerificationEmail;
  /** Fecha de negocio (YYYY-MM-DD). */
  readonly today: string;
}
export type PublicVerifyResult = "ok" | "invalido" | "expirado" | "agotado" | "usado";
export interface PublicVerifyOutcome {
  readonly result: PublicVerifyResult;
  readonly organizationId: string | null;
  readonly propertyId: string | null;
  readonly folio: string | null;
}

/** Documento de datos del huesped (JSON de `hoteles.guest_data_snapshot`). Las secciones de staff solo existen en el alcance 'staff'. */
export interface GuestDataDocument {
  readonly perfil: Readonly<Record<string, unknown>>;
  readonly estancias: readonly Readonly<Record<string, unknown>>[];
  readonly consentimientos: readonly Readonly<Record<string, unknown>>[];
  readonly identidad: readonly Readonly<Record<string, unknown>>[];
  readonly notas?: readonly Readonly<Record<string, unknown>>[];
  readonly solicitudesContacto?: readonly Readonly<Record<string, unknown>>[];
  readonly conversaciones?: readonly Readonly<Record<string, unknown>>[];
  readonly folio?: string;
  readonly solicitudId?: string;
}
export type ExportFormat = "json" | "csv";

export interface AccessGrant {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly folio: string;
  readonly contact: string | null;
  readonly orgSlug: string;
  readonly orgName: string;
}

export interface PublicPrivacyRepository {
  listNotices(orgSlug: string): Promise<PublicNoticesResult>;
  /** Devuelve la referencia o `null` si se alcanzo el tope por contacto (la ruta responde igual). Lanza `PrivacyUnavailableError` sin la migracion. */
  submitArco(input: SubmitPublicArcoInput): Promise<string | null>;
  /** `today` null = la base usa la fecha de negocio de la zona horaria de la property. */
  verifyArco(requestId: string, codeHash: string, today: string | null): Promise<PublicVerifyOutcome>;
  /** `null` si la solicitud no es del hotel del slug, no es de acceso procedente/ejecutada o no esta ligada a un huesped. */
  accessSnapshot(requestId: string, orgSlug: string): Promise<GuestDataDocument | null>;
}

export interface GuestDataRepository {
  exportGuestData(propertyId: string, guestId: string, format: ExportFormat): Promise<GuestDataDocument>;
  grantAccess(requestId: string, guestId: string): Promise<AccessGrant>;
}

// ---------------------------------------------------------------------------
// Entrada publica
// ---------------------------------------------------------------------------

export interface PublicArcoForm {
  readonly rightType: ArcoRight;
  readonly name: string;
  readonly email: string;
  readonly description: string | null;
  /** Slug de la propiedad (opcional si el hotel tiene una sola). */
  readonly propertySlug: string | null;
  /** Honeypot lleno: es un robot; la ruta responde igual que un exito y no guarda nada. */
  readonly honeypot: boolean;
}

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$/;

function trimmed(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new PrivacyInvalidInputError(`${field}: requerido.`);
  const t = value.trim();
  if (t.length < min || t.length > max) throw new PrivacyInvalidInputError(`${field}: debe tener entre ${min} y ${max} caracteres.`);
  return t;
}

export function parsePublicArcoForm(raw: unknown): PublicArcoForm {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PrivacyInvalidInputError("El cuerpo debe ser un objeto JSON.");
  const b = raw as Record<string, unknown>;
  const honeypot = typeof b.sitioWeb === "string" && b.sitioWeb.trim() !== "";
  if (honeypot) {
    // No se valida nada mas: el robot recibe la misma respuesta de exito que un titular real.
    return { rightType: "acceso", name: "", email: "", description: null, propertySlug: null, honeypot: true };
  }
  if (typeof b.derecho !== "string" || !(ARCO_RIGHTS as readonly string[]).includes(b.derecho)) {
    throw new PrivacyInvalidInputError(`derecho: se esperaba uno de ${ARCO_RIGHTS.join(", ")}.`);
  }
  const email = trimmed(b.correo, "correo", 5, 200).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new PrivacyInvalidInputError("correo: debe ser un correo valido.");
  const description = b.descripcion === undefined || b.descripcion === null || (typeof b.descripcion === "string" && b.descripcion.trim() === "") ? null : trimmed(b.descripcion, "descripcion", 1, 1000);
  const propertySlug = b.propiedad === undefined || b.propiedad === null || b.propiedad === "" ? null : trimmed(b.propiedad, "propiedad", 1, 120);
  return { rightType: b.derecho as ArcoRight, name: trimmed(b.nombre, "nombre", 2, 200), email, description, propertySlug, honeypot: false };
}

/** Codigo de verificacion: 6 digitos. */
export const VERIFICATION_CODE_RE = /^\d{6}$/;

export function parseVerificationCode(raw: unknown): string {
  if (typeof raw !== "string" || !VERIFICATION_CODE_RE.test(raw.trim())) throw new PrivacyInvalidInputError("codigo: 6 digitos.");
  return raw.trim();
}

/** Slug estable de una property (para `?property=`): minusculas, sin acentos, guiones. */
export function propertySlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Escoge la property de un hotel: por slug; sin slug, solo si hay una unica. `null` = ambigua o inexistente. */
export function pickProperty(properties: readonly PublicNoticeProperty[], slug: string | null): PublicNoticeProperty | null {
  if (slug) return properties.find((p) => propertySlug(p.propertyName) === slug.toLowerCase()) ?? null;
  return properties.length === 1 ? (properties[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Exportacion CSV
// ---------------------------------------------------------------------------

/** Neutraliza formulas de hoja de calculo (=, +, -, @, tab, retorno) en celdas con texto del huesped o del staff. */
export function csvCell(value: unknown): string {
  let t = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** CSV plano `seccion,indice,campo,valor`: una fila por campo, para abrir en cualquier hoja de calculo. */
export function guestDataToCsv(doc: GuestDataDocument): string {
  const rows: string[] = [["seccion", "indice", "campo", "valor"].map(csvCell).join(",")];
  for (const [section, content] of Object.entries(doc)) {
    if (Array.isArray(content)) {
      content.forEach((item, i) => {
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) rows.push([section, i + 1, k, v].map(csvCell).join(","));
      });
    } else if (content && typeof content === "object") {
      for (const [k, v] of Object.entries(content as Record<string, unknown>)) rows.push([section, "", k, v].map(csvCell).join(","));
    } else {
      rows.push([section, "", "", content].map(csvCell).join(","));
    }
  }
  return `${rows.join("\r\n")}\r\n`;
}

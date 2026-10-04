// Boveda de documentos de la convocatoria (L-P3-05): tipos, validacion de subida por magic bytes en TODO el buffer
// (AE-03/AE-05 del suelto) y claves estables (matriz de requisitos y conflictos). Funciones PURAS, sin I/O.
//
// Validacion de subida -- el contenido manda, no el nombre ni el mime:
//  - ZIP (PK..) se rechaza siempre: un .docx/.xlsx/.zip es un contenedor que esta fase no abre y que puede ocultar contenido.
//  - Un ejecutable (PE de Windows "MZ"+"PE", ELF, Mach-O) se rechaza donde sea que aparezca: al inicio, o pegado al
//    final de un PDF valido (polyglot). El PE se confirma con su cabecera (e_lfanew -> "PE\0\0"), asi un "MZ" casual
//    dentro de un stream comprimido no produce un falso positivo.
//  - Un PDF debe empezar con "%PDF-" y terminar en "%%EOF"; tras el ultimo "%%EOF" solo se admite espacio en blanco.
//    Un PDF truncado (sin %%EOF) o con contenido colgado despues del EOF se rechaza.
//  - Texto plano: sin bytes NUL y con proporcion baja de caracteres de control.
import { createHash } from "node:crypto";

export const TENDER_DOCUMENT_TYPES = ["bases", "anexo", "acta_junta", "modificacion", "fallo", "other"] as const;
export type TenderDocumentType = (typeof TENDER_DOCUMENT_TYPES)[number];

export function isTenderDocumentType(value: unknown): value is TenderDocumentType {
  return typeof value === "string" && (TENDER_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export const TENDER_DOCUMENT_TYPE_LABELS: Readonly<Record<TenderDocumentType, string>> = {
  bases: "Bases",
  anexo: "Anexo",
  acta_junta: "Acta de junta de aclaraciones",
  modificacion: "Modificación a las bases",
  fallo: "Fallo",
  other: "Otro",
};

export type DocumentExtractionStatus = "extracted" | "requires_ocr" | "failed";

export interface TenderDocumentRecord {
  readonly id: string;
  readonly tenderId: string;
  readonly documentType: TenderDocumentType;
  readonly title: string | null;
  readonly filename: string | null;
  readonly mimeType: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly pageCount: number | null;
  /** `null` = fila anterior a la migracion 037 (sin informacion): nunca se inventa un estado para ella. */
  readonly extractionStatus: DocumentExtractionStatus | null;
  readonly extractionDetail: string | null;
  readonly lineageId: string;
  readonly version: number;
  /** `true` si es la version vigente de su linaje (la mas alta). */
  readonly latest: boolean;
  readonly uploadedBy: string | null;
  readonly createdAt: string;
}

export interface TenderDocumentWithPages extends TenderDocumentRecord {
  readonly pages: readonly { readonly page: number; readonly text: string }[] | null;
}

export type UploadRejectionReason = "vacio" | "zip_rechazado" | "ejecutable_rechazado" | "pdf_sin_eof" | "pdf_contenido_tras_eof" | "formato_no_soportado";

export type UploadValidation =
  | { readonly ok: true; readonly kind: "pdf" | "text" }
  | { readonly ok: false; readonly reason: UploadRejectionReason; readonly message: string };

const WHITESPACE_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buffer[i] !== bytes[i]) return false;
  return true;
}

function isZip(buffer: Buffer): boolean {
  return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) || startsWith(buffer, [0x50, 0x4b, 0x07, 0x08]);
}

/** Ejecutable nativo al inicio (ELF, Mach-O) o imagen PE de Windows en CUALQUIER posicion del buffer. */
function containsExecutable(buffer: Buffer): boolean {
  if (startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  for (const magic of [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]] as const) {
    if (startsWith(buffer, magic)) return true; // Mach-O / fat binary
  }
  let from = 0;
  for (;;) {
    const i = buffer.indexOf("MZ", from, "latin1");
    if (i === -1) return false;
    if (i + 0x40 <= buffer.length) {
      const peOffset = buffer.readUInt32LE(i + 0x3c);
      const at = i + peOffset;
      if (peOffset >= 0x40 && peOffset <= 0x1000 && at + 4 <= buffer.length && buffer[at] === 0x50 && buffer[at + 1] === 0x45 && buffer[at + 2] === 0 && buffer[at + 3] === 0) return true;
    }
    from = i + 2;
  }
}

function looksLikeText(buffer: Buffer): boolean {
  if (buffer.indexOf(0x00) !== -1) return false;
  const text = buffer.toString("utf8");
  if (text.length === 0) return false;
  let control = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / text.length <= 0.02;
}

export function validateDocumentUpload(buffer: Buffer): UploadValidation {
  if (buffer.length === 0) return { ok: false, reason: "vacio", message: "El archivo está vacío." };
  if (isZip(buffer)) return { ok: false, reason: "zip_rechazado", message: "Los archivos comprimidos (ZIP, DOCX, XLSX) no se aceptan: suba el PDF o un texto plano." };
  if (containsExecutable(buffer)) return { ok: false, reason: "ejecutable_rechazado", message: "El archivo contiene un ejecutable y se rechazó." };
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    const eof = buffer.lastIndexOf("%%EOF", buffer.length, "latin1");
    if (eof === -1) return { ok: false, reason: "pdf_sin_eof", message: "El PDF está incompleto (no termina en %%EOF)." };
    for (let i = eof + 5; i < buffer.length; i += 1) {
      if (!WHITESPACE_BYTES.has(buffer[i]!)) return { ok: false, reason: "pdf_contenido_tras_eof", message: "El PDF trae contenido después de su marca de fin (%%EOF) y se rechazó." };
    }
    return { ok: true, kind: "pdf" };
  }
  if (looksLikeText(buffer)) return { ok: true, kind: "text" };
  return { ok: false, reason: "formato_no_soportado", message: "Formato no soportado: solo PDF con texto o texto plano." };
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeForKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Clave estable de un requisito entre re-extracciones: documento (o linaje) + tema + pagina + clausula + huella del
 * texto normalizado. Re-extraer el mismo documento da la misma clave, asi se actualiza la fila en vez de duplicarla y
 * se conservan el responsable, el estado y la asignacion hechos a mano. `documentRef` es el linaje de la boveda (una
 * version nueva del mismo documento conserva su clave) o la etiqueta del documento cuando no viene de la boveda.
 */
export function requirementStableKey(input: { readonly documentRef: string; readonly topicKey: string | null; readonly page: number | null; readonly clause: string | null; readonly text: string }): string {
  const raw = [input.documentRef, input.topicKey ?? "", input.page ?? "", input.clause ?? "", normalizeForKey(input.text)].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/** Huella de un conflicto: tipo + tema + claves estables de los requisitos en disputa (orden irrelevante). */
export function conflictStableKey(kind: string, topicKey: string | null, stableKeys: readonly string[]): string {
  const raw = [kind, topicKey ?? "", [...stableKeys].sort().join(",")].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

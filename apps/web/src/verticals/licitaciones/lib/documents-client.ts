// Cliente de la boveda de documentos de la convocatoria (paridad3 L-P3-05): bases, anexos, actas de junta,
// modificaciones y fallo. Rutas: GET/POST .../documents, GET .../documents/:id?page=N (visor de la cita) y
// POST .../requirements/extract con `documentIds` (re-extraer sin volver a subir).
import { fetchJson, postJson } from "./admin-client.ts";
import { fileToBase64 } from "./requirements-client.ts";
import type { ExtractRequirementsResult } from "./requirements-client.ts";

export type TenderDocumentType = "bases" | "anexo" | "acta_junta" | "modificacion" | "fallo" | "other";

export const TENDER_DOCUMENT_TYPE_LABELS: Readonly<Record<TenderDocumentType, string>> = {
  bases: "Bases",
  anexo: "Anexo",
  acta_junta: "Acta de junta de aclaraciones",
  modificacion: "Modificación a las bases",
  fallo: "Fallo",
  other: "Otro",
};

export const TENDER_DOCUMENT_TYPES = Object.keys(TENDER_DOCUMENT_TYPE_LABELS) as TenderDocumentType[];

export type DocumentExtractionStatus = "extracted" | "requires_ocr" | "failed";

export interface TenderDocument {
  readonly id: string;
  readonly tenderId: string;
  readonly documentType: TenderDocumentType;
  readonly title: string | null;
  readonly filename: string | null;
  readonly mimeType: string | null;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly pageCount: number | null;
  readonly extractionStatus: DocumentExtractionStatus | null;
  readonly extractionDetail: string | null;
  readonly lineageId: string;
  readonly version: number;
  readonly latest: boolean;
  readonly createdAt: string;
}

export interface DocumentsListResult {
  /** `false` = la base todavía no tiene la migración 037: la bóveda no está disponible. */
  readonly disponible: boolean;
  readonly documents: readonly TenderDocument[];
}

const base = (apiBaseUrl: string, propertyId: string, tenderId: string) => `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}`;

export async function fetchTenderDocuments(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<DocumentsListResult> {
  const body = await fetchJson<DocumentsListResult>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/documents`, token);
  return { disponible: body.disponible, documents: body.documents };
}

export interface UploadDocumentInput {
  readonly file: File;
  readonly documentType: TenderDocumentType;
  readonly title: string | null;
  /** Si se indica, el archivo es una versión nueva de ese documento. */
  readonly replacesDocumentId: string | null;
}

export async function uploadTenderDocument(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: UploadDocumentInput,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<TenderDocument> {
  const body = await postJson<{ document: TenderDocument }>(
    fetchImpl,
    `${base(apiBaseUrl, propertyId, tenderId)}/documents`,
    token,
    {
      documentType: input.documentType,
      title: input.title,
      filename: input.file.name,
      mimeType: input.file.type || null,
      contentBase64: await fileToBase64(input.file),
      replacesDocumentId: input.replacesDocumentId,
    },
    { "idempotency-key": idempotencyKey },
  );
  return body.document;
}

export interface DocumentPageResult {
  readonly document: TenderDocument;
  readonly page: { readonly page: number; readonly text: string } | null;
}

/** Visor de la cita: el texto de UNA página del documento guardado. */
export async function fetchDocumentPage(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, documentId: string, page: number): Promise<DocumentPageResult> {
  return fetchJson<DocumentPageResult>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/documents/${documentId}?page=${page}`, token);
}

/** Re-extrae los requisitos de documentos ya guardados (sin volver a subirlos). */
export async function extractRequirementsFromDocuments(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  documentIds: readonly string[],
  idempotencyKey: string = crypto.randomUUID(),
): Promise<ExtractRequirementsResult> {
  return postJson<ExtractRequirementsResult>(fetchImpl, `${base(apiBaseUrl, propertyId, tenderId)}/requirements/extract`, token, { documentIds }, { "idempotency-key": idempotencyKey });
}

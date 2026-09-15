// Cliente web de requisitos extraídos de las bases (Fase 11 pieza acotada) —
// cierra SOLO el prerrequisito compartido documentado en
// checklist-client.ts/README de este vertical ("no hay pantalla de carga de
// documentos, aunque el backend ya extrae texto de PDF nativo",
// technicalProposal.ts): GET .../requirements (lista lo YA persistido,
// `licitaciones.requirement_item`, forma `RequirementItemRecord`) y
// POST .../requirements/extract (sube un PDF -- o texto plano -- convertido a
// base64 en el navegador; el backend corre `extractDocumentText`
// (`@atiende/domain-licitaciones`, motor real `pdfjs-dist`) y sobre ese texto
// `RuleBasedExtractor` [+ `LlmRequirementExtractor` si hay LLM configurado]).
//
// Deliberadamente FUERA de esta pieza (ver README de este vertical): la
// generación de la propuesta técnica/económica
// (`POST .../proposal/technical/generate`, `proposalEconomic.ts`), el mapeo
// de cumplimiento (`PUT .../requirement-mappings/:topicKey`), aprobaciones y
// el ZIP de cierre -- eso es alcance de rondas futuras, esto es solo carga +
// visualización de requisitos.
import { fetchJson, postJson } from "./admin-client.ts";

export type RequirementKind = "tecnico" | "economico" | "legal" | "administrativo" | "anexo";
export type Obligatoriedad = "obligatorio" | "opcional" | "condicional";
export type RequirementStatus = "pendiente" | "en_progreso" | "cumplido" | "bloqueado" | "no_evaluable";

/** Forma persistida (`GET .../requirements`, `RequirementItemRecord` en el API) -- la que este panel usa para LISTAR, siempre recargada después de un `extractRequirements` exitoso (misma disciplina que el resto del vertical: nunca reconciliar a mano dos formas de un mismo requisito). */
export interface RequirementItemRecord {
  readonly id: string;
  readonly documentId: string | null;
  readonly text: string;
  readonly requirementKind: RequirementKind;
  readonly obligatoriedad: Obligatoriedad;
  readonly topicKey: string | null;
  readonly requiredEvidence: readonly string[];
  readonly extractedBy: "rule" | "llm";
  readonly page: number | null;
  readonly clause: string | null;
  readonly responsibleRole: string;
  readonly deadline: string | null;
  readonly status: RequirementStatus;
  readonly confidence: number | null;
}

export async function fetchRequirementItems(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly RequirementItemRecord[]> {
  const body = await fetchJson<{ items: readonly RequirementItemRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/requirements`, token);
  return body.items;
}

/** Documento excluido de la extracción porque su texto no se pudo obtener (PDF escaneado sin capa de texto -> `"requires_ocr"`; formato no soportado/corrupto -> `"failed"`) -- nunca se inventa texto vacío para que "pase" (REQ-166), ver `technicalProposal.ts::resolveDocuments`. */
export interface SkippedDocument {
  readonly documentId: string;
  readonly documentLabel: string;
  readonly status: "requires_ocr" | "failed";
  readonly detail: string | null;
}

/** Un documento a extraer: SIEMPRE bytes reales (`contentBase64`, sin el prefijo `data:...;base64,` -- ver `fileToBase64`), nunca `pages` ya extraído a mano -- esa forma sigue existiendo en el contrato del API (compatibilidad hacia atrás) pero esta pantalla es la de "sube el PDF", no la de pegar texto. */
export interface ExtractDocumentInput {
  readonly documentId: string;
  readonly documentLabel: string;
  /** ISO 8601 -- fecha en la que se publicó/emitió este documento de bases (para el historial, no la fecha de subida). */
  readonly publishedAt: string;
  readonly contentBase64: string;
  readonly mimeType: string | null;
  readonly filename: string | null;
}

/** Forma de dominio que devuelve el POST (`RequirementItem` en el API, NO `RequirementItemRecord` -- distinta a propósito, ver cabecera de `technicalProposal.ts`: `source` en vez de `documentId`/`page`/`clause` sueltos, `type` en vez de `requirementKind`). Este cliente no la usa para listar -- después de extraer, la pantalla vuelve a pedir `fetchRequirementItems` (GET) para mostrar la forma persistida canónica. */
export interface ExtractedRequirementItem {
  readonly id: string;
  readonly text: string;
  readonly source: { readonly documentId: string; readonly documentLabel: string; readonly page: number; readonly clause?: string };
  readonly obligatoriedad: Obligatoriedad;
  readonly type: RequirementKind;
  readonly responsibleRole: string;
  readonly deadline: string | null;
  readonly requiredEvidence: readonly string[];
  readonly status: RequirementStatus;
  readonly extractedBy: "rule" | "llm";
  readonly confidence?: number;
  readonly topicKey?: string;
}

export interface RequirementConflict {
  readonly id: string;
  readonly kind: string;
  readonly topicKey: string | null;
  readonly description: string;
  readonly status: string;
  readonly itemIds: readonly string[];
}

export interface ExtractRequirementsResult {
  readonly items: readonly ExtractedRequirementItem[];
  readonly conflicts: readonly RequirementConflict[];
  readonly skippedDocuments: readonly SkippedDocument[];
}

/**
 * `POST .../requirements/extract` -- WRITE_ROLES en el servidor (ver
 * `technicalProposal.ts`); esta función no valida rol, solo transporta. Exige
 * `idempotency-key` (mismo criterio que `folios-client.ts` de hoteles): se
 * genera una nueva por cada intento de subida para que un doble clic/reintento
 * de red nunca corra la extracción (y su reversionado de la convocatoria,
 * `recordTenderVersion`) dos veces -- un reintento MANUAL del usuario (botón
 * "reintentar" tras un error) sí debe generar una key nueva, nunca reusar la
 * que falló.
 */
export async function extractRequirements(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  documents: readonly ExtractDocumentInput[],
  idempotencyKey: string = crypto.randomUUID(),
): Promise<ExtractRequirementsResult> {
  return postJson<ExtractRequirementsResult>(
    fetchImpl,
    `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/requirements/extract`,
    token,
    { documents },
    { "idempotency-key": idempotencyKey },
  );
}

/** Límite REAL del servidor (`storage.ts::decodeBase64Content`, ~22MB decodificado); se valida aquí ANTES de leer el archivo completo en memoria del navegador para no bloquear la pestaña con un archivo que el backend rechazaría igual. Base64 infla el tamaño ~4/3 -- el límite en bytes CRUDOS del archivo es más chico que el límite en caracteres base64 del backend. */
export const MAX_UPLOAD_FILE_BYTES = 22 * 1024 * 1024;

/**
 * Convierte un `File` elegido en el navegador a base64 PLANO (sin prefijo
 * `data:<mime>;base64,` -- `decodeBase64Content` server-side espera base64
 * puro). Corre 100% en el cliente: el archivo nunca se manda a ningún destino
 * salvo el propio backend de licitaciones.
 *
 * Deliberadamente `File.arrayBuffer()` + `btoa` en vez de `FileReader` --
 * `FileReader` es un tipo de `lib.dom` que NO existe bajo el `tsconfig.json`
 * raíz del monorepo (lib `ES2023` sin DOM, ver `packages/config/tsconfig.base.json`
 * y `npm run typecheck` en la raíz, que sí recorre los .ts de `apps/web/src`
 * recursivamente -- solo `.tsx` queda fuera) -- mismo motivo por el que
 * `authed-fetch.ts` evita los
 * tipos `Window`/`Storage` de DOM y usa `globalThis as {...}` en su lugar. `File`
 * y `btoa` SÍ están tipados por `@types/node` (Node 18+ los trae como globales
 * reales), así que esto compila en ambos tsconfig sin castear nada.
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK_SIZE = 0x8000; // 32KB por chunk -- evita el stack overflow de `String.fromCharCode(...bytes)` con un archivo grande.
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

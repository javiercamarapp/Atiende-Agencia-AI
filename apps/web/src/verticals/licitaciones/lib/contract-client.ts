// Cliente web de contratos post-adjudicación (Fase 15 pieza acotada) — cierra
// la primera porción del hallazgo ALTA de auditoría "Post-adjudicación
// completa (contratos, documentos, cobranza, inconformidades, autopsia,
// renovaciones) = 22 rutas sin UI": contracts.ts expone POST/GET/PATCH del
// contrato + GET del historial + POST de transición (DECISION_ROLES para
// rescindir/penalizar/marcar en inconformidad/modificar) y
// contractDocuments.ts expone POST/GET de documentos del contrato + GET de
// campos extraídos + POST de confirmación -- ninguno tenía cliente ni página
// todavía. El flujo central (documentos de bases -> propuesta técnica ->
// propuesta económica -> checklist -> aprobaciones -> paquete final,
// pages/Cierre.tsx) ya estaba completo; esto es la fase SIGUIENTE, para
// cuando la convocatoria ya se ganó (`TenderSummary.status === "won"`).
//
// Deliberadamente FUERA de esta pieza (alcance de otro agente en paralelo o
// de rondas futuras, ver README de este vertical): cobranza del contrato
// (`ContractInvoiceRecord`/`createContractInvoice`, `contract-billing.ts`),
// inconformidades, autopsia y renovaciones -- SOLO contratos + documentos del
// contrato aquí.
//
// Mismo aislamiento que el resto de apps/web (ver cabecera de
// requirements-client.ts): no depende de `@atiende/domain-licitaciones`, todo
// lo que este cliente necesita del contrato de datos vive duplicado aquí
// (uniones de string LITERALES, mismo criterio que `go-no-go-client.ts`).
import { defaultAuthCtx, fetchJson, postJson, LicitacionesAdminError } from "./admin-client.ts";
import { withAuthRefresh, apiBaseUrlFromRequestUrl } from "../../../lib/authed-fetch.ts";
export { fileToBase64, MAX_UPLOAD_FILE_BYTES } from "./requirements-client.ts";

/** Espejo EXACTO de `CONTRACT_STATES` (domain-licitaciones/contract-lifecycle.ts) -- catálogo cerrado en código, el servidor rechaza cualquier otro valor con 400. */
export const CONTRACT_STATES = [
  "adjudicado",
  "contrato_firmado_declarado",
  "en_ejecucion",
  "entregado",
  "facturado",
  "pagado",
  "cerrado",
  "modificado",
  "penalizado",
  "rescindido",
  "en_inconformidad",
] as const;

export type ContractStatus = (typeof CONTRACT_STATES)[number];

/** Espejo de `CONTRACT_TRANSITIONS` (contract-lifecycle.ts) -- SOLO para decidir qué botones de transición ofrecer; el servidor SIEMPRE re-valida contra esta misma tabla y responde 409 con `allowedNextStates` si algo queda desincronizado (nunca se confía en este mapa como única barrera). */
export const CONTRACT_TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  adjudicado: ["contrato_firmado_declarado", "en_inconformidad", "rescindido"],
  contrato_firmado_declarado: ["en_ejecucion", "modificado", "rescindido", "en_inconformidad"],
  en_ejecucion: ["entregado", "modificado", "penalizado", "rescindido"],
  entregado: ["facturado", "modificado", "penalizado"],
  facturado: ["pagado", "penalizado"],
  pagado: ["cerrado"],
  modificado: ["en_ejecucion", "entregado", "facturado", "pagado", "penalizado", "rescindido"],
  penalizado: ["en_ejecucion", "entregado", "facturado", "pagado", "rescindido"],
  rescindido: ["cerrado"],
  en_inconformidad: ["adjudicado", "contrato_firmado_declarado", "cerrado"],
  cerrado: [],
};

/** Espejo de `CONTRACT_DECISION_TRANSITIONS` (contract-lifecycle.ts) -- estas transiciones exigen DECISION_ROLES en el servidor (`assertVerticalRole`), el resto solo WRITE_ROLES. Cosmético (oculta el botón a quien el servidor rechazaría igual), el enforcement real es siempre server-side. */
export const CONTRACT_DECISION_TRANSITIONS: readonly ContractStatus[] = ["rescindido", "penalizado", "en_inconformidad", "modificado"];

/** Espejo de `ContractRecord` (domain-licitaciones/repository.ts). */
export interface ContractRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly tenderId: string;
  readonly status: ContractStatus;
  readonly endDate: string | null;
  readonly contractNumber: string | null;
  readonly hasRenewalOption: boolean;
  readonly renewalOptionNotes: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Espejo de `ContractStatusHistoryRecord` -- fila append-only, `fromStatus` es `null` solo en el registro inicial ("adjudicado" sin transición previa). */
export interface ContractStatusHistoryRecord {
  readonly id: string;
  readonly contractId: string;
  readonly fromStatus: ContractStatus | null;
  readonly toStatus: ContractStatus;
  readonly reason: string;
  readonly actorId: string;
  readonly evidenceRef: string | null;
  readonly createdAt: string;
}

export interface ContractMetadataInput {
  readonly endDate?: string | null;
  readonly contractNumber?: string | null;
  readonly hasRenewalOption?: boolean;
  readonly renewalOptionNotes?: string | null;
}

/**
 * `POST .../contract` -- WRITE_ROLES en el servidor. Crea el `ContractRecord`
 * de esta convocatoria en estado inicial `"adjudicado"`; 409 si ya existe uno
 * (el servidor nunca crea dos contratos para la misma convocatoria).
 */
export async function createContract(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ContractRecord> {
  return postJson<ContractRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract`, token, {});
}

/**
 * `GET .../contract` -- sin rol restringido (lectura). Devuelve `null` cuando
 * todavía no se ha registrado ningún contrato para esta convocatoria (404
 * explícito de `contracts.ts`, "regístrelo primero con POST .../contract" --
 * tratado aquí como estado normal "sin contrato todavía", no como error,
 * mismo criterio que `cierre-client.ts::fetchLatestPackage`).
 */
export async function fetchContract(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ContractRecord | null> {
  const url = `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new LicitacionesAdminError(body?.message ?? `No se pudo consultar el contrato (${res.status}).`);
  }
  return (await res.json()) as ContractRecord;
}

/**
 * `PATCH .../contract` -- WRITE_ROLES en el servidor. Metadatos
 * administrativos (fecha de fin/número de contrato/opción de renovación),
 * NUNCA una transición de estado -- no genera fila de historial (ver
 * comentario de cabecera de `contracts.ts`). Solo los campos presentes en
 * `input` se envían (mismo criterio que el resto de este cliente: nunca se
 * manda `undefined` como si fuera un valor real).
 */
export async function updateContractMetadata(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string, input: ContractMetadataInput): Promise<ContractRecord> {
  const url = `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) =>
    fetchImpl(url, { method: "PATCH", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(input) }),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new LicitacionesAdminError(body?.message ?? `No se pudo actualizar el contrato (${res.status}).`);
  }
  return (await res.json()) as ContractRecord;
}

/** `GET .../contract/history` -- sin rol restringido (lectura); requiere que ya exista un contrato (404 si no). */
export async function fetchContractHistory(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly ContractStatusHistoryRecord[]> {
  const body = await fetchJson<{ history: readonly ContractStatusHistoryRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/history`, token);
  return body.history;
}

/**
 * `POST .../contract/transition` -- WRITE_ROLES, o DECISION_ROLES si
 * `toStatus` está en `CONTRACT_DECISION_TRANSITIONS` (rescindir/penalizar/
 * marcar en inconformidad/registrar una modificación) -- el servidor decide
 * cuál exigir según el destino, esta función no valida rol, solo transporta.
 * 409 con el detalle de `allowedNextStates` si la transición no es válida
 * desde el estado actual (nunca aplica un cambio parcial).
 */
export async function transitionContract(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: { toStatus: ContractStatus; reason: string; evidenceRef?: string | null },
): Promise<ContractRecord> {
  return postJson<ContractRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/transition`, token, {
    toStatus: input.toStatus,
    reason: input.reason,
    evidenceRef: input.evidenceRef ?? null,
  });
}

export type ContractFieldKey =
  | "numero_contrato"
  | "monto_total"
  | "plazo_entrega"
  | "garantia_cumplimiento"
  | "pena_convencional"
  | "deductiva"
  | "forma_pago"
  | "administrador_contrato"
  | "cesion_cobro";

/** Espejo de `ContractDocumentRecord`. */
export interface ContractDocumentRecord {
  readonly id: string;
  readonly contractId: string;
  readonly documentLabel: string;
  readonly pageCount: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

/** Espejo de `ContractExtractedFieldRecord` -- todo lo que produce el extractor entra como `"sugerido"`, nunca se da por válido sin confirmación explícita (`POST .../fields/:fieldId/confirm`). */
export interface ContractExtractedFieldRecord {
  readonly id: string;
  readonly contractDocumentId: string;
  readonly fieldKey: ContractFieldKey;
  readonly extractedValue: string;
  readonly sourcePage: number | null;
  readonly sourceClause: string | null;
  readonly confidence: number;
  readonly status: "sugerido" | "confirmado" | "corregido";
  readonly confirmedValue: string | null;
  readonly confirmedBy: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
}

export interface AddContractDocumentResult {
  readonly document: ContractDocumentRecord;
  readonly fields: readonly ContractExtractedFieldRecord[];
}

/**
 * `POST .../contract/documents` -- WRITE_ROLES en el servidor. Sube el
 * contrato firmado como bytes reales (`contentBase64`, sin el prefijo
 * `data:...;base64,` -- ver `fileToBase64` reexportado de
 * `requirements-client.ts`, mismo helper, mismo límite ~22MB real del
 * servidor aunque el cap del cuerpo JSON de esta ruta sea mayor, 30MB, para
 * absorber la inflación de base64). 422 explícito si el documento no produce
 * texto extraíble (PDF escaneado sin capa de texto -> `requires_ocr`; formato
 * no soportado/corrupto -> `failed`) -- nunca se inventa texto vacío para que
 * la extracción de campos corra sobre nada (REQ-166, mismo criterio que
 * `requirements-client.ts`).
 */
export async function addContractDocument(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: { documentLabel: string; contentBase64: string; mimeType: string | null; filename: string },
): Promise<AddContractDocumentResult> {
  return postJson<AddContractDocumentResult>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/documents`, token, input);
}

/** `GET .../contract/documents` -- sin rol restringido (lectura); requiere que ya exista un contrato (404 si no). */
export async function fetchContractDocuments(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<readonly ContractDocumentRecord[]> {
  const body = await fetchJson<{ documents: readonly ContractDocumentRecord[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/documents`, token);
  return body.documents;
}

/** `GET .../contract/documents/:documentId/fields` -- sin rol restringido (lectura). */
export async function fetchContractDocumentFields(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  documentId: string,
): Promise<readonly ContractExtractedFieldRecord[]> {
  const body = await fetchJson<{ fields: readonly ContractExtractedFieldRecord[] }>(
    fetchImpl,
    `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/documents/${documentId}/fields`,
    token,
  );
  return body.fields;
}

/**
 * `POST .../contract/fields/:fieldId/confirm` -- WRITE_ROLES en el servidor.
 * `action: "confirm"` acepta `extractedValue` tal cual; `action: "correct"`
 * exige `correctedValue` no vacío (el servidor rechaza `correct` sin valor).
 */
export async function confirmContractExtractedField(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  fieldId: string,
  input: { action: "confirm" | "correct"; correctedValue?: string | null },
): Promise<ContractExtractedFieldRecord> {
  return postJson<ContractExtractedFieldRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/contract/fields/${fieldId}/confirm`, token, {
    action: input.action,
    correctedValue: input.correctedValue ?? null,
  });
}

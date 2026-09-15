// Cliente del checklist de integridad (Fase 7 el GET, Fase 14 el POST) —
// `GET .../tenders/:tenderId/checklist` y `POST .../tenders/:tenderId/checklist/run`
// (L1 · Flujo 1, checklist.ts). El GET solo lee el ÚLTIMO resultado ya
// persistido; el POST lo vuelve a correr contra metadatos de archivo REALES
// (nunca inventados) que el staff declara en `pages/Cierre.tsx` -- ese panel
// (no este cliente) decide de dónde salen `files`/`formatLimits`/
// `requiredSignatures`/`presentAnnexRefs` (`files` viene de `<input
// type="file">`, filename/extension/sizeBytes reales del `File` elegido;
// `presentAnnexRefs` se deriva de los anexos obligatorios ya extraídos vía
// `requirements-client.ts`, mismo criterio -- `topicKey ?? id` -- que
// `listRequiredAnnexes` server-side).
//
// Cierra el hallazgo ALTA de auditoría ("checklist.ts expone POST
// .../checklist/run [...] -- ninguno tiene cliente ni página"), continuado en
// `cierre-client.ts` (aprobaciones + ensamblado/descarga del paquete final).
import { fetchJson, postJson } from "./admin-client.ts";

export type ComplianceResult = "verde" | "ambar" | "rojo";

export interface ComplianceItem {
  readonly id: string;
  readonly dimension: string;
  readonly result: ComplianceResult;
  readonly notes: string;
  readonly evidenceRef: string | null;
  readonly checkedAt: string;
}

export interface ChecklistSummary {
  readonly overallStatus: ComplianceResult;
  readonly items: readonly ComplianceItem[];
}

export async function fetchChecklist(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ChecklistSummary> {
  return fetchJson<ChecklistSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/checklist`, token);
}

/** Espejo de `FileArtifact` (domain-licitaciones/integrity-checklist.ts) -- metadatos de UN archivo del paquete que se subirá al portal oficial, nunca su contenido (el checklist solo valida formato/tamaño/páginas, no revisa el archivo). */
export interface ChecklistFileArtifact {
  readonly filename: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly pages?: number;
}

/** Espejo de `FormatLimitsConfig` -- reglas del portal oficial destino para ESTA convocatoria (varían por dependencia/plataforma, por eso el staff las declara aquí en vez de que el sistema las asuma). */
export interface ChecklistFormatLimits {
  readonly allowedExtensions: readonly string[];
  readonly maxFileSizeBytes: number;
  readonly maxUploadSlots: number;
  readonly maxPagesPerFile?: number;
}

/** Espejo de `SignatureRequirement` -- el sistema NUNCA firma ni simula firma; `userConfirmedSigned` es solo la declaración del staff de que la firma ya se hizo fuera del sistema. */
export interface ChecklistSignatureRequirement {
  readonly role: string;
  readonly userConfirmedSigned: boolean;
}

export interface RunChecklistInput {
  readonly files: readonly ChecklistFileArtifact[];
  readonly formatLimits: ChecklistFormatLimits;
  readonly requiredSignatures: readonly ChecklistSignatureRequirement[];
  readonly presentAnnexRefs: readonly string[];
}

/**
 * `POST .../checklist/run` -- WRITE_ROLES en el servidor (ver checklist.ts);
 * esta función no valida rol, solo transporta. Exige `idempotency-key` (mismo
 * criterio que el resto del vertical): una key nueva por cada intento para
 * que un doble clic nunca vuelva a persistir el mismo resultado dos veces. El
 * servidor DERIVA `asOfIso` de la convocatoria ya resuelta -- este body nunca
 * declara esa fecha (REQ-LIC-001/AE-01), ni esta función expone un parámetro
 * para intentarlo.
 */
export async function runChecklist(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  input: RunChecklistInput,
  idempotencyKey: string = crypto.randomUUID(),
): Promise<ChecklistSummary> {
  return postJson<ChecklistSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/checklist/run`, token, input, { "idempotency-key": idempotencyKey });
}

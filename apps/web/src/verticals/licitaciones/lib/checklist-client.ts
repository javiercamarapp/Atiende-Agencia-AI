// Lectura del checklist de integridad (Fase 7) — `GET .../tenders/:tenderId/checklist`
// (L1 · Flujo 1, checklist.ts). Solo lectura a propósito: `POST .../checklist/run`
// exige un `FileArtifact[]`/`FormatLimitsConfig`/`SignatureRequirement[]` reales
// (metadatos de los documentos ya subidos al expediente) que este panel todavía no
// construye -- la pantalla de carga que SÍ existe desde Fase 11
// (`pages/RequisitosConvocatoria.tsx`, `lib/requirements-client.ts`) alimenta
// `.../requirements/extract`, un endpoint distinto que produce requisitos, no el
// `FileArtifact[]` que este checklist necesita; sigue documentado como pendiente en
// el README -- mostrar el ÚLTIMO resultado ya corrido (por el agente o por una
// corrida previa) sí es honesto y real hoy.
import { fetchJson } from "./admin-client.ts";

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

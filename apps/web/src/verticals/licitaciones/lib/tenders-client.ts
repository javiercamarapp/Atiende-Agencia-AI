// Lógica de datos de convocatorias (Fase 7) — separada de pages/Convocatorias.tsx
// a propósito, mismo motivo que el resto de lib/*.ts de este panel: probarla con
// vitest en entorno "node" sin DOM. Llama a `GET/POST /licitaciones/:propertyId/tenders`
// y `GET /licitaciones/:propertyId/tenders/:tenderId` (Fase 7 — tenders.ts), que
// exponen el `TenderRecord` completo (título/fecha límite/entidad) — a diferencia
// de `GET .../tenders/matching` (matching-client.ts), que solo trae el score.
import { fetchJson, postJson } from "./admin-client.ts";

export type TenderStatus = "discovered" | "in_review" | "go" | "no_go" | "in_progress" | "submitted" | "won" | "lost" | "cancelled";

export interface TenderSummary {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly submissionDeadline: string | null;
  readonly updatedAt: string;
  readonly source: string | null;
  readonly externalId: string | null;
  readonly contractingBody: string | null;
  readonly cpvCodes: readonly string[];
  readonly budgetAmount: number | null;
  readonly currency: string | null;
  readonly state: string | null;
  readonly procedureTypeRaw: string | null;
  readonly status: TenderStatus | null;
}

export async function fetchTenders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly TenderSummary[]> {
  const body = await fetchJson<{ tenders: readonly TenderSummary[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders`, token);
  return body.tenders;
}

export async function fetchTender(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<TenderSummary> {
  return fetchJson<TenderSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}`, token);
}

export interface TenderCreateInput {
  readonly title: string;
  readonly submissionDeadline?: string | null;
  readonly externalId?: string | null;
  readonly contractingBody?: string | null;
  readonly cpvCodes?: readonly string[];
  readonly budgetAmount?: number | null;
  readonly currency?: string;
  readonly state?: string | null;
  readonly procedureTypeRaw?: string | null;
}

/** `source` SIEMPRE lo fija el servidor como "manual" (ver tenders.ts) aunque el
 * panel no lo mande -- nunca se declara aquí. Reingestar el mismo `externalId`
 * ACTUALIZA la convocatoria existente en vez de duplicarla (200 en vez de 201). */
export async function createOrUpdateTender(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: TenderCreateInput): Promise<TenderSummary> {
  return postJson<TenderSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders`, token, input);
}

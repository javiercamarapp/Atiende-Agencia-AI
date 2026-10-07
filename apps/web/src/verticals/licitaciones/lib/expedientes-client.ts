// Cliente web de la bandeja de Expedientes (paridad3 L-P3-16): GET .../expedientes, solo lectura y paginada por el servidor (total en
// X-Total-Count). Espejo de `ExpedienteFila` (apps/api .../licitaciones/expedientes.ts).
import { fetchJsonWithHeaders } from "./admin-client.ts";

export type ExpedienteEstado = "go" | "in_progress" | "submitted";

export interface ExpedienteFila {
  readonly tenderId: string;
  readonly title: string;
  readonly status: string;
  readonly submissionDeadline: string | null;
  readonly requisitos: { readonly total: number; readonly cumplidos: number };
  readonly redaccion: "hecho" | "pendiente";
  readonly checklist: "verde" | "ambar" | "rojo" | "sin_correr";
  readonly aprobacion: { readonly modo: "doble" | "legacy" | "sin_propuesta"; readonly tecnicaLegal: boolean; readonly economica: boolean; readonly completa: boolean };
  readonly paquete: boolean;
  readonly presentada: boolean;
}

export interface ExpedientesPagina {
  readonly items: readonly ExpedienteFila[];
  readonly total: number;
}

export async function fetchExpedientes(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  query: { readonly status?: ExpedienteEstado | ""; readonly limit: number; readonly offset: number },
): Promise<ExpedientesPagina> {
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
  if (query.status) params.set("status", query.status);
  const { body, headers } = await fetchJsonWithHeaders<{ expedientes: readonly ExpedienteFila[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/expedientes?${params.toString()}`, token);
  const total = Number(headers.get("x-total-count"));
  return { items: body.expedientes, total: Number.isFinite(total) ? total : body.expedientes.length };
}

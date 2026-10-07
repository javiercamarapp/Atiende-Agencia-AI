// Lógica de datos de convocatorias (Fase 7) — separada de pages/Convocatorias.tsx
// a propósito, mismo motivo que el resto de lib/*.ts de este panel: probarla con
// vitest en entorno "node" sin DOM. Llama a `GET/POST /licitaciones/:propertyId/tenders`
// y `GET /licitaciones/:propertyId/tenders/:tenderId` (Fase 7 — tenders.ts), que
// exponen el `TenderRecord` completo (título/fecha límite/entidad) — a diferencia
// de `GET .../tenders/matching` (matching-client.ts), que solo trae el score.
import { fetchJson, fetchJsonWithHeaders, postJson } from "./admin-client.ts";

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

/** Pagina de convocatorias con el total REAL de la organizacion (cabecera `X-Total-Count`). Nunca se asume que "lo recibido es todo". */
export interface TendersPage {
  readonly items: readonly TenderSummary[];
  readonly total: number;
  /** Offset de la pagina siguiente, o `null` si no queda ninguna. */
  readonly nextOffset: number | null;
}

/** Filtros del servidor (`GET .../tenders`): todos se aplican en la consulta, no sobre una pagina ya cortada. */
export interface TendersQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly q?: string;
  readonly status?: TenderStatus;
  readonly source?: string;
  /** Solo sin resolver (ni ganadas, perdidas, canceladas ni no-go). */
  readonly open?: boolean;
  readonly deadlineFrom?: string;
  readonly deadlineTo?: string;
  readonly ids?: readonly string[];
}

/** Techo de `ids` por peticion y de `limit` (coincide con la API). */
export const TENDERS_MAX_PAGE = 200;

export function tendersQueryString(query: TendersQuery): string {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  if (query.q && query.q.trim()) params.set("q", query.q.trim());
  if (query.status) params.set("status", query.status);
  if (query.source) params.set("source", query.source);
  if (query.open) params.set("open", "true");
  if (query.deadlineFrom) params.set("deadlineFrom", query.deadlineFrom);
  if (query.deadlineTo) params.set("deadlineTo", query.deadlineTo);
  if (query.ids && query.ids.length > 0) params.set("ids", query.ids.join(","));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function fetchTendersPage(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, query: TendersQuery = {}): Promise<TendersPage> {
  const { body, headers } = await fetchJsonWithHeaders<{ tenders: readonly TenderSummary[] }>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders${tendersQueryString(query)}`, token);
  const rawTotal = headers.get("x-total-count");
  const parsedTotal = rawTotal === null ? Number.NaN : Number(rawTotal);
  // Una API que no anuncia el total (version vieja) no se toma por "completa": se cae a lo recibido.
  const total = Number.isFinite(parsedTotal) ? parsedTotal : body.tenders.length;
  const rawNext = headers.get("x-next-offset");
  const next = rawNext === null ? Number.NaN : Number(rawNext);
  return { items: body.tenders, total, nextOffset: Number.isFinite(next) ? next : null };
}

/** Solo las convocatorias pedidas por id (Seguimiento, Radar, Dias inhabiles): nunca "todo". Parte la lista en bloques del techo del servidor. */
export async function fetchTendersByIds(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ids: readonly string[]): Promise<readonly TenderSummary[]> {
  const unicos = [...new Set(ids)];
  const bloques: string[][] = [];
  for (let i = 0; i < unicos.length; i += TENDERS_MAX_PAGE) bloques.push(unicos.slice(i, i + TENDERS_MAX_PAGE));
  const paginas = await Promise.all(bloques.map((bloque) => fetchTendersPage(fetchImpl, apiBaseUrl, token, propertyId, { ids: bloque, limit: bloque.length })));
  return paginas.flatMap((p) => p.items);
}

/** Convocatorias sin resolver para un selector (Dias inhabiles, WhatsApp): las mas recientes hasta el techo del servidor. `total` permite avisar cuando hay mas de las que se listan. */
export async function fetchOpenTenders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<TendersPage> {
  return fetchTendersPage(fetchImpl, apiBaseUrl, token, propertyId, { open: true, limit: TENDERS_MAX_PAGE });
}

/** Conteos de TODA la organizacion (`GET .../tenders/summary`): alimentan los KPIs del Resumen. */
export interface TendersSummary {
  readonly total: number;
  readonly open: number;
  readonly closingSoon: number;
  readonly windowDays: number;
  readonly byStatus: Readonly<Record<string, number>>;
}

export async function fetchTendersSummary(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, windowDays?: number): Promise<TendersSummary> {
  const qs = windowDays === undefined ? "" : `?windowDays=${windowDays}`;
  return fetchJson<TendersSummary>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/summary${qs}`, token);
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

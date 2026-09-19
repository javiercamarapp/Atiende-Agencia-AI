// r5 -- cliente de la bitácora de auditoría del staff. Un solo endpoint de lectura
// (GET .../admin/auditoria), sin propertyId en la ruta (la bitácora es de TODA la
// organización, ver apps/api/src/routes/verticals/rentas/auditoria.ts) -- mismo
// patrón que discovery-client.ts (fetchJson, `fetchImpl` inyectado para poder
// probar la lógica de red real con vitest en entorno "node" sin depender de jsdom,
// ver admin-client.ts).
import { fetchJson } from "./admin-client.ts";

export type AuditLogEntityType = "pricing" | "reserva" | "payout" | "owner_statement" | "membership" | "canal";

export const AUDIT_LOG_ENTITY_TYPES: readonly AuditLogEntityType[] = ["pricing", "reserva", "payout", "owner_statement", "membership", "canal"];

/** Etiqueta legible por humano de cada tipo -- usada por el filtro de la pantalla. */
export const AUDIT_LOG_ENTITY_TYPE_LABELS: Record<AuditLogEntityType, string> = {
  pricing: "Precios",
  reserva: "Reservas",
  payout: "Payouts",
  owner_statement: "Estados de cuenta",
  membership: "Membresía/rol",
  canal: "Canales",
};

export interface AuditLogEntry {
  readonly id: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly campo: string | null;
  readonly antes: string | null;
  readonly despues: string | null;
  readonly creadoEn: string;
}

export interface AuditLogPagina {
  /** `false` cuando la migración de la bitácora todavía no se aplicó a esta base --
   *  la pantalla debe mostrar "no disponible aún", nunca confundirlo con una
   *  bitácora real pero vacía. */
  readonly disponible: boolean;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly items: readonly AuditLogEntry[];
}

export interface AuditLogFiltro {
  readonly tipo?: AuditLogEntityType | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly desde?: string | null;
  /** `YYYY-MM-DD`, inclusive. */
  readonly hasta?: string | null;
  readonly limit?: number;
  readonly offset?: number;
}

export async function fetchAuditoria(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string, filtro: AuditLogFiltro = {}): Promise<AuditLogPagina> {
  const params = new URLSearchParams();
  if (filtro.tipo) params.set("tipo", filtro.tipo);
  if (filtro.desde) params.set("desde", filtro.desde);
  if (filtro.hasta) params.set("hasta", filtro.hasta);
  if (filtro.limit !== undefined) params.set("limit", String(filtro.limit));
  if (filtro.offset !== undefined) params.set("offset", String(filtro.offset));
  const query = params.toString();
  return fetchJson<AuditLogPagina>(fetchImpl, `${apiBaseUrl}/v1/rentas/${orgSlug}/admin/auditoria${query ? `?${query}` : ""}`, token);
}

// FASE 3 (producto) — cliente de la bitácora de auditoría del staff. Mismo
// patrón exacto que restaurantes/lib/auditoria-client.ts (citas también monta
// todas sus rutas admin sobre `:propertyId`, ver
// apps/api/src/routes/verticals/citas/auditoria.ts).
import { fetchJson } from "./admin-client.ts";

export type AuditLogEntityType = "servicio" | "cita" | "staff" | "configuracion" | "lista_espera";

export const AUDIT_LOG_ENTITY_TYPES: readonly AuditLogEntityType[] = ["servicio", "cita", "staff", "configuracion", "lista_espera"];

/** Etiqueta legible por humano de cada tipo -- usada por el filtro de la pantalla. */
export const AUDIT_LOG_ENTITY_TYPE_LABELS: Record<AuditLogEntityType, string> = {
  servicio: "Servicios",
  cita: "Citas",
  staff: "Staff",
  configuracion: "Configuración",
  lista_espera: "Lista de espera",
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

export async function fetchAuditoria(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filtro: AuditLogFiltro = {}): Promise<AuditLogPagina> {
  const params = new URLSearchParams();
  if (filtro.tipo) params.set("tipo", filtro.tipo);
  if (filtro.desde) params.set("desde", filtro.desde);
  if (filtro.hasta) params.set("hasta", filtro.hasta);
  if (filtro.limit !== undefined) params.set("limit", String(filtro.limit));
  if (filtro.offset !== undefined) params.set("offset", String(filtro.offset));
  const query = params.toString();
  return fetchJson<AuditLogPagina>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/auditoria${query ? `?${query}` : ""}`, token);
}

// FASE 3 (producto) — cliente de la bitácora de auditoría del staff. A diferencia
// de rentas/lib/auditoria-client.ts (sin propertyId, la bitácora de rentas se
// resuelve por `orgSlug`), este vertical monta TODAS sus rutas admin sobre
// `:propertyId` (ver apps/api/src/routes/verticals/restaurantes/auditoria.ts) --
// mismo patrón que branches-client.ts/catalog-client.ts de este mismo directorio.
import { fetchJson } from "./admin-client.ts";

export type AuditLogEntityType = "producto" | "promocion" | "pedido" | "repartidor" | "staff" | "configuracion";

export const AUDIT_LOG_ENTITY_TYPES: readonly AuditLogEntityType[] = ["producto", "promocion", "pedido", "repartidor", "staff", "configuracion"];

/** Etiqueta legible por humano de cada tipo -- usada por el filtro de la pantalla. */
export const AUDIT_LOG_ENTITY_TYPE_LABELS: Record<AuditLogEntityType, string> = {
  producto: "Productos",
  promocion: "Promociones",
  pedido: "Pedidos",
  repartidor: "Repartidor",
  staff: "Staff",
  configuracion: "Configuración",
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
  return fetchJson<AuditLogPagina>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/auditoria${query ? `?${query}` : ""}`, token);
}

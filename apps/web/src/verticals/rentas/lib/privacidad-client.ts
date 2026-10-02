// Rn-07 -- cliente de las solicitudes ARCO de rentas (apps/api/src/routes/verticals/rentas/privacidad.ts).
// Separado de pages/Privacidad.tsx para probarlo en entorno "node".
import { fetchJson, sendJson } from "./admin-client.ts";

export type ArcoDerecho = "acceso" | "rectificacion" | "cancelacion" | "oposicion";
export type ArcoCanal = "correo" | "telefono" | "presencial" | "otro";
export type ArcoEstado = "recibida" | "en_proceso" | "bloqueada" | "resuelta" | "rechazada";
export type ArcoAccion = "en_proceso" | "bloqueada" | "resuelta" | "rechazada";
export type ArcoPlazo = "en_plazo" | "por_vencer" | "vencida" | "cerrada";

export const ETIQUETA_CANAL_ARCO: Readonly<Record<ArcoCanal, string>> = { correo: "Correo", telefono: "Teléfono", presencial: "En persona", otro: "Otro" };

export interface SolicitudArco {
  readonly id: string;
  readonly folio: string;
  readonly derecho: ArcoDerecho;
  readonly canal: ArcoCanal;
  readonly estado: ArcoEstado;
  readonly plazo: ArcoPlazo;
  readonly solicitanteNombre: string;
  readonly solicitanteContacto: string;
  readonly detalle: string | null;
  readonly recibidaEn: string;
  readonly respuestaVenceEn: string;
  readonly ejecucionVenceEn: string;
  readonly notaResolucion: string | null;
}

export interface PaginaSolicitudesArco {
  readonly disponible: boolean;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly plazos: { readonly respuestaDias: number; readonly ejecucionDias: number };
  readonly items: readonly SolicitudArco[];
}

export interface NuevaSolicitudArco {
  readonly derecho: ArcoDerecho;
  readonly canal: ArcoCanal;
  readonly solicitanteNombre: string;
  readonly solicitanteContacto: string;
  readonly detalle: string | null;
  /** ISO; `null` = ahora. */
  readonly recibidaEn: string | null;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/rentas/${propertyId}/privacidad/solicitudes`;

export async function fetchSolicitudesArco(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  q: { estado: ArcoEstado | null; derecho: ArcoDerecho | null; limit: number; offset: number },
): Promise<PaginaSolicitudesArco> {
  const params = new URLSearchParams({ limit: String(q.limit), offset: String(q.offset) });
  if (q.estado) params.set("estado", q.estado);
  if (q.derecho) params.set("derecho", q.derecho);
  return fetchJson<PaginaSolicitudesArco>(fetchImpl, `${base(apiBaseUrl, propertyId)}?${params.toString()}`, token);
}

export async function registrarSolicitudArco(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, s: NuevaSolicitudArco): Promise<{ id: string; folio: string; creada: boolean }> {
  return sendJson<{ id: string; folio: string; creada: boolean }>(fetchImpl, base(apiBaseUrl, propertyId), token, "POST", s);
}

export async function cambiarEstadoSolicitudArco(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string, estado: ArcoAccion, nota: string | null): Promise<void> {
  await sendJson<{ id: string; estado: ArcoEstado }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/${id}/estado`, token, "PATCH", { estado, nota });
}

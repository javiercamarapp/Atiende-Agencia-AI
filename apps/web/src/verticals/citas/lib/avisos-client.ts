// C-16 -- cliente del centro de avisos de citas (ver apps/api/src/routes/verticals/citas/avisos.ts).
import { fetchJson, postJson } from "./admin-client.ts";

export type EscalacionSeguimiento = "pending" | "in_progress" | "resolved";

export interface AvisosPorConfirmarItem {
  readonly id: string;
  readonly iniciaEn: string;
  readonly proveedor: string | null;
  readonly servicio: string | null;
  readonly origen: string;
}

export interface AvisosRecordatorioFila {
  readonly canal: string;
  readonly estado: string;
  readonly total: number;
}

export interface AvisosEscalacion {
  readonly id: string;
  readonly canal: string;
  readonly palabraClave: string;
  /** Ya enmascarado por el servidor (`***1234`). */
  readonly telefono: string;
  readonly creadaEn: string;
  /** null = la migracion de seguimiento no esta aplicada: no hay estado que mostrar. */
  readonly seguimiento: EscalacionSeguimiento | null;
  readonly seguimientoEn: string | null;
  readonly nota: string | null;
}

export interface AvisosCitas {
  readonly generadoEn: string;
  readonly porConfirmar: { readonly horas: number; readonly total: number; readonly items: readonly AvisosPorConfirmarItem[] };
  readonly recordatorios: { readonly visible: boolean; readonly disponible: boolean; readonly ventanaDias: number; readonly filas: readonly AvisosRecordatorioFila[] };
  readonly escalaciones: { readonly visible: boolean; readonly disponible: boolean; readonly seguimientoDisponible: boolean; readonly items: readonly AvisosEscalacion[] };
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin`;

export function fetchAvisosCitas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<AvisosCitas> {
  return fetchJson<AvisosCitas>(fetchImpl, `${base(apiBaseUrl, propertyId)}/avisos`, token);
}

export function darSeguimientoEscalacion(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  escalationId: string,
  estado: "in_progress" | "resolved",
  nota: string | null,
): Promise<{ id: string; estado: EscalacionSeguimiento; en: string }> {
  return postJson(fetchImpl, `${base(apiBaseUrl, propertyId)}/escalaciones/${escalationId}/seguimiento`, token, nota ? { estado, nota } : { estado });
}

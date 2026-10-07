// H-26 -- logica de datos de lo residual de housekeeping: configuracion, asignacion automatica, fotos de inspeccion, blancos y opt-out.
// Consume apps/api/.../hoteles/housekeeping-residual.ts. `fetchImpl` inyectado (mismo criterio que el resto de lib/*.ts).
import { fetchBlob, fetchJson, sendJson } from "./admin-client.ts";
import type { TareaTipo } from "./limpieza-client.ts";

const hk = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/hoteles/${propertyId}/housekeeping`;

/** Espejo cosmetico de los roles del servidor (domain-hoteles/src/roles.ts); el servidor es la barrera real (403). */
export const HK_CONFIG_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
export const HK_AUTO_ASSIGN_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk"]);

export const PHOTO_MAX_BYTES = 1_572_864;
export const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

export interface HkConfig {
  readonly disponible: boolean;
  readonly personalizada: boolean;
  readonly asignacionAutomatica: boolean;
  readonly maxTareasPorCamarista: number;
  readonly minutosJornada: number;
  readonly minutosPorTipo: Readonly<Record<TareaTipo, number>>;
  readonly fotosObligatoriasEnInspeccion: boolean;
  readonly maxFotosPorTarea: number;
  /** Hora local (0..23) a la que el cron arranca el dia de housekeeping. */
  readonly horaArranque: number;
  /** false = la base aun no tiene la migracion 045: se muestra el 7 por omision y no se puede cambiar. */
  readonly horaArranqueDisponible: boolean;
  readonly actualizadoEn: string | null;
  readonly vision: { readonly disponible: boolean; readonly requiere: string };
}

export type HkConfigPatch = Partial<{
  asignacionAutomatica: boolean;
  maxTareasPorCamarista: number;
  minutosJornada: number;
  minutosPorTipo: Partial<Record<TareaTipo, number>>;
  fotosObligatoriasEnInspeccion: boolean;
  maxFotosPorTarea: number;
  horaArranque: number;
}>;

export function fetchConfigHk(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<HkConfig> {
  return fetchJson<HkConfig>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/configuracion`, token);
}
export function saveConfigHk(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, patch: HkConfigPatch): Promise<HkConfig> {
  return sendJson<HkConfig>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/configuracion`, token, "PUT", patch);
}

export interface AsignacionResultado {
  readonly fecha: string;
  readonly asignadas: number;
  readonly sinAsignar: number;
  readonly sinCamaristas: boolean;
}
export function asignacionAutomatica(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha: string): Promise<AsignacionResultado> {
  return sendJson<AsignacionResultado>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/asignacion-automatica`, token, "POST", { fecha });
}

export interface FotoTarea {
  readonly id: string;
  readonly tareaId: string;
  readonly tipo: string;
  readonly bytes: number;
  readonly descripcion: string | null;
  readonly creadaEn: string;
}
export interface FotosTareaResponse {
  readonly tareaId: string;
  readonly disponible: boolean;
  readonly fotos: readonly FotoTarea[];
  readonly maximo: number;
  readonly vision: { readonly disponible: boolean; readonly requiere: string };
}
export function fetchFotos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, taskId: string): Promise<FotosTareaResponse> {
  return fetchJson<FotosTareaResponse>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tareas/${taskId}/fotos`, token);
}
export function subirFoto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, taskId: string, imagenBase64: string, descripcion?: string): Promise<FotoTarea> {
  return sendJson<FotoTarea>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tareas/${taskId}/fotos`, token, "POST", { imagen: imagenBase64, ...(descripcion ? { descripcion } : {}) });
}
export function retirarFoto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, taskId: string, photoId: string): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tareas/${taskId}/fotos/${photoId}`, token, "DELETE", {});
}
export function descargarFoto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, taskId: string, photoId: string): Promise<Blob> {
  return fetchBlob(fetchImpl, `${hk(apiBaseUrl, propertyId)}/tareas/${taskId}/fotos/${photoId}`, token);
}

/** Lee un archivo del navegador como base64 (sin prefijo data:). Rechaza lo que pasa del tope ANTES de leerlo. */
export async function archivoABase64(file: Blob): Promise<string> {
  if (file.size > PHOTO_MAX_BYTES) throw new Error("La foto pesa mas de 1.5 MB: toma otra mas ligera.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export type LinenItem = "sabanas" | "fundas" | "toallas_bano" | "toallas_mano" | "toallas_piso" | "cobertores" | "albornoces";
export const LINEN_LABELS: Record<LinenItem, string> = {
  sabanas: "Sábanas",
  fundas: "Fundas",
  toallas_bano: "Toallas de baño",
  toallas_mano: "Toallas de mano",
  toallas_piso: "Toallas de piso",
  cobertores: "Cobertores",
  albornoces: "Albornoces",
};
export interface BlancosRenglon {
  readonly articulo: LinenItem;
  readonly limpias: number | null;
  readonly sucias: number | null;
  readonly enLavanderia: number | null;
  readonly danadas: number | null;
  readonly total: number | null;
  readonly actualizadoEn: string | null;
  readonly conteoAnterior: { readonly fecha: string; readonly total: number } | null;
  readonly diferencia: number | null;
}
export interface BlancosResponse {
  readonly fecha: string;
  readonly disponible: boolean;
  readonly articulos: readonly BlancosRenglon[];
}
export function fetchBlancos(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha: string): Promise<BlancosResponse> {
  return fetchJson<BlancosResponse>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/blancos?fecha=${encodeURIComponent(fecha)}`, token);
}
export function guardarBlancos(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly fecha: string; readonly articulo: LinenItem; readonly limpias: number; readonly sucias: number; readonly enLavanderia: number; readonly danadas: number },
): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/blancos`, token, "PUT", input);
}

export interface OptOut {
  readonly id: string;
  readonly roomId: string;
  readonly habitacion: string;
  readonly fecha: string;
  readonly origen: "huesped" | "recepcion" | "whatsapp";
  readonly nota: string | null;
  readonly estado: "activo" | "revertido";
  readonly creadoEn: string;
}
export interface OptOutResponse {
  readonly fecha: string;
  readonly disponible: boolean;
  readonly optOuts: readonly OptOut[];
}
export function fetchOptOuts(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, fecha: string): Promise<OptOutResponse> {
  return fetchJson<OptOutResponse>(fetchImpl, `${hk(apiBaseUrl, propertyId)}/opt-out?fecha=${encodeURIComponent(fecha)}`, token);
}
export function registrarOptOut(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly roomId: string; readonly fecha: string; readonly origen: "huesped" | "recepcion"; readonly nota?: string },
): Promise<OptOut & { readonly tareasCanceladas: number }> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/opt-out`, token, "POST", input);
}
export function revertirOptOut(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<unknown> {
  return sendJson(fetchImpl, `${hk(apiBaseUrl, propertyId)}/opt-out/${id}/revertir`, token, "POST", {});
}

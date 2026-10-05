// Portal del cliente final del despacho (D-08). Dos superficies:
//  * PUBLICA (el cliente del despacho, sin cuenta): se identifica con el token del enlace, que viaja SOLO en
//    el header `X-Portal-Token` (el enlace lo lleva en el fragmento `#t=...`, que el navegador nunca envia).
//    Ninguna funcion de aqui pone el token en una URL ni lo escribe en consola.
//  * STAFF (panel del despacho): /despachos/:propertyId/portal-cliente/* con la sesion normal.
import { fetchBlob, fetchJson, postJson } from "./admin-client.ts";
import { conStepUp } from "./step-up.ts";

// ------------------------------------------------------------------ tipos compartidos
export interface PortalObligacion {
  readonly tipo: string;
  readonly periodo: string;
  readonly fechaLimite: string;
  readonly estado: string;
  readonly fechaPresentacion: string | null;
}
export interface PortalCierre {
  readonly anio: number;
  readonly mes: number;
  readonly estado: string;
  readonly tareasTotal: number;
  readonly tareasListas: number;
}
export type PortalDocumentoEstado = "recibido" | "aceptado" | "rechazado";
export interface PortalDocumentoCliente {
  readonly id: string;
  readonly tipo: "cfdi_xml" | "pdf" | "imagen";
  readonly nombreArchivo: string;
  readonly estado: PortalDocumentoEstado;
  readonly motivo: string | null;
  readonly creadoEn: string;
}
export interface PortalMensaje {
  readonly autor: "cliente" | "despacho";
  readonly cuerpo: string;
  readonly creadoEn: string;
}
export interface PortalResumen {
  readonly cliente: { readonly nombre: string };
  readonly despacho: { readonly nombre: string };
  readonly expiraEn: string;
  readonly obligaciones: readonly PortalObligacion[];
  readonly cierres: readonly PortalCierre[];
  readonly documentos: readonly PortalDocumentoCliente[];
  readonly mensajes: readonly PortalMensaje[];
}

// ------------------------------------------------------------------ PUBLICO
export class PortalClienteError extends Error {
  constructor(message: string, readonly codigo: string, readonly status: number) {
    super(message);
  }
}

/** Extrae el token del fragmento `#t=<token>` (forma exacta; cualquier otra cosa -> null). */
export function tokenDeFragmento(hash: string): string | null {
  const m = /^#t=([A-Za-z0-9_-]{43})$/.exec(hash);
  return m ? m[1]! : null;
}

async function llamarPublico(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, ruta: string, init: RequestInit): Promise<Response> {
  const res = await fetchImpl(`${apiBaseUrl}${ruta}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-portal-token": token }, referrerPolicy: "no-referrer", cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    throw new PortalClienteError(body?.message ?? `No se pudo completar la operación (${res.status}).`, body?.code ?? "error", res.status);
  }
  return res;
}

export async function fetchPortalResumen(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<PortalResumen> {
  return (await (await llamarPublico(fetchImpl, apiBaseUrl, token, "/portal-cliente/resumen", { method: "GET" })).json()) as PortalResumen;
}

/** D-P3-22: un CFDI de SU cliente tal como lo ve en el portal. */
export interface PortalCfdiCliente {
  readonly id: string;
  readonly folioFiscal: string;
  readonly tipo: string;
  readonly direccion: "emitido" | "recibido" | "indeterminado" | null;
  readonly fecha: string;
  readonly rfcEmisor: string;
  readonly rfcReceptor: string;
  readonly emisorNombre: string | null;
  readonly totalCentavos: number;
  readonly estadoSat: string;
  /** El despacho rechazo este CFDI en su revision: no cuenta en sus declaraciones. */
  readonly excluido: boolean;
}

export async function fetchPortalCfdi(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<{ readonly cfdi: readonly PortalCfdiCliente[]; readonly tope: number }> {
  const cuerpo = (await (await llamarPublico(fetchImpl, apiBaseUrl, token, "/portal-cliente/cfdi", { method: "GET" })).json()) as { cfdi?: readonly PortalCfdiCliente[]; tope?: number };
  return { cfdi: Array.isArray(cuerpo.cfdi) ? cuerpo.cfdi : [], tope: typeof cuerpo.tope === "number" ? cuerpo.tope : 500 };
}

/** CSV de SUS CFDI (el servidor neutraliza celdas que empiezan con = + - @ y deja bitacora). El token viaja en el header, nunca en la URL. */
export async function descargarPortalCfdiCsv(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<Blob> {
  return (await llamarPublico(fetchImpl, apiBaseUrl, token, "/portal-cliente/cfdi?formato=csv", { method: "GET" })).blob();
}

export const ETIQUETA_SENTIDO_CFDI: Readonly<Record<string, string>> = { emitido: "Emitido", recibido: "Recibido", indeterminado: "Sin sentido" };

export interface ArchivoParaSubir {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export const PORTAL_MAX_BYTES = 2 * 1024 * 1024;
const TIPOS_SUBIDA: Readonly<Record<string, readonly string[]>> = {
  "application/xml": [".xml"],
  "text/xml": [".xml"],
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};

/** Prevalidacion en el navegador (comodidad: el servidor y la base repiten TODO). `null` = parece valido. */
export function validarArchivoLocal(archivo: { readonly name: string; readonly type: string; readonly size: number }): string | null {
  if (archivo.size === 0) return "El archivo está vacío.";
  if (archivo.size > PORTAL_MAX_BYTES) return "El archivo pesa más de 2 MB.";
  const ext = archivo.name.includes(".") ? archivo.name.slice(archivo.name.lastIndexOf(".")).toLowerCase() : "";
  const permitidas = TIPOS_SUBIDA[archivo.type.toLowerCase()];
  if (!permitidas || !permitidas.includes(ext)) return "Solo se aceptan CFDI (XML), PDF, PNG o JPEG.";
  return null;
}

export async function subirDocumentoPortal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, archivo: ArchivoParaSubir): Promise<{ readonly id: string; readonly estado: PortalDocumentoEstado; readonly duplicado: boolean; readonly nombreArchivo: string }> {
  const bytes = await archivo.arrayBuffer();
  const res = await llamarPublico(fetchImpl, apiBaseUrl, token, "/portal-cliente/documentos", {
    method: "POST",
    headers: { "content-type": archivo.type, "x-nombre-archivo": encodeURIComponent(archivo.name) },
    body: bytes,
  });
  return (await res.json()) as { id: string; estado: PortalDocumentoEstado; duplicado: boolean; nombreArchivo: string };
}

export async function enviarMensajePortal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, cuerpo: string): Promise<void> {
  await llamarPublico(fetchImpl, apiBaseUrl, token, "/portal-cliente/mensajes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cuerpo }) });
}

// Textos y tonos (terminologia SAT) -- puros, probados sin DOM.
const OBLIGACION_ESTADOS: Readonly<Record<string, { readonly etiqueta: string; readonly tono: "neutral" | "info" | "success" | "warning" | "danger" }>> = {
  pendiente: { etiqueta: "Pendiente", tono: "neutral" },
  en_proceso: { etiqueta: "En proceso", tono: "info" },
  completado: { etiqueta: "Presentada", tono: "success" },
  vencido: { etiqueta: "Vencida", tono: "danger" },
  escalado: { etiqueta: "En atención del despacho", tono: "warning" },
};
export function estadoObligacion(estado: string): { readonly etiqueta: string; readonly tono: "neutral" | "info" | "success" | "warning" | "danger" } {
  return OBLIGACION_ESTADOS[estado] ?? { etiqueta: estado, tono: "neutral" };
}

const CIERRE_ESTADOS: Readonly<Record<string, { readonly etiqueta: string; readonly tono: "info" | "success" | "danger" | "neutral" }>> = {
  open: { etiqueta: "En proceso", tono: "info" },
  closed: { etiqueta: "Cerrado", tono: "success" },
  overdue: { etiqueta: "Atrasado", tono: "danger" },
};
export function estadoCierre(estado: string): { readonly etiqueta: string; readonly tono: "info" | "success" | "danger" | "neutral" } {
  return CIERRE_ESTADOS[estado] ?? { etiqueta: estado, tono: "neutral" };
}

const DOCUMENTO_ESTADOS: Readonly<Record<PortalDocumentoEstado, { readonly etiqueta: string; readonly tono: "info" | "success" | "danger" }>> = {
  recibido: { etiqueta: "Recibido, en revisión", tono: "info" },
  aceptado: { etiqueta: "Aceptado por el despacho", tono: "success" },
  rechazado: { etiqueta: "Rechazado", tono: "danger" },
};
export function estadoDocumento(estado: PortalDocumentoEstado): { readonly etiqueta: string; readonly tono: "info" | "success" | "danger" } {
  return DOCUMENTO_ESTADOS[estado] ?? { etiqueta: estado, tono: "info" };
}

const MESES = ["", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export function nombreMes(mes: number, anio: number): string {
  return `${MESES[mes] ?? mes} de ${anio}`;
}

/** Porcentaje de avance de un cierre (0 si no hay tareas obligatorias). */
export function avanceCierre(c: Pick<PortalCierre, "tareasTotal" | "tareasListas">): number {
  return c.tareasTotal > 0 ? Math.round((c.tareasListas / c.tareasTotal) * 100) : 0;
}

// ------------------------------------------------------------------ STAFF
export interface PortalEnlaceStaff {
  readonly id: string;
  readonly etiqueta: string;
  readonly creadoEn: string;
  readonly expiraEn: string;
  readonly revocadoEn: string | null;
  readonly ultimoUsoEn: string | null;
  readonly usos: number;
}
export interface PortalDocumentoStaff {
  readonly id: string;
  readonly tipo: "cfdi_xml" | "pdf" | "imagen";
  readonly nombreArchivo: string;
  readonly tamanoBytes: number;
  readonly estado: PortalDocumentoEstado;
  readonly motivo: string | null;
  readonly resumen: Readonly<Record<string, string>>;
  readonly invoiceId: string | null;
  readonly creadoEn: string;
}
export interface PortalMensajeStaff extends PortalMensaje {
  readonly id: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/despachos/${propertyId}/portal-cliente`;

export function fetchPortalEnlaces(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchJson<{ disponible: boolean; enlaces: readonly PortalEnlaceStaff[] }>(f, `${base(apiBaseUrl, propertyId)}/enlaces`, token);
}
export function crearPortalEnlace(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, etiqueta: string, dias: number) {
  // D-30: un enlace nuevo da acceso a un tercero -> segundo factor reciente (lib/step-up.ts).
  return conStepUp({ fetchImpl: f, apiBaseUrl, token }, (h) => postJson<{ id: string; etiqueta: string; expiraEn: string; url: string }>(f, `${base(apiBaseUrl, propertyId)}/enlaces`, token, { etiqueta, dias }, h));
}
export function revocarPortalEnlace(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, enlaceId: string) {
  return conStepUp({ fetchImpl: f, apiBaseUrl, token }, (h) => postJson<{ revocado: boolean }>(f, `${base(apiBaseUrl, propertyId)}/enlaces/${enlaceId}/revocar`, token, {}, h));
}
export function fetchPortalDocumentos(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchJson<{ disponible: boolean; documentos: readonly PortalDocumentoStaff[] }>(f, `${base(apiBaseUrl, propertyId)}/documentos`, token);
}
export function aceptarPortalDocumento(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, documentoId: string) {
  return postJson<{ estado: "aceptado"; invoiceId: string | null; cfdi: { valido: boolean; requiereRevisionHumana: boolean; duplicado: boolean } | null; rep: { registrados: number; yaExistian: number; omitidos: number; rechazados: number } | null }>(f, `${base(apiBaseUrl, propertyId)}/documentos/${documentoId}/aceptar`, token, {});
}
export function rechazarPortalDocumento(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, documentoId: string, motivo: string) {
  return postJson<{ estado: "rechazado" }>(f, `${base(apiBaseUrl, propertyId)}/documentos/${documentoId}/rechazar`, token, { motivo });
}
export function descargarPortalDocumento(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, documentoId: string, nombre: string) {
  return fetchBlob(f, `${base(apiBaseUrl, propertyId)}/documentos/${documentoId}/descargar`, token, nombre);
}
export function fetchPortalMensajes(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string) {
  return fetchJson<{ disponible: boolean; mensajes: readonly PortalMensajeStaff[] }>(f, `${base(apiBaseUrl, propertyId)}/mensajes`, token);
}
export function enviarPortalMensajeStaff(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, cuerpo: string) {
  return postJson<{ id: string }>(f, `${base(apiBaseUrl, propertyId)}/mensajes`, token, { cuerpo });
}

/** Un enlace vigente = no revocado y no expirado (solo informativo; la base decide de verdad). */
export function estadoEnlace(e: Pick<PortalEnlaceStaff, "revocadoEn" | "expiraEn">, ahora: Date = new Date()): { readonly etiqueta: string; readonly tono: "success" | "neutral" | "danger" } {
  if (e.revocadoEn) return { etiqueta: "Revocado", tono: "danger" };
  if (new Date(e.expiraEn).getTime() <= ahora.getTime()) return { etiqueta: "Expirado", tono: "neutral" };
  return { etiqueta: "Vigente", tono: "success" };
}

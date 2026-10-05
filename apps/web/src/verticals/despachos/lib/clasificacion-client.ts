// D-P3-13 -- cliente de la clasificacion contable del CFDI (apps/api/.../despachos/clasificacion.ts, migracion 026): categoria de un CFDI (cada correccion
// es una fila NUEVA, nunca un cambio silencioso), reglas por RFC emisor y ajustes del cliente (umbral de confianza y autoaceptado del portal). Sin LLM: reglas +
// ClaveProdServ. Contra la base sin migrar el servidor responde `estado: "no_disponible"` (lecturas) o 503 (escrituras) y esta pantalla lo dice tal cual.
import { deleteJson, fetchJson, putJson } from "./admin-client.ts";

export type MetodoClasificacion = "reglas" | "claveprodserv" | "correccion" | "manual" | "heuristica_claveprodserv";

export interface ClasificacionVista {
  readonly categoria: string;
  readonly nombre: string;
  readonly confianza: number | null;
  readonly metodo: MetodoClasificacion;
  readonly razon: string | null;
  readonly cuenta: string | null;
  readonly empate: boolean;
  /** true = la escribio una persona (correccion o categoria indicada); false = el sistema. */
  readonly porPersona: boolean;
  readonly creadaEn: string;
}

export interface CategoriaContableOpcion {
  readonly id: string;
  readonly nombre: string;
}

export interface CatalogoClasificacion {
  readonly categorias: readonly CategoriaContableOpcion[];
  readonly pisoConfianza: number;
  readonly umbralPorOmision: number;
}

export interface CorreccionClasificacionVista {
  readonly id: string;
  readonly rfcEmisor: string;
  readonly claveProdServ: string | null;
  readonly categoria: string;
  readonly nombre: string;
  readonly cuenta: string | null;
  readonly creadaEn: string;
  readonly actualizadaEn: string;
}

export interface AjustesClasificacion {
  readonly estado: "disponible" | "no_disponible";
  readonly umbralConfianza: number;
  readonly portalAutoaceptarValidos: boolean;
  readonly pisoConfianza: number;
}

export const ETIQUETA_METODO_CLASIFICACION: Readonly<Record<string, string>> = {
  reglas: "Por palabras de la descripción",
  claveprodserv: "Por ClaveProdServ",
  correccion: "Corrección del despacho para este emisor",
  manual: "Indicada por una persona",
  heuristica_claveprodserv: "Por ClaveProdServ",
};

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/despachos/${propertyId}`;

export async function fetchCatalogoClasificacion(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<CatalogoClasificacion> {
  return fetchJson<CatalogoClasificacion>(f, `${base(apiBaseUrl, propertyId)}/clasificacion/catalogo`, token);
}

/** `PUT .../cfdi/:invoiceId/categoria` -- corrige la categoria de UN CFDI (fila nueva); con `guardarRegla` el RFC del emisor queda corregido para los siguientes. */
export async function corregirCategoriaCfdi(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  invoiceId: string,
  datos: { readonly categoria: string; readonly cuenta?: string | null; readonly guardarRegla?: boolean },
): Promise<{ clasificacionId: string; clasificacion: ClasificacionVista | null }> {
  return putJson(f, `${base(apiBaseUrl, propertyId)}/cfdi/${invoiceId}/categoria`, token, { categoria: datos.categoria, ...(datos.cuenta ? { cuenta: datos.cuenta } : {}), guardarRegla: datos.guardarRegla === true });
}

export async function fetchCorrecciones(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ estado: "ok" | "no_disponible"; correcciones: readonly CorreccionClasificacionVista[] }> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/clasificacion/correcciones`, token);
}

export async function guardarCorreccion(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  datos: { readonly rfcEmisor: string; readonly claveProdServ?: string | null; readonly categoria: string; readonly cuenta?: string | null },
): Promise<{ id: string }> {
  return putJson(f, `${base(apiBaseUrl, propertyId)}/clasificacion/correcciones`, token, {
    rfcEmisor: datos.rfcEmisor,
    ...(datos.claveProdServ ? { claveProdServ: datos.claveProdServ } : {}),
    categoria: datos.categoria,
    ...(datos.cuenta ? { cuenta: datos.cuenta } : {}),
  });
}

export async function eliminarCorreccion(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, id: string): Promise<{ eliminada: boolean }> {
  return deleteJson(f, `${base(apiBaseUrl, propertyId)}/clasificacion/correcciones/${id}`, token);
}

export async function fetchAjustesClasificacion(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<AjustesClasificacion> {
  return fetchJson<AjustesClasificacion>(f, `${base(apiBaseUrl, propertyId)}/clasificacion/ajustes`, token);
}

export async function guardarAjustesClasificacion(
  f: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  cambios: { readonly umbralConfianza?: number; readonly portalAutoaceptarValidos?: boolean },
): Promise<AjustesClasificacion> {
  return putJson<AjustesClasificacion>(f, `${base(apiBaseUrl, propertyId)}/clasificacion/ajustes`, token, cambios);
}

/** Valida en pantalla lo que el servidor tambien exige (RFC emisor); el servidor y la base son la autoridad. */
export function esRfcValido(valor: string): boolean {
  return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(valor.trim().toUpperCase());
}

/** "0.45" -> "45 %". */
export function formatConfianza(valor: number | null | undefined): string {
  return valor === null || valor === undefined ? "—" : `${Math.round(valor * 100)} %`;
}

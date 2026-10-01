// Rn-18 -- cliente de las reglas de comisión de canal (GET/POST/PATCH + "cargar sugeridas") de
// `apps/api/src/routes/verticals/rentas/finanzas-reglas-comision.ts`. Los códigos de canal y los rangos son los del
// servidor (`packages/domain-rentas/src/catalogo/validacion.ts`), duplicados aquí a propósito: apps/web no depende de los
// paquetes de dominio. El servidor es SIEMPRE la autoridad (rol, alcance, duplicados); esto solo da el primer feedback.
import { fetchJson, sendJson } from "./admin-client.ts";

export interface ReglaComision {
  readonly id: string;
  readonly alcance: "organizacion" | "propiedad";
  readonly propertyId: string | null;
  readonly canalCodigo: string;
  readonly canalNombre: string;
  readonly yaNetoDeComision: boolean;
  readonly comisionBasisPoints: number;
  readonly fuente: string;
  readonly vigenteDesde: string;
  /** Viene del sembrado por defecto y nadie la ha confirmado: porcentaje estimado, sin verificar. */
  readonly sugerida: boolean;
}

export interface CanalComision {
  readonly codigo: string;
  readonly nombre: string;
}

export interface ReglasComisionRespuesta {
  readonly reglas: readonly ReglaComision[];
  readonly canales: readonly CanalComision[];
  /** Canales externos que NO tienen regla (ni global ni de la propiedad): sus reservas no pueden registrar movimiento. */
  readonly canalesSinRegla: readonly string[];
}

export interface EntradaRegla {
  readonly canalCodigo: string;
  readonly alcance: "organizacion" | "propiedad";
  readonly yaNetoDeComision: boolean;
  readonly comisionBasisPoints: number;
  readonly fuente: string;
}

export type EntradaEditarRegla = Pick<EntradaRegla, "yaNetoDeComision" | "comisionBasisPoints" | "fuente">;

const ruta = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/rentas/${propertyId}/finanzas/reglas-comision`;

export function fetchReglasComision(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ReglasComisionRespuesta> {
  return fetchJson<ReglasComisionRespuesta>(fetchImpl, ruta(apiBaseUrl, propertyId), token);
}

export function crearReglaComision(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, entrada: EntradaRegla): Promise<{ id: string }> {
  return sendJson<{ id: string }>(fetchImpl, ruta(apiBaseUrl, propertyId), token, "POST", entrada);
}

export function editarReglaComision(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reglaId: string, entrada: EntradaEditarRegla): Promise<{ id: string }> {
  return sendJson<{ id: string }>(fetchImpl, `${ruta(apiBaseUrl, propertyId)}/${reglaId}`, token, "PATCH", entrada);
}

export function cargarReglasSugeridas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ creadas: number }> {
  return sendJson<{ creadas: number }>(fetchImpl, `${ruta(apiBaseUrl, propertyId)}/sugeridas`, token, "POST", {});
}

/** `1500` -> "15.00 %" (los puntos base nunca se muestran crudos). */
export function basisPointsAPorcentaje(bps: number): string {
  return `${(bps / 100).toFixed(2)} %`;
}

/** "15" o "15.5" -> 1500 / 1550; `null` si no es un porcentaje entre 0 y 100 con a lo mas 2 decimales. */
export function porcentajeABasisPoints(texto: string): number | null {
  const t = texto.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 100);
  return n >= 0 && n <= 10000 ? n : null;
}

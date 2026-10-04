// Cliente HTTP tipado de la encuesta post-entrega, lado PANEL (R-41, migracion 061). Mismo criterio que voz-kpi-client.ts: 404/503 o
// `disponible: false` (base sin migrar) = VozNoDisponibleError y la pantalla muestra un estado honesto; nunca inventa cifras.
import { pedir, VozNoDisponibleError } from "./voz-client.ts";

export interface EncuestaConfig {
  readonly activa: boolean;
  readonly esperaMin: number;
  readonly resenasUrl: string | null;
  readonly umbralResena: number;
}

export interface EncuestaPromedio {
  readonly enviadas: number;
  readonly respondidas: number;
  /** null = sin respuestas (no hay base para el promedio). */
  readonly promedio: number | null;
  /** null = sin envios. */
  readonly tasaRespuestaPct: number | null;
}

export interface EncuestaPorSucursal extends EncuestaPromedio {
  readonly propertyId: string;
  readonly nombre: string;
}

export interface EncuestaPorRepartidor extends EncuestaPromedio {
  readonly repartidorId: string;
  readonly nombre: string;
}

export interface EncuestaComentario {
  readonly id: string;
  readonly pedido: number | null;
  readonly propertyId: string;
  readonly sucursal: string;
  readonly calificacion: number;
  readonly comentario: string | null;
  readonly respondidaAt: string;
  readonly repartidor: string | null;
}

export type EncuestaAlcance = "organizacion" | "sucursal";

export interface EncuestaResumenRespuesta {
  readonly zonaHoraria: string;
  readonly hoy: string;
  readonly desde: string;
  readonly hasta: string;
  readonly alcance: EncuestaAlcance;
  readonly resumen: EncuestaPromedio & { readonly distribucion: readonly number[] };
  readonly porSucursal: readonly EncuestaPorSucursal[];
  readonly porRepartidor: readonly EncuestaPorRepartidor[];
  readonly recientes: readonly EncuestaComentario[];
}

export interface EnvioPendientesRespuesta {
  readonly candidatas: number;
  readonly encoladas: number;
  readonly yaRegistradas: number;
  readonly omitidas: { readonly telefono_invalido: number; readonly sin_canal_whatsapp: number };
  readonly errores: number;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/encuestas`;

export async function fetchEncuestaConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<EncuestaConfig> {
  const r = await pedir<{ disponible: boolean; config: EncuestaConfig }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "GET" });
  if (r.disponible === false) throw new VozNoDisponibleError(503);
  return r.config;
}

/** 503 = base sin la migracion 061: se propaga como VozNoDisponibleError (la pantalla dice que aun no esta disponible). */
export async function guardarEncuestaConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, config: EncuestaConfig): Promise<EncuestaConfig> {
  const r = await pedir<{ config: EncuestaConfig }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "PUT", body: config });
  return r.config;
}

export async function fetchEncuestaResumen(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, dias: number, alcance: EncuestaAlcance): Promise<EncuestaResumenRespuesta> {
  const url = `${base(apiBaseUrl, propertyId)}/resumen?dias=${encodeURIComponent(String(dias))}&alcance=${alcance}`;
  const r = await pedir<EncuestaResumenRespuesta & { disponible: boolean }>(fetchImpl, url, token, { method: "GET" });
  if (r.disponible === false) throw new VozNoDisponibleError(503);
  return r;
}

export async function enviarEncuestasPendientes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<EnvioPendientesRespuesta> {
  const r = await pedir<EnvioPendientesRespuesta & { disponible: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/enviar-pendientes`, token, { method: "POST", body: {} });
  if (r.disponible === false) throw new VozNoDisponibleError(503);
  return r;
}

// Cliente HTTP tipado de los KPI de voz, el costo por día y las alertas operativas (R-13, migración 035).
// Mismo criterio que voz-client.ts: 404/503 o `disponible: false` (base sin migrar) = VozNoDisponibleError y la
// interfaz muestra un estado honesto; nunca inventa cifras.
import { base, pedir, VozNoDisponibleError } from "./voz-client.ts";

export interface VozKpiTotales {
  readonly dias: number;
  readonly llamadas: number;
  readonly llamadasCerradas: number;
  readonly duracionPromedioS: number | null;
  readonly pedidosVoz: number;
  readonly escaladas: number;
  readonly abandonadas: number;
  readonly tasaResolucionPct: number | null;
  readonly tasaHandoffPct: number | null;
  readonly tasaAbandonoPct: number | null;
  readonly erroresProveedor: number;
  readonly erroresTwilio: number;
  readonly erroresOtros: number;
  readonly tasaErrorPct: number | null;
  readonly toolCalls: number;
  readonly toolP95PeorDiaMs: number | null;
  readonly costoVozMicroUsd: number;
  readonly costoTelefoniaMicroUsd: number;
  /** Centavos MXN enteros; null = hay gasto pero falta el tipo de cambio. */
  readonly costoCentavosMxn: number | null;
  readonly costoCompleto: boolean;
  readonly costoPorLlamadaCentavosMxn: number | null;
  /** LLM de la ORGANIZACIÓN (todas las sucursales y canales); null si no tienes alcance de toda la organización. */
  readonly costoLlmOrgCentavosMxn: number | null;
}

export interface VozKpiDiaSerie {
  readonly fecha: string;
  readonly llamadas: number;
  readonly pedidosVoz: number;
  readonly escaladas: number;
  readonly erroresProveedor: number;
  readonly toolP95Ms: number | null;
  readonly costoCentavosMxn: number | null;
}

export interface VozKpi {
  readonly zonaHoraria: string;
  readonly hoy: string;
  readonly diaDeHoy: VozKpiTotales;
  readonly mes: VozKpiTotales;
  readonly serie: readonly VozKpiDiaSerie[];
}

export type VozAlertaTipo = "costo_dia" | "tasa_error";

export interface VozAlerta {
  readonly fecha: string;
  readonly tipo: VozAlertaTipo;
  /** costo_dia: centavos MXN; tasa_error: porcentaje. */
  readonly valor: number;
  readonly umbral: number;
  readonly nueva: boolean;
}

export interface VozUmbrales {
  readonly configurado: boolean;
  readonly umbralCostoDiaCentavosMxn: number | null;
  readonly umbralTasaErrorPct: number | null;
  readonly minLlamadasTasaError: number;
}

export type VozUmbralesInput = Omit<VozUmbrales, "configurado">;

export async function fetchVozKpi(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<VozKpi> {
  const w = await pedir<VozKpi & { disponible: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/kpi`, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w;
}

export async function fetchVozAlertas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<{ readonly umbrales: VozUmbrales; readonly alertas: readonly VozAlerta[] }> {
  const w = await pedir<{ disponible: boolean; umbrales: VozUmbrales; alertas: VozAlerta[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/alertas`, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return { umbrales: w.umbrales, alertas: w.alertas };
}

/** Compara HOY con los umbrales y registra las alertas nuevas (panel + bitácora). No envía WhatsApp ni correo. */
export async function evaluarVozAlertas(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly VozAlerta[]> {
  const w = await pedir<{ disponible: boolean; alertas: VozAlerta[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/alertas/evaluar`, token, { method: "POST", body: {} });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w.alertas;
}

export async function updateVozUmbrales(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: VozUmbralesInput): Promise<VozUmbrales> {
  const w = await pedir<VozUmbrales & { disponible: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/alertas/config`, token, { method: "PUT", body: input });
  return { configurado: w.configurado, umbralCostoDiaCentavosMxn: w.umbralCostoDiaCentavosMxn, umbralTasaErrorPct: w.umbralTasaErrorPct, minLlamadasTasaError: w.minLlamadasTasaError };
}

/** Un día local de la sucursal: llamadas que llegaron por desvío del conmutador (el personal no las contestó), sus pedidos y ventas, y la latencia de voz a voz. */
export interface VozKpiDesbordeDia {
  readonly fecha: string;
  readonly llamadasDesborde: number;
  readonly pedidosDesborde: number;
  /** Pesos MXN (suma de los totales de esos pedidos, sin cancelados). */
  readonly ventasRecuperadas: number;
  readonly llamadasConModo: number;
  readonly llamadasConLatencia: number;
  readonly latenciaP50Ms: number | null;
  readonly latenciaP95Ms: number | null;
}

export interface VozKpiDesborde {
  readonly zonaHoraria: string;
  readonly desde: string;
  readonly hasta: string;
  /** Objetivo de latencia de voz a voz (p95), ms. */
  readonly objetivoLatenciaP95Ms: number;
  readonly totales: { readonly llamadasDesborde: number; readonly pedidosDesborde: number; readonly ventasRecuperadas: number };
  /** Último día con muestras de latencia (los percentiles no se suman entre días). */
  readonly ultimaLatencia: { readonly fecha: string; readonly p50Ms: number | null; readonly p95Ms: number | null; readonly llamadas: number } | null;
  readonly serie: readonly VozKpiDesbordeDia[];
}

/** Llamadas no contestadas por el personal -> pedidos -> ventas recuperadas, y latencia de voz a voz (migración 067). 404/503 o `disponible: false` = no disponible aún. */
export async function fetchVozKpiDesborde(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<VozKpiDesborde> {
  const w = await pedir<VozKpiDesborde & { disponible: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/kpi-desborde`, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w;
}

// Cliente HTTP tipado del cierre del día y resumen semanal (R-42, migración 041). Mismo criterio que whatsapp-kpi-client.ts: 404/503 o
// `disponible: false` (base sin migrar) = VozNoDisponibleError y la pantalla muestra un estado honesto; nunca inventa cifras.
import { pedir, VozNoDisponibleError } from "./voz-client.ts";

export type CierreTipo = "dia" | "semana";

export interface CierreCanalFila {
  readonly canal: "web" | "whatsapp" | "voice" | "admin";
  readonly pedidos: number;
  readonly ventasCentavos: number;
  readonly cancelados: number;
}

export interface CierreFila {
  readonly id: string;
  readonly tipo: CierreTipo;
  readonly fechaInicio: string;
  readonly fechaFin: string;
  readonly zonaHoraria: string;
  readonly generadoPor: "sistema" | "staff";
  readonly generadoAt: string;
  readonly pedidos: number;
  readonly ventasCentavos: number;
  /** null = sin pedidos (no hay base para el promedio). */
  readonly ticketPromedioCentavos: number | null;
  readonly conProblema: number;
  readonly cancelados: number;
  readonly canceladosCentavos: number;
  readonly noRecogidos: number;
  readonly cancelacionPct: number | null;
  readonly porCanal: readonly CierreCanalFila[];
  readonly tiempos: { readonly entregados: number; readonly promedioMin: number | null; readonly medianaMin: number | null; readonly p90Min: number | null };
  readonly comparativo: {
    readonly fechaInicio: string;
    readonly fechaFin: string;
    readonly pedidos: number;
    readonly ventasCentavos: number;
    readonly variacionPedidosPct: number | null;
    readonly variacionVentasPct: number | null;
  } | null;
  readonly porDia: readonly { readonly fecha: string; readonly pedidos: number; readonly ventasCentavos: number }[] | null;
}

export interface CierresLista {
  readonly tipo: CierreTipo;
  readonly zonaHoraria: string;
  readonly hoy: string;
  readonly cierres: readonly CierreFila[];
  /** Fechas de inicio de periodos ya terminados que aún no tienen cierre (más reciente primero). */
  readonly pendientes: readonly string[];
}

export interface CierreGenerado {
  readonly estado: "creado" | "existente";
  readonly cierre: CierreFila;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/cierres`;

export async function fetchCierres(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tipo: CierreTipo): Promise<CierresLista> {
  const w = await pedir<CierresLista & { disponible: boolean }>(fetchImpl, `${base(apiBaseUrl, propertyId)}?tipo=${tipo}`, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w;
}

export async function generarCierre(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tipo: CierreTipo, fecha: string): Promise<CierreGenerado> {
  return pedir<CierreGenerado>(fetchImpl, `${base(apiBaseUrl, propertyId)}/generar`, token, { method: "POST", body: { tipo, fecha } });
}

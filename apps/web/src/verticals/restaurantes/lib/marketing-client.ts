// Cliente HTTP tipado de las campanas de reactivacion de clientes inactivos (autopiloto 2, migracion 052). Mismo criterio que cierres-client.ts:
// 404/503 o `disponible: false` (base sin migrar) = VozNoDisponibleError y la pantalla muestra un estado honesto; nunca inventa cifras.
// La regla (consentimiento, tope de 14 dias, control, aprobacion) vive en el servidor: aqui solo se llama y se tipa.
import { pedir, VozNoDisponibleError } from "./voz-client.ts";

export type SegmentoCampana = "inactivo_30" | "inactivo_60" | "inactivo_90";
export type EstadoCampana = "borrador" | "aprobada" | "rechazada" | "expirada";

export interface ConfigMarketing {
  readonly activo: boolean;
  readonly tarifaCentavos: number | null;
  readonly topeMensualCentavos: number | null;
  readonly minimoSegmento: number;
  readonly plantillaNombre: string | null;
  readonly plantillaIdioma: string;
  readonly hayPromocionVigente: boolean;
  readonly plantillaAprobada: boolean;
  readonly whatsappConectado: boolean;
  readonly gastadoMesCentavos: number;
  readonly consentimientosVigentes: number;
}

export interface CampanaMarketing {
  readonly id: string;
  readonly segmento: SegmentoCampana;
  readonly estado: EstadoCampana;
  readonly conteo: number;
  readonly conteoControl: number;
  readonly costoEstimadoCentavos: number | null;
  readonly promoNombre: string;
  readonly promoCodigo: string;
  readonly creadaAt: string;
  readonly decididaAt: string | null;
  readonly encolados: number | null;
  readonly enviados: number;
  readonly recompraTratados: number;
  readonly recompraControl: number;
  readonly ingresoTratados: number;
  readonly ventanaCerrada: boolean;
}

export interface PanelMarketing {
  readonly config: ConfigMarketing;
  readonly campanas: readonly CampanaMarketing[];
}

export interface EntradaConfigMarketing {
  readonly activo: boolean;
  readonly tarifaCentavos: number | null;
  readonly topeMensualCentavos: number | null;
  readonly minimoSegmento: number;
  readonly plantillaNombre: string | null;
  readonly plantillaIdioma: string;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/marketing`;

export async function fetchMarketing(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<PanelMarketing> {
  const w = await pedir<{ disponible: boolean; config: ConfigMarketing | null; campanas: CampanaMarketing[] }>(fetchImpl, base(apiBaseUrl, propertyId), token, { method: "GET" });
  if (w.disponible === false || w.config === null) throw new VozNoDisponibleError(503);
  return { config: w.config, campanas: w.campanas };
}

export async function guardarConfigMarketing(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, c: EntradaConfigMarketing): Promise<void> {
  await pedir<unknown>(fetchImpl, `${base(apiBaseUrl, propertyId)}/config`, token, { method: "PUT", body: c });
}

export interface ResultadoDecision {
  readonly estado: "aprobada" | "rechazada";
  readonly encolados: number;
  readonly control: number;
}

export async function decidirCampana(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, campanaId: string, accion: "aprobar" | "rechazar"): Promise<ResultadoDecision> {
  return pedir<ResultadoDecision>(fetchImpl, `${base(apiBaseUrl, propertyId)}/campanas/${encodeURIComponent(campanaId)}/decidir`, token, { method: "POST", body: { accion } });
}

/** Etiqueta legible del segmento (dias desde el ultimo pedido). */
export const ETIQUETA_SEGMENTO: Readonly<Record<SegmentoCampana, string>> = {
  inactivo_30: "30 a 59 días sin pedir",
  inactivo_60: "60 a 89 días sin pedir",
  inactivo_90: "90 días o más sin pedir",
};

/**
 * Recompra incremental en puntos porcentuales: tasa de recompra de los tratados MENOS la del grupo de control (sin mensaje). `null` mientras la
 * ventana de 7 dias sigue abierta, si no hay control con que comparar o si no hubo envios: nunca se suma "todo lo que volvio".
 */
export function recompraIncremental(c: Pick<CampanaMarketing, "encolados" | "conteoControl" | "recompraTratados" | "recompraControl" | "ventanaCerrada" | "estado">): number | null {
  if (c.estado !== "aprobada" || !c.ventanaCerrada || !c.encolados || c.conteoControl <= 0) return null;
  const tratados = (c.recompraTratados / c.encolados) * 100;
  const control = (c.recompraControl / c.conteoControl) * 100;
  return Math.round((tratados - control) * 10) / 10;
}

// Cliente HTTP tipado del KPI del agente de WhatsApp (R-31, migración 040). Mismo criterio que voz-kpi-client.ts: 404/503 o
// `disponible: false` (base sin migrar) = VozNoDisponibleError y la pantalla muestra un estado honesto; nunca inventa cifras.
import { pedir, VozNoDisponibleError } from "./voz-client.ts";

export interface WhatsappKpiResumen {
  readonly dias: number;
  readonly conversaciones: number;
  readonly conversacionesConPedido: number;
  readonly conversacionesConHandoff: number;
  /** null = no hubo conversaciones nuevas (no hay base para el porcentaje). */
  readonly conversionPct: number | null;
  readonly handoffPct: number | null;
  readonly pedidos: number;
  readonly handoffs: number;
  /** Pedidos de WhatsApp de TODA la organización; null si no tienes alcance de toda la organización. */
  readonly pedidosOrg: number | null;
  readonly orgEsDemo: boolean;
  /** Centavos MXN enteros del LLM del agente de WhatsApp de la ORGANIZACIÓN; null = no disponible. */
  readonly costoLlmOrgCentavosMxn: number | null;
  /** Promedio del periodo (costo de la organización / pedidos de la organización); null si falta algún dato. */
  readonly costoLlmPorPedidoCentavosMxn: number | null;
}

export interface WhatsappKpiDiaSerie {
  readonly fecha: string;
  readonly conversaciones: number;
  readonly conversacionesConPedido: number;
  readonly conversionPct: number | null;
  readonly handoffPct: number | null;
  readonly pedidos: number;
  readonly handoffs: number;
  readonly pedidosOrg: number | null;
  readonly costoLlmOrgCentavosMxn: number | null;
  readonly costoLlmPorPedidoCentavosMxn: number | null;
}

/** Entrega y lectura de los avisos de estado de pedido por WhatsApp (migracion 066): solo conteos. */
export interface WhatsappEntregaResumen {
  readonly dias: number;
  readonly enviados: number;
  readonly entregados: number;
  readonly leidos: number;
  readonly fallidos: number;
  readonly sinEstado: number;
  /** entregados / enviados; null si no hubo envios. */
  readonly entregaPct: number | null;
  /** leidos / entregados; null si nada se entrego. */
  readonly lecturaPct: number | null;
  readonly fallosPorMotivo: Readonly<Record<string, number>>;
}

export interface WhatsappEntregaDiaSerie {
  readonly fecha: string;
  readonly enviados: number;
  readonly entregados: number;
  readonly leidos: number;
  readonly fallidos: number;
  readonly sinEstado: number;
  readonly fallosPorMotivo: Readonly<Record<string, number>>;
}

export interface WhatsappEntrega {
  /** false = la base aun no tiene la migracion 066: estado honesto, no ceros. */
  readonly disponible: boolean;
  readonly resumen: WhatsappEntregaResumen;
  readonly serie: readonly WhatsappEntregaDiaSerie[];
}

export interface WhatsappKpi {
  readonly zonaHoraria: string;
  readonly hoy: string;
  readonly desde: string;
  readonly hasta: string;
  readonly resumen: WhatsappKpiResumen;
  readonly serie: readonly WhatsappKpiDiaSerie[];
  /** Ausente en una API anterior a la 066: la pantalla lo trata como "no disponible". */
  readonly entrega?: WhatsappEntrega;
}

export async function fetchWhatsappKpi(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, dias: number): Promise<WhatsappKpi> {
  const url = `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/whatsapp/kpi?dias=${encodeURIComponent(String(dias))}`;
  const w = await pedir<WhatsappKpi & { disponible: boolean }>(fetchImpl, url, token, { method: "GET" });
  if (w.disponible === false) throw new VozNoDisponibleError(503);
  return w;
}

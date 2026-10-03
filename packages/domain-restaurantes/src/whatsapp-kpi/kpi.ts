// KPI del agente de WhatsApp de restaurantes (R-31, migracion 040). Tipos y calculos puros: las definiciones de cada cifra
// viven en el encabezado de packages/domain-restaurantes/migrations/040_whatsapp_kpis_diarios.sql y los rotulos de la
// pantalla las repiten. Todo dinero en enteros (micro-USD y centavos MXN); un dato que no existe es `null`, jamas 0.

/** Una fila por dia LOCAL de la sucursal. */
export interface WhatsappKpiDia {
  readonly fecha: string;
  readonly zonaHoraria: string;
  /** Conversaciones nuevas del dia (primer contacto del cliente con la sucursal; sin trafico demo). */
  readonly conversaciones: number;
  /** De esas conversaciones nuevas, las ligadas a un pedido de WhatsApp no cancelado. */
  readonly conversacionesConPedido: number;
  /** De esas conversaciones nuevas, las que alguna vez pidieron un humano. */
  readonly conversacionesConHandoff: number;
  /** Pedidos de WhatsApp (no cancelados) creados ese dia en la sucursal. */
  readonly pedidos: number;
  /** Solicitudes de atencion humana hechas ese dia en la sucursal. */
  readonly handoffs: number;
  /** Pedidos de WhatsApp de TODA la organizacion ese dia; null sin alcance de toda la organizacion. */
  readonly pedidosOrg: number | null;
  /** Organizacion demo: su costo LLM mezcla el widget publico con uso real y no se muestra. */
  readonly orgEsDemo: boolean;
  /** Costo LLM del agente de WhatsApp de la ORGANIZACION (no de la sucursal); null = no disponible para este usuario/organizacion. */
  readonly costoLlmOrgMicroUsd: number | null;
  /** Null tambien cuando no hay tipo de cambio para ese dia. */
  readonly costoLlmOrgCentavosMxn: number | null;
}

export interface WhatsappKpiResumen {
  readonly dias: number;
  readonly conversaciones: number;
  readonly conversacionesConPedido: number;
  readonly conversacionesConHandoff: number;
  readonly pedidos: number;
  readonly handoffs: number;
  /** conversacionesConPedido / conversaciones, en % con un decimal; null si no hubo conversaciones. */
  readonly conversionPct: number | null;
  /** conversacionesConHandoff / conversaciones, en % con un decimal; null si no hubo conversaciones. */
  readonly handoffPct: number | null;
  readonly pedidosOrg: number | null;
  readonly orgEsDemo: boolean;
  readonly costoLlmOrgMicroUsd: number | null;
  readonly costoLlmOrgCentavosMxn: number | null;
  /** Promedio: costo LLM de la organizacion / pedidos de WhatsApp de la organizacion del periodo. Null si falta algun dato. */
  readonly costoLlmPorPedidoCentavosMxn: number | null;
}

/** Porcentaje con un decimal, o null cuando el denominador es 0 (no hay base: nunca "0%"). */
export function porcentaje(numerador: number, denominador: number): number | null {
  if (denominador <= 0) return null;
  return Math.round((numerador * 1000) / denominador) / 10;
}

function sumaONull(valores: readonly (number | null)[]): number | null {
  let total = 0;
  for (const v of valores) {
    if (v === null) return null;
    total += v;
  }
  return total;
}

/** Costo por pedido del dia (o del periodo): centavos MXN redondeados; null si falta el costo o no hubo pedidos. */
export function costoPorPedidoCentavos(costoCentavos: number | null, pedidosOrg: number | null): number | null {
  if (costoCentavos === null || pedidosOrg === null || pedidosOrg <= 0) return null;
  return Math.round(costoCentavos / pedidosOrg);
}

export function resumirWhatsappKpi(dias: readonly WhatsappKpiDia[]): WhatsappKpiResumen {
  const conversaciones = dias.reduce((a, d) => a + d.conversaciones, 0);
  const conPedido = dias.reduce((a, d) => a + d.conversacionesConPedido, 0);
  const conHandoff = dias.reduce((a, d) => a + d.conversacionesConHandoff, 0);
  const costoCentavos = dias.length === 0 ? null : sumaONull(dias.map((d) => d.costoLlmOrgCentavosMxn));
  const pedidosOrg = dias.length === 0 ? null : sumaONull(dias.map((d) => d.pedidosOrg));
  return {
    dias: dias.length,
    conversaciones,
    conversacionesConPedido: conPedido,
    conversacionesConHandoff: conHandoff,
    pedidos: dias.reduce((a, d) => a + d.pedidos, 0),
    handoffs: dias.reduce((a, d) => a + d.handoffs, 0),
    conversionPct: porcentaje(conPedido, conversaciones),
    handoffPct: porcentaje(conHandoff, conversaciones),
    pedidosOrg,
    orgEsDemo: dias.some((d) => d.orgEsDemo),
    costoLlmOrgMicroUsd: dias.length === 0 ? null : sumaONull(dias.map((d) => d.costoLlmOrgMicroUsd)),
    costoLlmOrgCentavosMxn: costoCentavos,
    costoLlmPorPedidoCentavosMxn: costoPorPedidoCentavos(costoCentavos, pedidosOrg),
  };
}

/** Lectura con estado honesto: `disponible: false` = la base todavia no tiene la migracion 040 (nunca se confunde con "no hay datos"). */
export interface WhatsappKpiLectura<T> {
  readonly disponible: boolean;
  readonly valor: T;
}

/** Puerto de lectura del KPI. Solo owner/admin con alcance a la sucursal (la base lo exige con 42501). */
export interface WhatsappKpiRepository {
  /** KPI por dia local de la sucursal, de `desde` a `hasta` (YYYY-MM-DD, inclusive, maximo 63 dias). Un dia sin datos aparece en ceros. */
  getKpisDiarios(organizationId: string, propertyId: string, desde: string, hasta: string): Promise<WhatsappKpiLectura<readonly WhatsappKpiDia[]>>;
}

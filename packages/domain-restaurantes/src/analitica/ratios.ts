// Analítica del dueño · RATIOS de restaurante. Una sola definición (aquí) de cada razón; el SQL (162) entrega conteos enteros.
// Regla de honestidad: si el denominador es 0 o falta el dato, el ratio es `null` (la pantalla pone «—»), nunca 0 ni un valor inventado.
import type { FilaRatiosCruda, VentanaRecompra } from "./tipos.ts";

export interface DefinicionRatio {
  readonly id: string;
  readonly etiqueta: string;
  readonly unidad: "pesos" | "porcentaje" | "razon" | "segundos" | "entero";
  readonly definicion: string;
}

/** Definiciones EXACTAS que muestra el panel (tooltip) y que repite el reporte de entrega. Deben coincidir con `calcularRatios` y con la migración 162. */
export const DEFINICIONES_RATIOS: readonly DefinicionRatio[] = [
  { id: "ticket", etiqueta: "Ticket promedio", unidad: "pesos", definicion: "Venta neta del periodo ÷ número de pedidos de venta (sin cancelados, falsos, reposiciones ni tráfico de prueba)." },
  { id: "frecuencia", etiqueta: "Frecuencia", unidad: "razon", definicion: "Pedidos con cliente ÷ clientes distintos con venta en el periodo (pedidos por cliente)." },
  { id: "recompra14", etiqueta: "Recompra a 14 días", unidad: "porcentaje", definicion: "De los clientes nuevos (primera venta del periodo, mirando 365 días atrás) cuya primera venta tuvo al menos 14 días para repetir, % que volvió a comprar en un día posterior y dentro de 14 días." },
  { id: "recompra30", etiqueta: "Recompra a 30 días", unidad: "porcentaje", definicion: "Igual que la de 14 días con ventana de 30." },
  { id: "recompra60", etiqueta: "Recompra a 60 días", unidad: "porcentaje", definicion: "Igual que la de 14 días con ventana de 60." },
  { id: "cancelacion", etiqueta: "Tasa de cancelación", unidad: "porcentaje", definicion: "Pedidos cancelados ÷ (pedidos de venta + cancelados). No cuenta pedidos falsos ni reposiciones." },
  { id: "grandes", etiqueta: "Pedidos grandes", unidad: "porcentaje", definicion: "Pedidos de venta con total mayor a $4,000 ÷ pedidos de venta. El criterio por peso (más de 5 kg) no se mide aquí." },
  { id: "conversion", etiqueta: "Conversión chat → pedido", unidad: "porcentaje", definicion: "Conversaciones nuevas de WhatsApp del periodo ligadas a un pedido no cancelado de la misma sucursal ÷ conversaciones nuevas de WhatsApp." },
  { id: "primeraRespuesta", etiqueta: "Primera respuesta (mediana)", unidad: "segundos", definicion: "Por cada racha de mensajes del cliente, segundos hasta el siguiente mensaje del asistente (agente o persona); mediana. Solo mensajes con hora registrada; las rachas aún sin respuesta no cuentan." },
  { id: "respuesta5", etiqueta: "Respondido en 5 min o menos", unidad: "porcentaje", definicion: "Rachas respondidas en 300 segundos o menos ÷ rachas respondidas." },
  { id: "resueltoAgente", etiqueta: "Resuelto por el agente", unidad: "porcentaje", definicion: "(Conversaciones nuevas de WhatsApp − las que alguna vez pidieron una persona) ÷ conversaciones nuevas. Es una cota superior: no mide la satisfacción del cliente." },
  { id: "escalado", etiqueta: "Escalado a una persona", unidad: "porcentaje", definicion: "Conversaciones nuevas de WhatsApp con solicitud de persona ÷ conversaciones nuevas de WhatsApp." },
  { id: "costoConversacion", etiqueta: "Costo por conversación", unidad: "pesos", definicion: "(Voz + telefonía + Meta + LLM, en pesos) ÷ (conversaciones nuevas de WhatsApp + llamadas). El LLM solo entra en el conjunto de la organización completa; sin tipo de cambio no se calcula." },
] as const;

export interface RatiosCalculados {
  readonly propertyId: string | null;
  readonly pedidos: number;
  readonly netaCentavos: number;
  readonly ticketCentavos: number | null;
  readonly clientes: number;
  readonly clientesNuevos: number;
  readonly frecuencia: number | null;
  readonly recompra14: RecompraCalculada;
  readonly recompra30: RecompraCalculada;
  readonly recompra60: RecompraCalculada;
  readonly cancelados: number;
  readonly tasaCancelacionPct: number | null;
  readonly grandes: number;
  readonly pctGrandes: number | null;
  readonly convChats: number;
  readonly conversionChatPedidoPct: number | null;
  readonly vozLlamadas: number;
  readonly conversionVozPedidoPct: number | null;
  readonly primeraRespuestaMedianaSeg: number | null;
  readonly primeraRespuestaP90Seg: number | null;
  readonly respondidoEn5minPct: number | null;
  readonly respuestasMedidas: number;
  readonly resueltoPorAgentePct: number | null;
  readonly escaladoPct: number | null;
  readonly costoTotalCentavos: number | null;
  readonly costoPorConversacionCentavos: number | null;
}
export interface RecompraCalculada extends VentanaRecompra { readonly pct: number | null }

/** Porcentaje 0..100 con un decimal; null si el denominador no es positivo. Redondeo half-up estable (sin depender de toFixed). */
export function pct(numerador: number, denominador: number): number | null {
  if (!(denominador > 0) || !Number.isFinite(numerador) || !Number.isFinite(denominador)) return null;
  return Math.round((numerador / denominador) * 1000 + 1e-9) / 10;
}

function razon(n: number, d: number): number | null {
  if (!(d > 0)) return null;
  return Math.round((n / d) * 100 + 1e-9) / 100;
}

const recompra = (v: VentanaRecompra): RecompraCalculada => ({ ...v, pct: pct(v.recompraron, v.elegibles) });

export function calcularRatios(f: FilaRatiosCruda): RatiosCalculados {
  return {
    propertyId: f.propertyId,
    pedidos: f.pedidos,
    netaCentavos: f.netaCentavos,
    ticketCentavos: f.pedidos > 0 ? Math.round(f.netaCentavos / f.pedidos) : null,
    clientes: f.clientes,
    clientesNuevos: f.clientesNuevos,
    frecuencia: razon(f.pedidosConCliente, f.clientes),
    recompra14: recompra(f.recompra.d14),
    recompra30: recompra(f.recompra.d30),
    recompra60: recompra(f.recompra.d60),
    cancelados: f.cancelados,
    tasaCancelacionPct: pct(f.cancelados, f.pedidos + f.cancelados),
    grandes: f.grandes,
    pctGrandes: pct(f.grandes, f.pedidos),
    convChats: f.convChats,
    conversionChatPedidoPct: pct(f.convConPedido, f.convChats),
    vozLlamadas: f.vozLlamadas,
    conversionVozPedidoPct: pct(f.vozConPedido, f.vozLlamadas),
    primeraRespuestaMedianaSeg: f.respN > 0 ? f.respMedianaSeg : null,
    primeraRespuestaP90Seg: f.respN > 0 ? f.respP90Seg : null,
    respondidoEn5minPct: pct(f.respHasta5min, f.respN),
    respuestasMedidas: f.respN,
    resueltoPorAgentePct: f.convChats > 0 ? pct(f.convChats - f.convEscaladas, f.convChats) : null,
    escaladoPct: pct(f.convEscaladas, f.convChats),
    costoTotalCentavos: f.costoTotalCentavos,
    costoPorConversacionCentavos: f.costoPorConversacionCentavos,
  };
}

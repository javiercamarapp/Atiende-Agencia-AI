// Cliente del autopiloto de restaurantes (migracion 050): aprobaciones "Por aprobar" con un clic, reglas por sucursal y "Agotado hasta manana".
// Endpoints reales de apps/api/src/routes/verticals/restaurantes/autopiloto.ts. Los tipos se duplican a proposito (apps/web no depende de ningun
// paquete domain-*, mismo aislamiento que orders-client.ts); el servidor SIEMPRE re-valida decision, motivo, alcance y rol.
import { fetchJson, sendJson } from "./admin-client.ts";
import { ORDER_STATUS_LABELS } from "./orders-client.ts";
import type { OrderCanal, OrderStatus } from "./orders-client.ts";

export type SolicitudTipo = "pedido_grande" | "cancelacion" | "compensacion" | "pausa_sucursal";
export type SolicitudDecision = "aprobar" | "rechazar" | "cancelar" | "mantener" | "sin_compensacion" | "reponer_producto" | "descuento_proximo" | "pausar" | "descartar";

/** Lista cerrada de motivos de cancelacion (espejo de MOTIVOS_CANCELACION del dominio). */
export const MOTIVOS_CANCELACION = ["cliente_desistio", "sin_producto", "fuera_de_zona", "duplicado", "error_agente", "otro"] as const;
export type MotivoCancelacion = (typeof MOTIVOS_CANCELACION)[number];

export const MOTIVO_CANCELACION_ETIQUETAS: Readonly<Record<MotivoCancelacion, string>> = {
  cliente_desistio: "El cliente desistió",
  sin_producto: "Sin producto",
  fuera_de_zona: "Fuera de zona",
  duplicado: "Pedido duplicado",
  error_agente: "Error del agente",
  otro: "Otro",
};

export const SOLICITUD_TIPO_ETIQUETAS: Readonly<Record<SolicitudTipo, string>> = {
  pedido_grande: "Pedido grande",
  cancelacion: "Cancelación pedida por el cliente",
  compensacion: "Queja: compensación",
  pausa_sucursal: "Pausa por saturación",
};

export interface SolicitudPedido {
  readonly numero: number | null;
  readonly total: number;
  readonly status: OrderStatus;
  readonly clienteNombre: string;
  readonly canal: OrderCanal | null;
  readonly renglones: readonly { readonly indice: number; readonly nombre: string; readonly cantidad: number }[];
}

export interface Solicitud {
  readonly id: string;
  readonly propertyId: string;
  readonly tipo: SolicitudTipo;
  readonly estado: "pendiente" | "resuelta";
  readonly orderId: string | null;
  readonly detalle: Readonly<Record<string, unknown>>;
  readonly decision: SolicitudDecision | null;
  readonly motivoResolucion: string | null;
  readonly codigoDescuento: string | null;
  readonly solicitadaAt: string;
  readonly escaladaAt: string | null;
  readonly resueltaAt: string | null;
  readonly pedido: SolicitudPedido | null;
  readonly decisionesPosibles: readonly SolicitudDecision[];
}

export interface SolicitudesRespuesta {
  /** `false` = la base aun no tiene la migracion 050 (estado honesto, lista vacia). */
  readonly disponible: boolean;
  readonly solicitudes: readonly Solicitud[];
}

export function fetchSolicitudes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, estado: "pendiente" | "resuelta" = "pendiente"): Promise<SolicitudesRespuesta> {
  return fetchJson<SolicitudesRespuesta>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/solicitudes?estado=${estado}`, token);
}

export interface ResolverEntrada {
  readonly decision: SolicitudDecision;
  readonly motivo?: MotivoCancelacion;
  /** Porcentaje del descuento del proximo pedido. */
  readonly valor?: number;
  /** Indices (base 0) de los renglones del pedido a reponer. */
  readonly indices?: readonly number[];
}

export interface ResolverRespuesta {
  /** `false` = ya estaba resuelta (doble clic o la resolvio otra persona): no se repitio ningun efecto. */
  readonly aplicado: boolean;
  readonly tipo: SolicitudTipo;
  readonly decision: SolicitudDecision | null;
  readonly estadoPedido: OrderStatus | null;
  readonly codigoDescuento: string | null;
  readonly reposicionOrderId: string | null;
  /** Por que se cerro asi (`no_cancelable_<estado>`, `pedido_ya_no_estaba_por_aprobar`, un motivo de lista cerrada o `null`). Ausente con una API anterior. */
  readonly motivo?: string | null;
  readonly efectos: readonly string[];
}

export interface MensajeResultado {
  readonly tono: "success" | "info" | "warning";
  readonly texto: string;
}

/**
 * Lo que se le dice a la persona tras pulsar un boton de una solicitud, segun lo que REALMENTE paso (no solo `aplicado`):
 *   * se aplico lo pedido -> exito;
 *   * pidio cancelar un pedido que ya salio/cerro -> la solicitud se cerro como "mantener" y se avisa al cliente que sigue en proceso (aviso, no exito);
 *   * el pedido grande ya no estaba por aprobar (otra persona lo cancelo o lo movio) -> se explica en vez de "ya estaba resuelta";
 *   * doble clic o la resolvio otra persona -> "ya estaba resuelta".
 */
export function mensajeResultadoSolicitud(entrada: Pick<ResolverEntrada, "decision">, r: Pick<ResolverRespuesta, "aplicado" | "decision" | "motivo" | "estadoPedido" | "codigoDescuento">): MensajeResultado {
  if (r.aplicado) {
    if (entrada.decision === "cancelar" && r.decision === "mantener") {
      const estado = r.estadoPedido ? ORDER_STATUS_LABELS[r.estadoPedido] : null;
      return { tono: "warning", texto: `No se pudo cancelar: el pedido ya salió o ya cerró${estado ? ` (estado: ${estado})` : ""}. Se avisó al cliente que sigue en proceso y la solicitud quedó cerrada.` };
    }
    return { tono: "success", texto: r.codigoDescuento ? `Listo. Código de descuento enviado al cliente: ${r.codigoDescuento}.` : "Listo: decisión aplicada y cliente avisado." };
  }
  if (r.motivo === "pedido_ya_no_estaba_por_aprobar") {
    const estado = r.estadoPedido ? ORDER_STATUS_LABELS[r.estadoPedido] : null;
    return { tono: "warning", texto: `El pedido ya no estaba por aprobar${estado ? ` (estado actual: ${estado})` : ""}: la solicitud se cerró sin mandar nada a cocina ni avisar al cliente desde aquí.` };
  }
  return { tono: "info", texto: "Esta solicitud ya estaba resuelta; no se repitió ningún aviso." };
}

export function resolverSolicitud(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, solicitudId: string, entrada: ResolverEntrada): Promise<ResolverRespuesta> {
  return sendJson<ResolverRespuesta>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/solicitudes/${solicitudId}/resolver`, token, "POST", entrada);
}

export interface AutopilotoConfig {
  readonly cancelacionAuto: boolean;
  readonly aceptacionAuto: boolean;
  readonly aprobacionMinutos: number;
  readonly handoffRegresoMinutos: number;
  readonly noRecogidoMinutos: number;
  readonly completadoHoras: number;
  readonly compensacionTopePct: number;
  readonly saturacionUmbral1: number | null;
  readonly saturacionUmbral2: number | null;
  readonly saturacionExtraMinutos: number;
  readonly configurada: boolean;
}

export interface AutopilotoConfigRespuesta {
  readonly disponible: boolean;
  readonly config: AutopilotoConfig;
  /** Reglas de TODA la organizacion (no de la sucursal). */
  readonly org?: { readonly cancelacionAgente: boolean };
  /** Plantillas de WhatsApp (Meta) que usa el autopiloto y si el operador las declaro aprobadas. */
  readonly plantillas: readonly { readonly nombre: string; readonly aprobada: boolean }[];
  /** `false` = no hay adaptador real de SoftRestaurant: el avance de estados desde el POS no esta disponible aun. */
  readonly posReal: boolean;
}

export function fetchAutopilotoConfig(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<AutopilotoConfigRespuesta> {
  return fetchJson<AutopilotoConfigRespuesta>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/config`, token);
}

export function guardarAutopilotoConfig(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  config: Omit<AutopilotoConfig, "configurada"> & { readonly cancelacionAgente?: boolean },
): Promise<{ readonly ok: boolean; readonly config: AutopilotoConfig }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/config`, token, "PUT", config);
}

export function marcarAgotadoHastaManana(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, productId: string): Promise<{ readonly ok: boolean; readonly agotadoHasta: string; readonly zonaHoraria: string }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/agotado`, token, "POST", { productId });
}

/**
 * El staff imprimio el ticket de cocina de un pedido pendiente (QA R2 features-05): sin POS, es lo que habilita la aceptacion automatica
 * (Recibido -> Preparando en el siguiente tick, solo si la sucursal activo la regla). `disponible: false` = base sin la migracion 077.
 */
export function registrarTicketImpreso(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string): Promise<{ readonly disponible: boolean; readonly registrado: boolean }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/pedidos/${orderId}/ticket-impreso`, token, "POST", {});
}

/** Minutos que lleva una solicitud esperando (para ordenar la urgencia en pantalla). */
export function minutosEsperando(solicitadaAt: string, ahoraMs: number): number {
  return Math.max(0, Math.floor((ahoraMs - Date.parse(solicitadaAt)) / 60_000));
}

export interface TiempoPrometido {
  /** `aprendido` = mediana de las ultimas entregas de la franja (con el piso del dueno); `texto_fijo` = lo que fijo el dueno (menos de 20 muestras). */
  readonly origen: "aprendido" | "texto_fijo";
  readonly rango: { readonly minimo: number; readonly maximo: number } | null;
  readonly texto: string;
  readonly saturacion: "normal" | "alargado" | "proponer_pausa";
  readonly muestras: number;
}

export async function fetchTiempoPrometido(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, canal: OrderCanal): Promise<TiempoPrometido> {
  const body = await fetchJson<{ tiempo: TiempoPrometido }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/tiempo?canal=${canal}`, token);
  return body.tiempo;
}

export interface EventoEstado {
  readonly desde: OrderStatus | null;
  readonly hacia: OrderStatus;
  /** `staff:<id>` | `agente` | `pos` | `sistema`. */
  readonly actor: string;
  readonly motivo: string | null;
  readonly at: string;
}

/** Historial de transiciones del pedido (`order_status_events`, migracion 050). `disponible: false` = base sin migrar. */
export function fetchHistorialPedido(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string): Promise<{ readonly disponible: boolean; readonly eventos: readonly EventoEstado[] }> {
  return fetchJson(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/autopiloto/pedidos/${orderId}/historial`, token);
}

export function etiquetaActor(actor: string): string {
  if (actor.startsWith("staff:")) return "Equipo";
  if (actor === "agente") return "Agente";
  if (actor === "pos") return "POS";
  return "Sistema";
}

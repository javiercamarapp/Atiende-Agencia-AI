// MAQUINA DE ESTADOS del pedido en el SERVIDOR (ADR-PM-001 §5.4 / §11 paso 1.b). Decide que
// tool puede ejecutarse en cada momento; NO depende de que el modelo siga el prompt:
//
//   (sin estado) --cotizar_pedido--> cotizado --confirmar_resumen--> confirmado
//   confirmado --crear_pedido (reclamo atomico)--> creando --exito--> creado
//                                                   creando --error de negocio--> confirmado
//   cualquier estado --cotizar_pedido--> cotizado   (una cotizacion nueva invalida la confirmacion)
//
// Garantias que hace cumplir (con pruebas de intentos fuera de orden):
//   * crear_pedido exige una cotizacion VIGENTE (no vencida) y una confirmacion explicita
//     (confirmar_resumen) posterior a esa cotizacion.
//   * el pedido que se crea debe ser EL MISMO que se cotizo/confirmo (huella de sucursal, canal,
//     renglones y mayoria de edad): cambiar cantidades despues de confirmar obliga a re-cotizar.
//   * la confirmacion no puede ocurrir en el MISMO turno del cliente que la cotizacion: el
//     cliente tiene que haber contestado entre las dos (WhatsApp: mensaje de usuario distinto).
//   * no se crea dos veces el mismo pedido (reclamo atomico por CAS, ademas de la idempotencia
//     de createOrder).
//
// Limite honesto: el servidor exige el PASO de confirmacion, no puede oir al cliente; que el
// modelo invoque confirmar_resumen solo tras un "si" real sigue siendo responsabilidad del
// prompt. Lo que ya NO puede hacer el modelo es saltarse cotizacion o confirmacion.
import { createHash } from "node:crypto";
import { OrderValidationError } from "../errors.ts";
import type { RequestedOrderItemInput } from "../types.ts";

export type OrderFlowState = "cotizado" | "confirmado" | "creando" | "creado";

export interface OrderFlowContext {
  readonly quoteHash: string;
  readonly quotedAtMs: number;
  /** Marcador del turno del cliente en que se cotizo (null si el canal no tiene noción de turno). */
  readonly quotedTurn: string | null;
  /**
   * Huella de los PRECIOS que el cliente vio al cotizar (ver `priceSignature`). `fingerprintOrder` no incluye
   * precios a proposito (identifica el carrito); esta huella es la que impide cobrar un total distinto al que se
   * confirmo si el catalogo cambia entre confirmar y crear. Ausente en filas guardadas antes de este campo.
   */
  readonly quotedPrices?: string;
  /** Hora de recogida (ISO UTC al minuto) con la que se cotizo, si la llevaba: `crear_pedido` con otra hora distinta ya no coincide con la huella. */
  readonly horaRecogida?: string;
  /** Total a pagar de la cotizacion vigente y cifras legitimas que el cliente vio (precios, importes, subtotal, descuento).
   * Lo lee el agente de WhatsApp en el turno SIGUIENTE para que su guardia de cifras siga corrigiendo un total alucinado
   * aunque ese turno no llame ninguna herramienta. Ausente en filas guardadas antes de este campo (guardia entonces solo en el turno que cotiza). */
  readonly quotedTotal?: number;
  readonly quotedAmounts?: readonly number[];
  /** Pedidos YA creados en esta conversacion/llamada: total y kilos acumulados. La guardia de pedido grande los suma al siguiente pedido para que partir un pedido
   * grande en dos no la esquive (QA-PM-R2-reglas-08). Ausente en filas anteriores = 0. */
  readonly sessionTotal?: number;
  readonly sessionPesoKg?: number;
  /** Cuantos pedidos creo esta sesion (un cliente cuyo unico historial es de hace segundos en esta misma sesion sigue contando como SIN historial). */
  readonly sessionPedidos?: number;
  /** Id del ultimo pedido creado en la sesion: un pedido identico dentro de la ventana de deduplicacion devuelve ESE id y se marca `ya_registrado`. */
  readonly sessionUltimoPedidoId?: string;
  readonly confirmedAtMs?: number;
  readonly claimedAtMs?: number;
  readonly orderId?: string;
}

export interface OrderFlowSnapshot {
  readonly state: OrderFlowState | null;
  readonly context: OrderFlowContext | null;
  /** Contador CAS. 0 = no hay fila. */
  readonly version: number;
}

export type OrderFlowWriteResult = "written" | "conflict" | "unavailable";

/** Una cotizacion vence a los 20 minutos: pasado ese tiempo los precios/horario pueden haber cambiado. */
export const QUOTE_TTL_MS = 20 * 60 * 1000;
/** Un reclamo de creacion colgado (proceso muerto) se puede retomar pasado este tiempo; createOrder es idempotente. */
export const CLAIM_STALE_MS = 60 * 1000;
/** TTL de la fila de estado (se renueva en cada escritura). */
export const FLOW_ROW_TTL_SECONDS = 2 * 60 * 60;

export type OrderFlowViolationCode =
  | "sin_cotizacion"
  | "cotizacion_vencida"
  | "sin_confirmacion"
  | "pedido_distinto_al_cotizado"
  | "confirmacion_mismo_turno"
  | "hash_no_coincide"
  | "pedido_ya_creado"
  | "pedido_en_proceso"
  | "precio_cambio";

export class OrderFlowViolationError extends OrderValidationError {
  constructor(
    readonly code: OrderFlowViolationCode,
    message: string,
    /** Pedido ya registrado en este flujo (solo `pedido_ya_creado` con el id conocido). */
    readonly orderId?: string,
  ) {
    super(message);
    this.name = "OrderFlowViolationError";
  }
}

/** Huella canonica del pedido: sucursal + canal + mayoria de edad + renglones ordenados. */
export function fingerprintOrder(input: {
  readonly branchSlug: string;
  readonly canal?: string;
  readonly adultConfirmed?: boolean;
  readonly items: readonly RequestedOrderItemInput[];
  /** Doble porcion de salsas: cambia el total, asi que forma parte de la huella (solo si hay alguna). */
  readonly doubleSalsas?: readonly string[];
  /** R-11: hora programada normalizada (ISO UTC). Cambiarla tras confirmar obliga a re-cotizar; solo entra a la huella si existe. */
  readonly programadoPara?: string;
  /** Hora de recogida normalizada al minuto (ISO UTC); solo entra a la huella si la cotizacion la llevaba: cambiarla tras confirmar obliga a re-cotizar. */
  readonly horaRecogida?: string;
}): string {
  const items = input.items
    .map((i) => ({
      k: (i.productId ?? (i.productName ?? "").trim().toLowerCase()) || "?",
      q: Number.isFinite(i.requestedQuantity) ? i.requestedQuantity : -1,
      t: i.tortilla ?? null,
    }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.q - b.q));
  const canonical = JSON.stringify({ b: input.branchSlug.trim(), c: input.canal === "recoger" ? "recoger" : "domicilio", a: input.adultConfirmed === true, i: items, ...(input.doubleSalsas && input.doubleSalsas.length > 0 ? { d: [...new Set(input.doubleSalsas)].sort() } : {}), ...(input.programadoPara ? { p: input.programadoPara } : {}), ...(input.horaRecogida ? { h: input.horaRecogida } : {}) });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Huella de precios de un pedido: producto + precio unitario + cantidad de cada renglon (incluida la doble porcion
 * de salsa, que es un renglon cobrado). Se calcula igual sobre los renglones de la cotizacion y sobre los del
 * pedido ya resuelto contra el catalogo, asi que un cambio de precio entre ambos momentos las hace distintas.
 */
export function priceSignature(lines: readonly { readonly productId?: string; readonly id?: string; readonly price: number; readonly quantity: number }[]): string {
  const canonical = lines
    .map((l) => `${l.productId ?? l.id ?? "?"}|${Math.round(l.price * 100)}|${l.quantity}`)
    .sort()
    .join(";");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export interface FlowCheckArgs {
  readonly now: number;
  readonly turn: string | null;
  /** Huella del pedido que el modelo intenta crear (solo crear_pedido). */
  readonly fingerprint?: string;
  /** quote_hash que el modelo cita al confirmar (opcional). */
  readonly quoteHashCited?: string;
}

function assertFresh(ctx: OrderFlowContext, now: number): void {
  if (now - ctx.quotedAtMs > QUOTE_TTL_MS) {
    throw new OrderFlowViolationError("cotizacion_vencida", "La cotización ya venció. Vuelve a llamar cotizar_pedido, repite el resumen y pide la confirmación del cliente otra vez.");
  }
}

/** Precondicion de `confirmar_resumen`. Lanza `OrderFlowViolationError` si no procede. */
export function assertCanConfirm(snap: OrderFlowSnapshot, args: FlowCheckArgs): OrderFlowContext {
  const ctx = snap.context;
  if (snap.state !== "cotizado" || !ctx) {
    if (snap.state === "creado") throw new OrderFlowViolationError("pedido_ya_creado", "El pedido ya quedó registrado. Si el cliente quiere otro, cotiza uno nuevo con cotizar_pedido.", ctx?.orderId);
    if (snap.state === "confirmado" || snap.state === "creando") return ctx!; // idempotente: ya confirmado
    throw new OrderFlowViolationError("sin_cotizacion", "No hay una cotización vigente. Llama primero cotizar_pedido, repite el resumen completo y espera la respuesta del cliente.");
  }
  assertFresh(ctx, args.now);
  if (args.quoteHashCited && args.quoteHashCited !== ctx.quoteHash) {
    throw new OrderFlowViolationError("hash_no_coincide", "El resumen que intentas confirmar no es el de la última cotización. Vuelve a cotizar y confirma ese resumen.");
  }
  if (ctx.quotedTurn !== null && args.turn !== null && ctx.quotedTurn === args.turn) {
    throw new OrderFlowViolationError(
      "confirmacion_mismo_turno",
      "El cliente todavía no contestó al resumen. Muéstrale el total y los renglones, pregúntale si confirma y espera su respuesta antes de confirmar.",
    );
  }
  return ctx;
}

/** Precondicion de `crear_pedido`. */
export function assertCanCreate(snap: OrderFlowSnapshot, args: FlowCheckArgs): OrderFlowContext {
  const ctx = snap.context;
  if (!snap.state || !ctx) {
    throw new OrderFlowViolationError("sin_cotizacion", "No se puede crear el pedido: falta una cotización vigente. Llama cotizar_pedido, repite el resumen y espera la confirmación del cliente.");
  }
  if (snap.state === "creado") {
    throw new OrderFlowViolationError("pedido_ya_creado", "Este pedido ya quedó registrado; no lo crees otra vez. Repite el resumen al cliente.", ctx.orderId);
  }
  if (snap.state === "creando" && args.now - (ctx.claimedAtMs ?? 0) <= CLAIM_STALE_MS) {
    throw new OrderFlowViolationError("pedido_en_proceso", "El pedido se está registrando en este momento; espera un momento antes de reintentar.");
  }
  if (snap.state === "cotizado") {
    throw new OrderFlowViolationError("sin_confirmacion", "El cliente todavía no confirmó el resumen. Llama confirmar_resumen solo después de que el cliente diga sí al resumen completo.");
  }
  assertFresh(ctx, args.now);
  if (args.fingerprint && args.fingerprint !== ctx.quoteHash) {
    throw new OrderFlowViolationError("pedido_distinto_al_cotizado", "El pedido no coincide con el que se cotizó y confirmó (sucursal, canal o productos). Vuelve a cotizar el pedido final y pide confirmación.");
  }
  return ctx;
}

/** Puerto de persistencia (lo implementa el repositorio; ver `RestaurantesRepository.readOrderFlow`). */
export interface OrderFlowStore {
  readOrderFlow(organizationId: string, flowKey: string): Promise<OrderFlowSnapshot | null>;
  writeOrderFlow(
    organizationId: string,
    flowKey: string,
    expectedVersion: number,
    next: { readonly state: OrderFlowState; readonly context: OrderFlowContext },
    ttlSeconds: number,
  ): Promise<OrderFlowWriteResult>;
}

export interface OrderFlowRef {
  readonly key: string;
  /** Marcador del turno del cliente (WhatsApp: numero de mensajes de usuario; voz: null). */
  readonly turn: string | null;
  readonly now?: () => number;
}

let flowUnavailableWarned = false;
export function warnOrderFlowUnavailable(): void {
  if (flowUnavailableWarned) return;
  flowUnavailableWarned = true;
  console.warn(
    "agent-tools/order-flow: restaurantes.order_flow_state no existe todavía en esta base (SQLSTATE 42883/42P01/42703) -- " +
      "la máquina de estados del pedido queda DESACTIVADA (camino anterior, sin exigir cotización/confirmación del servidor). " +
      "Aplica packages/domain-restaurantes/migrations/026_voz_secretos_sucursal_y_estado_pedido.sql (o su espejo en supabase/migrations/).",
  );
}

/** Solo para pruebas: reinicia el aviso de una sola vez. */
export function resetOrderFlowWarningForTests(): void {
  flowUnavailableWarned = false;
}

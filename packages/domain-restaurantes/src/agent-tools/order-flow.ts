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
  /** Hora PROGRAMADA (ISO UTC) con la que se cotizo un pedido para recoger: en recoger `programado_para` y `hora_recogida` son la misma hora (QA-PM-R5-reglas-02) y crear la reutiliza. */
  readonly programadoPara?: string;
  /** Plazo en minutos (`minutos_para_recoger`) con el que el SERVIDOR calculo `horaRecogida`: una re-cotizacion identica con el mismo plazo conserva esa hora (no es una cotizacion nueva
   * por haber pasado un minuto) y un `crear_pedido` con OTRO plazo obliga a re-cotizar. Ausente si la hora la mando el modelo explicita. */
  readonly minutosPlazo?: number;
  /** Total a pagar de la cotizacion vigente y cifras legitimas que el cliente vio (precios, importes, subtotal, descuento).
   * Lo lee el agente de WhatsApp en el turno SIGUIENTE para que su guardia de cifras siga corrigiendo un total alucinado
   * aunque ese turno no llame ninguna herramienta. Ausente en filas guardadas antes de este campo (guardia entonces solo en el turno que cotiza). */
  readonly quotedTotal?: number;
  readonly quotedAmounts?: readonly number[];
  /**
   * Renglones de la cotizacion YA RESUELTOS contra el catalogo (id, nombre, cantidad pedida, tortilla solo si el producto la exige). La huella del
   * pedido se calcula sobre ESTOS renglones y no sobre lo que escribio el modelo: un modelo que manda la tortilla de la horchata como "mixta" en un
   * turno y "maiz" en el siguiente, o un `product_id` vacio al crear, ya no vuelve "nueva" una cotizacion que el cliente ya vio (QA-PM-R3-whatsapp-01/07).
   * Ausente en filas guardadas antes de este campo: la huella se calcula como siempre, sobre lo que mande el modelo.
   */
  readonly quotedItems?: readonly QuotedItem[];
  /** Sucursal y canal con los que se cotizo: con `quotedItems` el servidor puede decirle al agente, en el turno del "si", exactamente que cotizo (ver `bloqueCotizacionVigente`). */
  readonly quotedBranchSlug?: string;
  readonly quotedCanal?: string;
  /** Huella del CARRITO (sucursal + canal + renglones) sin hora, pago ni salsas: sirve para reconocer "el mismo pedido" aunque el modelo cambie la hora (QA-PM-R3-whatsapp-03). */
  readonly cartHash?: string;
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

/** Renglon de la cotizacion resuelto contra el catalogo. */
export interface QuotedItem {
  readonly id: string;
  readonly name: string;
  readonly qty: number;
  /** Solo si el producto exige tortilla; `null` en bebidas y demas (el modelo manda ahi cualquier valor y no debe afectar la huella). */
  readonly tortilla: string | null;
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

const PALABRAS_VACIAS = new Set(["de", "del", "al", "a", "los", "las", "el", "la", "un", "una", "unos", "unas", "y", "con", "sin", "en", "para", "taco", "tacos", "orden", "ordenes", "individual", "individuales", "pieza", "piezas"]);

function tokensDeNombre(name: string | undefined): Set<string> {
  const base = (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ");
  const out = new Set<string>();
  for (const raw of base.split(/\s+/)) {
    if (!raw) continue;
    const t = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (!PALABRAS_VACIAS.has(raw) && !PALABRAS_VACIAS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Empareja cada renglon que escribio el modelo con un renglon resuelto (por id; si no, por nombre; si no, el unico que sobra). Devuelve, por posicion de `items`,
 * el indice del renglon resuelto o `null` si no se pudo emparejar sin ambiguedad. Cada renglon resuelto se usa a lo mas una vez.
 */
function emparejar(items: readonly RequestedOrderItemInput[], candidatos: readonly { readonly id: string; readonly name: string }[], idsDeOtroProducto: ReadonlySet<string> = new Set()): (number | null)[] {
  const usados = new Set<number>();
  const res: (number | null)[] = items.map(() => null);
  items.forEach((it, i) => {
    if (!it.productId) return;
    const j = candidatos.findIndex((c, k) => !usados.has(k) && c.id === it.productId);
    if (j >= 0) {
      usados.add(j);
      res[i] = j;
    }
  });
  // Un `product_id` que es de OTRO producto real del catalogo (el cliente cambio de producto y el modelo no re-cotizo) NUNCA se empareja por nombre aproximado ni por "el unico que sobra":
  // se deja sin par para que la huella no coincida y se exija re-cotizar. Solo un id vacio o inexistente cae al nombre.
  const esDeOtro = (it: RequestedOrderItemInput) => Boolean(it.productId) && idsDeOtroProducto.has(it.productId as string);
  items.forEach((it, i) => {
    if (res[i] !== null || esDeOtro(it)) return;
    const mios = tokensDeNombre(it.productName);
    if (mios.size === 0) return;
    let mejor = -1;
    let mejorPuntaje = 0;
    let empate = false;
    candidatos.forEach((c, k) => {
      if (usados.has(k)) return;
      const suyos = tokensDeNombre(c.name);
      let comunes = 0;
      for (const t of mios) if (suyos.has(t)) comunes += 1;
      if (comunes === 0) return;
      const puntaje = comunes / (mios.size + suyos.size - comunes);
      if (puntaje > mejorPuntaje) {
        mejor = k;
        mejorPuntaje = puntaje;
        empate = false;
      } else if (puntaje === mejorPuntaje) empate = true;
    });
    if (mejor >= 0 && !empate) {
      usados.add(mejor);
      res[i] = mejor;
    }
  });
  const sinPar = res.map((r, i) => (r === null ? i : -1)).filter((i) => i >= 0);
  if (sinPar.some((i) => esDeOtro(items[i]!))) return res;
  const libres = candidatos.map((_, k) => k).filter((k) => !usados.has(k));
  if (sinPar.length === 1 && libres.length === 1) res[sinPar[0]!] = libres[0]!;
  return res;
}

/**
 * Renglones del modelo -> renglones resueltos de la cotizacion (`lines` de `quoteOrder`). `null` si algun renglon no se puede emparejar: entonces la huella cae
 * al comportamiento anterior (sobre lo que mando el modelo).
 */
export function resolverRenglonesCotizados(
  items: readonly RequestedOrderItemInput[],
  lines: readonly { readonly productId: string; readonly name: string; readonly tortilla?: string | null }[],
): QuotedItem[] | null {
  if (items.length === 0) return null;
  const par = emparejar(items, lines.map((l) => ({ id: l.productId, name: l.name })));
  const out: QuotedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const j = par[i];
    if (j === null || j === undefined) return null;
    const l = lines[j]!;
    out.push({ id: l.productId, name: l.name, qty: items[i]!.requestedQuantity, tortilla: l.tortilla ?? null });
  }
  return out;
}

/**
 * Al crear: reemplaza lo que escribio el modelo por los renglones ya cotizados (id y nombre del catalogo, y tortilla solo si el producto la lleva), de modo que la
 * huella solo cambie si cambio el carrito de verdad (otro producto, otra cantidad o, en un producto con tortilla, otra tortilla) y que el pedido se cree con el
 * producto cotizado aunque el modelo mande `product_id` vacio o un nombre aproximado. `null` si algun renglon no se puede emparejar sin ambiguedad: el caller
 * conserva lo que mando el modelo (la huella no coincidira, como antes).
 */
export function reconciliarConCotizacion(items: readonly RequestedOrderItemInput[], quoted: readonly QuotedItem[], idsDeOtroProducto: ReadonlySet<string> = new Set()): RequestedOrderItemInput[] | null {
  const par = emparejar(items, quoted, idsDeOtroProducto);
  if (par.some((j) => j === null)) return null;
  return items.map((it, i) => {
    const q = quoted[par[i]!]!;
    // Producto con tortilla: si el modelo mando una tortilla distinta a la cotizada, se respeta (cambia la huella y obliga a re-cotizar); si la omitio, es la cotizada.
    const tortilla = q.tortilla === null ? undefined : ((it.tortilla ?? q.tortilla) as RequestedOrderItemInput["tortilla"]);
    return { productId: q.id, productName: q.name, requestedQuantity: it.requestedQuantity, tortilla };
  });
}

/** Renglones cotizados -> entrada de `fingerprintOrder`. */
export function itemsDeHuella(quoted: readonly QuotedItem[]): RequestedOrderItemInput[] {
  return quoted.map((q) => ({ productId: q.id, productName: q.name, requestedQuantity: q.qty, tortilla: (q.tortilla ?? undefined) as RequestedOrderItemInput["tortilla"] }));
}

/** Huella del carrito (sucursal + canal + renglones resueltos): reconoce "el mismo pedido" aunque cambie la hora de recogida, el pago o las salsas. */
export function huellaDeCarrito(branchSlug: string, canal: string | undefined, quoted: readonly QuotedItem[]): string {
  return fingerprintOrder({ branchSlug, canal, items: itemsDeHuella(quoted) }).slice(0, 32);
}

/** Despues de crear, un cotizar del MISMO carrito dentro de esta ventana se toma como un "si" repetido y no como un pedido nuevo. */
export const MISMO_PEDIDO_VENTANA_MS = 30 * 60 * 1000;

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
    throw new OrderFlowViolationError("pedido_distinto_al_cotizado", "El pedido no coincide con el que se cotizó y confirmó (sucursal, canal, productos u hora de recogida). Vuelve a cotizar el pedido final y pide confirmación.");
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

/**
 * Bloque de prompt con la cotizacion VIGENTE que dejo el servidor (QA-PM-R3-whatsapp-01 / 10). El historial de WhatsApp no trae los resultados de las herramientas, asi que en el turno del
 * "si" el modelo volvia a buscar sucursal y productos (2-4 llamadas de 1.5-3 s) solo para recuperar los ids, y re-cotizaba (con lo que el cierre se perdia). Con esto sabe que cotizo el
 * servidor y puede confirmar y crear de inmediato. Vacio si no hay una cotizacion fresca con renglones resueltos.
 */
export function bloqueCotizacionVigente(snap: OrderFlowSnapshot | null, ahoraMs: number): string {
  const ctx = snap?.context;
  if (!snap || !ctx || (snap.state !== "cotizado" && snap.state !== "confirmado")) return "";
  if (!ctx.quotedItems || ctx.quotedItems.length === 0 || !ctx.quotedBranchSlug) return "";
  if (ahoraMs - ctx.quotedAtMs > QUOTE_TTL_MS) return "";
  const renglones = ctx.quotedItems.map((i) => `  - product_id ${i.id} | ${i.name} | requested_quantity ${i.qty}${i.tortilla ? ` | tortilla ${i.tortilla}` : ""}`).join("\n");
  const total = typeof ctx.quotedTotal === "number" ? `, total a pagar $${ctx.quotedTotal}` : "";
  return [
    "COTIZACIÓN VIGENTE DE ESTA CONVERSACIÓN (la dejó el sistema; es la que el cliente vio en el resumen):",
    `- branch_slug ${ctx.quotedBranchSlug}${ctx.quotedCanal ? `, canal ${ctx.quotedCanal}` : ""}${total}${ctx.horaRecogida ? ", hora de recogida ya fijada por el sistema (en crear_pedido no la recalcule: el sistema usa la cotizada)" : ""}.`,
    renglones,
    snap.state === "confirmado"
      ? "- Ya está CONFIRMADA: si falta crear el pedido, llame crear_pedido con estos mismos datos."
      : "- Si el ÚLTIMO mensaje del cliente es un sí claro a ese resumen y no cambió nada, llame confirmar_resumen y enseguida crear_pedido con estos mismos datos, SIN buscar de nuevo ni cotizar otra vez. Si cambió algo (producto, cantidad, tortilla, canal, dirección, pago), vuelva a cotizar normalmente.",
  ].join("\n");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Los `product_id` que mando el modelo, distintos de los cotizados, que SI existen en el catalogo de la organizacion (son OTRO producto, no un error de tecleo). */
export async function idsDeOtrosProductosReales(
  items: readonly RequestedOrderItemInput[],
  quoted: readonly QuotedItem[],
  existe: (productId: string) => Promise<boolean>,
): Promise<Set<string>> {
  const cotizados = new Set(quoted.map((q) => q.id));
  const out = new Set<string>();
  for (const it of items) {
    const id = it.productId;
    if (!id || cotizados.has(id) || out.has(id) || !UUID_RE.test(id)) continue;
    if (await existe(id)) out.add(id);
  }
  return out;
}

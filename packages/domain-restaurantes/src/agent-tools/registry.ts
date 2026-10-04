// REGISTRO UNICO de tools de dominio del agente de restaurantes, compartido por WhatsApp y
// voz (ADR-PM-001 §5.4, brecha B9). Antes existian dos copias: `TOOLS` + `executeToolCall`
// en whatsapp/llm-turn-handler.ts y los handlers HTTP de apps/api (voice-tools.ts/public.ts).
// Ahora hay UNA definicion tipada (nombre, descripcion, esquema JSON, canales) y UN ejecutor:
// cada canal solo traduce formato (WhatsApp -> `LlmToolDefinition`; voz -> JSON de proveedor
// via `exportVoiceToolManifest`).
//
// Reglas de aislamiento que el registro impone a AMBOS canales:
//   * El telefono del cliente sale del CONTEXTO (`ctx.phone`: remitente de WhatsApp o token
//     de llamada firmado), nunca de los argumentos que escribe el modelo. Ninguna tool
//     declara un parametro de telefono.
//   * Si el contexto fija una sucursal (`ctx.lockedPropertyId`: token de llamada o numero de
//     WhatsApp de sucursal), una tool que apunte a otra sucursal de la organizacion se
//     rechaza.
import { registerCallbackRequest } from "../callback-requests.ts";
import { cargarMemoria, evaluarReincidencia } from "../cliente-360/memoria.ts";
import { elegirPedido, repetirPedido } from "../cliente-360/repetir.ts";
import { lookupCustomerConPedidoReciente } from "../customers.ts";
import { OrderValidationError } from "../errors.ts";
import { normalizePhone } from "../phone.ts";
import { DEFAULT_COMPLEMENTS, isTortillaChoice } from "../order-quote.ts";
import { estaAbiertoAhora } from "../horarios.ts";
import { assignBranch } from "../branch-assignment.ts";
import { createOrder, prepareCreateOrder, quoteOrder, searchProducts, type QuotePolicyInfo, type QuotePromotionInfo } from "../orders.ts";
import { assertWebOrderRules } from "../storefront.ts";
import type { RestaurantesRepository } from "../repository.ts";
import {
  assertCanConfirm,
  assertCanCreate,
  FLOW_ROW_TTL_SECONDS,
  fingerprintOrder,
  warnOrderFlowUnavailable,
  type OrderFlowContext,
  type OrderFlowRef,
  type OrderFlowSnapshot,
  type OrderFlowState,
} from "./order-flow.ts";
import type {
  CanalPedido,
  CreateOrderInput,
  DefaultComplement,
  DoubleSalsa,
  Order,
  OrderQuote,
  RequestedComplement,
  RequestedOrderItemInput,
} from "../types.ts";

/** "web" = checkout publico del storefront (R-09): solo cotizar/confirmar/crear, con la misma maquina de estados
 * del servidor. El telefono lo escribe el cliente (no hay canal que lo identifique), asi que `ctx.phone` es null. */
export type AgentChannel = "whatsapp" | "voz" | "web";

export type AgentToolName =
  | "buscar_cliente"
  | "historial_pedidos"
  | "repetir_pedido"
  | "consultar_sucursal"
  | "buscar_sucursal_cercana"
  | "buscar_producto"
  | "cotizar_pedido"
  | "confirmar_resumen"
  | "crear_pedido"
  | "registrar_contacto"
  | "escalar_a_humano";

/** Subconjunto de JSON Schema que usan las tools (mismo shape que `LlmToolDefinition.parameters`). */
export interface AgentToolJsonSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

export interface AgentToolDefinition {
  readonly name: AgentToolName;
  readonly description: string;
  readonly parameters: AgentToolJsonSchema;
  readonly channels: readonly AgentChannel[];
}

export interface AgentToolContext {
  readonly organizationId: string;
  readonly channel: AgentChannel;
  /** Telefono del cliente tomado del CONTEXTO (remitente de WhatsApp / token de llamada).
   * `null` = el canal no lo conoce (voz sin token de llamada, camino legado). */
  readonly phone: string | null;
  /** Sucursal fijada por el contexto (token de llamada / numero de WhatsApp de sucursal). */
  readonly lockedPropertyId?: string | null;
  /** Maquina de estados del pedido (order-flow.ts). Ausente = sin exigir cotizacion/confirmacion
   * (camino legado: voz con secreto global sin token de llamada). */
  readonly flow?: OrderFlowRef;
  /** Ultima ubicacion que el cliente COMPARTIO por WhatsApp (lat/lng reales del mensaje, no inventadas
   * por el modelo). Alimenta `buscar_sucursal_cercana` cuando el modelo no manda coordenadas. */
  readonly sharedLocation?: { readonly lat: number; readonly lng: number } | null;
}

export interface AgentToolOutcome {
  /** Respuesta "wire" (snake_case) que ve el LLM de WhatsApp; la voz la usa salvo donde su
   * contrato historico difiere y lee `raw`. */
  readonly result: unknown;
  /** Objeto de dominio sin transformar (OrderQuote / Order), para los envoltorios HTTP de voz. */
  readonly raw?: unknown;
  readonly orderId: string | null;
  readonly propertyId: string | null;
  /** Huella de la cotizacion vigente (solo cotizar_pedido con maquina de estados activa). */
  readonly quoteHash?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Definiciones (una sola fuente)
// ─────────────────────────────────────────────────────────────────────────

/** Motivos con los que el agente pasa una conversacion a una persona. Los cinco primeros son los
 * historicos (genericos); el resto son los de la matriz de escalacion de Los Taquitos de PM (quejas,
 * modificacion de platillos, pago por transferencia, tiempos de entrega, etc.). Un valor fuera de la
 * lista se guarda como `otro`: el motivo viaja a la bandeja del gerente y no puede ser texto libre. */
export const MOTIVOS_ESCALACION = [
  "cliente_lo_pide",
  "queja",
  "no_puedo_resolver",
  "pedido_especial",
  "otro",
  "modificacion_platillo",
  "transferencia",
  "tiempos_entrega",
  "pedido_grande",
  "cancelacion_modificacion",
  "reposicion_descuento",
  "alergia_salud",
  "zona_no_reconocida",
  "zona_ambigua",
  "producto_agotado",
  "no_entiende",
  "falla_sistema",
  "cobro_duplicado",
  "urgencia",
  "privacidad_arco",
] as const;
export type MotivoEscalacion = (typeof MOTIVOS_ESCALACION)[number];

export function normalizarMotivoEscalacion(raw: unknown): MotivoEscalacion {
  return typeof raw === "string" && (MOTIVOS_ESCALACION as readonly string[]).includes(raw) ? (raw as MotivoEscalacion) : "otro";
}

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    product_id: { type: "string" },
    product_name: { type: "string", description: "Nombre exacto devuelto por buscar_producto." },
    requested_quantity: { type: "integer", description: "Cantidad de piezas/unidades que pidio el cliente, no el numero de paquetes." },
    tortilla: { type: "string", enum: ["maiz", "harina", "mixta"] },
  },
  required: ["product_id", "product_name", "requested_quantity"],
} as const;

const DOBLE_SALSAS_SCHEMA = {
  type: "array",
  description: "Salsas de las que el cliente quiere DOBLE porción. Las 9 salsas ya van incluidas sin costo; la doble porción es un extra cobrado.",
  items: { type: "string", enum: [...DEFAULT_COMPLEMENTS] },
} as const;

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "buscar_cliente",
    description:
      "Devuelve el historial real del cliente que esta hablando (nombre, direcciones, ultimo pedido, lo que mas pide). No recibe telefono: el sistema usa el numero real de la conversacion o llamada.",
    parameters: { type: "object", properties: {} },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "historial_pedidos",
    description:
      "Lista los ultimos pedidos del cliente que esta hablando (sin cancelados): numero, fecha, canal, sucursal, productos y total de ESA vez. Sirve para ofrecer 'lo mismo de la vez pasada'. No recibe telefono: el sistema usa el numero real de la conversacion o llamada; un cliente nunca ve pedidos de otro numero.",
    parameters: { type: "object", properties: {} },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "repetir_pedido",
    description:
      "Repite un pedido anterior del MISMO cliente re-cotizandolo con los precios y la disponibilidad de HOY (nunca el precio de la vez pasada). Devuelve la cotizacion normal (con quote_hash) y 'repeticion.cambios': productos que ya no estan disponibles o que cambiaron de precio, que DEBES avisar al cliente antes de confirmar. Sin pedido_numero repite el mas reciente. Despues sigue el flujo normal: repetir el resumen, confirmar_resumen y crear_pedido.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string", description: "Sucursal ya confirmada con el cliente." },
        pedido_numero: { type: "integer", description: "Numero del pedido a repetir (el que devolvio historial_pedidos). Opcional: sin el, el mas reciente." },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Opcional: por defecto el mismo canal de la vez pasada." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega (solo a domicilio)." },
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"], description: "Forma de pago ya elegida, solo para saber si corresponde preguntar propina." },
        adult_confirmed: { type: "boolean", description: "true únicamente si el pedido incluye alcohol y el cliente confirmó mayoría de edad." },
      },
      required: ["branch_slug"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "consultar_sucursal",
    description: "Datos reales de una sucursal: direccion, telefono, si esta abierta ahora, horario y pedido minimo por canal.",
    parameters: {
      type: "object",
      properties: { branch_slug: { type: "string", description: "El branch_slug de la sucursal." } },
      required: ["branch_slug"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "buscar_sucursal_cercana",
    description:
      "Asigna la sucursal real MÁS CERCANA EN KM al domicilio del cliente (distancia real; no adivines tú cuál está más cerca). Pásale la colonia/zona/referencia que dio el cliente y, si compartió su ubicación, lat y lng. Si responde fuera_de_zona no se envía a domicilio: ofrece recoger en sucursal. Llámala en cuanto tengas la colonia o una referencia clara.",
    parameters: {
      type: "object",
      properties: {
        colonia: { type: "string", description: "La colonia, zona o referencia que dio el cliente, tal cual." },
        lat: { type: "number", description: "Latitud de la ubicación compartida por el cliente (solo junto con lng)." },
        lng: { type: "number", description: "Longitud de la ubicación compartida por el cliente (solo junto con lat)." },
        max_km: { type: "number", description: "Radio máximo de reparto en km, solo si el negocio lo indicó." },
      },
      required: [],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "buscar_producto",
    description:
      "Busca productos del menú real de la sucursal por nombre, sinónimo o palabra clave. Devuelve id, nombre, precio real de esa sucursal, pack_size y requires_adult_confirmation. Lista vacía significa que ese producto no existe en el menú.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "texto a buscar, ej. 'pastor' o 'kilo arrachera'" },
        branch_slug: { type: "string", description: "El branch_slug de la sucursal ya confirmada. Si todavía no se confirma la sucursal, no llames esta herramienta." },
      },
      required: ["query", "branch_slug"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "cotizar_pedido",
    description: "Valida cantidades/presentaciones y calcula el total exacto con precios reales. Debes llamarla antes de decir el total o preguntar la forma de pago.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string", description: "Sucursal ya confirmada con el cliente." },
        items: { type: "array", description: "Productos confirmados.", items: ITEM_SCHEMA },
        adult_confirmed: { type: "boolean", description: "true únicamente si el pedido incluye alcohol y el cliente confirmó mayoría de edad." },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Si el pedido es a domicilio o para recoger en sucursal. Por defecto 'domicilio'." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega que dio el cliente (solo a domicilio); la herramienta verifica que esté dentro de la zona de reparto de la sucursal." },
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"], description: "Forma de pago ya elegida, solo para saber si corresponde preguntar propina." },
        doble_salsas: DOBLE_SALSAS_SCHEMA,
      },
      required: ["branch_slug", "items"],
    },
    channels: ["whatsapp", "voz", "web"],
  },
  {
    name: "confirmar_resumen",
    description:
      "Registra que el CLIENTE confirmó explícitamente (dijo sí) el resumen completo devuelto por cotizar_pedido. Llámala solo después de repetirle los renglones y el total y de recibir su respuesta en un mensaje posterior; nunca en el mismo turno en que cotizaste. Sin esta confirmación el sistema rechaza crear_pedido.",
    parameters: {
      type: "object",
      properties: { quote_hash: { type: "string", description: "El quote_hash que devolvió cotizar_pedido (opcional; si se manda debe ser el de la última cotización)." } },
    },
    channels: ["whatsapp", "voz", "web"],
  },
  {
    name: "crear_pedido",
    description: "Registra el pedido final en el sistema. Solo llamar cuando el cliente ya confirmó todo, incluyendo la sucursal. El sistema rechaza crear_pedido si antes no hubo cotizar_pedido y confirmar_resumen con los mismos productos.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string" },
        customer_name: { type: "string" },
        customer_address: { type: "string", description: "Dirección completa de entrega; obligatoria salvo canal 'recoger'." },
        items: { type: "array", items: ITEM_SCHEMA },
        notes: { type: "string" },
        requested_complements: { type: "array", items: { type: "string", enum: ["salsa_habanero", "crema_ajo"] } },
        omit_default_complements: { type: "array", items: { type: "string", enum: [...DEFAULT_COMPLEMENTS, "cebolla"] } },
        doble_salsas: DOBLE_SALSAS_SCHEMA,
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"] },
        adult_confirmed: { type: "boolean" },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Por defecto 'domicilio'. Para 'recoger' no hace falta customer_address." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega (solo a domicilio)." },
        propina: { type: "number", description: "Propina en pesos, solo si cotizar_pedido indicó preguntar_propina: true y el cliente la dio. No suma al total." },
        hora_recogida: { type: "string", description: "Solo canal 'recoger': hora a la que el cliente pasará, en ISO 8601 con zona (por ejemplo 2026-09-30T20:30:00-06:00)." },
        direccion_etiqueta: { type: "string", description: "Opcional: como llama el cliente a este domicilio (casa, oficina...). Solo si lo dijo." },
        referencias_acceso: { type: "string", description: "Opcional: referencias para llegar (porton, timbre, entre calles). Solo si las dio el cliente." },
        maps_url: { type: "string", description: "Opcional: link de Google Maps/Waze que el cliente mando por escrito (https). Nunca lo inventes." },
        usar_ubicacion_compartida: { type: "boolean", description: "true solo si el cliente compartio su ubicacion por WhatsApp Y es la de este domicilio de entrega; el sistema usa las coordenadas reales del mensaje." },
      },
      required: ["branch_slug", "customer_name", "items", "payment_method"],
    },
    channels: ["whatsapp", "voz", "web"],
  },
  {
    name: "registrar_contacto",
    description: "Registra nombre/motivo de un mensaje que NO es para hacer un pedido, para que alguien del restaurante le regrese la llamada. Nunca usar para pedidos normales.",
    parameters: {
      type: "object",
      properties: { customer_name: { type: "string" }, reason: { type: "string" }, message: { type: "string" } },
      required: ["customer_name", "reason"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "escalar_a_humano",
    description:
      "Pasa la conversación a una persona del restaurante cuando el cliente lo pide, hay una queja, o no puedes resolver lo que necesita. Deja un aviso con el motivo para que alguien le responda.",
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string" },
        motivo: {
          type: "string",
          enum: [...MOTIVOS_ESCALACION],
          description:
            "Motivo del aviso (llamala UNA sola vez por conversacion y motivo): transferencia (quiere pagar por transferencia), modificacion_platillo (pide cambiar ingredientes o receta de un platillo), alergia_salud, cancelacion_modificacion (cancelar o cambiar un pedido ya confirmado), producto_agotado, zona_no_reconocida (colonia no reconocida dos veces), no_entiende (no se le entiende dos veces), falla_sistema, pedido_grande / tiempos_entrega (pedido muy grande o exige un tiempo concreto), cobro_duplicado, urgencia, privacidad_arco (derechos ARCO / datos personales).",
        },
        resumen: { type: "string", description: "Una o dos frases con lo que necesita el cliente." },
      },
      required: ["motivo"],
    },
    channels: ["whatsapp", "voz"],
  },
];

/** Definiciones visibles para un canal (ninguna parametro de telefono, por diseño). */
export function toolDefinitionsForChannel(channel: AgentChannel): readonly AgentToolDefinition[] {
  return AGENT_TOOL_DEFINITIONS.filter((t) => t.channels.includes(channel));
}

/** Ruta HTTP (relativa a `/v1/restaurantes/:orgSlug`) con la que el proveedor de voz invoca cada tool. */
export const VOICE_TOOL_HTTP_PATHS: Readonly<Record<AgentToolName, string>> = {
  buscar_cliente: "/customers/lookup",
  historial_pedidos: "/customers/orders",
  repetir_pedido: "/orders/repeat",
  consultar_sucursal: "/branches/info",
  buscar_sucursal_cercana: "/branches/nearest",
  buscar_producto: "/products/search",
  cotizar_pedido: "/orders/quote",
  confirmar_resumen: "/orders/confirm",
  crear_pedido: "/orders",
  registrar_contacto: "/callbacks",
  escalar_a_humano: "/callbacks",
};

/**
 * Definicion en JSON (neutral al proveedor) para configurar el agente de voz: misma fuente
 * que usa WhatsApp, mas metodo/URL. El proveedor agrega la cabecera del token de llamada
 * (`x-atiende-call-token`) y el secreto de sucursal (`x-atiende-tool-secret`).
 */
export function exportVoiceToolManifest(baseUrl: string, orgSlug: string): ReadonlyArray<{
  readonly name: string;
  readonly description: string;
  readonly method: "POST";
  readonly url: string;
  readonly request_body_schema: AgentToolJsonSchema;
}> {
  const root = `${baseUrl.replace(/\/+$/, "")}/v1/restaurantes/${encodeURIComponent(orgSlug)}`;
  return toolDefinitionsForChannel("voz").map((t) => ({
    name: t.name,
    description: t.description,
    method: "POST" as const,
    url: `${root}${VOICE_TOOL_HTTP_PATHS[t.name]}`,
    request_body_schema: t.parameters,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Mapeo de entrada/salida (snake_case wire <-> camelCase de dominio)
// ─────────────────────────────────────────────────────────────────────────

interface RawItemInput {
  readonly product_id?: unknown;
  readonly product_name?: unknown;
  readonly requested_quantity?: unknown;
  readonly tortilla?: unknown;
}

/** `lenient`: WhatsApp historicamente convierte una cantidad ausente/invalida en 1; voz deja pasar NaN
 * para que la validacion de dominio lo rechace. */
export function toRequestedItems(raw: unknown, lenient: boolean): RequestedOrderItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as RawItemInput;
    const qty = typeof item.requested_quantity === "number" ? item.requested_quantity : lenient ? Number(item.requested_quantity) || 1 : Number(item.requested_quantity);
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      requestedQuantity: qty,
      tortilla: isTortillaChoice(item.tortilla) ? item.tortilla : undefined,
    };
  });
}

export function quoteToWire(quote: OrderQuote & Partial<QuotePolicyInfo> & Partial<QuotePromotionInfo>) {
  return {
    lines: quote.lines.map((line) => ({
      product_id: line.productId,
      name: line.name,
      price: line.price,
      requested_quantity: line.requestedQuantity,
      pack_size: line.packSize,
      quantity: line.quantity,
      tortilla: line.tortilla,
      requires_adult_confirmation: line.requiresAdultConfirmation,
      line_total: line.lineTotal,
    })),
    // `total` es el TOTAL A PAGAR (ya con la promocion automatica, si hubo); `subtotal` es la suma de renglones.
    total: quote.total,
    contains_alcohol: quote.containsAlcohol,
    ...(quote.promocionAplicada
      ? { subtotal: quote.subtotal, descuento: quote.descuento, promocion_aplicada: { code: quote.promocionAplicada.code, name: quote.promocionAplicada.name, type: quote.promocionAplicada.type, descuento: quote.promocionAplicada.descuento } }
      : {}),
    ...(quote.promocionesSugeridas && quote.promocionesSugeridas.length > 0
      ? {
          promociones_sugeridas: quote.promocionesSugeridas.map((s) => ({
            code: s.code,
            name: s.name,
            motivo: s.motivo,
            mensaje: s.mensaje,
            ...(s.opcionesCortesia ? { opciones_cortesia: s.opcionesCortesia.map((o) => ({ product_id: o.productId, name: o.name })), cortesia_por_unidad: s.cortesiaPorUnidad ?? 0 } : {}),
          })),
        }
      : {}),
    // Modelo PM: politica de la sucursal que aplico la herramienta (minimo ya cumplido,
    // propina, horario). Solo se incluye lo que la cotizacion reporto.
    ...(quote.canal ? { canal: quote.canal } : {}),
    ...(quote.pedidoMinimo !== undefined && quote.pedidoMinimo !== null ? { pedido_minimo: quote.pedidoMinimo } : {}),
    ...(quote.propinaPolitica ? { propina_politica: quote.propinaPolitica, preguntar_propina: quote.preguntarPropina === true } : {}),
    ...(quote.abiertoAhora !== undefined && quote.abiertoAhora !== null ? { abierto_ahora: quote.abiertoAhora, cierra_a: quote.cierraA ?? null } : {}),
  };
}

/** `undefined` si no vino; un valor fuera del catalogo se deja pasar para que la validacion de dominio lo rechace. */
function toDoubleSalsas(raw: unknown): readonly DoubleSalsa[] | undefined {
  return Array.isArray(raw) ? (raw as readonly DoubleSalsa[]) : undefined;
}

function toCanal(raw: unknown): CanalPedido | undefined {
  return typeof raw === "string" ? (raw as CanalPedido) : undefined;
}

export function orderToWire(order: Order) {
  return {
    id: order.id,
    branch: order.branch,
    total: order.total,
    status: order.status,
    payment_method: order.paymentMethod,
    items: order.items,
  };
}

/** Una tool apunta a otra sucursal que la fijada por el contexto -> se rechaza (aislamiento entre sucursales). */
async function assertBranchAllowed(repo: RestaurantesRepository, ctx: AgentToolContext, branchSlug: string, branchName?: string): Promise<void> {
  if (!ctx.lockedPropertyId) return;
  const branch = await repo.findBranch(ctx.organizationId, branchSlug ? { slug: branchSlug } : { name: branchName });
  if (branch && branch.propertyId !== ctx.lockedPropertyId) {
    throw new OrderValidationError("Esta llamada o conversación pertenece a otra sucursal; no se puede operar sobre la sucursal indicada.");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Ejecutor unico
// ─────────────────────────────────────────────────────────────────────────

/** Renglones de `crear_pedido`. WhatsApp (`lenient`) conserva el redondeo historico a 1; voz conserva el
 * contrato historico del checkout (`quantity` legado + `requested_quantity` opcional). */
function toCreateOrderItems(raw: unknown, lenient: boolean): CreateOrderInput["items"] {
  if (lenient) return toRequestedItems(raw, true);
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as RawItemInput & { quantity?: unknown };
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      quantity: typeof item.quantity === "number" ? item.quantity : undefined,
      requestedQuantity: typeof item.requested_quantity === "number" ? item.requested_quantity : undefined,
      tortilla: isTortillaChoice(item.tortilla) ? item.tortilla : undefined,
    };
  });
}

/** Convierte los argumentos de `crear_pedido` en el input de dominio. El telefono viene del CONTEXTO
 * siempre que el canal lo conoce (WhatsApp: remitente; voz: token de llamada). */
export function mapCreateOrderToolInput(ctx: AgentToolContext, input: Record<string, unknown>, lenient: boolean): CreateOrderInput {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const base: CreateOrderInput = {
    organizationId: ctx.organizationId,
    branchSlug: lenient ? String(input.branch_slug ?? "") : str(input.branch_slug),
    customerName: lenient ? String(input.customer_name ?? "") : (str(input.customer_name) ?? ""),
    customerPhone: ctx.phone ?? (lenient ? "" : (str(input.customer_phone) ?? "")),
    customerAddress: str(input.customer_address),
    items: toCreateOrderItems(input.items, lenient),
    source: ctx.channel === "voz" ? "voice" : ctx.channel === "web" ? "web" : "whatsapp",
    notes: str(input.notes),
    paymentMethod: input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined,
    adultConfirmed: lenient ? input.adult_confirmed === true : typeof input.adult_confirmed === "boolean" ? input.adult_confirmed : undefined,
    requestedComplements: Array.isArray(input.requested_complements) ? (input.requested_complements as readonly RequestedComplement[]) : undefined,
    omitDefaultComplements: Array.isArray(input.omit_default_complements) ? (input.omit_default_complements as readonly DefaultComplement[]) : undefined,
    doubleSalsas: toDoubleSalsas(input.doble_salsas),
    canal: toCanal(input.canal),
    colonia: str(input.colonia_entrega),
    propina: typeof input.propina === "number" ? input.propina : undefined,
    horaRecogida: str(input.hora_recogida),
    // Cliente 360: datos opcionales del domicilio (solo alimentan la ficha; nunca cambian el total).
    addressLabel: str(input.direccion_etiqueta),
    accessNotes: str(input.referencias_acceso),
    mapsUrl: str(input.maps_url) ?? (input.usar_ubicacion_compartida === true && ctx.sharedLocation ? `https://www.google.com/maps?q=${ctx.sharedLocation.lat},${ctx.sharedLocation.lng}` : undefined),
  };
  if (lenient) return base;
  // Campos que solo trae el canal de voz/checkout (correo, transcripcion, promo, idempotencia, nombre de sucursal).
  return {
    ...base,
    branchName: str(input.branch_name),
    customerEmail: str(input.customer_email),
    idempotencyKey: str(input.idempotency_key),
    callTranscript: str(input.call_transcript),
    callRecordingUrl: str(input.call_recording_url),
    promoCode: str(input.promo_code),
  };
}

/**
 * Ejecuta UNA tool del registro. Lanza `OrderValidationError` ante errores de negocio (el
 * envoltorio de WhatsApp los convierte en `{error}`; el HTTP de voz en 400). No abre SAVEPOINT:
 * quien ejecute dentro de una transaccion compartida debe envolver la llamada (ver
 * `executeAgentToolSafely`).
 */
export async function invokeAgentTool(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def || !def.channels.includes(ctx.channel)) throw new OrderValidationError(`Herramienta desconocida: ${name}`);
  if (!ctx.flow || (name !== "cotizar_pedido" && name !== "confirmar_resumen" && name !== "crear_pedido" && name !== "repetir_pedido")) {
    return dispatchTool(repo, ctx, name, input);
  }
  return runWithOrderFlow(repo, ctx, ctx.flow, name, input);
}

function flowNow(flow: OrderFlowRef): number {
  return (flow.now ?? Date.now)();
}

async function readFlow(repo: RestaurantesRepository, ctx: AgentToolContext, flow: OrderFlowRef): Promise<OrderFlowSnapshot | null> {
  const snap = await repo.readOrderFlow(ctx.organizationId, flow.key);
  if (snap === null) warnOrderFlowUnavailable();
  return snap;
}

async function writeFlow(
  repo: RestaurantesRepository,
  ctx: AgentToolContext,
  flow: OrderFlowRef,
  expectedVersion: number,
  state: OrderFlowState,
  context: OrderFlowContext,
): Promise<"written" | "conflict" | "unavailable"> {
  const res = await repo.writeOrderFlow(ctx.organizationId, flow.key, expectedVersion, { state, context }, FLOW_ROW_TTL_SECONDS);
  if (res === "unavailable") warnOrderFlowUnavailable();
  return res;
}

const CONFLICT_MESSAGE = "La conversación se está procesando en otro lugar; vuelve a intentar en un momento.";

/** Aplica la maquina de estados alrededor de cotizar/confirmar/crear. Base sin migrar => camino anterior. */
async function runWithOrderFlow(repo: RestaurantesRepository, ctx: AgentToolContext, flow: OrderFlowRef, name: string, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const lenient = ctx.channel === "whatsapp";
  const canalOf = (raw: unknown) => (raw === "recoger" ? "recoger" : "domicilio");

  if (name === "repetir_pedido") {
    // Repetir = cotizar: la cotizacion con precios de hoy entra a la misma maquina de estados (quote_hash, confirmacion).
    const { cotizarInput, repeticion } = await prepararRepeticion(repo, ctx, input);
    const outcome = await runWithOrderFlow(repo, ctx, flow, "cotizar_pedido", cotizarInput);
    return { ...outcome, result: { ...(outcome.result as object), repeticion } };
  }

  if (name === "cotizar_pedido") {
    const outcome = await dispatchTool(repo, ctx, name, input);
    const quoteHash = fingerprintOrder({
      branchSlug: String(input.branch_slug ?? ""),
      canal: canalOf(input.canal),
      adultConfirmed: input.adult_confirmed === true,
      items: toRequestedItems(input.items, lenient),
      doubleSalsas: toDoubleSalsas(input.doble_salsas),
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await readFlow(repo, ctx, flow);
      if (snap === null) return outcome; // base sin migrar: camino anterior
      const res = await writeFlow(repo, ctx, flow, snap.version, "cotizado", { quoteHash, quotedAtMs: flowNow(flow), quotedTurn: flow.turn });
      if (res === "written") return { ...outcome, result: { ...(outcome.result as object), quote_hash: quoteHash }, quoteHash };
      if (res === "unavailable") return outcome;
    }
    throw new OrderValidationError(CONFLICT_MESSAGE);
  }

  if (name === "confirmar_resumen") {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snap = await readFlow(repo, ctx, flow);
      if (snap === null) return { result: { confirmado: true, aviso: "confirmación no registrada por el servidor todavía" }, orderId: null, propertyId: null };
      const cited = typeof input.quote_hash === "string" ? input.quote_hash : undefined;
      const current = assertCanConfirm(snap, { now: flowNow(flow), turn: flow.turn, quoteHashCited: cited });
      if (snap.state !== "cotizado") {
        return { result: { confirmado: true, quote_hash: current.quoteHash }, orderId: null, propertyId: null, quoteHash: current.quoteHash };
      }
      const res = await writeFlow(repo, ctx, flow, snap.version, "confirmado", { ...current, confirmedAtMs: flowNow(flow) });
      if (res === "written") return { result: { confirmado: true, quote_hash: current.quoteHash }, orderId: null, propertyId: null, quoteHash: current.quoteHash };
      if (res === "unavailable") return { result: { confirmado: true }, orderId: null, propertyId: null };
    }
    throw new OrderValidationError(CONFLICT_MESSAGE);
  }

  // crear_pedido: reclamo atomico (confirmado -> creando) ANTES de crear, para que dos llamadas
  // concurrentes no creen dos pedidos.
  const fingerprint = fingerprintOrder({
    branchSlug: String(input.branch_slug ?? ""),
    canal: canalOf(input.canal),
    adultConfirmed: input.adult_confirmed === true,
    items: toRequestedItems(input.items, lenient),
    doubleSalsas: toDoubleSalsas(input.doble_salsas),
  });
  let claimed: { version: number; context: OrderFlowContext } | null = null;
  for (let attempt = 0; attempt < 3 && !claimed; attempt++) {
    const snap = await readFlow(repo, ctx, flow);
    if (snap === null) return dispatchTool(repo, ctx, name, input); // base sin migrar: camino anterior
    const current = assertCanCreate(snap, { now: flowNow(flow), turn: flow.turn, fingerprint });
    const claimCtx: OrderFlowContext = { ...current, claimedAtMs: flowNow(flow) };
    const res = await writeFlow(repo, ctx, flow, snap.version, "creando", claimCtx);
    if (res === "written") claimed = { version: snap.version + 1, context: claimCtx };
    else if (res === "unavailable") return dispatchTool(repo, ctx, name, input);
  }
  if (!claimed) throw new OrderValidationError(CONFLICT_MESSAGE);

  try {
    const outcome = await dispatchTool(repo, ctx, name, input);
    await writeFlow(repo, ctx, flow, claimed.version, "creado", { ...claimed.context, orderId: outcome.orderId ?? undefined });
    return outcome;
  } catch (err) {
    // Error de negocio (horario, zona, minimo...): vuelve a "confirmado" para poder corregir/reintentar.
    // Un error real de Postgres aborta la transaccion del request entera (no se puede escribir mas);
    // el rollback de la transaccion deshace tambien el reclamo.
    if (err instanceof OrderValidationError) {
      await writeFlow(repo, ctx, flow, claimed.version, "confirmado", { ...claimed.context, claimedAtMs: undefined });
    }
    throw err;
  }
}

async function dispatchTool(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  const def = AGENT_TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def || !def.channels.includes(ctx.channel)) throw new OrderValidationError(`Herramienta desconocida: ${name}`);
  const lenient = ctx.channel === "whatsapp";
  const { organizationId } = ctx;

  switch (def.name) {
    case "buscar_cliente": {
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede consultar el historial.");
      const result = await lookupCustomerConPedidoReciente(repo, organizationId, ctx.phone);
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "historial_pedidos": {
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede consultar el historial.");
      const memoria = await cargarMemoria(repo, organizationId, normalizePhone(ctx.phone));
      if (memoria === undefined) throw new OrderValidationError("El historial de pedidos todavía no está disponible: tome el pedido de forma normal.");
      const pedidos = (memoria?.orders ?? []).slice(0, 5).map((o) => ({
        numero: o.orderNumber,
        fecha: o.createdAt,
        canal: o.canal,
        sucursal: o.branch,
        total: o.total,
        productos: o.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      }));
      const result = { pedidos, total_pedidos_anteriores: pedidos.length };
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "repetir_pedido": {
      const { cotizarInput, repeticion } = await prepararRepeticion(repo, ctx, input);
      const quoted = await dispatchTool(repo, ctx, "cotizar_pedido", cotizarInput);
      return { ...quoted, result: { ...(quoted.result as object), repeticion } };
    }
    case "consultar_sucursal": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      const branch = await repo.findBranch(organizationId, { slug: branchSlug });
      if (!branch || branch.status !== "active") throw new OrderValidationError(`Sucursal '${branchSlug}' no encontrada o inactiva`);
      const policy = await repo.findBranchPolicy(branch.propertyId);
      let abierto: boolean | null = null;
      let cierraA: string | null = null;
      if (policy.horario && policy.horario.length > 0) {
        const zona = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
        const estado = estaAbiertoAhora(policy.horario, new Date(), zona);
        abierto = estado.abierto;
        cierraA = estado.cierraA;
      }
      const result = {
        branch_slug: branch.slug,
        branch_name: branch.name,
        direccion: branch.address,
        telefono: branch.phone,
        abierto_ahora: abierto,
        cierra_a: cierraA,
        horario: policy.horario,
        pedido_minimo_domicilio: policy.pedidoMinimoDomicilio,
        pedido_minimo_recoger: policy.pedidoMinimoRecoger,
      };
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "buscar_sucursal_cercana": {
      let lat = typeof input.lat === "number" ? input.lat : undefined;
      let lng = typeof input.lng === "number" ? input.lng : undefined;
      // Ubicacion compartida por WhatsApp: se usa solo si el modelo no mando coordenadas ni una colonia
      // explicita (una colonia dicha por el cliente despues de compartir manda).
      const coloniaDicha = typeof input.colonia === "string" && input.colonia.trim() !== "";
      if (lat === undefined && lng === undefined && !coloniaDicha && ctx.sharedLocation) {
        lat = ctx.sharedLocation.lat;
        lng = ctx.sharedLocation.lng;
      }
      const match = await assignBranch(repo, {
        organizationId,
        colonia: typeof input.colonia === "string" ? input.colonia : undefined,
        ...(lat !== undefined || lng !== undefined ? { lat, lng } : {}),
        ...(typeof input.max_km === "number" ? { maxKm: input.max_km } : {}),
      });
      const result =
        match.estado === "asignada"
          ? {
              encontrada: true,
              estado: match.estado,
              branch_slug: match.branchSlug,
              branch_name: match.branchName,
              distancia_km: match.distanceKm,
              colonia_reconocida: match.recognizedZoneName,
              via: match.via,
              ajuste_por_zona: match.ajustePorZona,
            }
          : match.estado === "fuera_de_zona"
            ? { encontrada: false, estado: match.estado, mensaje: match.message, branch_slug_mas_cercana: match.branchSlug, distancia_km: match.distanceKm, max_km: match.maxKm }
            : { encontrada: false, estado: match.estado, mensaje: match.message };
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "buscar_producto": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      const branch = await repo.findBranch(organizationId, { slug: branchSlug });
      if (!branch) throw new OrderValidationError(`Sucursal '${branchSlug}' no encontrada`);
      const productos = await searchProducts(repo, { propertyId: branch.propertyId, query: String(input.query ?? "") });
      const result = productos.map((p) => ({ id: p.id, name: p.name, price: p.price, pack_size: p.packSize, requires_adult_confirmation: p.requiresAdultConfirmation }));
      return { result, raw: result, orderId: null, propertyId: null };
    }
    case "cotizar_pedido": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      const quote = await quoteOrder(repo, {
        organizationId,
        branchSlug,
        items: toRequestedItems(input.items, lenient),
        adultConfirmed: input.adult_confirmed === true,
        canal: toCanal(input.canal),
        colonia: typeof input.colonia_entrega === "string" ? input.colonia_entrega : undefined,
        paymentMethod: input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined,
        doubleSalsas: toDoubleSalsas(input.doble_salsas),
      });
      return { result: { quote: quoteToWire(quote) }, raw: quote, orderId: null, propertyId: null };
    }
    case "confirmar_resumen": {
      // Sin maquina de estados activa (camino legado): no hay nada que registrar.
      return { result: { confirmado: true, aviso: "confirmación no registrada por el servidor" }, orderId: null, propertyId: null };
    }
    case "crear_pedido": {
      const mapped = mapCreateOrderToolInput(ctx, input, lenient);
      // Checkout web: reglas duras que la fuente "web" historica no exige (ver storefront.ts).
      const createInput = ctx.channel === "web" ? assertWebOrderRules(mapped) : mapped;
      // La sucursal puede venir por slug o por nombre (contrato historico del checkout de voz).
      if (createInput.branchSlug || createInput.branchName) {
        await assertBranchAllowed(repo, ctx, createInput.branchSlug ?? "", createInput.branchName);
      } else if (ctx.lockedPropertyId) {
        throw new OrderValidationError("Esta llamada está fijada a una sucursal; indica branch_slug.");
      }
      const retenido = await retenerPedidoDeReincidente(repo, ctx, createInput);
      if (retenido) return retenido;
      const order = await createOrder(repo, createInput);
      return { result: { order: orderToWire(order) }, raw: order, orderId: order.id, propertyId: order.propertyId };
    }
    case "registrar_contacto":
    case "escalar_a_humano": {
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede dejar aviso.");
      const esEscalada = def.name === "escalar_a_humano";
      await registerCallbackRequest(repo, {
        organizationId,
        propertyId: ctx.lockedPropertyId ?? null,
        customerName: String(input.customer_name ?? "Cliente"),
        customerPhone: ctx.phone,
        reason: esEscalada ? `escalada:${normalizarMotivoEscalacion(input.motivo)}` : typeof input.reason === "string" ? input.reason : undefined,
        message: esEscalada ? (typeof input.resumen === "string" ? input.resumen : undefined) : typeof input.message === "string" ? input.message : undefined,
        source: ctx.channel === "voz" ? "voice" : "whatsapp",
      });
      return { result: { ok: true }, raw: { ok: true }, orderId: null, propertyId: null };
    }
  }
}

/** Arma la entrada de `cotizar_pedido` a partir de un pedido anterior del MISMO cliente (el telefono sale del contexto). */
async function prepararRepeticion(repo: RestaurantesRepository, ctx: AgentToolContext, input: Record<string, unknown>) {
  if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede repetir un pedido.");
  const branchSlug = String(input.branch_slug ?? "");
  await assertBranchAllowed(repo, ctx, branchSlug);
  const memoria = await cargarMemoria(repo, ctx.organizationId, normalizePhone(ctx.phone));
  if (memoria === undefined) throw new OrderValidationError("El historial de pedidos todavía no está disponible: tome el pedido de forma normal.");
  const numero = typeof input.pedido_numero === "number" && Number.isInteger(input.pedido_numero) ? input.pedido_numero : undefined;
  const pedido = elegirPedido(memoria?.orders ?? [], numero);
  const repetido = await repetirPedido(repo, { organizationId: ctx.organizationId, branchSlug, order: pedido });
  const canal = input.canal === "domicilio" || input.canal === "recoger" ? input.canal : (pedido.canal ?? "domicilio");
  const cotizarInput: Record<string, unknown> = {
    branch_slug: branchSlug,
    canal,
    items: repetido.renglones.map((r) => ({ product_id: r.productId, product_name: r.productName, requested_quantity: r.requestedQuantity, ...(r.tortilla ? { tortilla: r.tortilla } : {}) })),
    ...(input.adult_confirmed === true ? { adult_confirmed: true } : {}),
    ...(typeof input.colonia_entrega === "string" ? { colonia_entrega: input.colonia_entrega } : {}),
    ...(input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? { payment_method: input.payment_method } : {}),
  };
  const repeticion = {
    pedido_numero: repetido.pedido.numero,
    fecha: repetido.pedido.fecha,
    sucursal_anterior: repetido.pedido.sucursal,
    total_anterior: repetido.totalAnterior,
    cambios: repetido.cambios.map((c) => ({ producto: c.producto, motivo: c.motivo, precio_anterior: c.precioAnterior, precio_actual: c.precioActual })),
    aviso:
      repetido.cambios.length > 0
        ? "Avise al cliente de estos cambios (productos que ya no están o que cambiaron de precio) ANTES de confirmar; el total que vale es el de la cotización de hoy, no el de la vez pasada."
        : "Sin cambios: mismos productos disponibles. El total que vale es el de la cotización de hoy.",
  };
  return { cotizarInput, repeticion };
}

/**
 * Reincidentes de "no recogido" / pedido falso: con el umbral de la politica (por omision 2 en 90 dias; 0 = apagada) el
 * pedido NO se crea solo: queda un aviso con TODO el pedido para que la sucursal lo confirme con el cliente. El agente nunca
 * acusa: solo dice que la sucursal confirma el pedido en un momento. Solo agentes (WhatsApp y voz) con telefono conocido.
 */
async function retenerPedidoDeReincidente(repo: RestaurantesRepository, ctx: AgentToolContext, createInput: CreateOrderInput): Promise<AgentToolOutcome | null> {
  if ((ctx.channel !== "whatsapp" && ctx.channel !== "voz") || !ctx.phone) return null;
  const memoria = await cargarMemoria(repo, ctx.organizationId, normalizePhone(ctx.phone));
  const decision = evaluarReincidencia(memoria?.reliability);
  if (!decision.requiereConfirmacion) return null;
  // Misma validacion y cotizacion que un pedido real (horario, zona, minimo, productos): un error de negocio se devuelve igual.
  const prepared = await prepareCreateOrder(repo, createInput);
  const lineas = prepared.orderItems.map((i) => `${i.quantity}x ${i.name}`).join(", ");
  await registerCallbackRequest(repo, {
    organizationId: ctx.organizationId,
    propertyId: prepared.branch.propertyId,
    customerName: prepared.payload.customerName,
    customerPhone: ctx.phone,
    reason: "aprobacion_pedido_cliente",
    message: [
      "PEDIDO RETENIDO: confirmar con el cliente antes de prepararlo (historial de pedidos no recogidos o marcados como falsos dentro de la ventana de la politica de clientes).",
      `Sucursal: ${prepared.branch.name}. Canal: ${prepared.payload.canal === "recoger" ? "recoger" : "domicilio"}.`,
      `Productos: ${lineas}. Total: $${prepared.total.toFixed(2)}.`,
      prepared.payload.customerAddress ? `Entrega: ${prepared.payload.customerAddress}.` : "Para recoger en sucursal.",
      `Pago: ${prepared.payload.paymentMethod ?? "sin definir"}.`,
    ].join("\n"),
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
  });
  const result = {
    pedido_retenido: true,
    mensaje: "La sucursal confirma su pedido en un momento. Dígaselo así, con amabilidad: no explique motivos ni mencione historial; el pedido NO está creado todavía y no debe prometer hora de entrega.",
  };
  return { result, raw: result, orderId: null, propertyId: prepared.branch.propertyId };
}

/**
 * Variante para turnos dentro de una transaccion compartida (WhatsApp): SAVEPOINT propio por tool
 * call y errores de negocio convertidos en una respuesta `{error}` normal, nunca en una
 * transaccion abortada ni en una excepcion que tumbe el resto del turno.
 */
export async function executeAgentToolSafely(repo: RestaurantesRepository, ctx: AgentToolContext, name: string, input: Record<string, unknown>): Promise<AgentToolOutcome> {
  try {
    return await repo.runWithRowSavepoint(() => invokeAgentTool(repo, ctx, name, input));
  } catch (err) {
    return { result: { error: err instanceof OrderValidationError ? err.message : "Error interno al ejecutar la herramienta" }, orderId: null, propertyId: null };
  }
}

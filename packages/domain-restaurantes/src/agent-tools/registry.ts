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
import { lookupCustomer } from "../customers.ts";
import { OrderValidationError } from "../errors.ts";
import { estaAbiertoAhora } from "../horarios.ts";
import { findNearestBranch } from "../nearest-branch.ts";
import { createOrder, quoteOrder, searchProducts, type QuotePolicyInfo } from "../orders.ts";
import type { RestaurantesRepository } from "../repository.ts";
import type {
  CanalPedido,
  CreateOrderInput,
  DefaultComplement,
  Order,
  OrderQuote,
  RequestedComplement,
  RequestedOrderItemInput,
  TortillaChoice,
} from "../types.ts";

export type AgentChannel = "whatsapp" | "voz";

export type AgentToolName =
  | "buscar_cliente"
  | "consultar_sucursal"
  | "buscar_sucursal_cercana"
  | "buscar_producto"
  | "cotizar_pedido"
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
  /** Campos extra que solo acepta el canal de voz en crear_pedido (transcripcion, etc.). */
  readonly extraOrder?: Partial<Pick<CreateOrderInput, "customerEmail" | "callTranscript" | "callRecordingUrl" | "promoCode" | "idempotencyKey">>;
}

export interface AgentToolOutcome {
  /** Respuesta "wire" (snake_case) que ve el LLM de WhatsApp; la voz la usa salvo donde su
   * contrato historico difiere y lee `raw`. */
  readonly result: unknown;
  /** Objeto de dominio sin transformar (OrderQuote / Order), para los envoltorios HTTP de voz. */
  readonly raw?: unknown;
  readonly orderId: string | null;
  readonly propertyId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────
// Definiciones (una sola fuente)
// ─────────────────────────────────────────────────────────────────────────

const ITEM_SCHEMA = {
  type: "object",
  properties: {
    product_id: { type: "string" },
    product_name: { type: "string", description: "Nombre exacto devuelto por buscar_producto." },
    requested_quantity: { type: "integer", description: "Cantidad de piezas/unidades que pidio el cliente, no el numero de paquetes." },
    tortilla: { type: "string", enum: ["maiz", "harina"] },
  },
  required: ["product_id", "product_name", "requested_quantity"],
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
      "Dado el nombre de una colonia/zona/referencia que dio el cliente, devuelve la sucursal real MÁS CERCANA calculada por distancia real (no adivines tú cuál está más cerca). Llámala en cuanto tengas la colonia o una referencia clara.",
    parameters: {
      type: "object",
      properties: { colonia: { type: "string", description: "La colonia, zona o referencia que dio el cliente, tal cual." } },
      required: ["colonia"],
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
      },
      required: ["branch_slug", "items"],
    },
    channels: ["whatsapp", "voz"],
  },
  {
    name: "crear_pedido",
    description: "Registra el pedido final en el sistema. Solo llamar cuando el cliente ya confirmó todo, incluyendo la sucursal.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string" },
        customer_name: { type: "string" },
        customer_address: { type: "string", description: "Dirección completa de entrega; obligatoria salvo canal 'recoger'." },
        items: { type: "array", items: ITEM_SCHEMA },
        notes: { type: "string" },
        requested_complements: { type: "array", items: { type: "string", enum: ["salsa_habanero", "crema_ajo"] } },
        omit_default_complements: { type: "array", items: { type: "string", enum: ["salsa_verde", "salsa_roja", "limones", "cebolla"] } },
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"] },
        adult_confirmed: { type: "boolean" },
        canal: { type: "string", enum: ["domicilio", "recoger"], description: "Por defecto 'domicilio'. Para 'recoger' no hace falta customer_address." },
        colonia_entrega: { type: "string", description: "Colonia/zona de entrega (solo a domicilio)." },
        propina: { type: "number", description: "Propina en pesos, solo si cotizar_pedido indicó preguntar_propina: true y el cliente la dio. No suma al total." },
      },
      required: ["branch_slug", "customer_name", "items", "payment_method"],
    },
    channels: ["whatsapp", "voz"],
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
        motivo: { type: "string", enum: ["cliente_lo_pide", "queja", "no_puedo_resolver", "pedido_especial", "otro"] },
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
  consultar_sucursal: "/branches/info",
  buscar_sucursal_cercana: "/branches/nearest",
  buscar_producto: "/products/search",
  cotizar_pedido: "/orders/quote",
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
      tortilla: item.tortilla === "maiz" || item.tortilla === "harina" ? (item.tortilla as TortillaChoice) : undefined,
    };
  });
}

export function quoteToWire(quote: OrderQuote & Partial<QuotePolicyInfo>) {
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
    total: quote.total,
    contains_alcohol: quote.containsAlcohol,
    // Modelo PM: politica de la sucursal que aplico la herramienta (minimo ya cumplido,
    // propina, horario). Solo se incluye lo que la cotizacion reporto.
    ...(quote.canal ? { canal: quote.canal } : {}),
    ...(quote.pedidoMinimo !== undefined && quote.pedidoMinimo !== null ? { pedido_minimo: quote.pedidoMinimo } : {}),
    ...(quote.propinaPolitica ? { propina_politica: quote.propinaPolitica, preguntar_propina: quote.preguntarPropina === true } : {}),
    ...(quote.abiertoAhora !== undefined && quote.abiertoAhora !== null ? { abierto_ahora: quote.abiertoAhora, cierra_a: quote.cierraA ?? null } : {}),
  };
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
async function assertBranchAllowed(repo: RestaurantesRepository, ctx: AgentToolContext, branchSlug: string): Promise<void> {
  if (!ctx.lockedPropertyId) return;
  const branch = await repo.findBranch(ctx.organizationId, { slug: branchSlug });
  if (branch && branch.propertyId !== ctx.lockedPropertyId) {
    throw new OrderValidationError("Esta llamada o conversación pertenece a otra sucursal; no se puede operar sobre la sucursal indicada.");
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Ejecutor unico
// ─────────────────────────────────────────────────────────────────────────

/** Convierte los argumentos de `crear_pedido` en el input de dominio. El telefono viene SIEMPRE del contexto. */
export function mapCreateOrderToolInput(ctx: AgentToolContext, input: Record<string, unknown>, lenient: boolean): CreateOrderInput {
  return {
    organizationId: ctx.organizationId,
    branchSlug: String(input.branch_slug ?? ""),
    customerName: String(input.customer_name ?? ""),
    customerPhone: ctx.phone ?? (typeof input.customer_phone === "string" ? input.customer_phone : ""),
    customerAddress: typeof input.customer_address === "string" ? input.customer_address : undefined,
    items: toRequestedItems(input.items, lenient),
    source: ctx.channel === "voz" ? "voice" : "whatsapp",
    notes: typeof input.notes === "string" ? input.notes : undefined,
    paymentMethod: input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined,
    adultConfirmed: input.adult_confirmed === true,
    requestedComplements: Array.isArray(input.requested_complements) ? (input.requested_complements as readonly RequestedComplement[]) : undefined,
    omitDefaultComplements: Array.isArray(input.omit_default_complements) ? (input.omit_default_complements as readonly DefaultComplement[]) : undefined,
    canal: toCanal(input.canal),
    colonia: typeof input.colonia_entrega === "string" ? input.colonia_entrega : undefined,
    propina: typeof input.propina === "number" ? input.propina : undefined,
    ...(ctx.extraOrder ?? {}),
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
  const lenient = ctx.channel === "whatsapp";
  const { organizationId } = ctx;

  switch (def.name) {
    case "buscar_cliente": {
      if (!ctx.phone) throw new OrderValidationError("No se conoce el teléfono de esta conversación; no se puede consultar el historial.");
      const result = await lookupCustomer(repo, organizationId, ctx.phone);
      return { result, raw: result, orderId: null, propertyId: null };
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
      const match = await findNearestBranch(repo, { organizationId, colonia: String(input.colonia ?? "") });
      const result = match.found
        ? { encontrada: true, branch_slug: match.branchSlug, branch_name: match.branchName, distancia_km: match.distanceKm, colonia_reconocida: match.recognizedZoneName }
        : { encontrada: false, mensaje: match.message };
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
      });
      return { result: { quote: quoteToWire(quote) }, raw: quote, orderId: null, propertyId: null };
    }
    case "crear_pedido": {
      const branchSlug = String(input.branch_slug ?? "");
      await assertBranchAllowed(repo, ctx, branchSlug);
      const order = await createOrder(repo, mapCreateOrderToolInput(ctx, input, lenient));
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
        reason: esEscalada ? `escalada:${typeof input.motivo === "string" ? input.motivo : "otro"}` : typeof input.reason === "string" ? input.reason : undefined,
        message: esEscalada ? (typeof input.resumen === "string" ? input.resumen : undefined) : typeof input.message === "string" ? input.message : undefined,
        source: ctx.channel === "voz" ? "voice" : "whatsapp",
      });
      return { result: { ok: true }, raw: { ok: true }, orderId: null, propertyId: null };
    }
  }
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

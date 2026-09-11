// Fase 2 §2 — agente de WhatsApp con LLM real, sobre el seam que Fase 1 dejó
// listo en turn-handler.ts (`WhatsAppTurnHandler`). Puerto de negocio de
// restaurantes/supabase/functions/_shared/whatsapp-agent-core.ts
// (`runAgentTurn`/`TOOLS`/`BASE_SYSTEM_PROMPT`) sobre
// `@atiende/agent-core`'s `LlmGateway` — el loop de tool-use, el prompt, las
// 5 TOOLS y la ejecución de cada tool call contra datos reales son negocio de
// restaurantes puro (igual que orders.ts/product-search.ts), NUNCA viven en
// agent-core (agnóstico de vertical por diseño).
//
// Principio "un solo núcleo, dos canales" (igual que create-order-core.ts en
// el origen): cada tool call se despacha EN PROCESO contra las mismas
// funciones de dominio que respaldan los Server Tools de voz —
// findNearestBranch/searchProducts/quoteOrder/createOrder/registerCallbackRequest
// — nunca hace un fetch HTTP a sus propios endpoints.
//
// Decisión de diseño explícita (ver diseño Fase 2 §2.5): el loop de tool-use
// corre con un arreglo EFÍMERO por turno (reconstruido cada vez a partir del
// historial de TEXTO persistido — `ConversationMessage[]`, sin detalle de
// tool_calls — más el mensaje nuevo), nunca se amplía `ConversationMessage`
// para guardar tool_calls/resultados crudos entre turnos. La regla dura "si
// crear_pedido ya tuvo éxito en esta conversación, nunca la vuelvas a llamar"
// se protege de forma ESTRUCTURAL (idempotencyKey + dedupeFingerprint de 5
// min en `createOrder`, ver orders.ts), no dependiendo de que el LLM relea su
// propio historial de tool_calls.
import { randomUUID } from "node:crypto";
import type { LlmGateway, LlmMessage, LlmToolCall, LlmToolDefinition } from "@atiende/agent-core";
import { registerCallbackRequest } from "../callback-requests.ts";
import { vipNote } from "../customers.ts";
import { OrderValidationError } from "../errors.ts";
import { findNearestBranch } from "../nearest-branch.ts";
import { createOrder, quoteOrder, searchProducts } from "../orders.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import type { BranchSummary, CustomerLookupResult, DefaultComplement, Order, OrderQuote, RequestedComplement, RequestedOrderItemInput, TortillaChoice } from "../types.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";

// ─────────────────────────────────────────────────────────────────────────
// Tono, reglas duras y generación del prompt.
// ─────────────────────────────────────────────────────────────────────────

/** Los 4 estilos de tono reales del selector de admin del origen — Fase 2
 * arranca con un único default fijo (`calido_cercano`, ver FALLBACK_CONFIG);
 * la tabla `whatsapp_agent_config` editable queda fuera de esta fase (diseño
 * §4), pero el seam queda listo: cambiar `toneStyle` en `WhatsAppLlmAgentConfig`
 * ya produce el texto correcto sin tocar el loop. */
export type WhatsAppToneStyle = "calido_cercano" | "formal_directo" | "profesional_neutro" | "divertido_desenfadado";

export const TONE_INSTRUCTIONS: Record<WhatsAppToneStyle, string> = {
  calido_cercano: "Cálido y cercano: como el encargado de confianza de la sucursal que ya conoce al cliente — cercano mexicano, sin ser cursi.",
  formal_directo: "Formal y directo: cortés y profesional, sin diminutivos ni emojis, va al grano en cada mensaje.",
  profesional_neutro: "Profesional y neutro: correcto y claro, ni muy formal ni muy relajado — como una línea de atención a clientes seria.",
  divertido_desenfadado: "Divertido y desenfadado: relajado, con humor ligero y algún emoji ocasional, sin dejar de ser claro con los datos del pedido.",
};

/** Reglas agregadas DESPUÉS del prompt base: una edición de tono/personalidad
 * nunca puede borrar por accidente la semántica de venta ni volver a delegar
 * la aritmética al modelo — port literal de ORDER_QUANTITY_RULES. */
export const ORDER_QUANTITY_RULES = `REGLAS DURAS DE CANTIDADES Y TOTAL:
- Si el producto es individual (pack_size 1), se puede pedir cualquier cantidad entera positiva. "Individual" significa precio por una pieza, NO un máximo de una pieza. Ejemplo obligatorio: 8 tacos al pastor son válidos y se cobran como 8 por el precio individual.
- Siempre que mencionen tacos de bistec, explica de inmediato que se venden únicamente en órdenes de 3 y que el precio de menú corresponde a la orden completa. Hazlo incluso si la cantidad pedida ya es válida: 3 tacos son 1 orden; 6 tacos son 2 órdenes; 9 tacos son 3 órdenes.
- Para cualquier producto con pack_size mayor a 1, solo acepta múltiplos exactos. Si piden 1, 2, 4, 5 u otro no múltiplo, explica la presentación y ofrece el múltiplo inferior válido y/o el siguiente.
- Para CADA renglón de tacos, pregunta por separado si lo quiere con tortilla de maíz o de harina, salvo que el cliente diga explícitamente "todos de maíz" o "todos de harina". Guarda la elección como tortilla: "maiz" o "harina" en cada item. No cotices ni avances al pago mientras falte esta elección para cualquier taco.
- Si buscar_producto devuelve requires_adult_confirmation: true, pregunta directamente si quien recibirá el pedido es mayor de edad y espera un sí claro. Solo entonces manda adult_confirmed: true tanto a cotizar_pedido como a crear_pedido. Nunca lo infieras por el tono, el nombre, la voz o una respuesta ambigua.
- Nunca cierres un turno diciendo solo "voy a revisar" o "déjame buscar". Ejecuta la herramienta necesaria en ese mismo turno y después responde con el resultado, o termina con una pregunta concreta que el cliente sí deba contestar.
- Está prohibido preguntar efectivo/tarjeta antes de que cotizar_pedido responda con éxito. Después de que el cliente elija la forma de pago, llama inmediatamente a crear_pedido: no pidas una confirmación redundante.
- Conserva en requested_quantity la cantidad de piezas/unidades que dijo y confirmó el cliente. Nunca conviertas tú las piezas a órdenes: cotizar_pedido y crear_pedido hacen esa conversión de forma determinista.
- Antes de decir cualquier total o preguntar la forma de pago, llama siempre a cotizar_pedido. Repite exactamente el total y los renglones devueltos; nunca hagas aritmética mental ni recalcules el resultado.`;

export const ORDER_IDENTITY_AND_COMPLEMENT_RULES = `REGLAS DURAS DE IDENTIDAD Y COMPLEMENTOS:
- Si el cliente corrige su nombre, descarta por completo la versión anterior y usa únicamente ese nombre final al crear el pedido.
- Todos los pedidos incluyen sin costo salsa verde, salsa roja, limones y cebolla, salvo que el cliente pida quitar alguno.
- Salsa habanero y crema de ajo son gratis pero solo se envían si el cliente las pide expresamente. Nunca las busques como producto ni las cobres. Envía habanero/ajo en requested_complements y las omisiones de verde/roja/limones/cebolla en omit_default_complements.
- Un pedido no existe hasta que crear_pedido devuelve éxito. Si ya devolvió un order id, nunca vuelvas a crear el pedido ni respondas con un error genérico aunque falle el siguiente turno del proveedor.
- REGLA DURA: si en esta MISMA conversación ya llamaste a crear_pedido y te respondió con éxito, NUNCA vuelvas a llamarla otra vez — solo repítele el resumen del pedido ya creado. Llamarla dos veces crea un pedido real duplicado en cocina.`;

/** Bug real confirmado 4-sep-2026: el agente saludaba con "Buenas tardes"
 * fijo sin importar la hora real — se calcula server-side con la hora REAL
 * de la zona horaria del restaurante, nunca se le pide al modelo "adivinar"
 * la hora. */
export function saludoSegunHora(timezone: string, ahora: Date = new Date()): string {
  const hora = Number(new Intl.DateTimeFormat("es-MX", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(ahora));
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

function customerContextBlock(customer: CustomerLookupResult): string {
  if (customer.isNew) {
    return "Cliente nuevo — nunca ha pedido antes por este número. Pide su nombre y su dirección de entrega; se guardan solos en su perfil al cerrar el pedido, no hace falta hacer nada extra.";
  }
  const lines: string[] = [];
  lines.push(`Cliente conocido${customer.name ? `: ${customer.name}` : " (sin nombre guardado todavía — pídeselo)"}.`);
  lines.push(`Ha pedido ${customer.orderCount} ${customer.orderCount === 1 ? "vez" : "veces"} antes.`);
  const nota = vipNote(customer.tier);
  if (nota) lines.push(nota);
  if (customer.addresses.length > 0) {
    const def = customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0]!;
    lines.push(`Dirección guardada por defecto: "${def.address}".`);
    const others = customer.addresses.filter((a) => a !== def);
    if (others.length > 0) {
      lines.push(`También tiene otras direcciones guardadas: ${others.map((a) => `"${a.address}"`).join(", ")}.`);
    }
  } else {
    lines.push("No tiene dirección guardada todavía — pídesela.");
  }
  if (customer.lastOrderItems && customer.lastOrderItems.length > 0) {
    const items = customer.lastOrderItems.map((i) => `${i.quantity}x ${i.name}`).join(", ");
    lines.push(`Su último pedido fue: ${items}.`);
  }
  if (customer.frequentItems.length > 0) {
    const items = customer.frequentItems.map((i) => i.name).join(", ");
    lines.push(
      `Lo que más pide (across todo su historial real, no solo el último pedido): ${items}. Puedes ofrecer "¿lo de siempre?" con confianza usando esto, incluso si su último pedido fue distinto.`,
    );
  } else if (customer.lastOrderItems && customer.lastOrderItems.length > 0) {
    lines.push(`Puedes usar su último pedido para sugerir "¿lo de siempre?" si aplica.`);
  }
  return lines.join("\n");
}

/** Bloque "SUCURSALES REALES" — GENERALIZACIÓN OBLIGATORIA por multi-tenancy
 * (diseño §2.2): el origen lo tenía hardcodeado en texto fijo para un único
 * restaurante mono-tenant; aquí se genera en cada turno a partir de
 * `repo.listBranchesForOrganization`, nunca vive en texto fijo del prompt. */
function branchesBlock(branches: readonly BranchSummary[]): string {
  if (branches.length === 0) {
    return "- (Este restaurante todavía no tiene sucursales activas configuradas — sé honesto si el cliente pregunta.)";
  }
  return branches.map((b) => `- ${b.name} (branch_slug: "${b.slug}")${b.address ? ` — ${b.address}` : ""}.`).join("\n");
}

export interface WhatsAppLlmAgentConfig {
  readonly businessName: string;
  readonly toneStyle: WhatsAppToneStyle;
  readonly timezone: string;
  readonly deliveryTimeText: string;
}

/** Mismo valor que corría hardcodeado en el origen antes de que existiera
 * `whatsapp_agent_config` — Fase 2 lo deja fijo por organización (diseño
 * §2.2/§4); el seam de lectura (`getAgentConfig`) queda aislado para que un
 * panel de admin futuro solo tenga que sustituir esta función, sin tocar el
 * loop. */
export const FALLBACK_CONFIG: WhatsAppLlmAgentConfig = {
  businessName: "este restaurante",
  toneStyle: "calido_cercano",
  timezone: "America/Merida",
  deliveryTimeText: "40 a 50 minutos (1h a 1h20 si llueve)",
};

/** Seam de lectura de configuración por organización — hoy siempre devuelve
 * `FALLBACK_CONFIG` (Fase 2 no porta `whatsapp_agent_config`, ver diseño §4).
 * Aislada en su propia función para que sustituirla por una consulta real a
 * una tabla futura no toque el loop de tool-use. */
export function getAgentConfig(_organizationId: string): WhatsAppLlmAgentConfig {
  return FALLBACK_CONFIG;
}

function buildSystemPrompt(config: WhatsAppLlmAgentConfig, branches: readonly BranchSummary[], customer: CustomerLookupResult, now: Date): string {
  const basePrompt = `Eres el asistente de WhatsApp de ${config.businessName}, con varias sucursales.
Tomas pedidos a domicilio por chat. Tono cálido, directo, mensajes cortos (esto es WhatsApp, no una carta), actúa natural — no leas listas completas de golpe, ve conversando.

SUCURSALES REALES (usa esto para decidir cuál está más cerca de la dirección del cliente — nunca inventes otra sucursal ni otro slug):
${branchesBlock(branches)}

REGLAS DE NEGOCIO:
- Formas de pago: tarjeta (pide la terminal al momento del pedido) o contra entrega. No proceses pagos ni pidas número de tarjeta por chat. Si el cliente comparte un número de tarjeta de todos modos, dile explícitamente que no lo necesitas y que no se guarda — nunca lo repitas, confirmes ni lo uses para nada.
- Tiempo de entrega estimado: ${config.deliveryTimeText}.
- Todos los pedidos incluyen sin costo salsa verde, salsa roja, limones y cebolla. No preguntes si desea estos cuatro: van por defecto, salvo que el cliente pida quitar alguno.
- Salsa habanero y crema de ajo también son complementos sin costo, pero SOLO se envían si el cliente los pide explícitamente. No llames a buscar_producto para ninguno de estos seis complementos y nunca los cobres.
- No inventes productos ni precios: usa siempre la herramienta buscar_producto para confirmar nombre/precio real antes de agregar algo al pedido.
- No vendas cantidades sueltas de un producto marcado "(orden de N)" — es un paquete fijo, no piezas individuales.
- Si buscar_producto devuelve una lista VACÍA para lo que pidió el cliente, significa que ese producto NO EXISTE en el menú de ninguna sucursal — nunca digas "no disponible en esta sucursal" ni nada que sugiera que existe en otro lado cuando la lista viene vacía: dilo tal cual ("no tenemos eso en el menú") y sugiere algo parecido que sí exista.
- Si el pedido incluye alcohol (cerveza, licor, cóctel): antes de agregarlo, pregunta directo si quien recibe es mayor de edad y espera un sí/no claro. Si la respuesta es evasiva o ambigua, vuelve a preguntar de forma directa — nunca sigas adelante sin una confirmación clara, y nunca digas que el producto no está disponible como pretexto para evitar la pregunta.
- No inventes horarios de apertura/cierre ni sucursales/branch_slugs que no estén en la lista de arriba.
- Si el mensaje NO es para hacer un pedido (queja, facturación, empleo, u otro motivo que no sea ordenar comida): sé honesto, di que este número es para pedidos, pide su nombre si no lo tienes, y llama a registrar_contacto con nombre, motivo y un resumen breve de lo que dijo. Usa exactamente el nombre que el cliente te dio en ESTE chat — nunca inventes o supongas un nombre que no te haya dado.
- Si crear_pedido devuelve un error para un producto que ya confirmaste con buscar_producto, no lo repitas como excusa fabricada sin haberlo vuelto a confirmar: llama a buscar_producto de nuevo para ese producto antes de reintentar crear_pedido.
- REGLA DURA: si en esta MISMA conversación ya llamaste a crear_pedido y te respondió con éxito, NUNCA vuelvas a llamarla otra vez. Solo repítele el resumen del pedido que ya se creó. Llamar crear_pedido dos veces crea un pedido real duplicado en cocina.

FLUJO DE LA CONVERSACIÓN (en este orden):
1. Saluda usando EXACTAMENTE el saludo de "SALUDO SEGÚN LA HORA ACTUAL" abajo (nunca uno fijo ni adivinado), preséntate como ${config.businessName} (sin mencionar sucursal todavía) y pregunta si quiere hacer un pedido. Este saludo por hora solo aplica al primer mensaje tuyo de la conversación. En cuanto el cliente te dé su nombre en este chat, no se lo vuelvas a pedir más adelante.
2. Dirección: si el CONTEXTO DEL CLIENTE trae una dirección guardada, recuérdasela y pregunta si el pedido es para ahí o para otro lugar. Si es cliente nuevo o no tiene dirección guardada, pídesela.
3. En cuanto tengas la dirección/colonia, llama a buscar_sucursal_cercana con esa colonia/zona para obtener la sucursal real más cercana por distancia calculada — NUNCA decidas tú "a ojo" cuál está más cerca. Si responde encontrada:false, pide otra referencia e inténtalo de nuevo — no adivines. Dile al cliente de qué sucursal va a salir su pedido y confirma que está bien.
4. Toma el pedido: ve agregando productos, confirmando cada uno con buscar_producto (pásale siempre el branch_slug de la sucursal ya confirmada). Revisa pack_size ANTES de confirmar cantidad: "individual" (pack_size 1) nunca es máximo una pieza. Si buscar_producto devuelve más de un producto parecido, no elijas tú solo — dile las opciones al cliente. Instrucciones especiales del cliente van en el parámetro notes de crear_pedido.
5. Antes de cerrar, pregunta si quiere agregar algo más.
6. Llama a cotizar_pedido con product_id Y product_name exactos devueltos por buscar_producto, además de requested_quantity. Solo si responde con éxito, di exactamente el resumen y total devueltos; nunca calcules tú. Luego pregunta cómo va a pagar: efectivo o tarjeta.
7. En cuanto tengas la forma de pago: llama a crear_pedido con los mismos product_id, product_name y requested_quantity usados en la cotización, el branch_slug confirmado, payment_method, complementos y notes si aplica. Este es el paso más importante: un pedido no existe hasta que la herramienta responde con éxito.
8. Si crear_pedido devuelve un error, explícaselo al cliente en una frase simple y corrige — no sigas adelante sin que haya quedado creado con éxito.
9. Solo hasta que el pedido ya quedó creado con éxito: confirma que ya se mandó a cocina y da el tiempo de espera aproximado.`;

  return [
    basePrompt,
    ORDER_QUANTITY_RULES,
    ORDER_IDENTITY_AND_COMPLEMENT_RULES,
    `TONO DE VOZ REQUERIDO: ${TONE_INSTRUCTIONS[config.toneStyle]}`,
    `SALUDO SEGÚN LA HORA ACTUAL (usa esto tal cual solo en tu primer mensaje de la conversación): "${saludoSegunHora(config.timezone, now)}"`,
    `CONTEXTO DEL CLIENTE (no lo repitas literal, úsalo para hablarle natural):\n${customerContextBlock(customer)}`,
  ].join("\n\n");
}

/** Bug real confirmado el 3-sep-2026: para tacos de bistec, refuerza el aviso
 * de "orden de 3" si el último mensaje del cliente los menciona y la
 * respuesta del modelo no lo menciona ya — puerto literal de
 * `enforceBistecPackNotice`. */
export function enforceBistecPackNotice(reply: string, messages: readonly LlmMessage[]): string {
  const latestUser = [...messages].reverse().find((m) => m.role === "user");
  const latestUserText = latestUser && latestUser.role === "user" ? latestUser.content : undefined;
  if (
    typeof latestUserText !== "string" ||
    !/(?:\btacos?\b.{0,30}\bbistec(?:es)?\b|\bbistec(?:es)?\b.{0,30}\btacos?\b)/i.test(latestUserText) ||
    /\b[oó]rdenes?\s+de\s+(?:3|tres)\b/i.test(reply)
  ) {
    return reply;
  }
  const notice = "Los tacos de bistec se venden únicamente en órdenes de 3; cada precio del menú corresponde a la orden completa.";
  return reply.trim() ? `${notice}\n\n${reply.trim()}` : notice;
}

export function providerFailureReply(orderId: string | null): string {
  return orderId
    ? "¡Listo! Tu pedido ya quedó registrado y se mandó a cocina."
    : "Ahorita tenemos un problema técnico, por favor intenta de nuevo en un momento.";
}

// ─────────────────────────────────────────────────────────────────────────
// TOOLS — mismas 5 funciones que el origen, formato reducido de
// `LlmToolDefinition` (el gateway/adaptador arma el envoltorio wire real).
// ─────────────────────────────────────────────────────────────────────────

export const TOOLS: readonly LlmToolDefinition[] = [
  {
    name: "buscar_sucursal_cercana",
    description:
      "Dado el nombre de una colonia/zona/referencia que dio el cliente, devuelve la sucursal real MÁS CERCANA calculada por distancia real (no adivines tú cuál está más cerca). Llámala en cuanto tengas la colonia o una referencia clara.",
    parameters: {
      type: "object",
      properties: { colonia: { type: "string", description: "La colonia, zona o referencia que dio el cliente, tal cual." } },
      required: ["colonia"],
    },
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
  },
  {
    name: "cotizar_pedido",
    description: "Valida cantidades/presentaciones y calcula el total exacto con precios reales. Debes llamarla antes de decir el total o preguntar la forma de pago.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string", description: "Sucursal ya confirmada con el cliente." },
        items: {
          type: "array",
          description: "Productos confirmados. requested_quantity es la cantidad de piezas/unidades que pidió el cliente, no el número de paquetes.",
          items: {
            type: "object",
            properties: {
              product_id: { type: "string" },
              product_name: { type: "string", description: "Nombre exacto devuelto por buscar_producto." },
              requested_quantity: { type: "integer" },
              tortilla: { type: "string", enum: ["maiz", "harina"] },
            },
            required: ["product_id", "product_name", "requested_quantity"],
          },
        },
        adult_confirmed: { type: "boolean", description: "true únicamente si el pedido incluye alcohol y el cliente confirmó mayoría de edad." },
      },
      required: ["branch_slug", "items"],
    },
  },
  {
    name: "crear_pedido",
    description: "Registra el pedido final en el sistema. Solo llamar cuando el cliente ya confirmó todo, incluyendo la sucursal.",
    parameters: {
      type: "object",
      properties: {
        branch_slug: { type: "string" },
        customer_name: { type: "string" },
        customer_address: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product_id: { type: "string" },
              product_name: { type: "string" },
              requested_quantity: { type: "integer" },
              tortilla: { type: "string", enum: ["maiz", "harina"] },
            },
            required: ["product_id", "product_name", "requested_quantity"],
          },
        },
        notes: { type: "string" },
        requested_complements: { type: "array", items: { type: "string", enum: ["salsa_habanero", "crema_ajo"] } },
        omit_default_complements: { type: "array", items: { type: "string", enum: ["salsa_verde", "salsa_roja", "limones", "cebolla"] } },
        payment_method: { type: "string", enum: ["efectivo", "tarjeta"] },
        adult_confirmed: { type: "boolean" },
      },
      required: ["branch_slug", "customer_name", "customer_address", "items", "payment_method"],
    },
  },
  {
    name: "registrar_contacto",
    description: "Registra nombre/motivo de un mensaje que NO es para hacer un pedido, para que alguien del restaurante le regrese la llamada. Nunca usar para pedidos normales.",
    parameters: {
      type: "object",
      properties: { customer_name: { type: "string" }, reason: { type: "string" }, message: { type: "string" } },
      required: ["customer_name", "reason"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Mapeo de entrada/salida de tools (camelCase de dominio <-> snake_case wire
// que el prompt/LLM espera, mismo shape que el origen).
// ─────────────────────────────────────────────────────────────────────────

interface RawItemInput {
  readonly product_id?: unknown;
  readonly product_name?: unknown;
  readonly requested_quantity?: unknown;
  readonly tortilla?: unknown;
}

function toRequestedItems(raw: unknown): RequestedOrderItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const item = (entry ?? {}) as RawItemInput;
    return {
      productId: typeof item.product_id === "string" ? item.product_id : undefined,
      productName: typeof item.product_name === "string" ? item.product_name : undefined,
      requestedQuantity: typeof item.requested_quantity === "number" ? item.requested_quantity : Number(item.requested_quantity) || 1,
      tortilla: item.tortilla === "maiz" || item.tortilla === "harina" ? (item.tortilla as TortillaChoice) : undefined,
    };
  });
}

function quoteToWire(quote: OrderQuote) {
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
  };
}

function orderToWire(order: Order) {
  return {
    id: order.id,
    branch: order.branch,
    total: order.total,
    status: order.status,
    payment_method: order.paymentMethod,
    items: order.items,
  };
}

/** Solo `crear_pedido` fallando cuenta como "fallo de herramienta" que
 * dispara el escalón caro en el siguiente turno (diseño §2.3) —
 * `buscar_producto` con lista vacía NO cuenta, es una respuesta normal ("no
 * tenemos eso"), no un error del modelo. Preservado literal. */
function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

interface ToolExecutionOutcome {
  readonly result: unknown;
  readonly orderId: string | null;
  readonly propertyId: string | null;
}

async function executeToolCall(
  repo: RestaurantesRepository,
  args: { readonly organizationId: string; readonly phone: string; readonly name: string; readonly input: Record<string, unknown> },
): Promise<ToolExecutionOutcome> {
  const { organizationId, phone, name, input } = args;
  try {
    switch (name) {
      case "buscar_sucursal_cercana": {
        const match = await findNearestBranch(repo, { organizationId, colonia: String(input.colonia ?? "") });
        const result = match.found
          ? { encontrada: true, branch_slug: match.branchSlug, branch_name: match.branchName, distancia_km: match.distanceKm, colonia_reconocida: match.recognizedZoneName }
          : { encontrada: false, mensaje: match.message };
        return { result, orderId: null, propertyId: null };
      }
      case "buscar_producto": {
        const branchSlug = String(input.branch_slug ?? "");
        const branch = await repo.findBranch(organizationId, { slug: branchSlug });
        if (!branch) return { result: { error: `Sucursal '${branchSlug}' no encontrada` }, orderId: null, propertyId: null };
        const productos = await searchProducts(repo, { propertyId: branch.propertyId, query: String(input.query ?? "") });
        const result = productos.map((p) => ({ id: p.id, name: p.name, price: p.price, pack_size: p.packSize, requires_adult_confirmation: p.requiresAdultConfirmation }));
        return { result, orderId: null, propertyId: null };
      }
      case "cotizar_pedido": {
        const quote = await quoteOrder(repo, {
          organizationId,
          branchSlug: String(input.branch_slug ?? ""),
          items: toRequestedItems(input.items),
          adultConfirmed: input.adult_confirmed === true,
        });
        return { result: { quote: quoteToWire(quote) }, orderId: null, propertyId: null };
      }
      case "crear_pedido": {
        const order = await createOrder(repo, {
          organizationId,
          branchSlug: String(input.branch_slug ?? ""),
          customerName: String(input.customer_name ?? ""),
          customerPhone: phone,
          customerAddress: typeof input.customer_address === "string" ? input.customer_address : undefined,
          items: toRequestedItems(input.items),
          source: "whatsapp",
          notes: typeof input.notes === "string" ? input.notes : undefined,
          paymentMethod: input.payment_method === "efectivo" || input.payment_method === "tarjeta" ? input.payment_method : undefined,
          adultConfirmed: input.adult_confirmed === true,
          requestedComplements: Array.isArray(input.requested_complements) ? (input.requested_complements as readonly RequestedComplement[]) : undefined,
          omitDefaultComplements: Array.isArray(input.omit_default_complements) ? (input.omit_default_complements as readonly DefaultComplement[]) : undefined,
        });
        return { result: { order: orderToWire(order) }, orderId: order.id, propertyId: order.propertyId };
      }
      case "registrar_contacto": {
        await registerCallbackRequest(repo, {
          organizationId,
          customerName: String(input.customer_name ?? ""),
          customerPhone: phone,
          reason: typeof input.reason === "string" ? input.reason : undefined,
          message: typeof input.message === "string" ? input.message : undefined,
          source: "whatsapp",
        });
        return { result: { ok: true }, orderId: null, propertyId: null };
      }
      default:
        return { result: { error: `Herramienta desconocida: ${name}` }, orderId: null, propertyId: null };
    }
  } catch (err) {
    return { result: { error: err instanceof OrderValidationError ? err.message : "Error interno al ejecutar la herramienta" }, orderId: null, propertyId: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// El loop de tool-use en sí.
// ─────────────────────────────────────────────────────────────────────────

export interface WhatsAppLlmAgentOptions {
  /** Rol registrado en `LlmGateway.registerLadder` para el modelo barato
   * default — ver diseño §2.3. */
  readonly defaultRole: string;
  /** Rol registrado para el modelo caro de escalada, usado en el turno
   * siguiente a un fallo real de `crear_pedido`. */
  readonly escalatedRole: string;
  /** Bound del loop de tool-use por turno — 4 en el origen. */
  readonly maxToolUseTurns?: number;
  /** Tope de tiempo de pared para todo el turno (todas las llamadas al
   * gateway + ejecución de tools) — 45s en el origen. */
  readonly turnBudgetMs?: number;
  /** Inyectable solo para tests deterministas del saludo por hora. */
  readonly now?: () => Date;
}

function toLlmHistory(messages: readonly ConversationMessage[]): LlmMessage[] {
  return messages.map((m) => (m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content }));
}

/**
 * Crea la implementación real de `WhatsAppTurnHandler` — reemplaza
 * `acknowledgeOnlyTurnHandler` (Fase 1) sin tocar `whatsapp/inbound.ts` ni la
 * ruta HTTP del webhook, exactamente como quedó diseñado en el seam de
 * turn-handler.ts.
 */
export function createLlmWhatsAppTurnHandler(repo: RestaurantesRepository, gateway: LlmGateway, options: WhatsAppLlmAgentOptions): WhatsAppTurnHandler {
  const maxToolUseTurns = options.maxToolUseTurns ?? 4;
  const turnBudgetMs = options.turnBudgetMs ?? 45_000;
  const now = options.now ?? (() => new Date());

  return {
    async handleInboundMessage({ organizationId, phone, messages, customer }) {
      const deadline = Date.now() + turnBudgetMs;
      const config = getAgentConfig(organizationId);
      const branches = await repo.listBranchesForOrganization(organizationId);
      const systemPrompt = buildSystemPrompt(config, branches, customer, now());

      const working: LlmMessage[] = toLlmHistory(messages);
      let orderId: string | null = null;
      let propertyId: string | null = null;
      let huboFalloDeHerramienta = false;
      const safeReply = (reply: string) => enforceBistecPackNotice(reply, working);

      for (let turn = 0; turn < maxToolUseTurns; turn++) {
        if (Date.now() >= deadline) {
          return { reply: safeReply(providerFailureReply(orderId)), orderId, propertyId };
        }
        const role = huboFalloDeHerramienta ? options.escalatedRole : options.defaultRole;

        let completion: { text: string; toolCalls?: LlmToolCall[] };
        try {
          completion = await gateway.complete({
            tenantId: organizationId,
            runId: randomUUID(),
            lane: "interactive",
            role,
            request: { system: systemPrompt, messages: working, tools: [...TOOLS], temperature: 0 },
          });
        } catch {
          // Escalera de proveedores agotada / presupuesto excedido / gate de
          // residencia bloqueado — nunca se propaga un 500 crudo al cliente
          // de WhatsApp; si ya hay un orderId real, se lo confirmamos con
          // éxito en vez de sonar a error (bug real corregido en el origen).
          return { reply: safeReply(providerFailureReply(orderId)), orderId, propertyId };
        }

        const toolCalls = completion.toolCalls ?? [];
        if (toolCalls.length === 0) {
          const reply = safeReply(completion.text || "¿Me puedes repetir tu pedido?");
          return { reply, orderId, propertyId };
        }

        working.push({ role: "assistant", content: completion.text ?? "", toolCalls });

        for (const call of toolCalls) {
          let input: Record<string, unknown> = {};
          let result: unknown;
          try {
            input = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
          } catch {
            result = { error: "No entendí bien los datos, ¿puedes repetir el pedido?" };
          }
          if (result === undefined) {
            const executed = await executeToolCall(repo, { organizationId, phone, name: call.name, input });
            result = executed.result;
            if (executed.orderId) {
              orderId = executed.orderId;
              propertyId = executed.propertyId;
            }
          }
          if (call.name === "crear_pedido" && isToolErrorResult(result)) {
            huboFalloDeHerramienta = true;
          }
          working.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
        }
      }

      if (orderId) {
        return { reply: safeReply(providerFailureReply(orderId)), orderId, propertyId };
      }
      return { reply: "Se me complicó procesar tu pedido, un momento por favor.", orderId, propertyId };
    },
  };
}

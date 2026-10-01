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
import { vipNote } from "../customers.ts";
import { executeAgentToolSafely, toolDefinitionsForChannel } from "../agent-tools/registry.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import type { Branch, BranchSummary, CustomerLookupResult } from "../types.ts";
import { branchAlreadyKnown, classifyHighRiskIntent, enforcePendingQuestion, enforceQuotedTotal } from "./guards.ts";
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
- Para CADA renglón de tacos, pregunta por separado si lo quiere con tortilla de maíz, de harina o mixta, salvo que el cliente diga explícitamente "todos de maíz", "todos de harina" o "todos mixtos". Guarda la elección como tortilla: "maiz", "harina" o "mixta" en cada item. No cotices ni avances al pago mientras falte esta elección para cualquier taco.
- Si buscar_producto devuelve requires_adult_confirmation: true, pregunta directamente si quien recibirá el pedido es mayor de edad y espera un sí claro. Solo entonces manda adult_confirmed: true tanto a cotizar_pedido como a crear_pedido. Nunca lo infieras por el tono, el nombre, la voz o una respuesta ambigua.
- Nunca cierres un turno diciendo solo "voy a revisar" o "déjame buscar". Ejecuta la herramienta necesaria en ese mismo turno y después responde con el resultado, o termina con una pregunta concreta que el cliente sí deba contestar.
- Está prohibido preguntar efectivo/tarjeta antes de que cotizar_pedido responda con éxito. Flujo obligatorio: (1) cotizar_pedido; (2) repite al cliente los renglones y el total exactos y pregúntale la forma de pago y si confirma; (3) cuando el cliente responda en su SIGUIENTE mensaje con su confirmación (sí) y la forma de pago, llama confirmar_resumen (con el quote_hash de la cotización) y después crear_pedido con los mismos productos cotizados. El sistema rechaza crear_pedido si no hubo cotización vigente y confirmar_resumen antes, o si los productos cambiaron: si el cliente cambia algo, vuelve a cotizar y a pedir confirmación. Nunca llames confirmar_resumen en el mismo turno en que cotizaste.
- Conserva en requested_quantity la cantidad de piezas/unidades que dijo y confirmó el cliente. Nunca conviertas tú las piezas a órdenes: cotizar_pedido y crear_pedido hacen esa conversión de forma determinista.
- Antes de decir cualquier total o preguntar la forma de pago, llama siempre a cotizar_pedido. Repite exactamente el total y los renglones devueltos; nunca hagas aritmética mental ni recalcules el resultado.`;

/** Trato y transparencia que fija el dueno (P26/P37): siempre de usted, y el cliente debe saber que habla con un asistente virtual. */
export const TRATO_Y_TRANSPARENCIA_RULES = `REGLAS DURAS DE TRATO:
- Trata SIEMPRE al cliente de usted ("¿qué le gustaría pedir?", "su pedido"); nunca lo tutees, aunque él te tutee.
- Eres un asistente virtual y debes decirlo en tu primer mensaje. Nunca finjas ser una persona.
- Quejas, cancelaciones o cambios de un pedido ya confirmado, cobros, alergias, pagos por transferencia y cualquier petición de hablar con una persona los resuelve el equipo del restaurante: llama a escalar_a_humano con el motivo que corresponda y no prometas reposiciones, descuentos ni cancelaciones.`;

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
  deliveryTimeText: "40 a 50 minutos (un poco más en horas pico: sábado y domingo de 1 a 4 pm y de 6 a 10 pm)",
};

/** Seam de lectura de configuración por organización — hoy siempre devuelve
 * `FALLBACK_CONFIG` (Fase 2 no porta `whatsapp_agent_config`, ver diseño §4).
 * Aislada en su propia función para que sustituirla por una consulta real a
 * una tabla futura no toque el loop de tool-use. */
export function getAgentConfig(_organizationId: string): WhatsAppLlmAgentConfig {
  return FALLBACK_CONFIG;
}

function buildSystemPrompt(config: WhatsAppLlmAgentConfig, branches: readonly BranchSummary[], customer: CustomerLookupResult, now: Date, entryBranch: Branch | null = null): string {
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
1. Saluda usando EXACTAMENTE el saludo de "SALUDO SEGÚN LA HORA ACTUAL" abajo (nunca uno fijo ni adivinado), preséntate como el asistente virtual de ${config.businessName} (sin mencionar sucursal todavía) y pregunta si quiere hacer un pedido. Este saludo por hora solo aplica al primer mensaje tuyo de la conversación. En cuanto el cliente te dé su nombre en este chat, no se lo vuelvas a pedir más adelante.
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
    TRATO_Y_TRANSPARENCIA_RULES,
    ...(entryBranch ? [branchChannelRules(entryBranch)] : []),
    `TONO DE VOZ REQUERIDO: ${TONE_INSTRUCTIONS[config.toneStyle]}`,
    `SALUDO SEGÚN LA HORA ACTUAL (usa esto tal cual solo en tu primer mensaje de la conversación): "${saludoSegunHora(config.timezone, now)}"`,
    `CONTEXTO DEL CLIENTE (no lo repitas literal, úsalo para hablarle natural):\n${customerContextBlock(customer)}`,
  ].join("\n\n");
}

/** Modelo PM (un WhatsApp por sucursal): solo se agrega cuando el mensaje entro por el numero
 * de una sucursal, asi que el prompt de los demas restaurantes no cambia. Las reglas duras
 * (minimo, horario, no_domicilio, zona, propina) las aplican las herramientas, no el modelo. */
export function branchChannelRules(branch: Pick<Branch, "name" | "slug">): string {
  return `SUCURSAL DE ESTE CHAT: el cliente escribió al WhatsApp de la sucursal "${branch.name}" (branch_slug: "${branch.slug}"). Úsala como sucursal del pedido por defecto: no le pidas elegir sucursal ni llames a buscar_sucursal_cercana, salvo que pida otra sucursal o que una herramienta diga que su dirección está fuera de la zona de reparto de esta sucursal.
CANAL: pregunta desde el inicio si el pedido es "a domicilio" o "para recoger en sucursal" y manda canal ("domicilio" o "recoger") en cotizar_pedido y en crear_pedido. Para recoger no pidas dirección. A domicilio pide dirección completa con referencias y manda colonia_entrega (la colonia o zona que dio el cliente).
REGLAS QUE APLICAN LAS HERRAMIENTAS (no las decidas ni las recalcules tú): pedido mínimo por canal, horario de la sucursal, productos que no se venden a domicilio y zona de reparto. Si cotizar_pedido o crear_pedido responden con un error por alguno de estos motivos, explícaselo al cliente con tus palabras y ofrece la alternativa del mensaje (agregar productos, pasar a recoger, dar otra referencia). Nunca registres un pedido que la herramienta rechazó.
PROPINA: cotizar_pedido devuelve propina_politica y preguntar_propina. Si la política es "solo_tarjeta", pregunta por la propina únicamente cuando el cliente paga con tarjeta (llama cotizar_pedido otra vez con payment_method para confirmar que corresponde) y mándala en pesos en propina de crear_pedido. Nunca preguntes propina si paga en efectivo.`;
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
    ? "¡Listo! Su pedido ya quedó registrado y se mandó a cocina."
    : "Ahorita tenemos un problema técnico, por favor inténtelo de nuevo en un momento.";
}

// ─────────────────────────────────────────────────────────────────────────
// TOOLS — ya NO se definen aquí: vienen del registro único compartido con voz
// (`agent-tools/registry.ts`). Este módulo solo traduce al formato del gateway.
// ─────────────────────────────────────────────────────────────────────────

export const TOOLS: readonly LlmToolDefinition[] = toolDefinitionsForChannel("whatsapp").map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters as unknown as LlmToolDefinition["parameters"],
}));

/** Solo `crear_pedido` fallando cuenta como "fallo de herramienta" que
 * dispara el escalón caro en el siguiente turno (diseño §2.3) —
 * `buscar_producto` con lista vacía NO cuenta, es una respuesta normal ("no
 * tenemos eso"), no un error del modelo. Preservado literal. */
function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
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
    async handleInboundMessage({ organizationId, phone, messages, customer, propertyId: entryPropertyId }) {
      const deadline = Date.now() + turnBudgetMs;
      const config = getAgentConfig(organizationId);
      const branches = await repo.listBranchesForOrganization(organizationId);
      // Sucursal dueña del numero que recibio el mensaje (null = numero por defecto de la org).
      const entryBranch = entryPropertyId ? await repo.findBranchById(organizationId, entryPropertyId) : null;
      const activeEntryBranch = entryBranch && entryBranch.status === "active" ? entryBranch : null;
      const systemPrompt = buildSystemPrompt(config, branches, customer, now(), activeEntryBranch);

      const working: LlmMessage[] = toLlmHistory(messages);
      // Marcador del turno del cliente: el historial solo crece, asi que el numero de mensajes de
      // usuario identifica en que mensaje del cliente estamos (la maquina de estados del pedido
      // exige que la confirmacion llegue en un turno posterior a la cotizacion).
      const userTurn = String(messages.filter((m) => m.role === "user").length);
      let orderId: string | null = null;
      let propertyId: string | null = activeEntryBranch?.propertyId ?? null;
      let huboFalloDeHerramienta = false;
      let lastQuoteTotal: number | null = null;
      let anyToolCalled = false;
      // El total que lee el cliente es SIEMPRE el real (cotizar/crear), aunque el modelo escriba otra cifra.
      const safeReply = (reply: string) => enforceQuotedTotal(enforceBistecPackNotice(reply, working), lastQuoteTotal);

      // Motivos de alto riesgo (cancelacion, cobro, ARCO, alergia, transferencia, queja, "quiero una
      // persona"): no se dejan al criterio del modelo. Se avisa al equipo ANTES del LLM y se responde fijo.
      const latestUserMessage = [...messages].reverse().find((m) => m.role === "user");
      const riesgo = latestUserMessage ? classifyHighRiskIntent(latestUserMessage.content) : null;
      if (riesgo) {
        const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
        const aviso = await executeAgentToolSafely(
          repo,
          { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null },
          "escalar_a_humano",
          { customer_name: nombre, motivo: riesgo.motivo, resumen: latestUserMessage!.content.slice(0, 500) },
        );
        // Honestidad: solo se dice "ya avisé al equipo" si el aviso quedó registrado de verdad.
        if (isToolErrorResult(aviso.result)) {
          return { reply: "Lamento el inconveniente: no pude avisar al equipo en este momento. Por favor inténtelo de nuevo en unos minutos.", orderId: null, propertyId };
        }
        return { reply: riesgo.reply, orderId: null, propertyId };
      }

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
          const base = completion.text || "¿Me puede repetir su pedido?";
          // Un turno sin herramienta ni pregunta deja al cliente esperando: se anexa la pregunta del paso pendiente.
          const conPregunta = anyToolCalled
            ? base
            : enforcePendingQuestion(
                base,
                branchAlreadyKnown(
                  activeEntryBranch?.name ?? null,
                  messages.filter((m) => m.role === "assistant").map((m) => m.content),
                  branches,
                ),
                orderId,
              );
          return { reply: safeReply(conPregunta), orderId, propertyId };
        }

        working.push({ role: "assistant", content: completion.text ?? "", toolCalls });

        for (const call of toolCalls) {
          let input: Record<string, unknown> = {};
          let result: unknown;
          try {
            input = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
          } catch {
            result = { error: "No entendí bien los datos, ¿puede repetir el pedido?" };
          }
          if (result === undefined) {
            const executed = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone, flow: { key: `wa:${phone}`, turn: userTurn } }, call.name, input);
            result = executed.result;
            anyToolCalled = true;
            const quoted = (result as { quote?: { total?: unknown }; order?: { total?: unknown } } | null) ?? null;
            if (call.name === "cotizar_pedido" && typeof quoted?.quote?.total === "number") lastQuoteTotal = quoted.quote.total;
            if (call.name === "crear_pedido" && typeof quoted?.order?.total === "number") lastQuoteTotal = quoted.order.total;
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
      return { reply: "Se me complicó procesar su pedido, un momento por favor.", orderId, propertyId };
    },
  };
}

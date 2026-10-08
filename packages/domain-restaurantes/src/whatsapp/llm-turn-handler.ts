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
import { lineasCliente360 } from "../cliente-360/prompt.ts";
import { randomUUID } from "node:crypto";
import type { LlmGateway, LlmMessage, LlmToolCall, LlmToolDefinition } from "@atiende/agent-core";
import { vipNote } from "../customers.ts";
import { maskAddressForPrompt, sanitizeInlineText } from "../text-sanitize.ts";
import { subtipoQueja } from "../autopiloto/taxonomia.ts";
import { intentarCancelacionConAutopiloto, registrarQuejaConAutopiloto } from "./autopiloto-turno.ts";
import type { AutopilotoTurnoHooks } from "./autopiloto-turno.ts";
import { executeAgentToolSafely, toolDefinitionsForChannel } from "../agent-tools/registry.ts";
import { CONTADOR_AGENTE_UMBRAL, COPY_ESCALACION_CONTADOR, contarAgente, pideRepetir } from "./contadores-agente.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import type { PedidoParaComanda, ResultadoEncolarPedido } from "../softrestaurant/outbox-service.ts";
import { MOTIVOS_ESCALACION_DESACTIVABLES } from "../types.ts";
import type { Branch, BranchSummary, CanalPedido, CustomerLookupResult, Order, PerfilAgenteWhatsApp, WhatsAppAgentConfigInput } from "../types.ts";
import { FUNCION_MAX_MS, MARGEN_CIERRE_TURNO_MS, mensajesSinResponder } from "./inbound.ts";
import { latestDeliveryPin, latestSharedLocation } from "./location.ts";
import { afirmaHaberAvisado, branchAlreadyKnown, classifyHighRiskIntentInMessages, contextoDeCliente, enforcePendingQuestion, enforceQuotedTotal, knownAmountsOfQuote, quitarAfirmacionDeAviso, quitarCortesiaNoRespaldada } from "./guards.ts";
import { PM_AGENT_NAME_POR_OMISION, PM_COPY, buildPmSystemPrompt, saludoPorHora } from "./perfil-pm.ts";
import { bloqueConocimientoPrompt, listarConocimientoVigente } from "../conocimiento/dominio.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";
import { quitarMarcadoresDeToque, contenidoParaElModelo, pareceResumenParaConfirmar, respuestaDeToqueQueNoSigue, toqueDeMensaje, vigenciaDelToque } from "./botones-confirmacion.ts";
import { emitirSeguro, telefonoHashSeguro } from "./observabilidad-turno.ts";
import type { ObservabilidadTurno, ResultadoTool, ResultadoTurno } from "./observabilidad-turno.ts";

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

/** PM PR-9: identidad de asistente virtual y datos personales. El aviso de privacidad simplificado lo
 * antepone el sistema (determinista) en el primer mensaje; el modelo no lo improvisa ni lo repite. */
export const PRIVACY_AND_AI_RULES = `REGLAS DE PRIVACIDAD E IDENTIDAD:
- Eres un asistente virtual (una inteligencia artificial). Si el cliente pregunta si hablas con una persona o con un bot, dile con claridad que eres un asistente virtual; nunca digas ni insinúes que eres humano.
- El sistema ya antepone el aviso de privacidad en el primer mensaje: no lo repitas ni lo parafrasees por tu cuenta.
- Si el cliente quiere ejercer derechos sobre sus datos personales (acceso, rectificación, cancelación u oposición), dile que escriba "mis datos personales"; esas solicitudes las atiende el sistema, no tú. No prometas plazos ni borres nada por tu cuenta.
- Nunca repitas ni confirmes datos personales de otras personas; solo usa los que el cliente te da en este chat para su pedido.`;

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
- Todos los pedidos incluyen sin costo 9 salsas: roja, verde, mexicana, guacamolera, limones, crema de ajo, cebolla con cilantro, piña y habanero (soasado o picado con limón), salvo que el cliente pida quitar alguna. Si pide DOBLE porción de una, es un extra cobrado: mándalo en doble_salsas.
- Habanero y crema de ajo están entre las 9 salsas incluidas por defecto: no preguntes por ellas ni las cobres, y nunca las busques como producto. Si el cliente las pide expresamente puedes enviarlas en requested_complements (no agrega ningún cargo ni cambia lo incluido); envía las omisiones (verde, roja, limones, cebolla, etc.) en omit_default_complements.
- Un pedido no existe hasta que crear_pedido devuelve éxito. Si ya devolvió un order id, nunca vuelvas a crear el pedido ni respondas con un error genérico aunque falle el siguiente turno del proveedor.
- REGLA DURA: si en esta MISMA conversación ya llamaste a crear_pedido y te respondió con éxito, NUNCA vuelvas a llamarla otra vez — solo repítele el resumen del pedido ya creado. Llamarla dos veces crea un pedido real duplicado en cocina.`;

/** Bug real confirmado 4-sep-2026: el agente saludaba con "Buenas tardes"
 * fijo sin importar la hora real — se calcula server-side con la hora REAL
 * de la zona horaria del restaurante, nunca se le pide al modelo "adivinar"
 * la hora. */
export function saludoSegunHora(timezone: string, ahora: Date = new Date()): string {
  const hora = Number(new Intl.DateTimeFormat("es-MX", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(ahora));
  const saludo = saludoPorHora(hora);
  return `${saludo.charAt(0).toUpperCase()}${saludo.slice(1)}`;
}

export function customerContextBlock(customer: CustomerLookupResult): string {
  if (customer.isNew) {
    return "Cliente nuevo — nunca ha pedido antes por este número. Pide su nombre y su dirección de entrega; se guardan solos en su perfil al cerrar el pedido, no hace falta hacer nada extra.";
  }
  const lines: string[] = [];
  lines.push(`Cliente conocido${customer.name ? `: ${sanitizeInlineText(customer.name, 80)}` : " (sin nombre guardado todavía — pídeselo)"}.`);
  lines.push(`Ha pedido ${customer.orderCount} ${customer.orderCount === 1 ? "vez" : "veces"} antes.`);
  const nota = vipNote(customer.tier);
  if (nota) lines.push(nota);
  if (customer.addresses.length > 0) {
    const def = customer.addresses.find((a) => a.isDefault) ?? customer.addresses[0]!;
    lines.push(`Dirección guardada por defecto (solo referencia parcial, NUNCA la uses como customer_address): "${maskAddressForPrompt(def.address)}". Pregunta si el pedido es para esa zona o para otro lugar. Para crear_pedido necesitas la dirección completa: si el cliente confirma que es la misma, llama buscar_cliente y usa la dirección guardada completa que devuelve; si es otro lugar, pídesela completa.`);
    const others = customer.addresses.filter((a) => a !== def);
    if (others.length > 0) {
      lines.push(`También tiene otras direcciones guardadas: ${others.map((a) => `"${maskAddressForPrompt(a.address)}"`).join(", ")}.`);
    }
  } else {
    lines.push("No tiene dirección guardada todavía — pídesela.");
  }
  lines.push(...lineasCliente360(customer));
  if (customer.lastOrderItems && customer.lastOrderItems.length > 0) {
    const items = customer.lastOrderItems.map((i) => `${i.quantity}x ${sanitizeInlineText(i.name, 80)}`).join(", ");
    lines.push(`Su último pedido fue: ${items}.`);
  }
  if (customer.frequentItems.length > 0) {
    const items = customer.frequentItems.map((i) => sanitizeInlineText(i.name, 80)).join(", ");
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
  /** Ausente = `generico` (el agente de siempre). */
  readonly perfil?: PerfilAgenteWhatsApp;
  /** Como se presenta el agente (solo el perfil PM lo usa). */
  readonly agentName?: string;
  /** R-10 (solo perfil PM): saludo propio, salsas incluidas, promos para recoger y motivos de escalacion apagados. */
  readonly greetingText?: string;
  readonly salsasText?: string;
  readonly promosText?: string;
  readonly motivosDesactivados?: readonly string[];
  /** PM-C5 (solo perfil PM): umbral de pedido grande en texto corto y espera de rafagas en segundos (0/ausente = apagada). */
  readonly largeOrderText?: string;
  readonly replyDebounceSeconds?: number;
  /** Enlace de facturación en línea (https) del negocio; viene de la configuración del despliegue, no de la base. Sin valor el agente no lo inventa. */
  readonly invoiceUrl?: string;
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

/** Valores por omision del perfil de Los Taquitos de PM. El tiempo de entrega es un TEXTO configurable por
 * organizacion/sucursal (no hay todavia una fuente de carga de cocina): sin "si llueve" ni minutos fijos de pico. */
export const PM_CONFIG_POR_OMISION: WhatsAppLlmAgentConfig = {
  businessName: "Los Taquitos de PM",
  toneStyle: "formal_directo",
  timezone: "America/Merida",
  deliveryTimeText: "a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)",
  perfil: "taqueria_pm",
  agentName: PM_AGENT_NAME_POR_OMISION,
};

/** Config del agente para ESTA organizacion y sucursal de entrada: fila de la sucursal, luego la de la
 * organizacion, y sin fila (o con la base sin migrar: el repositorio degrada con SAVEPOINT a `null`) el
 * agente generico de siempre. Una fila con perfil `generico` solo pisa los campos que traiga. */
export async function resolveAgentConfig(repo: RestaurantesRepository, organizationId: string, propertyId: string | null): Promise<WhatsAppLlmAgentConfig> {
  return aplicarFilaAConfig(await repo.findWhatsAppAgentConfig(organizationId, propertyId), organizationId);
}

/** Tope de la espera de rafagas. Muy por debajo del limite de la funcion del webhook (30 s en vercel.json): despues de esperar, la fase B todavia tiene que correr el turno del LLM (hasta 3). */
export const ESPERA_RAFAGAS_MAX_SEGUNDOS = 10;

/** Version pura de `resolveAgentConfig`: sirve tambien a la vista previa del editor (sin tocar la base). Los textos
 * editables pasan por `sanitizeInlineText` aunque la fila se haya escrito directo en la base. */
export function aplicarFilaAConfig(row: WhatsAppAgentConfigInput | null, organizationId = ""): WhatsAppLlmAgentConfig {
  if (!row) return getAgentConfig(organizationId);
  const base = row.perfil === "taqueria_pm" ? PM_CONFIG_POR_OMISION : FALLBACK_CONFIG;
  const texto = (v: string | null | undefined, max: number): string | undefined => {
    const limpio = v ? sanitizeInlineText(v, max) : "";
    return limpio.length > 0 ? limpio : undefined;
  };
  const saludo = texto(row.greetingText, 80);
  const salsas = texto(row.salsasText, 300);
  const promos = texto(row.promosText, 300);
  const umbral = texto(row.largeOrderText, 200);
  const espera = row.replyDebounceSeconds !== undefined && row.replyDebounceSeconds !== null && Number.isInteger(row.replyDebounceSeconds) && row.replyDebounceSeconds > 0 ? Math.min(row.replyDebounceSeconds, ESPERA_RAFAGAS_MAX_SEGUNDOS) : undefined;
  const apagados = (row.escalationReasonsOff ?? []).filter((m) => (MOTIVOS_ESCALACION_DESACTIVABLES as readonly string[]).includes(m));
  return {
    ...base,
    perfil: row.perfil,
    businessName: row.businessName ?? base.businessName,
    toneStyle: row.toneStyle ?? base.toneStyle,
    deliveryTimeText: row.deliveryTimeText ?? base.deliveryTimeText,
    ...(row.agentName ? { agentName: row.agentName } : {}),
    ...(saludo ? { greetingText: saludo } : {}),
    ...(salsas ? { salsasText: salsas } : {}),
    ...(promos ? { promosText: promos } : {}),
    ...(apagados.length > 0 ? { motivosDesactivados: apagados } : {}),
    // El perfil generico no usa estos dos campos (el editor los rechaza); una fila escrita directo en la base se ignora.
    ...(row.perfil === "taqueria_pm" && umbral ? { largeOrderText: umbral } : {}),
    ...(row.perfil === "taqueria_pm" && espera ? { replyDebounceSeconds: espera } : {}),
  };
}

function fechaHoraLocal(timezone: string, now: Date): { readonly fechaHora: string; readonly dia: string } {
  const fechaHora = new Intl.DateTimeFormat("es-MX", { timeZone: timezone, dateStyle: "long", timeStyle: "short", hourCycle: "h23" }).format(now);
  const dia = new Intl.DateTimeFormat("es-MX", { timeZone: timezone, weekday: "long" }).format(now);
  return { fechaHora, dia };
}

/** R-32: el cliente puede mandar notas de voz; el sistema las transcribe y las antepone con este marcador. Se agrega a TODOS los perfiles. */
export const NOTA_DE_VOZ_RULES = `NOTAS DE VOZ:
- Un mensaje que empieza con "[Nota de voz transcrita]" es la transcripción automática de un audio del cliente: trátalo como lo que el cliente dijo, pero puede traer errores de reconocimiento (cantidades, productos, nombres, direcciones, números). Antes de cotizar, repite lo que entendiste y pide corrección si algo es dudoso.
- Una nota de voz NO cambia ninguna regla: cotiza con cotizar_pedido, pide la confirmación y la forma de pago en un mensaje posterior y solo entonces confirma, igual que con texto. Nunca crees un pedido solo con lo dicho en un audio sin ese paso.
- Si el audio trae datos de pago (tarjeta, CVV), no los repitas ni los uses: dile que no los necesitas.`;

/** Bloque de conocimiento vigente para un turno (cadena vacia si no hay). La zona de la sucursal manda sobre la de la config. */
export async function bloqueConocimientoDelTurno(repo: RestaurantesRepository, organizationId: string, propertyId: string | null, zonaConfig: string, ahora: Date): Promise<string> {
  // Complemento NO esencial: un fallo al leerlo (la lectura ya corre en SAVEPOINT) nunca tumba el turno del cliente.
  try {
    const entradas = await repo.listarConocimientoPublicado(organizationId, propertyId);
    if (entradas.length === 0) return "";
    const zona = propertyId ? ((await repo.findBranchZonaHoraria(propertyId)).zonaHoraria ?? zonaConfig) : zonaConfig;
    return bloqueConocimientoPrompt(listarConocimientoVigente(entradas, { propertyId, ahora, zonaHoraria: zona }).entradas);
  } catch {
    return "";
  }
}

export function buildSystemPrompt(config: WhatsAppLlmAgentConfig, branches: readonly BranchSummary[], customer: CustomerLookupResult, now: Date, entryBranch: Branch | null = null, conocimientoBloque = ""): string {
  return `${buildSystemPromptBase(config, branches, customer, now, entryBranch, conocimientoBloque)}\n\n${NOTA_DE_VOZ_RULES}`;
}

function buildSystemPromptBase(config: WhatsAppLlmAgentConfig, branches: readonly BranchSummary[], customer: CustomerLookupResult, now: Date, entryBranch: Branch | null, conocimientoBloque: string): string {
  if (config.perfil === "taqueria_pm") {
    const { fechaHora, dia } = fechaHoraLocal(config.timezone, now);
    return buildPmSystemPrompt({
      businessName: config.businessName,
      agentName: config.agentName ?? PM_AGENT_NAME_POR_OMISION,
      deliveryTimeText: config.deliveryTimeText,
      saludo: saludoSegunHora(config.timezone, now),
      branches,
      entryBranch: entryBranch ? { name: entryBranch.name, slug: entryBranch.slug } : null,
      customer,
      fechaHoraLocal: fechaHora,
      diaSemana: dia,
      saludoPersonalizado: config.greetingText ?? null,
      salsasTexto: config.salsasText ?? null,
      promosTexto: config.promosText ?? null,
      motivosDesactivados: config.motivosDesactivados ?? [],
      pedidoGrandeTexto: config.largeOrderText ?? null,
      urlFacturacion: config.invoiceUrl ?? null,
      conocimientoBloque,
    });
  }
  const basePrompt = `Eres el asistente de WhatsApp de ${config.businessName}, con varias sucursales.
Tomas pedidos a domicilio por chat. Tono cálido, directo, mensajes cortos (esto es WhatsApp, no una carta), actúa natural — no leas listas completas de golpe, ve conversando.

SUCURSALES REALES (usa esto para decidir cuál está más cerca de la dirección del cliente — nunca inventes otra sucursal ni otro slug):
${branchesBlock(branches)}
${conocimientoBloque ? `\n${conocimientoBloque}\n` : ""}
REGLAS DE NEGOCIO:
- Formas de pago: tarjeta (pide la terminal al momento del pedido) o contra entrega. No proceses pagos ni pidas número de tarjeta por chat. Si el cliente comparte un número de tarjeta de todos modos, dile explícitamente que no lo necesitas y que no se guarda — nunca lo repitas, confirmes ni lo uses para nada.
- Tiempo de entrega estimado: ${config.deliveryTimeText}.
- Todos los pedidos incluyen sin costo 9 salsas: roja, verde, mexicana, guacamolera, limones, crema de ajo, cebolla con cilantro, piña y habanero (soasado o picado con limón). No preguntes por ellas: van por defecto, salvo que el cliente pida quitar alguna. Doble porción de una salsa es un extra cobrado: mándalo en doble_salsas.
- Ninguna de estas 9 salsas es un producto del catálogo: no llames a buscar_producto para ellas y nunca las cobres (solo la doble porción es extra, en doble_salsas). Si el cliente pide expresamente habanero o crema de ajo puedes enviarlas en requested_complements; ya van incluidas.
- No inventes productos ni precios: usa siempre la herramienta buscar_producto para confirmar nombre/precio real antes de agregar algo al pedido.
- No vendas cantidades sueltas de un producto marcado "(orden de N)" — es un paquete fijo, no piezas individuales.
- Si buscar_producto devuelve una lista VACÍA para lo que pidió el cliente, significa que ese producto NO EXISTE en el menú de ninguna sucursal — nunca digas "no disponible en esta sucursal" ni nada que sugiera que existe en otro lado cuando la lista viene vacía: dilo tal cual ("no tenemos eso en el menú") y sugiere algo parecido que sí exista.
- Si el pedido incluye alcohol (cerveza, licor, cóctel): antes de agregarlo, pregunta directo si quien recibe es mayor de edad y espera un sí/no claro. Si la respuesta es evasiva o ambigua, vuelve a preguntar de forma directa — nunca sigas adelante sin una confirmación clara, y nunca digas que el producto no está disponible como pretexto para evitar la pregunta.
- No inventes horarios de apertura/cierre ni sucursales/branch_slugs que no estén en la lista de arriba.
- Si el cliente comparte su ubicación (verás un mensaje "[Ubicación compartida por WhatsApp] lat=... lng=..."), úsala: llama buscar_sucursal_cercana (el sistema ya conoce esas coordenadas) en vez de pedirle la colonia. Esa ubicación solo sirve para asignar la sucursal más cercana; nunca la repitas como si fuera una dirección de entrega.
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
    PRIVACY_AND_AI_RULES,
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

/** Aviso al cliente cuando el asistente no puede responder y el equipo ya fue avisado (perfil generico). */
export const PROVEEDOR_CAIDO_REPLY_GENERICO = "Ahorita tenemos un problema técnico. Ya avisé al equipo del restaurante para que una persona lo contacte lo antes posible.";

export function providerFailureReply(orderId: string | null, perfil: PerfilAgenteWhatsApp = "generico"): string {
  if (perfil === "taqueria_pm") return orderId ? PM_COPY.pedidoRegistrado : PM_COPY.problemaTecnico;
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
  /** Tope de tiempo de pared para todo el turno (todas las llamadas al gateway + ejecución de tools). Por omisión
   * cabe con margen en la vida de la funcion del webhook (`FUNCION_MAX_MS` = 30 s de `maxDuration`): 45 s (el valor
   * del origen) dejaba que Vercel matara la funcion a mitad del turno y Meta reintentara el lote. Si el llamador
   * pasa `finTurnoMs` (el webhook lo hace), manda el menor de los dos. */
  readonly turnBudgetMs?: number;
  /** Inyectable solo para tests deterministas del saludo por hora. */
  readonly now?: () => Date;
  /** SoftRestaurant: encola la comanda del pedido recien creado por WhatsApp (mismo helper que voz y
   * web: `encolarComandaParaPedido`). Ausente = comportamiento anterior. La comanda va ANTES de cobrar
   * y el agente solo puede decir lo que devuelve esta funcion (nunca un folio inventado). */
  readonly encolarComanda?: (pedido: PedidoParaComanda) => Promise<ResultadoEncolarPedido>;
  /** Enlace de facturación en línea (https) para el perfil PM. Ausente = el agente dice que una persona se lo confirma. */
  readonly urlFacturacion?: string | null;
  /** Ajustes del agente de la organizacion (modelo elegido y temperatura efectiva). Ausente o `null` = el modelo y la temperatura de siempre. Nunca debe
   * lanzar: un fallo aqui no puede tumbar el turno (el llamador degrada a los valores de siempre). */
  readonly leerAjustes?: (organizationId: string) => Promise<{ readonly modelo: string | null; readonly temperatura: number } | null>;
  /** Autopiloto: cancelaciones gestionadas por el agente (detras de la bandera por organizacion) y quejas ligadas al pedido. Ausente = comportamiento anterior. */
  readonly autopiloto?: AutopilotoTurnoHooks;
  /** R-PM-15: sumidero de eventos estructurados por turno y por tool (sin texto del cliente ni telefono en
   * claro). Ausente = sin observabilidad; emitir nunca lanza ni retrasa el turno. */
  readonly observabilidad?: ObservabilidadTurno;
}

/** Encola la comanda del pedido recien creado. Nunca lanza: un fallo aqui no puede tumbar el turno ni
 * ocultarle al cliente un pedido que si quedo creado. Devuelve el bloque que ve el modelo (solo en modo
 * `activo`; con la bandera apagada o en sombra el resultado de `crear_pedido` queda identico). */
async function encolarComandaDelTurno(
  encolar: NonNullable<WhatsAppLlmAgentOptions["encolarComanda"]>,
  order: Order,
  input: Record<string, unknown>,
): Promise<{ readonly estado: string; readonly folio: string | null; readonly mensaje: string } | null> {
  try {
    const canal: CanalPedido | undefined = input.canal === "recoger" || input.canal === "domicilio" ? input.canal : undefined;
    const outcome = await encolar({
      order,
      tipo: canal,
      colonia: typeof input.colonia_entrega === "string" ? input.colonia_entrega : undefined,
      propina: typeof input.propina === "number" ? input.propina : undefined,
    });
    return outcome.modo === "activo" ? { estado: outcome.agente.estado, folio: outcome.agente.folio, mensaje: outcome.agente.mensaje } : null;
  } catch (err) {
    console.error("whatsapp: no se pudo encolar la comanda de SoftRestaurant (el pedido NO se ve afectado):", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Tope de lo que se le manda al modelo de una conversacion: la fila de WhatsApp es UNA por (organizacion, telefono) y solo crece, asi que un cliente
 * frecuente acumula semanas de chats. Sin tope cada turno manda TODO (costo y latencia sin limite; con suficiente historial revienta el contexto). */
export const HISTORIAL_MAX_MENSAJES = 40;
export const HISTORIAL_MAX_CARACTERES = 24_000;

/** Ventana de la conversacion que ve el modelo: los ultimos mensajes dentro de ambos topes, empezando siempre en un mensaje del cliente (un
 * "assistant" suelto al inicio confunde a los proveedores) y conservando SIEMPRE el ultimo mensaje del cliente. El resto del turno (marcador de
 * turno de la maquina del pedido, ubicacion compartida) sigue leyendo el historial completo. */
export function ventanaDeHistorial(messages: readonly ConversationMessage[]): readonly ConversationMessage[] {
  let inicio = messages.length;
  let caracteres = 0;
  while (inicio > 0 && messages.length - inicio < HISTORIAL_MAX_MENSAJES) {
    const siguiente = messages[inicio - 1]!;
    if (caracteres + siguiente.content.length > HISTORIAL_MAX_CARACTERES && inicio < messages.length) break;
    caracteres += siguiente.content.length;
    inicio -= 1;
  }
  while (inicio < messages.length - 1 && messages[inicio]!.role !== "user") inicio += 1;
  return inicio === 0 ? messages : messages.slice(inicio);
}

/** Historial para el modelo. Los toques a los botones del resumen se leen como nota (nunca se le muestra el id): «Cambiar algo» siempre; «Confirmar pedido»
 * solo se vuelve un «si» explicito despues de comprobar que el resumen sigue vigente (ver `confirmarVigente` y el turno). */
function toLlmHistory(messages: readonly ConversationMessage[]): LlmMessage[] {
  // La nota de «Cambiar algo» solo vale para el turno inmediato siguiente: los toques ya respondidos (antes de la ultima respuesta del agente) vuelven a ser su titulo.
  const pendientes = new Set<ConversationMessage>(mensajesSinResponder(messages));
  return ventanaDeHistorial(messages).map((m) =>
    m.role === "user"
      ? { role: "user" as const, content: pendientes.has(m) ? contenidoParaElModelo(m.content, { esElUltimo: false, confirmarVigente: false }) : quitarMarcadoresDeToque(m.content) }
      : { role: "assistant" as const, content: m.content },
  );
}

/** 30 s de funcion menos el margen de cierre menos ~6 s para la ultima llamada al LLM que arranque antes del tope. */
export const TURN_BUDGET_POR_OMISION_MS = FUNCION_MAX_MS - MARGEN_CIERRE_TURNO_MS - 6_000;

/**
 * Crea la implementación real de `WhatsAppTurnHandler` — reemplaza
 * `acknowledgeOnlyTurnHandler` (Fase 1) sin tocar `whatsapp/inbound.ts` ni la
 * ruta HTTP del webhook, exactamente como quedó diseñado en el seam de
 * turn-handler.ts.
 */
export function createLlmWhatsAppTurnHandler(repo: RestaurantesRepository, gateway: LlmGateway, options: WhatsAppLlmAgentOptions): WhatsAppTurnHandler {
  const turnBudgetMs = options.turnBudgetMs ?? TURN_BUDGET_POR_OMISION_MS;
  const now = options.now ?? (() => new Date());

  type Entrada = Parameters<WhatsAppTurnHandler["handleInboundMessage"]>[0];
  type Salida = Awaited<ReturnType<WhatsAppTurnHandler["handleInboundMessage"]>>;
  /** Registro mutable del turno que alimenta los eventos de observabilidad (solo clases y duraciones). */
  interface Telemetria {
    vueltas: number;
    rolesUsados: string[];
    tools: Array<{ tool: string; latenciaMs: number; resultado: ResultadoTool; vuelta: number }>;
    resultado: ResultadoTurno;
    motivoEscalacion: string | null;
    motivoEscaladaDeRol: "fallo_crear_pedido" | null;
  }

  async function ejecutarTurno(
    { organizationId, phone, messages, customer, propertyId: entryPropertyId, messageId, finTurnoMs, modo, previewCustomerId, configBorrador }: Entrada,
    tele: Telemetria,
  ): Promise<Salida> {
      // Una llamada al LLM que ARRANCA justo antes del tope todavia tarda lo suyo: el presupuesto por omision deja
      // `MARGEN_CIERRE_TURNO_MS` + una llamada lenta de holgura bajo los 30 s de la funcion.
      const deadline = Math.min(Date.now() + turnBudgetMs, finTurnoMs ?? Number.POSITIVE_INFINITY);
      // `modo` y `configBorrador` solo los fija la ruta de preview del panel (servidor); el modelo nunca los ve.
      const preview = modo === "preview";
      const configBase = preview && configBorrador ? aplicarFilaAConfig(configBorrador, organizationId) : await resolveAgentConfig(repo, organizationId, entryPropertyId ?? null);
      const config = options.urlFacturacion ? { ...configBase, invoiceUrl: options.urlFacturacion } : configBase;
      // Preview sin efectos: los contadores del agente viven en la conversacion real de la base, asi que en preview no se leen ni se escriben
      // (devuelven `null` = "no hay donde contar" y se usa la cuenta local del turno).
      const contar: typeof contarAgente = async (...a) => (preview ? null : contarAgente(...a));
      const modoCtx = preview ? { modo: "preview" as const, previewCustomerId: previewCustomerId ?? null } : {};
      // Modelo y temperatura que eligio la organizacion (ajustes del agente). Si falla la lectura, el turno sigue con los de siempre.
      const ajustes = options.leerAjustes ? await options.leerAjustes(organizationId).catch(() => null) : null;
      const perfil: PerfilAgenteWhatsApp = config.perfil ?? "generico";
      // El flujo de PM encadena mas llamadas por turno (cliente, zona, un producto por renglon, cotizar).
      const maxToolUseTurns = options.maxToolUseTurns ?? (perfil === "taqueria_pm" ? 8 : 4);
      const branches = await repo.listBranchesForOrganization(organizationId);
      // Sucursal dueña del numero que recibio el mensaje (null = numero por defecto de la org).
      const entryBranch = entryPropertyId ? await repo.findBranchById(organizationId, entryPropertyId) : null;
      const activeEntryBranch = entryBranch && entryBranch.status === "active" ? entryBranch : null;
      // Conocimiento del negocio (053): politicas, FAQ y avisos vigentes HOY segun la fecha local de la sucursal, antes de las reglas duras.
      // Base sin migrar o sin entradas = bloque vacio (el prompt es identico al de antes); la lectura corre en SAVEPOINT dentro del repositorio.
      const conocimientoBloque = await bloqueConocimientoDelTurno(repo, organizationId, activeEntryBranch?.propertyId ?? entryPropertyId ?? null, config.timezone, now());
      const systemPrompt = buildSystemPrompt(config, branches, customer, now(), activeEntryBranch, conocimientoBloque);

      const working: LlmMessage[] = toLlmHistory(messages);
      // Marcador del turno del cliente: el historial solo crece, asi que el numero de mensajes de
      // usuario identifica en que mensaje del cliente estamos (la maquina de estados del pedido
      // exige que la confirmacion llegue en un turno posterior a la cotizacion).
      // Ultima ubicacion que el cliente compartio con el clip de WhatsApp (ver whatsapp/location.ts).
      const sharedLocation = latestSharedLocation(messages);
      const ubicacionEntrega = latestDeliveryPin(ventanaDeHistorial(messages));
      const userTurn = String(messages.filter((m) => m.role === "user").length);
      let orderId: string | null = null;
      let propertyId: string | null = activeEntryBranch?.propertyId ?? null;
      let huboFalloDeHerramienta = false;
      let lastQuoteTotal: number | null = null;
      let lastQuoteAmounts: readonly number[] | undefined;
      /** Si la ultima cotizacion DE ESTE TURNO traia `promocion_aplicada` o una promocion sugerida con cortesias (null = no se cotizo en este turno: no se puede verificar). */
      let lastQuoteRespaldaCortesia: boolean | null = null;
      let anyToolCalled = false;
      // Preview: el pedido SIMULADO de `crear_pedido` (para la tarjeta del panel).
      let pedidoSimulado: unknown;
      // El total que lee el cliente es SIEMPRE el real (cotizar/crear), aunque el modelo escriba otra cifra.
      const safeReply = (reply: string) => enforceQuotedTotal(enforceBistecPackNotice(lastQuoteRespaldaCortesia === false ? quitarCortesiaNoRespaldada(reply) : reply, working), lastQuoteTotal, lastQuoteAmounts);
      // R-21: si el agente pidio un humano (`escalar_a_humano` sin error), el webhook abre la toma de handoff.
      let escalarMotivo: string | null = null;
      // §5: pin con el boton nativo de WhatsApp. Se pide una sola vez por pedido (contador `ubicacion_solicitada`, se reinicia al crear el pedido)
      // y solo si el cliente aun no compartio su ubicacion y el turno no termino en una escalacion.
      let pedirUbicacionEnTurno = false;
      // B03: el turno termino mostrando el resumen de un pedido por confirmar (el webhook lo manda con los botones «Confirmar pedido» / «Cambiar algo»).
      let pedirConfirmacionEnTurno: { readonly quoteHash: string; readonly quotedAtMs: number } | null = null;
      // Huella de la ultima cotizacion EXITOSA de este turno (cotizar_pedido / repetir_pedido).
      let cotizacionDelTurno: string | null = null;
      const done = <R extends { readonly reply: string }>(r: R): R & { readonly escalacion?: { readonly motivo: string }; readonly pedirUbicacion?: true; readonly pedirConfirmacion?: { readonly quoteHash: string; readonly quotedAtMs: number }; readonly pedidoSimulado?: unknown } => ({
        ...r,
        ...(escalarMotivo ? { escalacion: { motivo: escalarMotivo } } : {}),
        ...(pedidoSimulado !== undefined ? { pedidoSimulado } : {}),
        ...(pedirUbicacionEnTurno && !escalarMotivo ? { pedirUbicacion: true as const } : {}),
        ...(pedirConfirmacionEnTurno && !escalarMotivo ? { pedirConfirmacion: pedirConfirmacionEnTurno } : {}),
      });
      // Contadores deterministas (§3): "no entiendo" y "colonia no reconocida" seguidos. Cuenta el SERVIDOR entre turnos (migracion 047); sin donde
      // contar (base sin migrar) se cuenta solo dentro del turno. Al llegar al umbral escala por su cuenta con un texto fijo.
      let coloniaFallosEnTurno = 0;
      let noEntiendeEnTurno = 0;
      const escalarPorContador = async (motivo: "zona_no_reconocida" | "no_entiende", resumen: string) => {
        const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
        const aviso = await executeAgentToolSafely(
          repo,
          { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
          "escalar_a_humano",
          { customer_name: nombre, motivo, resumen },
        );
        if (isToolErrorResult(aviso.result)) {
          return done({ reply: "Lamento el inconveniente: no pude avisar al equipo en este momento. Por favor inténtelo de nuevo en unos minutos.", orderId, propertyId });
        }
        escalarMotivo = motivo;
        await contar(repo, organizationId, phone, motivo === "zona_no_reconocida" ? "colonia_no_reconocida" : "no_entiende", "reiniciar");
        return done({ reply: COPY_ESCALACION_CONTADOR[motivo], orderId, propertyId });
      };
      const noEntiendeActivo = perfil === "taqueria_pm" && !(config.motivosDesactivados ?? []).includes("no_entiende");

      // Motivos de alto riesgo (cancelacion, cobro, ARCO, alergia, transferencia, queja, "quiero una
      // persona"): no se dejan al criterio del modelo. Se avisa al equipo ANTES del LLM y se responde fijo.
      // En una rafaga (espera de mensajes) se revisan TODOS los mensajes del cliente sin responder, no solo el ultimo: el riesgo puede venir
      // en el primero ("me cobraron dos veces") seguido de un "hola??". Sin rafaga el unico pendiente es el mensaje nuevo (igual que antes).
      // Solo los ultimos 5: una cola larga sin respuesta (p. ej. mensajes de una toma humana ya devuelta) no revive escalaciones viejas.
      const pendientes = mensajesSinResponder(messages).slice(-5);
      const riesgo = classifyHighRiskIntentInMessages(pendientes.map((m) => m.content), contextoDeCliente(customer));
      if (riesgo) {
        const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
        // Autopiloto: con la bandera de la organizacion encendida, una cancelacion con pedido activo se resuelve con una solicitud de aprobacion (o la
        // cancelacion automatica que la sucursal haya permitido); si no aplica, `null` y todo sigue por el camino de siempre.
        if (riesgo.motivo === "cancelacion_modificacion" && options.autopiloto) {
          const resuelta = await intentarCancelacionConAutopiloto(repo, options.autopiloto, { organizationId, phone, ahora: now(), texto: riesgo.text });
          if (resuelta) return { reply: resuelta.reply, orderId: null, propertyId };
        }
        // El subtipo de la queja viaja en el resumen del aviso al equipo (lista cerrada).
        const subtipoDeQueja = riesgo.motivo === "queja" && options.autopiloto ? subtipoQueja(riesgo.text) : null;
        const aviso = await executeAgentToolSafely(
          repo,
          { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
          "escalar_a_humano",
          { customer_name: nombre, motivo: riesgo.motivo, resumen: `${subtipoDeQueja ? `[queja:${subtipoDeQueja}] ` : ""}${riesgo.text}`.slice(0, 500) },
        );
        // Honestidad: solo se dice "ya avisé al equipo" si el aviso quedó registrado de verdad.
        if (isToolErrorResult(aviso.result)) {
          tele.resultado = "error_sistema";
          return { reply: "Lamento el inconveniente: no pude avisar al equipo en este momento. Por favor inténtelo de nuevo en unos minutos.", orderId: null, propertyId };
        }
        // El aviso al equipo ya quedo registrado arriba; `escalacion` solo abre la toma de handoff (R-21),
        // igual que cuando el modelo llama a escalar_a_humano, sin duplicar el aviso.
        escalarMotivo = riesgo.motivo;
        // Autopiloto: la queja queda ligada al ultimo pedido del telefono (solicitud de compensacion, decide una persona); no cambia la respuesta.
        if (riesgo.motivo === "queja" && options.autopiloto) {
          await registrarQuejaConAutopiloto(repo, options.autopiloto, { organizationId, phone, texto: riesgo.text, ahora: now() });
        }
        tele.resultado = "escalado_alto_riesgo";
        tele.motivoEscalacion = riesgo.motivo;
        return done({ reply: riesgo.reply, orderId: null, propertyId });
      }

      // La cotizacion vigente vive en la maquina de estados del servidor (no en una variable del turno): un turno posterior
      // sin herramientas ("¿cuanto era?") sigue corrigiendo un total alucinado. Base sin migrar -> null: solo el turno que cotiza.
      const flowSnapshot = await repo.readOrderFlow(organizationId, `wa:${phone}`);
      const flowVigente = flowSnapshot?.context ?? null;
      if (flowVigente && typeof flowVigente.quotedTotal === "number" && Number.isFinite(flowVigente.quotedTotal)) {
        lastQuoteTotal = flowVigente.quotedTotal;
        lastQuoteAmounts = flowVigente.quotedAmounts;
      }

      // B03: toque a «Confirmar pedido». Es un «si» explicito, pero SOLO a la cotizacion vigente: el boton de un resumen viejo (el pedido cambio, vencio, ya se
      // creo o se esta creando) se responde aqui con texto fijo, sin modelo y sin crear nada. Si es vigente, el pedido se crea por el camino de siempre
      // (confirmar_resumen -> crear_pedido) y el servidor revalida precio, zona, horario y pedido grande.
      const ultimoDelCliente = pendientes.at(-1);
      const toqueUltimo = ultimoDelCliente ? toqueDeMensaje(ultimoDelCliente.content) : null;
      // Solo es un «si» a ese resumen si TODO lo pendiente son toques: con texto escrito junto (en una rafaga, antes o despues del toque: «mejor 5») el cliente pudo cambiar el
      // pedido, asi que no se inyecta la nota ni se responde con texto fijo; el modelo lee el texto y vuelve a cotizar.
      const soloToques = pendientes.length > 0 && pendientes.every((m) => toqueDeMensaje(m.content) !== null);
      if (ultimoDelCliente && soloToques && toqueUltimo?.accion === "confirmar") {
        const vigencia = vigenciaDelToque(flowSnapshot, toqueUltimo, options.now ? options.now().getTime() : Date.now());
        const fija = respuestaDeToqueQueNoSigue(vigencia);
        if (fija) return done({ reply: fija, orderId: null, propertyId });
        const ultimoEnHistorial = working.findLastIndex((m) => m.role === "user");
        if (ultimoEnHistorial >= 0) working[ultimoEnHistorial] = { role: "user", content: contenidoParaElModelo(ultimoDelCliente.content, { esElUltimo: true, confirmarVigente: true }) };
      }

      // Modo sin IA (interruptor de plataforma, tope de gasto agotado, proveedor caido o turno sin tiempo): si NO hay pedido creado, "problema
      // tecnico" a secas pierde el pedido sin que nadie del restaurante se entere. Se deja el aviso `falla_sistema` (con la sucursal de entrada)
      // y la toma de handoff para que una persona tome el pedido, como ya hace la voz. Solo se promete el aviso si quedo registrado de verdad.
      const fallaDelSistema = async (): Promise<{ readonly reply: string; readonly orderId: string | null; readonly propertyId: string | null; readonly escalacion?: { readonly motivo: string } }> => {
        if (orderId) return done({ reply: safeReply(providerFailureReply(orderId, perfil)), orderId, propertyId });
        const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
        const ultimo = [...messages].reverse().find((m) => m.role === "user");
        const aviso = await executeAgentToolSafely(
          repo,
          { organizationId, channel: "whatsapp", phone, entryPropertyId: activeEntryBranch?.propertyId ?? null, ...modoCtx },
          "escalar_a_humano",
          { customer_name: nombre, motivo: "falla_sistema", resumen: `El asistente no pudo responder (falla del sistema). Ultimo mensaje del cliente: ${(ultimo?.content ?? "").slice(0, 400)}` },
        );
        if (isToolErrorResult(aviso.result)) return done({ reply: providerFailureReply(null, perfil), orderId: null, propertyId });
        escalarMotivo = "falla_sistema";
        return done({ reply: perfil === "taqueria_pm" ? PM_COPY.sinAsistenteAvisoEquipo : PROVEEDOR_CAIDO_REPLY_GENERICO, orderId: null, propertyId });
      };

      for (let turn = 0; turn < maxToolUseTurns; turn++) {
        if (Date.now() >= deadline) {
          tele.resultado = "presupuesto_agotado";
          return fallaDelSistema();
        }
        const role = huboFalloDeHerramienta ? options.escalatedRole : options.defaultRole;
        if (huboFalloDeHerramienta) tele.motivoEscaladaDeRol = "fallo_crear_pedido";
        tele.vueltas += 1;
        if (!tele.rolesUsados.includes(role)) tele.rolesUsados.push(role);

        let completion: { text: string; toolCalls?: LlmToolCall[] };
        try {
          completion = await gateway.complete({
            tenantId: organizationId,
            runId: randomUUID(),
            lane: "interactive",
            role,
            // El modelo elegido solo aplica al rol por defecto: el reintento tras un fallo real de `crear_pedido` (rol escalado) sigue siendo el de la plataforma.
            ...(ajustes?.modelo && role === options.defaultRole ? { preferredModel: ajustes.modelo } : {}),
            request: { system: systemPrompt, messages: working, tools: [...TOOLS], temperature: ajustes && role === options.defaultRole ? ajustes.temperatura : 0 },
          });
        } catch {
          tele.resultado = "error_proveedor";
          // Escalera de proveedores agotada / presupuesto excedido / gate de
          // residencia bloqueado — nunca se propaga un 500 crudo al cliente
          // de WhatsApp; si ya hay un orderId real, se lo confirmamos con
          // éxito en vez de sonar a error (bug real corregido en el origen).
          return fallaDelSistema();
        }

        const toolCalls = completion.toolCalls ?? [];
        if (toolCalls.length === 0) {
          const base = completion.text || (perfil === "taqueria_pm" ? PM_COPY.repetirPedido : "¿Me puede repetir su pedido?");
          if (noEntiendeActivo) {
            // Solo el texto del modelo cuenta: el respaldo por respuesta vacia (PM_COPY.repetirPedido) no es un 'no entiendo' del agente.
            if (completion.text && pideRepetir(completion.text)) {
              const n = (await contar(repo, organizationId, phone, "no_entiende", "incrementar")) ?? (noEntiendeEnTurno += 1);
              if (n >= CONTADOR_AGENTE_UMBRAL) return escalarPorContador("no_entiende", `El agente no logró entender al cliente ${CONTADOR_AGENTE_UMBRAL} veces seguidas. Último mensaje: ${(mensajesSinResponder(messages).slice(-1)[0]?.content ?? "").slice(0, 300)}`);
            } else {
              await contar(repo, organizationId, phone, "no_entiende", "reiniciar");
            }
          }
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
          // Honestidad (QA-PM-R2-whatsapp-04): "ya avise al gerente" solo si el aviso existe. Sin llamada a escalar_a_humano/registrar_contacto en este turno
          // (ni una promesa anterior ya respaldada), el servidor deja el aviso de verdad; si no puede, quita la frase en vez de mentir.
          let respuesta = conPregunta;
          const promesaPrevia = [...messages].reverse().find((m) => m.role === "assistant");
          const avisoDelTurno = tele.tools.some((t) => (t.tool === "escalar_a_humano" || t.tool === "registrar_contacto") && t.resultado === "ok");
          if (afirmaHaberAvisado(respuesta) && !escalarMotivo && !avisoDelTurno && !(promesaPrevia && afirmaHaberAvisado(promesaPrevia.content))) {
            const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
            const ultimo = [...messages].reverse().find((m) => m.role === "user");
            const aviso = await executeAgentToolSafely(
              repo,
              { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
              "escalar_a_humano",
              { customer_name: nombre, motivo: "otro", resumen: `El asistente le dijo al cliente que avisaria al equipo; se deja el aviso para que alguien lo revise. Ultimo mensaje del cliente: ${(ultimo?.content ?? "").slice(0, 400)}` },
            );
            if (isToolErrorResult(aviso.result)) respuesta = quitarAfirmacionDeAviso(respuesta);
            else {
              escalarMotivo = "otro";
              tele.motivoEscalacion = "otro";
            }
          }
          const replyFinal = safeReply(respuesta);
          // B03: resumen por confirmar (cotizacion de ESTE turno, aun sin pedido): el webhook agrega los botones. Si no se puede comprobar la cotizacion vigente en el
          // servidor (base sin la maquina de estados) o no hay resumen con total, el cliente recibe el texto de siempre y contesta «si».
          if (perfil === "taqueria_pm" && !preview && !orderId && !escalarMotivo && cotizacionDelTurno && pareceResumenParaConfirmar(replyFinal)) {
            const vigente = await repo.readOrderFlow(organizationId, `wa:${phone}`);
            if (vigente?.state === "cotizado" && vigente.context?.quoteHash === cotizacionDelTurno) pedirConfirmacionEnTurno = { quoteHash: vigente.context.quoteHash, quotedAtMs: vigente.context.quotedAtMs };
          }
          return done({ reply: replyFinal, orderId, propertyId });
        }

        working.push({ role: "assistant", content: completion.text ?? "", toolCalls });

        for (const call of toolCalls) {
          let input: Record<string, unknown> = {};
          let result: unknown;
          let fallaSistema = false;
          let argumentosInvalidos = false;
          const toolInicio = Date.now();
          try {
            input = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
          } catch {
            result = { error: "No entendí bien los datos, ¿puede repetir el pedido?" };
            argumentosInvalidos = true;
          }
          if (result === undefined) {
            const executed = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone, flow: { key: `wa:${phone}`, turn: userTurn }, sharedLocation, ubicacionEntrega, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...(options.autopiloto?.pedidoGrande ? { pedidoGrande: options.autopiloto.pedidoGrande } : {}), ...modoCtx }, call.name, input);
            result = executed.result;
            fallaSistema = executed.fallaSistema === true;
            anyToolCalled = true;
            if ((call.name === "cotizar_pedido" || call.name === "repetir_pedido") && !isToolErrorResult(result) && executed.quoteHash) cotizacionDelTurno = executed.quoteHash;
            if (call.name === "cotizar_pedido" && !isToolErrorResult(result)) {
              const q = (result as { quote?: { promocion_aplicada?: unknown; promociones_sugeridas?: readonly unknown[] } } | null)?.quote;
              lastQuoteRespaldaCortesia = q?.promocion_aplicada != null || (q?.promociones_sugeridas?.length ?? 0) > 0;
            }
            const quoted = (result as { quote?: Parameters<typeof knownAmountsOfQuote>[0]; order?: { total?: unknown; items?: readonly { price?: unknown; quantity?: unknown }[] } } | null) ?? null;
            if (call.name === "cotizar_pedido" && typeof quoted?.quote?.total === "number") {
              lastQuoteTotal = quoted.quote.total;
              lastQuoteAmounts = knownAmountsOfQuote(quoted.quote);
            }
            if (call.name === "crear_pedido" && typeof quoted?.order?.total === "number") {
              lastQuoteTotal = quoted.order.total;
              lastQuoteAmounts = knownAmountsOfQuote({
                total: quoted.order.total,
                lines: (quoted.order.items ?? []).map((i) => ({ price: i.price, line_total: typeof i.price === "number" && typeof i.quantity === "number" ? Math.round(i.price * i.quantity * 100) / 100 : undefined })),
              });
            }
            if (executed.simulated && call.name === "crear_pedido" && !isToolErrorResult(result)) pedidoSimulado = executed.raw;
            if (executed.orderId) {
              orderId = executed.orderId;
              propertyId = executed.propertyId;
              if (call.name === "crear_pedido" && options.encolarComanda && executed.raw && !executed.pedidoRetenido) {
                const comanda = await encolarComandaDelTurno(options.encolarComanda, executed.raw as Order, input);
                if (comanda) result = { ...(result as object), comanda };
              }
            }
          }
          if (call.name === "escalar_a_humano" && !isToolErrorResult(result)) {
            escalarMotivo = typeof input.motivo === "string" ? input.motivo : "otro";
            tele.motivoEscalacion = escalarMotivo;
          }
          // Pedido grande retenido por el servidor: el aviso ya quedo registrado; solo se abre la toma de handoff (R-21). Si el pedido quedo `por_aprobar`
          // (autopiloto) NO se abre toma: ya esta en el sistema y la sucursal lo aprueba con un clic; el agente sigue atendiendo al cliente.
          if (call.name === "crear_pedido" && (result as { pedido_grande?: unknown; por_aprobar?: unknown } | null)?.pedido_grande === true && (result as { por_aprobar?: unknown }).por_aprobar !== true) escalarMotivo = "pedido_grande";
          tele.tools.push({ tool: call.name, latenciaMs: Date.now() - toolInicio, resultado: isToolErrorResult(result) ? (fallaSistema ? "error_sistema" : "error_regla") : "ok", vuelta: tele.vueltas });
          const esDomicilio = call.name === "buscar_sucursal_cercana" || (call.name === "cotizar_pedido" && input.canal === "domicilio");
          if (perfil === "taqueria_pm" && esDomicilio && !isToolErrorResult(result) && !sharedLocation && !pedirUbicacionEnTurno) {
            if ((await contar(repo, organizationId, phone, "ubicacion_solicitada", "incrementar")) === 1) pedirUbicacionEnTurno = true;
          }
          if (perfil === "taqueria_pm" && call.name === "crear_pedido" && !isToolErrorResult(result)) {
            await contar(repo, organizationId, phone, "ubicacion_solicitada", "reiniciar");
          }
          if (perfil === "taqueria_pm" && call.name === "buscar_sucursal_cercana" && !isToolErrorResult(result)) {
            const estado = (result as { estado?: unknown } | null)?.estado;
            if (estado === "no_reconocida") {
              const n = (await contar(repo, organizationId, phone, "colonia_no_reconocida", "incrementar")) ?? (coloniaFallosEnTurno += 1);
              if (n >= CONTADOR_AGENTE_UMBRAL) return escalarPorContador("zona_no_reconocida", `La colonia no se reconoció ${CONTADOR_AGENTE_UMBRAL} veces seguidas. Último mensaje: ${(mensajesSinResponder(messages).slice(-1)[0]?.content ?? "").slice(0, 300)}`);
            } else if (estado === "asignada" || estado === "fuera_de_zona") {
              await contar(repo, organizationId, phone, "colonia_no_reconocida", "reiniciar");
            }
          }
          // B04: la escalera sube al modelo caro solo ante un FALLO (error de sistema al crear el pedido, o argumentos que el modelo barato no supo armar). Un RECHAZO DE
          // REGLA (`OrderValidationError`: minimo a domicilio, zona, horario, cantidad, y los rechazos de la maquina de estados como un duplicado o un reintento
          // simultaneo) es el servidor haciendo su trabajo: la respuesta correcta es explicarlo, y pagar el modelo caro solo suma latencia y costo en el turno donde mas
          // se pierde el pedido.
          if (call.name === "crear_pedido" && isToolErrorResult(result) && (fallaSistema || argumentosInvalidos)) {
            huboFalloDeHerramienta = true;
          }
          working.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
        }
      }

      tele.resultado = "loop_agotado";
      if (orderId) {
        return done({ reply: safeReply(providerFailureReply(orderId, perfil)), orderId, propertyId });
      }
      // El loop agoto sus vueltas sin pedido: "un momento, por favor" dejaba al cliente esperando algo que nunca llegaba. Se avisa al equipo
      // (motivo no_puedo_resolver, que abre la toma de handoff) y solo se dice "ya avise" si el aviso quedo registrado; si no, una pregunta concreta.
      const ultimoCliente = [...messages].reverse().find((m) => m.role === "user");
      const aviso = await executeAgentToolSafely(
        repo,
        { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, ...modoCtx },
        "escalar_a_humano",
        { customer_name: !customer.isNew && customer.name ? customer.name : "Cliente", motivo: "no_puedo_resolver", resumen: `El agente agoto sus vueltas sin completar el pedido. Ultimo mensaje del cliente: ${ultimoCliente?.content.slice(0, 400) ?? ""}` },
      );
      if (isToolErrorResult(aviso.result)) {
        return done({ reply: perfil === "taqueria_pm" ? PM_COPY.turnoAgotadoSinAviso : "Se me complicó procesar su solicitud. ¿Me puede decir en una sola frase qué le gustaría pedir, por favor?", orderId, propertyId });
      }
      escalarMotivo = "no_puedo_resolver";
      return done({ reply: perfil === "taqueria_pm" ? PM_COPY.turnoAgotadoConAviso : "Se me complicó procesar su solicitud por este medio. Ya avisé al equipo para que lo contacte directamente.", orderId, propertyId });
  }

  return {
    async handleInboundMessage(entrada) {
      const inicio = Date.now();
      const correlationId = randomUUID();
      const tele: Telemetria = { vueltas: 0, rolesUsados: [], tools: [], resultado: "ok", motivoEscalacion: null, motivoEscaladaDeRol: null };
      let salida: Salida | null = null;
      try {
        salida = await ejecutarTurno(entrada, tele);
        return salida;
      } catch (err) {
        tele.resultado = "error_sistema";
        throw err;
      } finally {
        const obs = options.observabilidad;
        if (obs) {
          // Solo identificadores, clases y duraciones: ni el texto del cliente, ni la respuesta, ni argumentos de tools.
          const propertyId = salida?.propertyId ?? entrada.propertyId ?? null;
          const telefonoHash = telefonoHashSeguro(obs, entrada.phone);
          for (const t of tele.tools) {
            emitirSeguro(obs, { evento: "whatsapp_tool", correlationId, organizationId: entrada.organizationId, propertyId, tool: t.tool, vuelta: t.vuelta, latenciaMs: t.latenciaMs, resultado: t.resultado, telefonoHash });
          }
          emitirSeguro(obs, {
            evento: "whatsapp_turno",
            correlationId,
            organizationId: entrada.organizationId,
            propertyId,
            rolModelo: tele.rolesUsados.at(-1) ?? null,
            rolesUsados: tele.rolesUsados,
            vueltas: tele.vueltas,
            latenciaTotalMs: Date.now() - inicio,
            tools: tele.tools.map(({ tool, latenciaMs, resultado }) => ({ tool, latenciaMs, resultado })),
            resultado: tele.resultado,
            motivoEscalacion: tele.motivoEscalacion,
            motivoEscaladaDeRol: tele.motivoEscaladaDeRol,
            telefonoHash,
          });
        }
      }
    },
  };
}

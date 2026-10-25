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
import { MODELO_PREDETERMINADO_ID, idModeloDeListaCerrada, modeloAdmiteRespaldoPorTope, modeloAlternoParaTope } from "../ajustes-agente/modelos.ts";
import { avisoFallaSistemaReciente, marcarAvisoFallaSistema } from "./dedupe-falla-sistema.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import { descripcionSeguraDeError } from "../log-seguro.ts";
import type { LlmGateway, LlmMessage, LlmToolCall, LlmToolDefinition } from "@atiende/agent-core";
import { vipNote } from "../customers.ts";
import { maskAddressForPrompt, sanitizeInlineText } from "../text-sanitize.ts";
import { subtipoQueja } from "../autopiloto/taxonomia.ts";
import { intentarCancelacionConAutopiloto, registrarQuejaConAutopiloto } from "./autopiloto-turno.ts";
import type { AutopilotoTurnoHooks } from "./autopiloto-turno.ts";
import { asistentePidioConfirmarResumen, bloqueCotizacionVigente, QUOTE_TTL_MS, resumenMostradoEnHistorial } from "../agent-tools/order-flow.ts";
import { cierreMaquinaActiva, clasificarRespuestaCierre, componerRespuestaConResumen, estadoDeCierre } from "../agent-tools/cierre-maquina.ts";
import { MENSAJE_PEDIDO_GRANDE_PENDIENTE, executeAgentToolSafely, toolDefinitionsForChannel } from "../agent-tools/registry.ts";
import { planCierreDeterminista } from "../agent-tools/cierre-determinista.ts";
import { bloqueCantidadNoMultiplo, bloqueProductoNoManejado } from "../unidades-pm.ts";
import { bloquePedidoPendienteTrasFalla } from "./falla-pendiente.ts";
import { CONTADOR_AGENTE_UMBRAL, COPY_ESCALACION_CONTADOR, contarAgente, pideRepetir } from "./contadores-agente.ts";
import { bloqueDatosYaConsultados } from "./datos-ya-consultados.ts";
import { BLOQUE_CONTEXTO_PRECARGADO, intercambioPrecargado, precargarBusquedas, resultadoClientePrecargado } from "./contexto-precargado.ts";
import type { ConversationMessage, RestaurantesRepository } from "../repository.ts";
import type { PedidoParaComanda, ResultadoEncolarPedido } from "../softrestaurant/outbox-service.ts";
import { aperturaConExcepciones, estaAbiertoAhora, evaluarUltimoPedido, fraseUltimoPedido, horaLegible, tieneUltimoPedidoPorTipo } from "../horarios.ts";
import { evaluarDomicilioSucursal } from "../domicilio-sucursal.ts";
import { MOTIVOS_ESCALACION_DESACTIVABLES } from "../types.ts";
import type { Branch, BranchSummary, CanalPedido, CustomerLookupResult, Order, PerfilAgenteWhatsApp, WhatsAppAgentConfigInput } from "../types.ts";
import { FUNCION_MAX_MS, MARGEN_CIERRE_TURNO_MS, mensajesSinResponder } from "./inbound.ts";
import { latestDeliveryPin, latestSharedLocation } from "./location.ts";
import { PEDIDO_GRANDE_TOTAL_MXN, evaluarPedidoGrande, pesoTotalKg, resumenPedidoGrande } from "../pedido-grande.ts";
import { confirmacionDePedido } from "./confirmacion-pedido.ts";
import { normalizarFormatoWhatsApp } from "./formato-whatsapp.ts";
import { afirmaCambioRegistrado, normalizarParaClasificar, CAMBIO_AVISADO_SIN_REGISTRAR, CAMBIO_SIN_REGISTRAR_OFRECE_AVISO, corregirPromesaDeHorarioNocturno, porcentajePropinaDichoPorElCliente, afirmaHaberAvisado, afirmaSoloRegistroDePedido, branchAlreadyKnown, classifyHighRiskIntent, classifyHighRiskIntentInMessages, contextoDeCliente, esperaDetalleDeQueja, noEsDetalleDeQueja, QUEJA_DETALLE_RECIBIDO, QUEJA_PREGUNTA_DETALLE, quejaTraeDetalle, respuestaDeQuejaConDetalle, enforcePendingQuestion, enforceQuotedTotal, knownAmountsOfQuote, quitarAfirmacionDeAviso, quitarAfirmacionDePedidoRegistrado, quitarCortesiaNoRespaldada, quitarPromesaDeDinero, reemplazarFugaDePrompt, contieneFugaDePrompt, RESPUESTA_SIN_FUGA } from "./guards.ts";
import { COPY_LLAMADA_NO_RECIBIDA, COPY_LLAMADA_REPETIDA, COPY_SI_REPETIDO_SIN_REGISTRAR, MARCA_SI_SIN_REGISTRAR, esAvisoDeLlamada } from "./prompt-pm-paquete-c.ts";
import { PM_AGENT_NAME_POR_OMISION, PM_COPY, buildPmSystemPrompt, saludoPorHora } from "./perfil-pm.ts";
import { bloqueConocimientoPrompt, listarConocimientoVigente } from "../conocimiento/dominio.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";
import { RESPUESTA_TOQUE_RETENIDO, quitarMarcadoresDeToque, contenidoParaElModelo, pareceResumenParaConfirmar, respuestaDeToqueQueNoSigue, toqueDeMensaje, vigenciaDelToque } from "./botones-confirmacion.ts";
import { emitirSeguro, telefonoHashSeguro } from "./observabilidad-turno.ts";
import { clasificarCausaError, TopeLlamadaLlmError } from "./observabilidad-turno.ts";
import { completarConHedging, HedgeLlmFalloError, hedgeLlmDespuesMs, hedgeLlmRetrasoEfectivoMs } from "./llm-hedge.ts";
import type { PataHedgeInforme } from "./llm-hedge.ts";
import type { CausaErrorTurno, ObservabilidadTurno, ResultadoTool, ResultadoTurno } from "./observabilidad-turno.ts";

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

export function buildSystemPrompt(config: WhatsAppLlmAgentConfig, branches: readonly BranchSummary[], customer: CustomerLookupResult, now: Date, entryBranch: Branch | null = null, conocimientoBloque = "", estadoSucursalAhora = ""): string {
  return `${buildSystemPromptBase(config, branches, customer, now, entryBranch, conocimientoBloque, estadoSucursalAhora)}\n\n${NOTA_DE_VOZ_RULES}`;
}

/**
 * QA-PM-R3-whatsapp-06: fuera de horario "por minutos" (01:10 con cierre a la 01:00; 11:57 con apertura a las 12:00) el agente aceptaba una recogida o daba tiempos sin decir que la
 * sucursal esta cerrada ni cuando abre. El servidor calcula el estado con el horario de la sucursal del chat y lo pone en el prompt; el horario sigue viniendo SOLO de datos.
 * Complemento no esencial: una lectura que falla (o una sucursal sin horario) devuelve "" y el prompt queda como antes.
 */
export async function estadoSucursalParaPrompt(repo: RestaurantesRepository, branch: Branch | null, ahora: Date): Promise<string> {
  if (!branch) return "";
  try {
    return await repo.runWithRowSavepoint(async () => {
      const policy = await repo.findBranchPolicy(branch.propertyId);
      if (!policy.horario || policy.horario.length === 0) return "";
      const zona = (await repo.findBranchZonaHoraria(branch.propertyId)).zonaHoraria;
      const estado = estaAbiertoAhora(policy.horario, ahora, zona);
      if (estado.abierto) {
        const ultimo = evaluarUltimoPedido(policy.horario, ahora, zona);
        // Hora fija de ultimo pedido por tipo (domicilio / recoger): el agente da cierre y ultimo pedido del tipo que le interesa al cliente. Misma frase que consultar_sucursal.
        if (tieneUltimoPedidoPorTipo(ultimo)) {
          // Dia de NEGOCIO (no calendario): en la madrugada del turno de ayer rigen los diasDomicilio de ayer.
          const domicilioDisponible = evaluarDomicilioSucursal(policy, aperturaConExcepciones(policy.horario, [], ahora, zona).diaNegocio).acepta;
          const frase = fraseUltimoPedido(ultimo, horaLegible, { domicilioDisponible });
          const dom = domicilioDisponible ? ultimo.domicilio : null;
          const alguno = (dom?.aceptaPedidos ?? false) || ultimo.recoger.aceptaPedidos;
          if (!alguno) {
            return `${branch.name} sigue ABIERTA${estado.cierraA ? ` (cierra a las ${horaLegible(estado.cierraA)})` : ""}, pero YA PASARON LOS ÚLTIMOS PEDIDOS. ${frase ?? ""} Ya no se toman pedidos para hoy: dígalo en su primer mensaje y ofrezca programar para la siguiente apertura o pedir mañana; no prometa horarios fuera del horario.`;
          }
          const faltaDomicilio = dom !== null && !dom.aceptaPedidos;
          return (
            `${branch.name} está ABIERTA${estado.cierraA ? ` y cierra a las ${horaLegible(estado.cierraA)}` : ""}. ${frase ?? ""} ` +
            (faltaDomicilio
              ? `YA PASÓ el último pedido a domicilio: no tome domicilio ahora; ofrezca recoger en la sucursal (todavía se toma) o programar para el día siguiente. `
              : "") +
            `El último pedido manda sobre el momento de pedir, no sobre la hora de recogida: un pedido para recoger hecho antes de su último pedido se acepta aunque la hora de recogida sea posterior, siempre que no pase del cierre; después del cierre ofrezca una hora anterior o programar para la siguiente apertura. A "¿siguen abiertos?" responda con el cierre y el último pedido del tipo que le interesa.`
          );
        }
        if (!ultimo.aceptaPedidos) {
          return `${branch.name} sigue ABIERTA${estado.cierraA ? ` (cierra a las ${horaLegible(estado.cierraA)})` : ""}, pero YA PASÓ EL ÚLTIMO PEDIDO (${ultimo.margenMin} minutos antes del cierre${ultimo.ultimoPedidoA ? `, hasta las ${horaLegible(ultimo.ultimoPedidoA)}` : ""}): ya no se toman pedidos para hoy. Dígalo en su primer mensaje y ofrezca programar para la siguiente apertura o pedir mañana; no prometa horarios fuera del horario.`;
        }
        return `${branch.name} está ABIERTA${estado.cierraA ? ` y cierra a las ${horaLegible(estado.cierraA)}` : ""}${ultimo.ultimoPedidoA ? `; el último pedido se toma hasta las ${horaLegible(ultimo.ultimoPedidoA)}` : ""}. Un pedido para recoger cuya hora caiga después del último pedido no se puede tomar.`;
      }
      const abre = estado.proximaApertura ? `; abre ${estado.proximaApertura.hoy ? "hoy" : `el ${estado.proximaApertura.dia}`} a las ${horaLegible(estado.proximaApertura.hora)}` : "";
      return `${branch.name} está CERRADA ahora${abre}. Diga en su primer mensaje que está cerrada y cuándo abre; tome el pedido y PROGRÁMELO con programado_para para la apertura u otra hora dentro del horario (H16), sin decir que ya está en cocina.`;
    });
  } catch {
    return "";
  }
}

function buildSystemPromptBase(config: WhatsAppLlmAgentConfig, branches: readonly BranchSummary[], customer: CustomerLookupResult, now: Date, entryBranch: Branch | null, conocimientoBloque: string, estadoSucursalAhora: string): string {
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
      ...(estadoSucursalAhora ? { estadoSucursalAhora } : {}),
      saludoPersonalizado: config.greetingText ?? null,
      salsasTexto: config.salsasText ?? null,
      promosTexto: config.promosText ?? null,
      motivosDesactivados: config.motivosDesactivados ?? [],
      pedidoGrandeTexto: config.largeOrderText ?? null,
      urlFacturacion: config.invoiceUrl ?? null,
      conocimientoBloque,
      ...(prefijoEstableActivo() ? { prefijoEstable: true } : {}),
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
    /(?<![\p{L}\p{N}_])[oó]rdenes?\s+de\s+(?:3|tres)(?![\p{L}\p{N}_])/iu.test(reply)
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
  /** Base https publica de los PDF del menu por sucursal (`PM_MENU_PDF_BASE_URL`). Ausente = `enviar_menu` comparte el enlace de la pagina oficial del menu. */
  readonly menuPdfBaseUrl?: string | null;
  /** Ajustes del agente de la organizacion (modelo elegido y temperatura efectiva). Ausente o `null` = el modelo y la temperatura de siempre. Nunca debe
   * lanzar: un fallo aqui no puede tumbar el turno (el llamador degrada a los valores de siempre). */
  readonly leerAjustes?: (organizationId: string) => Promise<{ readonly modelo: string | null; readonly temperatura: number } | null>;
  /** Autopiloto: cancelaciones gestionadas por el agente (detras de la bandera por organizacion) y quejas ligadas al pedido. Ausente = comportamiento anterior. */
  readonly autopiloto?: AutopilotoTurnoHooks;
  /** R-PM-15: sumidero de eventos estructurados por turno y por tool (sin texto del cliente ni telefono en
   * claro). Ausente = sin observabilidad; emitir nunca lanza ni retrasa el turno. */
  readonly observabilidad?: ObservabilidadTurno;
  /** R11 Arquitectura A: contexto precargado + llamadas en lote (ver `contexto-precargado.ts`). Solo perfil PM y nunca en la vista previa del panel. Ausente o `false` = el turno
   * se comporta EXACTAMENTE como antes. Produccion lo enciende con la variable de entorno `WHATSAPP_CONTEXTO_PRECARGADO=1`. */
  readonly contextoPrecargado?: boolean;
}

/** Encola la comanda del pedido recien creado. Nunca lanza: un fallo aqui no puede tumbar el turno ni
 * ocultarle al cliente un pedido que si quedo creado. Devuelve el bloque que ve el modelo (solo en modo
 * `activo`; con la bandera apagada o en sombra el resultado de `crear_pedido` queda identico). */
export async function encolarComandaDelTurno(
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
    console.error("whatsapp: no se pudo encolar la comanda de SoftRestaurant (el pedido NO se ve afectado):", descripcionSeguraDeError(err));
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
/** R11-05a: tope de herramientas que se EJECUTAN por respuesta del modelo (las demas reciben un resultado de error para mantener el protocolo). */
export const MAX_HERRAMIENTAS_POR_RESPUESTA = 8;
/** R11-10: piso del tope de tiempo de una llamada al proveedor, para que una llamada legitima y rapida no se corte por un presupuesto casi agotado. */
export const PISO_TOPE_LLAMADA_LLM_MS = 500;
/**
 * PM-R19: respaldo de PROVEEDOR cuando la llamada al modelo agota su tope de tiempo. El tope por llamada era TODO el presupuesto restante del turno
 * (`completarConTope(deadline)`): al vencer no quedaba tiempo para nada y el cliente recibia "problema tecnico" (`tope_llamada` fue el 100 % de los errores de
 * proveedor de las rondas 15-18; con error el acierto es ~15 %, sin error ~71 %). El intento #610 (repetir la MISMA llamada al MISMO modelo) se revirtio porque solo
 * salvaba el 14 % de los turnos: un modelo atascado sigue atascado. Aqui el reintento va a OTRO modelo de la escalera ya aprobada (`modeloAlternoParaTope`).
 * Con al menos `RESPALDO_LLM_RESTANTE_MIN_MS` de presupuesto, el primer intento se corta antes (nunca antes de `RESPALDO_LLM_PRIMER_TOPE_MIN_MS`, dejando
 * `RESPALDO_LLM_RESERVA_MS` al respaldo, ~p95 de una llamada normal) y se repite la misma peticion contra el modelo alterno (PM-R19b: tambien en vueltas posteriores con 10 a 16 s restantes; sigue siendo UN respaldo por turno). El reloj del turno (18 s) no cambia.
 */
export const RESPALDO_LLM_RESTANTE_MIN_MS = 16_000;
export const RESPALDO_LLM_PRIMER_TOPE_MIN_MS = 9_000;
export const RESPALDO_LLM_RESERVA_MS = 7_000;
/**
 * PM-R19b: la ronda 19 mostro que los 93 `tope_llamada` SIN respaldo cayeron todos en la 2.a vuelta o despues (ninguno en la 1.a): tras una o mas llamadas previas
 * (~3.5 s cada una) quedan < 16 s y el respaldo de arriba no actuaba. Con 10 a 16 s restantes se activa un plan TARDIO: primer intento hasta `max(6 s, restante - 6 s)`
 * (6 s ~ p95 de una llamada normal, 5.8 s medido) dejando al respaldo al menos 4 s (mediana de una llamada, 3.4 s). Con < 10 s ya no hay tiempo util para un respaldo.
 */
export const RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS = 10_000;
export const RESPALDO_LLM_PRIMER_TOPE_MIN_TARDIO_MS = 6_000;
export const RESPALDO_LLM_RESERVA_TARDIA_MS = 6_000;

/** Reparte el presupuesto restante del turno entre el primer intento y el respaldo. Sin presupuesto suficiente: un solo intento con todo lo que queda. */
export function planTopeLlamadaLlm(restanteMs: number): { readonly primerTopeMs: number; readonly respalda: boolean } {
  if (restanteMs < RESPALDO_LLM_RESTANTE_MIN_TARDIO_MS) return { primerTopeMs: Math.max(0, restanteMs), respalda: false };
  if (restanteMs < RESPALDO_LLM_RESTANTE_MIN_MS) return { primerTopeMs: Math.max(RESPALDO_LLM_PRIMER_TOPE_MIN_TARDIO_MS, restanteMs - RESPALDO_LLM_RESERVA_TARDIA_MS), respalda: true };
  return { primerTopeMs: Math.max(RESPALDO_LLM_PRIMER_TOPE_MIN_MS, restanteMs - RESPALDO_LLM_RESERVA_MS), respalda: true };
}
/** PM-R14: rechazos de regla de `crear_pedido` seguidos en un turno tras los cuales se corta el bucle del modelo. */
export const MAX_RECHAZOS_MISMO_CODIGO_AL_CREAR = 2;
/** PM-R14: llamadas REPETIDAS (misma herramienta y mismos argumentos) tras un `crear_pedido` rechazado por regla con las que se corta el bucle. */
export const MAX_LLAMADAS_REPETIDAS_TRAS_RECHAZO_AL_CREAR = 3;
/** R21: el texto del modelo tras un pedido que el servidor ya creo contradice la confirmacion del servidor (niega el registro, o trae un monto u hora que el servidor no tiene). */
export function textoContradiceConfirmacion(textoModelo: string, confirmacionServidor: string): boolean {
  if (/\bno\s+(?:pude|pudimos|alcanc[eé]|logr[eé]|se\s+pudo|fue\s+posible)(?![a-záéíóúñ])[^.!?\n]*(?:registr|cre|guard|proces)|\b(?:problema|error|falla)\s+(?:t[eé]cnic|al\s+registr)|\bsin\s+registrar\b|\bpendiente\s+de\s+registr/i.test(textoModelo)) return true;
  const montos = (t: string) => new Set([...t.matchAll(/\$\s?(\d+(?:[.,]\d+)?)/g)].map((m) => Number(m[1]!.replace(",", "."))));
  const horas = (t: string) => new Set([...t.matchAll(/\b(\d{1,2}):(\d{2})\b/g)].map((m) => `${Number(m[1])}:${m[2]}`));
  const mS = montos(confirmacionServidor);
  for (const m of montos(textoModelo)) if (!mS.has(m)) return true;
  const hS = horas(confirmacionServidor);
  for (const h of horas(textoModelo)) if (!hS.has(h)) return true;
  return false;
}
/** PM-R21: interruptor de entorno del prompt con prefijo estable (cache de prompt del proveedor). APAGADO por omision; encendido solo con `1`, `true`, `on` o `si`. */
export function prefijoEstableActivo(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env.WHATSAPP_PROMPT_PREFIJO_ESTABLE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "si";
}

/** R21: interruptor de entorno del cierre del «si» en una sola vuelta del modelo. Encendido salvo `0`, `false`, `off` o `no`. */
export function cierreUnaVueltaActivo(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env.WHATSAPP_CIERRE_UNA_VUELTA ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/** PM-R14: respaldo: llamadas siguientes (sin una cotizacion exitosa) tras un rechazo, aunque los argumentos cambien. El tope de vueltas del turno (8 en PM) sigue acotando el peor caso. */
export const MAX_LLAMADAS_TRAS_RECHAZO_AL_CREAR = 6;

/** Firma de una llamada: herramienta + argumentos normalizados (claves ordenadas, textos recortados y en minusculas). */
function firmaDeLlamada(nombre: string, input: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") return v.trim().toLowerCase();
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return `${nombre}:${JSON.stringify(norm(input))}`;
}
const CIERRE_BLOQUEADO_REPLY_GENERICO = "Todavía no queda registrado su pedido: necesito que revisemos un dato. ¿Me confirma de nuevo su pedido (productos, forma de pago y entrega) o me dice qué desea corregir?";
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
    tools: Array<{ tool: string; latenciaMs: number; resultado: ResultadoTool; vuelta: number; codigoRegla: string | null }>;
    resultado: ResultadoTurno;
    /** PM-R14: causa del error en la lista cerrada (null = el turno no termino en error). */
    causaError: CausaErrorTurno | null;
    /** PM-R14: la bandera de la maquina de cierre al ARRANCAR el turno. */
    cierreMaquina: boolean;
    /** PM-R14: el turno se corto por el bucle de crear_pedido rechazado (resultado `ok` con causaError `regla`). */
    cierreCortado: boolean;
    /** PM-R19: veces que la llamada al modelo se repitio contra el modelo alterno tras agotar su tope (0 o 1 por turno). */
    reintentosLlm: number;
    /** PM-R19: el respaldo contesto y el turno siguio con esa respuesta. */
    reintentoLlmRecuperado: boolean;
    /** PM-R19: id del modelo alterno usado (lista cerrada de modelos aprobados; nunca contenido); null si no hubo respaldo. */
    modeloRespaldoLlm: string | null;
    /** PM-R19: modelo que REALMENTE contesto la ultima llamada del turno (lista cerrada o "otro"); distingue respaldo real de caida de escalera. null si ninguna contesto. */
    modeloRespondioLlm: string | null;
    /** PM-R21: una entrada por llamada al modelo (ver `EventoTurnoWhatsApp.llamadasLlm`); acotada a 12. */
    llamadasLlm: Array<{ pata: "primario" | "alterno" | "respaldo_secuencial"; resultado: "ok" | "tope" | "error" | "cancelada"; ms: number; modelo: string; causa?: CausaErrorTurno }>;
    /** PM-R21: el hedging lanzo el alterno en paralelo en alguna vuelta del turno. */
    hedgeLlmLanzado: boolean;
    /** PM-R21: quien contesto la ULTIMA vuelta con hedging (null si no hubo). */
    hedgeLlmGanador: "primario" | "alterno" | null;
    motivoEscalacion: string | null;
    motivoEscaladaDeRol: "fallo_crear_pedido" | null;
    /** Solo con `contextoPrecargado` encendido: que llamadas hizo el servidor antes de la primera vuelta. */
    precargado: { cliente: boolean; productos: number } | null;
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
      const estadoSucursal = config.perfil === "taqueria_pm" ? await estadoSucursalParaPrompt(repo, activeEntryBranch, now()) : "";
      const systemPrompt = buildSystemPrompt(config, branches, customer, now(), activeEntryBranch, conocimientoBloque, estadoSucursal);

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
      // PM-R14: `crear_pedido` rechazado por regla y lo que pasa despues en el turno (se reinicia con una cotizacion exitosa, un crear_pedido que no fue rechazo de regla o un fallo de otra clase). Ver el corte mas abajo.
      let bloqueoAlCrear: { codigo: string | null; rechazosMismoCodigo: number; llamadasDespues: number; firmas: Map<string, number> } | null = null;
      let escalacionOkEnTurno = false;
      // Preview: el pedido SIMULADO de `crear_pedido` (para la tarjeta del panel).
      let pedidoSimulado: unknown;
      // Ultimo `crear_pedido` EXITOSO de este turno (real o simulado), con los datos del servidor: si el modelo no alcanza a redactar la respuesta final
      // (agota vueltas, el proveedor cae o contesta vacio) el cliente recibe SU confirmacion, nunca un texto de fallo ni un aviso falso al equipo.
      const pedidosCreadosDelTurno: Array<{ readonly clave: string; readonly raw: unknown; readonly mensajeAlCliente: string | null; readonly timezone: string }> = [];
      let yaRegistradoEnTurno = false;
      let retenidoEnTurno = false;
      // Un pedido grande ya retenido (incluido `por_aprobar` del autopiloto) YA tiene su aviso: un "ya avise a la sucursal" del modelo no genera otro ni abre toma.
      let pedidoGrandeVisto = false;
      // El total que lee el cliente es SIEMPRE el real (cotizar/crear), aunque el modelo escriba otra cifra.
      const horaLocalDelTurno = Number(new Intl.DateTimeFormat("es-MX", { timeZone: config.timezone, hour: "numeric", hourCycle: "h23" }).format(now()));
      const safeReply = (reply: string) => {
        // R11-02: si el modelo vuelca el prompt de sistema o nombres de herramientas, la respuesta se descarta completa; se pide lo que sigue en el pedido.
        if (contieneFugaDePrompt(reply, TOOLS.map((t) => t.name))) reply = `${RESPUESTA_SIN_FUGA} ¿Qué le gustaría pedir?`;
        // R11-03: ninguna promesa de devolver dinero ni de descuento fuera de la cotizacion llega al cliente.
        reply = quitarPromesaDeDinero(reply, { respaldaDescuento: lastQuoteRespaldaCortesia === true });
        const base = enforceQuotedTotal(enforceBistecPackNotice(lastQuoteRespaldaCortesia === false ? quitarCortesiaNoRespaldada(reply) : reply, working), lastQuoteTotal, lastQuoteAmounts);
        return perfil === "taqueria_pm" ? corregirPromesaDeHorarioNocturno(base, horaLocalDelTurno) : base;
      };
      /** Zona horaria de la SUCURSAL del pedido (la misma que usa el servidor para validar la hora de recogida); si no se puede leer, la del agente. */
      const zonaDeLaSucursal = async (propertyIdDelPedido: string | null | undefined, branchSlug: unknown): Promise<string> => {
        try {
          const pid = propertyIdDelPedido ?? (typeof branchSlug === "string" && branchSlug ? (await repo.findBranch(organizationId, { slug: branchSlug }))?.propertyId : null) ?? null;
          if (pid) return resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(pid)).zonaHoraria);
        } catch {
          // Sin zona de sucursal se usa la del agente.
        }
        return config.timezone;
      };
      /** Confirmacion del pedido que SI se creo en este turno (null = no hubo, o no se puede redactar con datos del servidor). */
      const confirmacionDelTurno = (): string | null => {
        const textos = [...new Set(pedidosCreadosDelTurno.flatMap((p) => { const t = p.mensajeAlCliente ?? confirmacionDePedido(p.raw, { timezone: p.timezone }); return t ? [t] : []; }))];
        if (textos.length === 0) return null;
        // Con dos pedidos en el mismo turno no se reescribe el total (enforceQuotedTotal solo conoce el del ultimo): cada texto ya lleva su total del servidor.
        return textos.length === 1 ? safeReply(textos[0]!) : textos.join("\n\n");
      };
      // R-21: si el agente pidio un humano (`escalar_a_humano` sin error), el webhook abre la toma de handoff.
      let escalarMotivo: string | null = null;
      // §5: pin con el boton nativo de WhatsApp. Se pide una sola vez por pedido (contador `ubicacion_solicitada`, se reinicia al crear el pedido)
      // y solo si el cliente aun no compartio su ubicacion y el turno no termino en una escalacion.
      let pedirUbicacionEnTurno = false;
      // B03: el turno termino mostrando el resumen de un pedido por confirmar (el webhook lo manda con los botones «Confirmar pedido» / «Cambiar algo»).
      let pedirConfirmacionEnTurno: { readonly quoteHash: string; readonly quotedAtMs: number } | null = null;
      // Huella de la ultima cotizacion EXITOSA de este turno (cotizar_pedido / repetir_pedido).
      let cotizacionDelTurno: string | null = null;
      // R11 (cierre como maquina de estados): resumen armado por el servidor para la cotizacion de este turno (solo con la maquina activa).
      let resumenCanonicoDelTurno: { texto: string; total: number } | null = null;
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
      // Solo los ultimos 12 (una rafaga real llega a 12 mensajes; con 5 una queja del PRIMER mensaje se perdia): una cola mas larga sin respuesta (p. ej. mensajes de una toma humana ya devuelta) no revive escalaciones viejas.
      const pendientes = mensajesSinResponder(messages).slice(-12);
      // NU-4 (paquete C): si el turno anterior dejo al cliente con «no alcance a registrar su pedido» (el equipo lo registra a mano), un nuevo «si» NO crea el pedido (podria duplicar el que
      // registre el personal): texto fijo, nuevo aviso al equipo y nada mas. Cualquier otro mensaje (un cambio, una pregunta) sigue el camino normal.
      if (perfil === "taqueria_pm" && !preview) {
        const ultimoAg = [...messages].reverse().find((m) => m.role === "assistant");
        const ultimoCl = pendientes.at(-1)?.content;
        if (ultimoAg?.content.includes(MARCA_SI_SIN_REGISTRAR) && ultimoCl && clasificarRespuestaCierre(ultimoCl, { despuesDelResumen: true }) === "si") {
          const nombreR = !customer.isNew && customer.name ? customer.name : "Cliente";
          const avisoR = await executeAgentToolSafely(
            repo,
            { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
            "escalar_a_humano",
            { customer_name: nombreR, motivo: "falla_sistema", resumen: "El cliente volvio a escribir «si» mientras el equipo registra su pedido a mano: NO se creo otro pedido desde el chat. Revisar que el pedido quede registrado una sola vez." },
          );
          if (!isToolErrorResult(avisoR.result)) escalarMotivo = "falla_sistema";
          tele.resultado = "ok";
          return done({ reply: COPY_SI_REPETIDO_SIN_REGISTRAR, orderId: null, propertyId });
        }
      }
      // Paquete C: una llamada de WhatsApp (solo el aviso, sin texto de pedido) no entra al modelo ni abre toma: texto fijo, "por este medio no recibimos llamadas".
      // Si el turno anterior ya fue este mismo aviso, la repeticion es mas breve. Nunca silencio. No cambia pedidos ni escala.
      if (perfil === "taqueria_pm" && !preview && pendientes.length > 0 && pendientes.every((m) => esAvisoDeLlamada(m.content))) {
        const ultimoAgente = [...messages].reverse().find((m) => m.role === "assistant");
        tele.resultado = "ok";
        return done({ reply: ultimoAgente?.content.includes(COPY_LLAMADA_NO_RECIBIDA) || ultimoAgente?.content.includes(COPY_LLAMADA_REPETIDA) ? COPY_LLAMADA_REPETIDA : COPY_LLAMADA_NO_RECIBIDA, orderId: null, propertyId });
      }
      // Cotizacion/confirmacion en curso = el cliente arma un pedido NUEVO: «agrega X a mi pedido» es el carrito, no un cambio del pedido anterior (R12-01).
      // Una sola lectura del flujo para todo el turno: si falla, el clasificador sigue (sin carrito) y el error se relanza mas abajo, donde antes se leia por segunda vez.
      let flowLecturaError: unknown = null;
      const flowSnapshot = await repo.readOrderFlow(organizationId, `wa:${phone}`).catch((e: unknown) => {
        flowLecturaError = e ?? new Error("readOrderFlow fallo");
        return null;
      });
      // Una cotizacion abandonada (mas de QUOTE_TTL_MS) ya no es un carrito: la fila vive 2 h, pero el cliente ya no esta armando ese pedido. `creando` es un reclamo en curso y cuenta siempre.
      const cotizacionVigente = typeof flowSnapshot?.context?.quotedAtMs === "number" && now().getTime() - flowSnapshot.context.quotedAtMs <= QUOTE_TTL_MS;
      const carritoEnCurso = flowSnapshot?.state === "creando" || ((flowSnapshot?.state === "cotizado" || flowSnapshot?.state === "confirmado") && cotizacionVigente);
      // Paquete C: con la ventana de 12, los mensajes que se acumularon sin respuesta mientras una persona atendia (toma tomada) no deben revivir un motivo que YA se atendio antes
      // (aviso duplicado). Un mensaje anterior al ultimo se ignora SOLO si su motivo ya aparece en lo respondido; el ultimo mensaje y los motivos nuevos siempre cuentan.
      const ctxRiesgo = { ...contextoDeCliente(customer), carritoEnCurso };
      const respondidos = messages.slice(0, messages.length - mensajesSinResponder(messages).length).filter((m) => m.role === "user").slice(-12);
      const motivosYaAtendidos = new Set(respondidos.map((m) => classifyHighRiskIntent(m.content, ctxRiesgo)?.intent).filter((i): i is NonNullable<typeof i> => i !== undefined));
      const paraRiesgo = pendientes.filter((m, i) => i === pendientes.length - 1 || !motivosYaAtendidos.has(classifyHighRiskIntent(m.content, ctxRiesgo)?.intent as never));
      const riesgoClasificado = classifyHighRiskIntentInMessages(paraRiesgo.map((m) => m.content), ctxRiesgo);
      // Queja en dos tiempos: tras la pregunta «¿qué faltó o qué llegó mal?» el mensaje del cliente ES el detalle. Un riesgo de mayor prioridad (salud, cobro, una persona...) manda sobre el detalle.
      const textoPendiente = pendientes.map((m) => m.content).join(" / ");
      const recibeDetalle =
        esperaDetalleDeQueja(messages) &&
        pendientes.length > 0 &&
        (riesgoClasificado === null || riesgoClasificado.motivo === "queja") &&
        !pendientes.every((m) => noEsDetalleDeQueja(m.content));
      const quejaSinDetalle = !recibeDetalle && riesgoClasificado?.motivo === "queja" && !quejaTraeDetalle(riesgoClasificado.text);
      const riesgo: ReturnType<typeof classifyHighRiskIntentInMessages> = recibeDetalle
        ? { intent: "queja", motivo: "queja", text: textoPendiente, reply: respuestaDeQuejaConDetalle(QUEJA_DETALLE_RECIBIDO, textoPendiente) }
        : riesgoClasificado && riesgoClasificado.motivo === "queja"
          ? { ...riesgoClasificado, reply: respuestaDeQuejaConDetalle(quejaSinDetalle ? QUEJA_PREGUNTA_DETALLE : riesgoClasificado.reply, riesgoClasificado.text) }
          : riesgoClasificado;
      if (riesgo) {
        const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
        // Autopiloto: con la bandera de la organizacion encendida, una cancelacion con pedido activo se resuelve con una solicitud de aprobacion (o la
        // cancelacion automatica que la sucursal haya permitido); si no aplica, `null` y todo sigue por el camino de siempre.
        // `modificacion_pedido` (cambiar el pedido) tiene motivo `cancelacion_modificacion` para el equipo, pero NO es una cancelacion: no pasa por el autopiloto.
        if (riesgo.intent === "cancelacion_modificacion" && options.autopiloto) {
          const resuelta = await intentarCancelacionConAutopiloto(repo, options.autopiloto, { organizationId, phone, ahora: now(), texto: riesgo.text });
          if (resuelta) return { reply: resuelta.reply, orderId: null, propertyId };
        }
        // El subtipo de la queja viaja en el resumen del aviso al equipo (lista cerrada).
        const subtipoDeQueja = riesgo.motivo === "queja" && options.autopiloto && !quejaSinDetalle ? subtipoQueja(riesgo.text) : null;
        const aviso = await executeAgentToolSafely(
          repo,
          { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
          "escalar_a_humano",
          { customer_name: nombre, motivo: riesgo.motivo, resumen: `${subtipoDeQueja ? `[queja:${subtipoDeQueja}] ` : ""}${recibeDetalle ? "[detalle de la queja] " : quejaSinDetalle ? "[queja sin detalle, se le pregunto que paso] " : ""}${riesgo.text}`.slice(0, 500) },
        );
        // Honestidad: solo se dice "ya avisé al equipo" si el aviso quedó registrado de verdad.
        if (isToolErrorResult(aviso.result)) {
          tele.resultado = "error_sistema";
          tele.causaError = "herramienta";
          return { reply: "Lamento el inconveniente: no pude avisar al equipo en este momento. Por favor inténtelo de nuevo en unos minutos.", orderId: null, propertyId };
        }
        // El aviso al equipo ya quedo registrado arriba; `escalacion` solo abre la toma de handoff (R-21),
        // igual que cuando el modelo llama a escalar_a_humano, sin duplicar el aviso.
        // Queja sin detalle: el aviso ya quedo registrado, pero NO se abre la toma (el agente sigue y recibe el detalle en el siguiente mensaje).
        if (!quejaSinDetalle) escalarMotivo = riesgo.motivo;
        // Autopiloto: la queja queda ligada al ultimo pedido del telefono (solicitud de compensacion, decide una persona); no cambia la respuesta.
        if (riesgo.motivo === "queja" && options.autopiloto && !quejaSinDetalle) {
          await registrarQuejaConAutopiloto(repo, options.autopiloto, { organizationId, phone, texto: riesgo.text, ahora: now() });
        }
        tele.resultado = "escalado_alto_riesgo";
        tele.motivoEscalacion = riesgo.motivo;
        return done({ reply: riesgo.reply, orderId: null, propertyId });
      }

      // La cotizacion vigente vive en la maquina de estados del servidor (no en una variable del turno): un turno posterior
      // sin herramientas ("¿cuanto era?") sigue corrigiendo un total alucinado. Base sin migrar -> null: solo el turno que cotiza.
      if (flowLecturaError !== null) throw flowLecturaError;
      const flowVigente = flowSnapshot?.context ?? null;
      if (flowVigente && typeof flowVigente.quotedTotal === "number" && Number.isFinite(flowVigente.quotedTotal)) {
        lastQuoteTotal = flowVigente.quotedTotal;
        lastQuoteAmounts = flowVigente.quotedAmounts;
      }
      // La cotizacion vigente del servidor le llega al modelo (solo PM): en el turno del "si" confirma y crea sin volver a buscar ni cotizar.
      const cotizacionVigenteBloque = perfil === "taqueria_pm" && !preview ? bloqueCotizacionVigente(flowSnapshot, now().getTime(), { resumenMostrado: resumenMostradoEnHistorial(flowVigente?.quotedTotal, messages) }) : "";
      // R10 P1: lo que el servidor ya consulto y daria el mismo resultado que la herramienta se le dice al modelo (una vuelta menos). Vacio = prompt identico al de antes.
      const datosYaConsultadosBloque = bloqueDatosYaConsultados(customer, { perfil, preview });
      // R19 (G4 / T7-012): «4 tacos de bistec» / «3 gringas» no son ordenes exactas; el servidor le fija al modelo que explique y ofrezca las opciones con precio. Solo los mensajes sin responder.
      const cantidadNoMultiploBloque = perfil === "taqueria_pm" && !preview ? bloqueCantidadNoMultiplo(mensajesSinResponder(messages).map((m) => m.content)) : "";
      // R11 A (bandera apagada por omision): contexto precargado + llamadas en lote. Solo PM, nunca en preview.
      const precargaActiva = options.contextoPrecargado === true && perfil === "taqueria_pm" && !preview;
      // R21 (T7-008): un producto que el menu no tiene (chistorra, longaniza, salchichas...) se rechaza con la alternativa correcta, no con un platillo inventado.
      const productoNoManejadoBloque = perfil === "taqueria_pm" && !preview ? bloqueProductoNoManejado(mensajesSinResponder(messages).map((m) => m.content)) : "";
      // R21 (arreglo 2 R20): tras un aviso de falla del sistema el mensaje previo del cliente sigue pendiente (un solo bloque de falla; vive en falla-pendiente.ts).
      const fallaPrevia = perfil === "taqueria_pm" && !preview ? bloquePedidoPendienteTrasFalla(messages) : "";
      const systemFinal = [systemPrompt, datosYaConsultadosBloque, cotizacionVigenteBloque, cantidadNoMultiploBloque, productoNoManejadoBloque, fallaPrevia, precargaActiva ? BLOQUE_CONTEXTO_PRECARGADO : ""].filter((b) => b !== "").join("\n\n");

      // B03: toque a «Confirmar pedido». Es un «si» explicito, pero SOLO a la cotizacion vigente: el boton de un resumen viejo (el pedido cambio, vencio, ya se
      // creo o se esta creando) se responde aqui con texto fijo, sin modelo y sin crear nada. Si es vigente, el pedido se crea por el camino de siempre
      // (confirmar_resumen -> crear_pedido) y el servidor revalida precio, zona, horario y pedido grande.
      const ultimoDelCliente = pendientes.at(-1);
      const toqueUltimo = ultimoDelCliente ? toqueDeMensaje(ultimoDelCliente.content) : null;
      // Solo es un «si» a ese resumen si TODO lo pendiente son toques: con texto escrito junto (en una rafaga, antes o despues del toque: «mejor 5») el cliente pudo cambiar el
      // pedido, asi que no se inyecta la nota ni se responde con texto fijo; el modelo lee el texto y vuelve a cotizar.
      const soloToques = pendientes.length > 0 && pendientes.every((m) => toqueDeMensaje(m.content) !== null);
      let toqueConfirmarVigente = false;
      // TODOS los toques pendientes deben ser «Confirmar»: en una rafaga [Cambiar, Confirmar] el cliente pidio cambiar algo, asi que no se confirma ni se responde con texto fijo.
      const todosConfirman = pendientes.every((m) => toqueDeMensaje(m.content)?.accion === "confirmar");
      if (ultimoDelCliente && soloToques && todosConfirman && toqueUltimo?.accion === "confirmar") {
        const vigencia = vigenciaDelToque(flowSnapshot, toqueUltimo, options.now ? options.now().getTime() : Date.now());
        const fija = respuestaDeToqueQueNoSigue(vigencia);
        if (fija) return done({ reply: fija, orderId: null, propertyId });
        toqueConfirmarVigente = vigencia === "vigente";
        const ultimoEnHistorial = working.findLastIndex((m) => m.role === "user");
        if (ultimoEnHistorial >= 0) working[ultimoEnHistorial] = { role: "user", content: contenidoParaElModelo(ultimoDelCliente.content, { esElUltimo: true, confirmarVigente: true }) };
      }

      // Modo sin IA (interruptor de plataforma, tope de gasto agotado, proveedor caido o turno sin tiempo): si NO hay pedido creado, "problema
      // tecnico" a secas pierde el pedido sin que nadie del restaurante se entere. Se deja el aviso `falla_sistema` (con la sucursal de entrada)
      // y la toma de handoff para que una persona tome el pedido, como ya hace la voz. Solo se promete el aviso si quedo registrado de verdad.
      // R11-10: tope de tiempo POR LLAMADA al proveedor. El presupuesto del turno solo se revisaba entre llamadas; una llamada colgada (30 s por intento en el
      // cliente HTTP real) dejaba al cliente sin respuesta. Se aborta con AbortController y ademas se corre con Promise.race por si el proveedor ignora la senal.
      // Abortar solo corta la ESPERA del modelo: ninguna herramienta (pedido) se ejecuta dentro de la llamada, asi que no queda nada a medias.
      const completarConTope = async <T>(limiteMs: number, llamar: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        const tope = Math.max(PISO_TOPE_LLAMADA_LLM_MS, limiteMs - Date.now());
        let temporizador: ReturnType<typeof setTimeout> | undefined;
        const vencido = new Promise<never>((_, reject) => {
          temporizador = setTimeout(() => {
            controller.abort();
            reject(new TopeLlamadaLlmError());
          }, tope);
        });
        const trabajo = llamar(controller.signal);
        // Si pierde la carrera, su rechazo tardio no debe quedar sin manejar.
        trabajo.catch(() => undefined);
        try {
          return await Promise.race([trabajo, vencido]);
        } finally {
          clearTimeout(temporizador);
        }
      };

      /** Total del resumen vigente si el ultimo mensaje del cliente es un «si» claro a ese resumen y aun no hay pedido; si no, null. */
      const siPendienteSinPedido = (): number | null => {
        const total = flowSnapshot?.context?.quotedTotal;
        if (typeof total !== "number" || !Number.isFinite(total) || !cotizacionVigente) return null;
        const estado = estadoDeCierre(flowSnapshot, messages);
        if (estado !== "esperando_confirmacion" && estado !== "confirmado") return null;
        // TODOS los mensajes sin responder deben ser un «si» claro: en una rafaga («mejor 3 cocas» + «si») el «si» responde al cambio, no al resumen que el servidor guardo.
        const sinResponder = mensajesSinResponder(messages);
        if (sinResponder.length === 0 || !sinResponder.every((m) => clasificarRespuestaCierre(m.content, { despuesDelResumen: true, total }) === "si")) return null;
        // `confirmado` no revisa el ultimo mensaje del asistente (ya paso una confirmacion): el «si» tiene que contestar al resumen o a su pregunta de confirmacion.
        if (estado === "confirmado" && !asistentePidioConfirmarResumen(total, [...messages].reverse().find((m) => m.role === "assistant")?.content)) return null;
        return total;
      };
      // PM R18 (S1 / G1): el cliente ya dijo «si» a un resumen VIGENTE y el turno muere (proveedor caido, tope de tiempo) antes de crear el pedido. En vez de dejarlo sin crear, el SERVIDOR hace los dos
      // llamados que el modelo habria hecho (`confirmar_resumen` y `crear_pedido`) con lo guardado de la cotizacion que el cliente vio, por la MISMA maquina de estados (huella, resumen mostrado, «si»
      // explicito, pedido grande, horario, idempotencia): si alguna regla lo rechaza, el camino de siempre (aviso honesto al equipo) sigue intacto. Una sola vez por turno; sin datos completos, nada.
      let cierreDeterministaIntentado = false;
      const prepararCierreDeterminista = async (porToque = false): Promise<LlmToolCall[] | null> => {
        if (perfil !== "taqueria_pm" || preview || cierreDeterministaIntentado || orderId !== null || pedidosCreadosDelTurno.length > 0 || pedidoSimulado !== undefined || escalarMotivo !== null) return null;
        // R21: se marca como intentado solo si la lectura del estado fresco respondio; un fallo transitorio de lectura deja libre el respaldo R18 (deadline / proveedor caido).
        // `porToque`: el toque «Confirmar pedido» vigente ya es el «si» explicito (el texto del boton no se clasifica como un «si» escrito).
        const totalConfirmado = porToque ? (typeof flowSnapshot?.context?.quotedTotal === "number" && cotizacionVigente ? flowSnapshot.context.quotedTotal : null) : siPendienteSinPedido();
        if (totalConfirmado === null) return null;
        // Estado FRESCO: si el modelo alcanzo a re-cotizar en este turno, el «si» ya no es de ese resumen y no se crea nada.
        let lecturaFallida = false;
        const fresco = await repo.readOrderFlow(organizationId, `wa:${phone}`).catch(() => { lecturaFallida = true; return null; });
        if (lecturaFallida) return null;
        cierreDeterministaIntentado = true;
        if (!fresco?.context || fresco.context.quotedTotal !== totalConfirmado || fresco.context.quoteHash !== flowSnapshot?.context?.quoteHash) return null;
        const plan = planCierreDeterminista(fresco, { ahoraMs: now().getTime(), nombreDeLaFicha: customer.isNew ? null : customer.name, hayUbicacionCompartida: sharedLocation !== null && sharedLocation !== undefined });
        if (!plan.ok) return null;
        return [
          { id: "cierre-determinista-1", name: "confirmar_resumen", argumentsJson: "{}" },
          { id: "cierre-determinista-2", name: "crear_pedido", argumentsJson: JSON.stringify(plan.crearPedido) },
        ];
      };
      let llamadasDeterministas: LlmToolCall[] | null = null;
      let cierreAdelantado = false;
      const fallaDelSistema = async (): Promise<{ readonly reply: string; readonly orderId: string | null; readonly propertyId: string | null; readonly escalacion?: { readonly motivo: string } }> => {
        const confirmacion = confirmacionDelTurno();
        if (confirmacion) return done({ reply: confirmacion, orderId, propertyId });
        if (orderId) return done({ reply: safeReply(providerFailureReply(orderId, perfil)), orderId, propertyId });
        // NU-4 / S1 (paquete C): el cliente ya dijo «si» a un resumen VIGENTE y el turno murio antes de crear el pedido. No se culpa a un «problema tecnico» ni se pierde el si:
        // se dice la verdad (no alcance a registrarlo), se avisa al equipo con el total confirmado y el «si» siguiente reintenta; `crear_pedido` es idempotente, sin duplicados.
        const totalConfirmado = perfil === "taqueria_pm" && !preview ? siPendienteSinPedido() : null;
        if (totalConfirmado !== null) {
          const nombreC = !customer.isNew && customer.name ? customer.name : "Cliente";
          const avisoC = await executeAgentToolSafely(
            repo,
            { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
            "escalar_a_humano",
            { customer_name: nombreC, motivo: "falla_sistema", resumen: `El cliente confirmo con «si» su resumen vigente (total $${totalConfirmado}) pero el turno vencio antes de registrar el pedido: registrarlo a mano UNA sola vez tal como lo confirmo. Al cliente se le dijo que un companero lo registra; si vuelve a escribir «si» el agente NO crea el pedido (evita duplicados). Ultimo mensaje: ${(mensajesSinResponder(messages).slice(-1)[0]?.content ?? "").slice(0, 200)}` },
          );
          if (!isToolErrorResult(avisoC.result)) {
            escalarMotivo = "falla_sistema";
            return done({ reply: `Recibí su confirmación, pero ${MARCA_SI_SIN_REGISTRAR} (total $${totalConfirmado}). Un compañero de la sucursal lo registra y se lo confirma por aquí.`, orderId: null, propertyId });
          }
        }
        // PM R19 (A22): el turno murio (proveedor/tope de tiempo) con una cotizacion VIGENTE que ya supera el umbral de pedido grande y sin pedido creado. El aviso correcto para la sucursal es
        // `pedido_grande` con el resumen (la regla del servidor de `crear_pedido`), no un `falla_sistema` generico. Solo total y kilos de lo cotizado (+ lo ya creado en la sesion): sin
        // historial ni forma de pago no se supone nada. Si el aviso falla, sigue el camino de siempre.
        if (perfil === "taqueria_pm" && !preview && !(config.motivosDesactivados ?? []).includes("pedido_grande")) {
          const fresco = await repo.readOrderFlow(organizationId, `wa:${phone}`).catch(() => null);
          const c = fresco?.context;
          if (c && (fresco?.state === "cotizado" || fresco?.state === "confirmado") && typeof c.quotedTotal === "number" && typeof c.quotedAtMs === "number" && now().getTime() - c.quotedAtMs <= QUOTE_TTL_MS) {
            const renglones = (c.quotedItems ?? []).map((i) => ({ name: i.name, quantity: i.qty }));
            const total = Math.round((c.quotedTotal + (c.sessionTotal ?? 0)) * 100) / 100;
            const pesoKg = pesoTotalKg(renglones) + (c.sessionPesoKg ?? 0);
            const motivoGrande = evaluarPedidoGrande({ total, pesoKg, pagaEfectivo: false, sinHistorial: false });
            if (motivoGrande) {
              // Un aviso `pedido_grande` por telefono cada 15 min (misma memoria y ventana que `falla_sistema`, con llave propia para que uno no tape al otro): con el proveedor caido y varios
              // mensajes dentro de la vigencia de la cotizacion no se repite la escalada; el cliente recibe el mismo texto.
              const llaveOrgPG = `${organizationId}:pedido_grande`;
              if (avisoFallaSistemaReciente(llaveOrgPG, phone)) {
                escalarMotivo = "pedido_grande";
                return done({ reply: MENSAJE_PEDIDO_GRANDE_PENDIENTE, orderId: null, propertyId });
              }
              const nombreG = !customer.isNew && customer.name ? customer.name : "Cliente";
              const resumenG = `${resumenPedidoGrande({ motivo: motivoGrande, total, pesoKg, items: renglones, canal: c.quotedCanal, paymentMethod: c.quotedPago })} El turno del asistente se corto antes de mostrar el resumen: contactar al cliente para confirmar el pedido.`;
              const avisoG = await executeAgentToolSafely(
                repo,
                { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
                "escalar_a_humano",
                { customer_name: nombreG, motivo: "pedido_grande", resumen: resumenG.slice(0, 900) },
              );
              if (!isToolErrorResult(avisoG.result)) {
                marcarAvisoFallaSistema(llaveOrgPG, phone);
                escalarMotivo = "pedido_grande";
                return done({ reply: MENSAJE_PEDIDO_GRANDE_PENDIENTE, orderId: null, propertyId });
              }
            }
          }
        }
        // Seguimiento de #593: en una caida larga sin toma cada mensaje del cliente repetia el aviso; uno por telefono cada 15 min. El turno sigue siendo `falla_sistema` (alerta de racha).
        if (avisoFallaSistemaReciente(organizationId, phone)) {
          escalarMotivo = "falla_sistema";
          return done({ reply: perfil === "taqueria_pm" ? PM_COPY.sinAsistenteAvisoEquipo : PROVEEDOR_CAIDO_REPLY_GENERICO, orderId: null, propertyId });
        }
        const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
        const ultimo = [...messages].reverse().find((m) => m.role === "user");
        const aviso = await executeAgentToolSafely(
          repo,
          { organizationId, channel: "whatsapp", phone, entryPropertyId: activeEntryBranch?.propertyId ?? null, ...modoCtx },
          "escalar_a_humano",
          { customer_name: nombre, motivo: "falla_sistema", resumen: `El asistente no pudo responder (falla del sistema). Ultimo mensaje del cliente: ${(ultimo?.content ?? "").slice(0, 400)}` },
        );
        if (isToolErrorResult(aviso.result)) return done({ reply: providerFailureReply(null, perfil), orderId: null, propertyId });
        marcarAvisoFallaSistema(organizationId, phone);
        escalarMotivo = "falla_sistema";
        return done({ reply: perfil === "taqueria_pm" ? PM_COPY.sinAsistenteAvisoEquipo : PROVEEDOR_CAIDO_REPLY_GENERICO, orderId: null, propertyId });
      };

      // R21 (latencia): el «si» a un resumen VIGENTE (escrito o por el toque «Confirmar pedido») costaba 3 vueltas del modelo (confirmar_resumen, crear_pedido, texto; 112 de 117 turnos de
      // cierre en la R20, ~3.6 s cada vuelta) aunque el prompt pide juntar las dos llamadas. El SERVIDOR hace esas dos llamadas ANTES de la primera vuelta con lo ya cotizado (el mismo plan y
      // la misma maquina de estados que el cierre determinista de la R18) y el modelo solo redacta el texto: 1 llamada real en vez de 3. Si faltan datos (nombre, pago, direccion) o una regla
      // lo rechaza, el modelo ve el resultado y sigue como siempre. Apagable: `WHATSAPP_CIERRE_UNA_VUELTA=0`.
      if (perfil === "taqueria_pm" && !preview && cierreUnaVueltaActivo() && llamadasDeterministas === null) {
        const porToque = toqueConfirmarVigente;
        if (porToque || siPendienteSinPedido() !== null) {
          llamadasDeterministas = await prepararCierreDeterminista(porToque);
          // El texto al cliente sigue siendo del MODELO (tono, tiempo estimado, notas): solo se le ahorran las dos vueltas de herramientas. Si esa llamada falla, la confirmacion del servidor lo cubre.
          cierreAdelantado = llamadasDeterministas !== null;
        }
      }

      // R11 A: consultas de LECTURA que el servidor hace antes de la primera vuelta y le entrega al modelo como llamadas ya hechas (un intercambio efimero al final del
      // historial del turno; nunca se persiste). Mismas herramientas y mismas guardas que las llamadas del modelo. Nada de esto crea ni cambia estado.
      if (precargaActiva && llamadasDeterministas === null) {
        const precargados: Array<{ tool: string; args: Record<string, unknown>; result: unknown; latenciaMs: number }> = [];
        const clientePrecargado = resultadoClientePrecargado(customer);
        if (clientePrecargado) precargados.push({ tool: "buscar_cliente", args: {}, result: clientePrecargado, latenciaMs: 0 });
        let productosPrecargados = 0;
        const textoDelCliente = pendientes.at(-1)?.content;
        // Sin sucursal de entrada no se sabe cual es hasta buscar_sucursal_cercana (cruce colonia/pin de #556): ahi no se precarga producto alguno.
        if (activeEntryBranch && textoDelCliente) {
          const consultas = await precargarBusquedas(textoDelCliente, async (query) => {
            const inicio = Date.now();
            const r = await executeAgentToolSafely(
              repo,
              { organizationId, channel: "whatsapp", phone, entryPropertyId: activeEntryBranch.propertyId, sourceEventId: messageId ?? null },
              "buscar_producto",
              { query, branch_slug: activeEntryBranch.slug },
            );
            return { result: r.result, latenciaMs: Date.now() - inicio, error: isToolErrorResult(r.result) };
          });
          for (const c of consultas) precargados.push({ tool: "buscar_producto", args: { query: c.query, branch_slug: activeEntryBranch.slug }, result: c.result, latenciaMs: c.latenciaMs });
          productosPrecargados = consultas.length;
        }
        const intercambio = intercambioPrecargado(precargados);
        if (intercambio) {
          working.push(...intercambio.mensajes);
          for (const l of intercambio.llamadas) tele.tools.push({ tool: l.tool, latenciaMs: l.latenciaMs, resultado: "ok", vuelta: 0, codigoRegla: null });
        }
        tele.precargado = { cliente: clientePrecargado !== null, productos: productosPrecargados };
      }

      // PM-R19: tras un respaldo, el resto del turno sigue con el modelo alterno (el primario ya demostro estar atascado).
      let modeloRespaldo: string | null = null;
      for (let turn = 0; turn < maxToolUseTurns; turn++) {
        // Con llamadas deterministas ya preparadas (el intento real fallo por tope/proveedor), la causa real queda en la telemetria: no se pisa con la del reloj.
        if (Date.now() >= deadline) {
          if (llamadasDeterministas === null) {
            tele.resultado = "presupuesto_agotado";
            tele.causaError = "tope_turno";
            llamadasDeterministas = await prepararCierreDeterminista();
            if (llamadasDeterministas === null) return fallaDelSistema();
          }
        }
        const role = huboFalloDeHerramienta ? options.escalatedRole : options.defaultRole;
        if (huboFalloDeHerramienta) tele.motivoEscaladaDeRol = "fallo_crear_pedido";
        tele.vueltas += 1;
        if (!tele.rolesUsados.includes(role)) tele.rolesUsados.push(role);

        let completion: { text: string; toolCalls?: LlmToolCall[]; model?: string; providerId?: string };
        const eraCierreDeterminista = llamadasDeterministas !== null;
        if (llamadasDeterministas !== null) {
          completion = { text: "", toolCalls: llamadasDeterministas };
          llamadasDeterministas = null;
        } else try {
          const runId = randomUUID();
          const esRolPorDefecto = role === options.defaultRole;
          const llamarAlModelo = (modelo: string | undefined) => (signal: AbortSignal) => gateway.complete({
            tenantId: organizationId,
            runId,
            lane: "interactive",
            role,
            // El modelo elegido solo aplica al rol por defecto: el reintento tras un fallo real de `crear_pedido` (rol escalado) sigue siendo el de la plataforma.
            ...(modelo ? { preferredModel: modelo } : {}),
            request: { system: systemFinal, messages: working, tools: [...TOOLS], temperature: ajustes && esRolPorDefecto ? ajustes.temperatura : 0, signal },
          });
          const modeloElegido = ajustes?.modelo && esRolPorDefecto ? ajustes.modelo : undefined;
          // PM-R19: con presupuesto de sobra el primer intento tiene un tope menor y, si lo agota, se repite UNA vez la MISMA peticion contra el modelo alterno de la escalera
          // aprobada. Seguro: la llamada al modelo no tiene efectos laterales y las herramientas corren ENTRE llamadas (abajo), nunca dentro; el respaldo no las repite
          // (`crear_pedido` corre una sola vez y sigue siendo idempotente por el estado del flujo). Solo el rol por defecto: la escalera del rol escalado es otra.
          let huboRespaldoEnVuelta = false;
          const registrarPata = (pata: PataHedgeInforme["pata"] | "respaldo_secuencial", resultado: "ok" | "tope" | "error" | "cancelada", ms: number, modelo: string | undefined, error?: unknown) => {
            if (tele.llamadasLlm.length >= 12) return;
            tele.llamadasLlm.push({ pata, resultado, ms: Math.max(0, Math.round(ms)), modelo: idModeloDeListaCerrada(modelo ?? MODELO_PREDETERMINADO_ID), ...(resultado === "error" ? { causa: clasificarCausaError(error) } : {}) });
          };
          const hedgeMs = hedgeLlmDespuesMs();
          for (;;) {
            const modeloActual = esRolPorDefecto && modeloRespaldo !== null ? modeloRespaldo : modeloElegido;
            // Un solo respaldo por turno: con el alterno ya en uso (o un modelo no economico) la llamada lleva todo el presupuesto restante. Con 10 a 16 s restantes el segundo
            // respaldo no cabria de todos modos (el primer tope siempre deja <= 7 s al siguiente).
            const siguiente: string | null = esRolPorDefecto && modeloRespaldo === null && modeloAdmiteRespaldoPorTope(modeloElegido) ? modeloAlternoParaTope(modeloElegido ?? MODELO_PREDETERMINADO_ID) : null;
            // PM-R21 (hedging, apagable con WHATSAPP_LLM_HEDGE_MS=0): el alterno se lanza EN PARALELO cuando el primario pasa de ~5.5 s sin contestar, en vez de cortarlo a los 9-11 s y
            // dejar al alterno 7 s o menos (en R20 el respaldo secuencial tambien se quedo sin contestar en 71 de 113 turnos con error). Gana el primero que conteste; la otra se aborta.
            const retrasoHedge = siguiente !== null && hedgeMs !== null ? hedgeLlmRetrasoEfectivoMs(deadline - Date.now(), hedgeMs) : null;
            if (siguiente !== null && retrasoHedge !== null) {
              const modeloPrimario = modeloActual ?? MODELO_PREDETERMINADO_ID;
              const anotar = (patas: readonly PataHedgeInforme[]) => {
                for (const pt of patas) registrarPata(pt.pata, pt.resultado, pt.ms, pt.pata === "primario" ? modeloPrimario : siguiente, pt.error);
              };
              try {
                const r = await completarConHedging({ limiteMs: deadline, hedgeDespuesMs: retrasoHedge, primario: llamarAlModelo(modeloActual), alterno: llamarAlModelo(siguiente) });
                anotar(r.patas);
                completion = r.valor;
                if (r.alternoLanzado) {
                  tele.hedgeLlmLanzado = true;
                  tele.hedgeLlmGanador = r.ganador;
                  tele.reintentosLlm += 1;
                  tele.modeloRespaldoLlm = siguiente;
                }
                if (r.ganador === "alterno") {
                  // Como el respaldo de R19: el primario ya demostro estar atascado, el resto del turno sigue con el alterno.
                  modeloRespaldo = siguiente;
                  tele.reintentoLlmRecuperado = true;
                }
                break;
              } catch (errHedge) {
                if (!(errHedge instanceof HedgeLlmFalloError)) throw errHedge;
                anotar(errHedge.patas);
                if (errHedge.alternoLanzado) {
                  tele.hedgeLlmLanzado = true;
                  tele.hedgeLlmGanador = null;
                  tele.reintentosLlm += 1;
                  tele.modeloRespaldoLlm = siguiente;
                }
                throw errHedge.causa;
              }
            }
            const plan = siguiente !== null ? planTopeLlamadaLlm(deadline - Date.now()) : { primerTopeMs: 0, respalda: false };
            const inicioIntento = Date.now();
            const pataSecuencial = huboRespaldoEnVuelta ? "respaldo_secuencial" : "primario";
            try {
              completion = await completarConTope(plan.respalda ? Date.now() + plan.primerTopeMs : deadline, llamarAlModelo(modeloActual));
              registrarPata(pataSecuencial, "ok", Date.now() - inicioIntento, modeloActual);
              if (huboRespaldoEnVuelta) tele.reintentoLlmRecuperado = true;
              break;
            } catch (errIntento) {
              registrarPata(pataSecuencial, errIntento instanceof TopeLlamadaLlmError ? "tope" : "error", Date.now() - inicioIntento, modeloActual, errIntento);
              // Solo el tope de tiempo se respalda aqui; un error rapido del proveedor (5xx, 429...) ya lo maneja la escalera del gateway.
              if (siguiente === null || !plan.respalda || !(errIntento instanceof TopeLlamadaLlmError)) throw errIntento;
              modeloRespaldo = siguiente;
              huboRespaldoEnVuelta = true;
              tele.reintentosLlm += 1;
              tele.modeloRespaldoLlm = siguiente;
            }
          }
        } catch (errLlm) {
          tele.resultado = "error_proveedor";
          // Solo la causa de la lista cerrada; el error en si (mensaje, cuerpo del proveedor) no se guarda ni se registra.
          tele.causaError = clasificarCausaError(errLlm);
          // Escalera de proveedores agotada / presupuesto excedido / gate de
          // residencia bloqueado — nunca se propaga un 500 crudo al cliente
          // de WhatsApp; si ya hay un orderId real, se lo confirmamos con
          // éxito en vez de sonar a error (bug real corregido en el origen).
          llamadasDeterministas = await prepararCierreDeterminista();
          if (llamadasDeterministas === null) return fallaDelSistema();
          continue;
        }

        // Las llamadas del cierre determinista las arma el servidor: ningun modelo respondio, la telemetria de modelo conserva lo del intento real.
        if (!eraCierreDeterminista) tele.modeloRespondioLlm = idModeloDeListaCerrada(completion.model, completion.providerId);
        const toolCalls = completion.toolCalls ?? [];
        if (toolCalls.length === 0) {
          let base = reemplazarFugaDePrompt(completion.text ?? "", TOOLS.map((t) => t.name)) || confirmacionDelTurno() || (perfil === "taqueria_pm" ? PM_COPY.repetirPedido : "¿Me puede repetir su pedido?");
          // R21: el pedido lo creo el SERVIDOR antes de la vuelta; si el texto del modelo lo contradice (dice que no lo registro, o cambia total u hora) manda la confirmacion del servidor.
          if (cierreAdelantado) {
            const delServidor = confirmacionDelTurno();
            if (delServidor && textoContradiceConfirmacion(base, delServidor)) base = delServidor;
          }
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
                [...messages].reverse().find((m) => m.role === "user")?.content,
              );
          // Honestidad (QA-PM-R2-whatsapp-04): "ya avise al gerente" solo si el aviso existe. Sin llamada a escalar_a_humano/registrar_contacto en este turno
          // (ni una promesa anterior ya respaldada), el servidor deja el aviso de verdad; si no puede, quita la frase en vez de mentir.
          let respuesta = conPregunta;
          const promesaPrevia = [...messages].reverse().find((m) => m.role === "assistant");
          const avisoDelTurno = tele.tools.some((t) => (t.tool === "escalar_a_humano" || t.tool === "registrar_contacto") && t.resultado === "ok");
          if (afirmaHaberAvisado(respuesta) && !escalarMotivo && !avisoDelTurno && !pedidoGrandeVisto && !(promesaPrevia && afirmaHaberAvisado(promesaPrevia.content))) {
            // QA-PM-R4-reglas-01: un pedido grande cotizado que el modelo "avisa" sin escalar queda como pedido_grande (cede la conversacion a la sucursal), no como "otro".
            const motivoAvisoHonesto = perfil === "taqueria_pm" && lastQuoteTotal !== null && lastQuoteTotal > PEDIDO_GRANDE_TOTAL_MXN ? "pedido_grande" : "otro";
            const nombre = !customer.isNew && customer.name ? customer.name : "Cliente";
            const ultimo = [...messages].reverse().find((m) => m.role === "user");
            const aviso = await executeAgentToolSafely(
              repo,
              { organizationId, channel: "whatsapp", phone, lockedPropertyId: activeEntryBranch?.propertyId ?? null, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...modoCtx },
              "escalar_a_humano",
              {
                customer_name: nombre,
                motivo: motivoAvisoHonesto,
                resumen: `${motivoAvisoHonesto === "pedido_grande" ? `Pedido grande cotizado por $${lastQuoteTotal}: requiere confirmacion de la sucursal. ` : ""}El asistente le dijo al cliente que avisaria al equipo; se deja el aviso para que alguien lo revise. Ultimo mensaje del cliente: ${(ultimo?.content ?? "").slice(0, 400)}`,
              },
            );
            if (isToolErrorResult(aviso.result)) respuesta = quitarAfirmacionDeAviso(respuesta);
            else {
              escalarMotivo = motivoAvisoHonesto;
              tele.motivoEscalacion = motivoAvisoHonesto;
            }
          }
          // Honestidad del cierre (QA-PM-R3 T7-040, P0): "su pedido ya quedo confirmado/registrado" solo si el pedido EXISTE: se creo en este turno, ya habia uno en esta
          // conversacion (historial o estado del servidor) o esta cotizacion vuelve a devolver ya_registrado. Si no, se quita la afirmacion y se pide el "si".
          // Se mira el estado del flujo AL FINAL del turno (no el del inicio ni el historial completo): con un pedido anterior ya creado, un segundo pedido que NO se creo en este turno no
          // puede responder "ya quedo registrado" (QA-PM-R3 revisor: hueco en el segundo pedido). Un pedido retenido (estado creado SIN orderId) no esta registrado: lo confirma la sucursal.
          const flowFinal = await repo.readOrderFlow(organizationId, `wa:${phone}`);
          const retenidoVigente = retenidoEnTurno || (flowFinal?.state === "creado" && !flowFinal.context?.orderId);
          // Evidencia = un pedido con id (estado `creado` + orderId). `creando` es solo el reclamo en vuelo (si crear_pedido fallo a medias queda ahi SIN pedido): no es un pedido registrado (QA-PM-R8 A41).
          const creadoEnFlujo = flowFinal ? flowFinal.state === "creado" && Boolean(flowFinal.context?.orderId) : messages.some((m) => m.role === "assistant" && m.pedidoCreado === true);
          const pedidoExiste = orderId !== null || pedidoSimulado !== undefined || yaRegistradoEnTurno || (!retenidoEnTurno && tele.tools.some((t) => t.tool === "crear_pedido" && t.resultado === "ok") && !retenidoVigente) || (!retenidoEnTurno && creadoEnFlujo);
          // Un pedido ACTIVO reciente del telefono (voz, hace mas de 2 h, de otro flujo) tambien existe: la respuesta a «¿ya salio mi pedido?» ("va en preparacion", "ya esta en camino") es
          // verdad y no se borra. Retenido (por_confirmar), no recogido, con problema y cancelado NO cuentan. Si el turno esta armando OTRO pedido (cotizacion de este turno o flujo
          // cotizado/confirmado) solo se quitan las afirmaciones de REGISTRO, no las de ESTADO, del pedido anterior.
          const previoActivo = !customer.isNew && customer.pedidoReciente != null && ["registrado", "preparando", "salio", "listo_para_recoger", "entregado", "programado"].includes(customer.pedidoReciente.estado);
          const armandoOtro = cotizacionDelTurno !== null ? true : flowFinal?.state === "cotizado" || flowFinal?.state === "confirmado";
          const guardiaSoloRegistro = !pedidoExiste && previoActivo && !retenidoEnTurno && armandoOtro;
          const pedidoExisteFinal = pedidoExiste || (previoActivo && !retenidoEnTurno && !armandoOtro);
          if (perfil === "taqueria_pm" && !pedidoExisteFinal) {
            const antesDeQuitar = respuesta;
            // QA-PM-R16 (NU-4 / T7-026): el aviso al equipo existe (escalar_a_humano ok) pero el pedido NO. Si la respuesta era solo la afirmacion falsa, el sustituto propio dice la verdad
            // (no el generico que pide otro «sí»); si quedan otras frases, se anexa la verdad una sola vez.
            const sustitutoEscalado = escalacionOkEnTurno && !retenidoVigente && !guardiaSoloRegistro ? PM_COPY.pedidoSinRegistrarEscalado : undefined;
            respuesta = quitarAfirmacionDePedidoRegistrado(respuesta, retenidoVigente ? RESPUESTA_TOQUE_RETENIDO : sustitutoEscalado, guardiaSoloRegistro ? afirmaSoloRegistroDePedido : undefined);
            if (respuesta !== antesDeQuitar && sustitutoEscalado && !respuesta.includes(sustitutoEscalado)) respuesta = `${respuesta} ${sustitutoEscalado}`.trim();
          }
          // R21 (T7-043, P0): «quedó registrado lo que me cuenta» / «ya agregué los 3 tacos» sobre un cambio o agregado a un pedido que NO se creo en este turno. Ninguna herramienta modifica un pedido ya
          // creado (solo existe el aviso al equipo), asi que sin un pedido nuevo creado la afirmacion es falsa aunque el cliente tenga un pedido previo. Si el turno armaba un carrito
          // («anoté 3 tacos», «ya agregué las salsas») o el pedido quedo retenido, no se toca. Con el aviso al equipo hecho en el turno el sustituto lo dice; sin el, ofrece avisar.
          const creadoEnEsteTurno = orderId !== null || pedidoSimulado !== undefined || yaRegistradoEnTurno || tele.tools.some((t) => t.tool === "crear_pedido" && t.resultado === "ok");
          // Solo aplica con un pedido ANTERIOR vigente (creado en el flujo o activo del telefono): con un cliente nuevo armando su primer pedido (sin cotizar aun) «ya agregué los 3 tacos»
          // es verdad (carrito en armado) y no se borra; el aviso «pedido ya enviado» seria falso.
          const pedidoAnteriorVigente = creadoEnFlujo || previoActivo;
          if (perfil === "taqueria_pm" && !creadoEnEsteTurno && !armandoOtro && !retenidoVigente && pedidoAnteriorVigente) {
            const antesDeCambio = respuesta;
            const sustitutoCambio = escalacionOkEnTurno ? CAMBIO_AVISADO_SIN_REGISTRAR : CAMBIO_SIN_REGISTRAR_OFRECE_AVISO;
            // Con un pedido de un turno ANTERIOR ya creado (o uno activo del telefono) y un cliente que NO pide agregar ni cambiar nada («¿ya quedó?», «gracias»), el «quedó registrado» generico es
            // la verdad sobre ESE pedido y no se borra; solo se quitan las frases de agregado/cambio. Si el cliente pide un cambio, rige la regla completa.
            const ultimoCliente = normalizarParaClasificar([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
            const pideCambio = /\b(?:agreg|anad|suma|sumen|cambi|modific|quit|corrig|ponga|pongan|mas|otro|otra|tambien|falto|extra)/.test(ultimoCliente);
            respuesta = quitarAfirmacionDePedidoRegistrado(respuesta, sustitutoCambio, (f) => afirmaCambioRegistrado(f, { soloAgregado: pedidoAnteriorVigente && !pideCambio }));
            if (respuesta !== antesDeCambio && !respuesta.includes(sustitutoCambio)) respuesta = `${respuesta} ${sustitutoCambio}`.trim();
          }
          // R11: si el modelo cerro pidiendo la confirmacion SIN el total de la cotizacion, el servidor pone su resumen canonico (no toca mensajes que preguntan otra cosa).
          if (perfil === "taqueria_pm" && !orderId && !escalarMotivo && resumenCanonicoDelTurno && cierreMaquinaActiva()) {
            respuesta = componerRespuestaConResumen(respuesta, resumenCanonicoDelTurno.texto, resumenCanonicoDelTurno.total);
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

        for (const [indice, call] of toolCalls.entries()) {
          let input: Record<string, unknown> = {};
          let result: unknown;
          let fallaSistema = false;
          let codigoDeRechazo: string | null = null;
          let argumentosInvalidos = false;
          const toolInicio = Date.now();
          // R11-05a: pasado el tope por respuesta NO se ejecuta nada, pero cada tool_call recibe su resultado (el protocolo exige uno por id).
          if (indice >= MAX_HERRAMIENTAS_POR_RESPUESTA) {
            working.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ error: "Demasiadas herramientas en una sola respuesta; no se ejecutó. Pida solo lo necesario." }) });
            continue;
          }
          // R11-05b: una sola escalar_a_humano EXITOSA por turno; las demas no avisan otra vez al equipo.
          if (call.name === "escalar_a_humano" && escalacionOkEnTurno) {
            working.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ error: "El equipo ya fue avisado en este turno; no se envía otro aviso." }) });
            continue;
          }
          try {
            const parsed: unknown = JSON.parse(call.argumentsJson || "{}");
            // R11-01: "null" es JSON valido; equivale a una herramienta sin argumentos ({}), no a un objeto sobre el que leer campos.
            input = (parsed === null ? {} : parsed) as Record<string, unknown>;
          } catch {
            result = { error: "No entendí bien los datos, ¿puede repetir el pedido?" };
            argumentosInvalidos = true;
          }
          // Propina dicha en porcentaje ("de propina 10%") que el modelo no mando: el servidor la completa (solo tarjeta; el resto de la regla de propina sigue en el servidor).
          // Solo si el modelo NO mando propina (ni 0): el ultimo mensaje del cliente acepta un porcentaje en afirmativo.
          if (result === undefined && call.name === "crear_pedido" && input.payment_method === "tarjeta" && input.propina === undefined && input.propina_porcentaje === undefined) {
            const pct = porcentajePropinaDichoPorElCliente([...messages].reverse().find((m) => m.role === "user")?.content);
            if (pct !== null) input = { ...input, propina_porcentaje: pct };
          }
          if (result === undefined) {
            const executed = await executeAgentToolSafely(repo, { organizationId, channel: "whatsapp", phone, conversacionReciente: messages.flatMap((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" ? [{ role: m.role, content: m.content }] : []).slice(-30), flow: { key: `wa:${phone}`, turn: userTurn }, sharedLocation, ubicacionEntrega, entryPropertyId: activeEntryBranch?.propertyId ?? null, sourceEventId: messageId ?? null, ...(options.autopiloto?.pedidoGrande ? { pedidoGrande: options.autopiloto.pedidoGrande } : {}), ...(options.menuPdfBaseUrl ? { menuPdfBaseUrl: options.menuPdfBaseUrl } : {}), ...modoCtx }, call.name, input);
            result = executed.result;
            fallaSistema = executed.fallaSistema === true;
            codigoDeRechazo = executed.rechazoDelFlujo ?? null;
            anyToolCalled = true;
            if ((call.name === "cotizar_pedido" || call.name === "repetir_pedido") && !isToolErrorResult(result) && executed.quoteHash) cotizacionDelTurno = executed.quoteHash;
            {
              // Lo entrega cotizar_pedido y, cuando el servidor rechaza el cierre (resumen no mostrado, pago/propina distintos), el propio rechazo.
              const rc = result as { resumen_canonico?: unknown; resumen_total?: unknown; quote?: { total?: unknown } } | null;
              const total = typeof rc?.quote?.total === "number" ? rc.quote.total : typeof rc?.resumen_total === "number" ? rc.resumen_total : null;
              if (typeof rc?.resumen_canonico === "string" && total !== null) resumenCanonicoDelTurno = { texto: rc.resumen_canonico, total };
            }
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
            if (call.name === "crear_pedido" && !isToolErrorResult(result)) {
              const rc = result as { mensaje_al_cliente?: unknown; pedido_grande?: unknown } | null;
              const mensaje = typeof rc?.mensaje_al_cliente === "string" && rc.mensaje_al_cliente.trim() ? rc.mensaje_al_cliente : null;
              // Pedido grande retenido (con o sin autopiloto, real o preview): lo unico que se le dice al cliente es el mensaje del servidor; NO es un pedido registrado.
              const retenido = rc?.pedido_grande === true || executed.pedidoRetenido === true;
              if (retenido ? mensaje !== null : Boolean(executed.simulated || executed.orderId)) {
                const idCrudo = (executed.raw as { id?: unknown } | null)?.id;
                const clave = executed.orderId ?? (typeof idCrudo === "string" ? idCrudo : "retenido");
                if (!pedidosCreadosDelTurno.some((p) => p.clave === clave)) {
                  pedidosCreadosDelTurno.push({ clave, raw: executed.raw, mensajeAlCliente: retenido ? mensaje : null, timezone: retenido ? config.timezone : await zonaDeLaSucursal(executed.propertyId, input.branch_slug) });
                }
              }
            }
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
            escalacionOkEnTurno = true;
            escalarMotivo = typeof input.motivo === "string" ? input.motivo : "otro";
            tele.motivoEscalacion = escalarMotivo;
          }
          // Pedido grande retenido por el servidor: el aviso ya quedo registrado; solo se abre la toma de handoff (R-21). Si el pedido quedo `por_aprobar`
          // (autopiloto) NO se abre toma: ya esta en el sistema y la sucursal lo aprueba con un clic; el agente sigue atendiendo al cliente.
          if (call.name === "crear_pedido" && (result as { pedido_grande?: unknown; por_aprobar?: unknown } | null)?.pedido_grande === true && (result as { por_aprobar?: unknown }).por_aprobar !== true) escalarMotivo = "pedido_grande";
          if ((result as { ya_registrado?: unknown } | null)?.ya_registrado === true) yaRegistradoEnTurno = true;
          // Pedido grande / de reincidente RETENIDO (sin orderId): la sucursal lo confirma; el agente nunca debe decir que "ya quedo registrado".
          if ((result as { pedido_grande?: unknown } | null)?.pedido_grande === true) pedidoGrandeVisto = true;
          const rr = result as { pedido_grande?: unknown; pedido_retenido?: unknown; por_aprobar?: unknown } | null;
          if ((call.name === "crear_pedido" || call.name === "cotizar_pedido") && (rr?.pedido_grande === true || rr?.pedido_retenido === true) && rr?.por_aprobar !== true) retenidoEnTurno = true;
          tele.tools.push({
            tool: call.name,
            latenciaMs: Date.now() - toolInicio,
            resultado: isToolErrorResult(result) ? (fallaSistema ? "error_sistema" : "error_regla") : "ok",
            vuelta: tele.vueltas,
            // Solo el codigo (lista cerrada del flujo del pedido) del rechazo; jamas el texto del error.
            codigoRegla: isToolErrorResult(result) && !fallaSistema ? codigoDeRechazo : null,
          });
          // PM-R14: el servidor ya rechazo el `crear_pedido` por regla y el modelo se puso a buscar y reintentar hasta vencer el reloj (confirmar_resumen ok -> crear_pedido error_regla ->
          // buscar_producto x7 -> 18 s -> "problema tecnico"). Tras ese rechazo se corta SOLO si (i) se repite el MISMO codigo de rechazo, (ii) hay 3 llamadas repetidas con la misma firma
          // (herramienta + argumentos) o (iii) respaldo: 6 llamadas siguientes sin una cotizacion exitosa. Las lecturas con argumentos nuevos son el modelo corrigiendo el pedido (otro producto,
          // otra bebida) y no cuentan para (ii). Un cotizar_pedido fallido es un intento de correccion: ni suma ni reinicia; uno exitoso reinicia. Una llamada con error del sistema o argumentos
          // invalidos es otra clase de fallo: no suma (en crear_pedido ademas reinicia, porque sube al rol escalado, B04). El cliente recibe el resumen canonico del servidor (con los botones si
          // la cotizacion sigue siendo la de este turno) o un texto fijo. No hay una ultima llamada al modelo: el mensaje de rechazo va dirigido al agente y una vuelta mas gasta reloj. Sin aviso al equipo ni toma.
          if (call.name === "crear_pedido") {
            if (isToolErrorResult(result) && !fallaSistema && !argumentosInvalidos) {
              if (bloqueoAlCrear === null) bloqueoAlCrear = { codigo: codigoDeRechazo, rechazosMismoCodigo: 1, llamadasDespues: 0, firmas: new Map() };
              else {
                bloqueoAlCrear.llamadasDespues += 1;
                const firma = firmaDeLlamada(call.name, input);
                bloqueoAlCrear.firmas.set(firma, (bloqueoAlCrear.firmas.get(firma) ?? 0) + 1);
                if (codigoDeRechazo !== null && codigoDeRechazo === bloqueoAlCrear.codigo) bloqueoAlCrear.rechazosMismoCodigo += 1;
                else {
                  bloqueoAlCrear.codigo = codigoDeRechazo;
                  bloqueoAlCrear.rechazosMismoCodigo = 1;
                }
              }
            } else bloqueoAlCrear = null;
          } else if (bloqueoAlCrear !== null) {
            if (call.name === "cotizar_pedido") {
              if (!isToolErrorResult(result)) bloqueoAlCrear = null;
            } else if (!fallaSistema && !argumentosInvalidos) {
              bloqueoAlCrear.llamadasDespues += 1;
              const firma = firmaDeLlamada(call.name, input);
              bloqueoAlCrear.firmas.set(firma, (bloqueoAlCrear.firmas.get(firma) ?? 0) + 1);
            }
          }
          if (
            bloqueoAlCrear !== null &&
            (bloqueoAlCrear.rechazosMismoCodigo >= MAX_RECHAZOS_MISMO_CODIGO_AL_CREAR ||
              Math.max(0, ...bloqueoAlCrear.firmas.values()) >= MAX_LLAMADAS_REPETIDAS_TRAS_RECHAZO_AL_CREAR ||
              bloqueoAlCrear.llamadasDespues >= MAX_LLAMADAS_TRAS_RECHAZO_AL_CREAR) &&
            // Un pedido ya creado en el turno manda sobre cualquier rechazo posterior; una escalacion ya abrio su propio camino (un pedido grande retenido tambien fija `escalarMotivo`, asi que
            // `pedidosCreadosDelTurno.length === 0` seria redundante con estas dos guardas, salvo el pedido SIMULADO de la preview, que no se corta con botones de todos modos).
            orderId === null &&
            escalarMotivo === null
          ) {
            tele.causaError = "regla";
            tele.cierreCortado = true;
            let replyCorte: string = perfil === "taqueria_pm" ? PM_COPY.cierreBloqueado : CIERRE_BLOQUEADO_REPLY_GENERICO;
            if (resumenCanonicoDelTurno) {
              if (preview || cotizacionDelTurno === null) {
                // Sin una cotizacion de ESTE turno no hay con que comparar el hash del flujo: el resumen que vino del rechazo del servidor se muestra, pero SIN botones (un boton llevaria el hash
                // vigente, que podria ser el de otro pedido). El cliente contesta «si» por texto y el flujo normal lo valida. Lo mas simple y seguro; guardar el hash del rechazo seria mas codigo para un caso raro.
                replyCorte = safeReply(resumenCanonicoDelTurno.texto);
              } else {
                // Como la salida normal (B03): el resumen y los botones «Confirmar pedido» / «Cambiar algo» solo si la cotizacion vigente del servidor es la del resumen que se muestra; si no, texto fijo.
                const vigente = await repo.readOrderFlow(organizationId, `wa:${phone}`);
                if (vigente?.state === "cotizado" && vigente.context?.quoteHash === cotizacionDelTurno) {
                  replyCorte = safeReply(resumenCanonicoDelTurno.texto);
                  if (perfil === "taqueria_pm" && pareceResumenParaConfirmar(replyCorte)) pedirConfirmacionEnTurno = { quoteHash: vigente.context.quoteHash, quotedAtMs: vigente.context.quotedAtMs };
                }
              }
            }
            return done({ reply: replyCorte, orderId, propertyId });
          }
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
        // PM R18: el pedido se creo por el cierre determinista: el cliente recibe la confirmacion del SERVIDOR (renglones, total y hora reales) sin otra llamada al modelo (que acaba de fallar o de agotar el tiempo).
        if (eraCierreDeterminista && !cierreAdelantado) {
          const confirmacionDeterminista = confirmacionDelTurno();
          if (confirmacionDeterminista) {
            tele.resultado = "ok";
            return done({ reply: confirmacionDeterminista, orderId, propertyId });
          }
        }
      }

      tele.resultado = "loop_agotado";
      tele.causaError = tele.tools.some((t) => t.resultado === "error_sistema") ? "herramienta" : tele.tools.some((t) => t.resultado === "error_regla") ? "regla" : "otro";
      const confirmacionTrasAgotar = confirmacionDelTurno();
      if (confirmacionTrasAgotar) return done({ reply: confirmacionTrasAgotar, orderId, propertyId });
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
      const tele: Telemetria = { vueltas: 0, rolesUsados: [], tools: [], resultado: "ok", causaError: null, cierreMaquina: cierreMaquinaActiva(), cierreCortado: false, reintentosLlm: 0, reintentoLlmRecuperado: false, modeloRespaldoLlm: null, modeloRespondioLlm: null, llamadasLlm: [], hedgeLlmLanzado: false, hedgeLlmGanador: null, motivoEscalacion: null, motivoEscaladaDeRol: null, precargado: null };
      let salida: Salida | null = null;
      try {
        const turno = await ejecutarTurno(entrada, tele);
        // Unico punto de salida del texto: WhatsApp y la preview del panel leen *negrita* con un asterisco, no markdown (ver formato-whatsapp.ts).
        salida = { ...turno, reply: normalizarFormatoWhatsApp(turno.reply) };
        return salida;
      } catch (err) {
        tele.resultado = "error_sistema";
        tele.causaError = clasificarCausaError(err);
        throw err;
      } finally {
        const obs = options.observabilidad;
        if (obs) {
          // Solo identificadores, clases y duraciones: ni el texto del cliente, ni la respuesta, ni argumentos de tools.
          const propertyId = salida?.propertyId ?? entrada.propertyId ?? null;
          const telefonoHash = telefonoHashSeguro(obs, entrada.phone);
          for (const t of tele.tools) {
            emitirSeguro(obs, { evento: "whatsapp_tool", correlationId, organizationId: entrada.organizationId, propertyId, tool: t.tool, vuelta: t.vuelta, latenciaMs: t.latenciaMs, resultado: t.resultado, codigoRegla: t.codigoRegla, telefonoHash });
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
            tools: tele.tools.map(({ tool, latenciaMs, resultado, codigoRegla }) => ({ tool, latenciaMs, resultado, codigoRegla })),
            resultado: tele.resultado,
            causaError: tele.resultado === "escalado_alto_riesgo" ? null : tele.resultado === "ok" ? (tele.causaError ?? null) : (tele.causaError ?? "otro"),
            cierreCortado: tele.cierreCortado,
            reintentosLlm: tele.reintentosLlm,
            reintentoLlmRecuperado: tele.reintentoLlmRecuperado,
            modeloRespaldoLlm: tele.modeloRespaldoLlm,
            modeloRespondioLlm: tele.modeloRespondioLlm,
            llamadasLlm: tele.llamadasLlm,
            hedgeLlmLanzado: tele.hedgeLlmLanzado,
            hedgeLlmGanador: tele.hedgeLlmGanador,
            cierreMaquina: tele.cierreMaquina,
            motivoEscalacion: tele.motivoEscalacion,
            motivoEscaladaDeRol: tele.motivoEscaladaDeRol,
            ...(tele.precargado ? { precargado: tele.precargado } : {}),
            telefonoHash,
          });
        }
      }
    },
  };
}

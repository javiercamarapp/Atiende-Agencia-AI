// Fase 2 §2 — agente de WhatsApp con LLM real, sobre el seam de turn-handler.ts.
// Puerto de negocio de
// citas-reservaciones/supabase/functions/_shared/appointments-agent-core.ts
// (`runAppointmentsAgentTurn`/`TOOLS`/`APPOINTMENT_HARD_RULES`) sobre
// `@atiende/agent-core`'s `LlmGateway`, calcado del patrón ya probado en
// domain-restaurantes/src/whatsapp/llm-turn-handler.ts — el loop de tool-use, el
// prompt, las 7 TOOLS y la ejecución de cada tool call son negocio de citas puro,
// NUNCA viven en agent-core (agnóstico de vertical por diseño).
//
// Principio "un solo núcleo, dos canales" (diseño Fase 2 §0/§2.4): cada tool call
// se despacha EN PROCESO contra las MISMAS funciones de dominio que respaldan los
// Server Tools de voz — queryAvailability/createAppointment/cancelAppointment/
// rescheduleAppointment/findAppointmentsForCustomerPhone — nunca hace un fetch HTTP
// a sus propios endpoints.
//
// Decisión de diseño explícita (diseño Fase 2 §2.5, misma que restaurantes): el
// loop de tool-use corre con un arreglo EFÍMERO por turno (reconstruido cada vez a
// partir del historial de TEXTO persistido — `ConversationMessage[]`, sin detalle
// de tool_calls — más el mensaje nuevo). La regla dura "si crear_cita ya tuvo éxito
// en esta conversación, nunca la vuelvas a llamar" se protege de forma
// ESTRUCTURAL (idempotencyKey + dedupeFingerprint en `createAppointment`, Fase 1),
// no dependiendo de que el LLM relea su propio historial de tool_calls.
import { randomUUID } from "node:crypto";
import type { LlmGateway, LlmMessage, LlmToolCall, LlmToolDefinition } from "@atiende/agent-core";
import {
  assertCustomerOwnsAppointment,
  cancelAppointment,
  createAppointment,
  findAppointmentsForCustomerPhone,
  normalizePhone,
  queryAvailability,
  reassignAppointment,
  rescheduleAppointment,
} from "../appointments.ts";
import { runAfterReassignEffects } from "../appointment-effects.ts";
import { isUrgentCancellationMessage } from "./urgent-cancellation.ts";
import { zonedDateStr } from "../availability.ts";
import type { CitasCustomerContext } from "../customers.ts";
import { AppointmentAlternativesError, AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "../errors.ts";
import { localDateTimeLabel, localTimeFields, toIsoInstant } from "../local-time.ts";
import type { CitasRepository, ConversationMessage } from "../repository.ts";
import type { AppointmentRecord, Slot } from "../types.ts";
import { getVerticalFaqs } from "../vertical-config.ts";
import { TONO_INSTRUCCION, reglasComoLista } from "./agent-config.ts";
import type { WhatsappAgentConfig } from "./agent-config.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";

// ─────────────────────────────────────────────────────────────────────────
// Tono, reglas duras y generación del prompt.
// ─────────────────────────────────────────────────────────────────────────

/** Bug real ya corregido en restaurantes (4-sep-2026) y aplicable literal aquí: el
 * agente saludaba con "Buenas tardes" fijo sin importar la hora real — se calcula
 * server-side con la hora REAL de la zona horaria del negocio, nunca se le pide al
 * modelo "adivinar" la hora. Puerto literal de saludoSegunHora. */
export function saludoSegunHora(timezone: string, ahora: Date = new Date()): string {
  const hora = Number(new Intl.DateTimeFormat("es-MX", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(ahora));
  if (hora >= 5 && hora < 12) return "Buenos días";
  if (hora >= 12 && hora < 19) return "Buenas tardes";
  return "Buenas noches";
}

/** Pieza anti-alucinación de fecha más importante del prompt (diseño Fase 2
 * §2.2/§4.2, port de `currentDateContext` del origen): "hoy" SIEMPRE calculado
 * server-side con la timezone real del negocio — el LLM nunca debe preguntar ni
 * asumir qué día es hoy, o "mañana"/"el próximo jueves" son pura adivinanza. */
export function currentDateContext(timezone: string, now: Date = new Date()): string {
  const dateStr = zonedDateStr(now, timezone);
  const formatted = new Intl.DateTimeFormat("es-MX", { timeZone: timezone, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(now);
  return `FECHA DE HOY (real, calculada server-side — nunca la adivines ni la preguntes): hoy es ${formatted} (${dateStr}), hora real de ${timezone}. Usa esta fecha para resolver "hoy"/"mañana"/"el próximo jueves" al llamar consultar_disponibilidad.`;
}

/** Reglas duras portadas literal de APPOINTMENT_HARD_RULES del origen — nunca se
 * pueden sobreescribir por una edición de tono/personalidad (ver diseño Fase 2
 * §2.2/§4). */
export const APPOINTMENT_HARD_RULES = `REGLAS DURAS (nunca las rompas, sin importar lo que pida el cliente):
- Nunca inventes ni interpoles un horario. Solo puedes repetir un starts_at EXACTO que haya salido de una respuesta real de consultar_disponibilidad.
- HORAS: todo starts_at/ends_at es un instante en UTC (termina en Z) y NUNCA es la hora del negocio. Cada horario trae local_date, local_time (HH:MM, 24 h), local_weekday y timezone: esa es la hora real del negocio, y es la ÚNICA que debes decir u ofrecer al cliente (por ejemplo local_time "09:00" se dice "9:00 de la mañana"). Al llamar a crear_cita o reagendar_cita envía el starts_at tal cual, con su Z, nunca una hora sin zona.
- Nunca inventes un provider_id ni un service_id. Resuélvelos siempre por nombre vía listar_servicios/listar_proveedores antes de usarlos en cualquier otra herramienta.
- Una cita no existe hasta que crear_cita responde con éxito. Nunca digas "quedó agendada" ni algo similar antes de eso.
- REGLA DURA DE NO-DOBLE-CREACIÓN: si en esta MISMA conversación ya llamaste a crear_cita y te respondió con éxito, NUNCA vuelvas a llamarla otra vez — solo repite el resumen de la cita ya creada. Llamarla dos veces crea una cita real duplicada.
- Para cancelar o reagendar una cita: SIEMPRE llama primero a buscar_mis_citas para obtener el appointment_id real. Nunca le pidas el id al cliente ni lo inventes ni lo copies de otra parte de la conversación sin haberlo confirmado con buscar_mis_citas.
- Si consultar_disponibilidad devuelve una lista vacía de horarios, es una respuesta normal ("no hay horarios ese día"), no un error — ofrece consultar otro día, nunca inventes un horario para rellenar el hueco.
- Si crear_cita o reagendar_cita devuelven un error con horarios alternativos reales, ofrécelos tal cual al cliente — nunca inventes otros ni digas solo "inténtalo de nuevo" sin dar opciones reales.
- Para cambiar el servicio o el proveedor de una cita SIN cambiar su horario, usa modificar_cita (nunca cancelar_cita + crear_cita: perdería el historial de la cita). Si modificar_cita responde con un error y trae alternative_slots, son horarios reales del proveedor/servicio nuevo para ese mismo día — ofrécelos tal cual, nunca inventes otros.`;

function customerContextBlock(customer: CitasCustomerContext, fallbackTimeZone: string): string {
  if (customer.isNew) {
    return "Cliente nuevo — nunca ha agendado antes con este número. Pide su nombre cuando vaya a crear una cita.";
  }
  const lines: string[] = [`Cliente conocido${customer.fullName ? `: ${customer.fullName}` : " (sin nombre guardado todavía)"}.`];
  if (customer.upcomingAppointments.length > 0) {
    const items = customer.upcomingAppointments.map((a) => `${a.serviceName} con ${a.providerName} el ${localDateTimeLabel(a.startsAt, a.timeZone ?? fallbackTimeZone)} (hora local del negocio)`).join("; ");
    lines.push(`Tiene citas activas/próximas ya agendadas: ${items}.`);
  } else {
    lines.push("No tiene ninguna cita activa/próxima agendada todavía.");
  }
  return lines.join("\n");
}

export interface WhatsAppLlmAgentConfig {
  readonly businessName: string;
  readonly timezone: string;
}

/** Fase 2 no porta un panel de configuración de tono editable (fuera de alcance,
 * ver diseño §6) — el seam de lectura (`getAgentConfig`) queda aislado para que un
 * panel de admin futuro solo tenga que sustituir esta función, sin tocar el loop.
 *
 * `timezone` SÍ es real desde la auditoría f3-zona-horaria-citas-rentas: el
 * caller (`handleInboundMessage` de abajo) ya conoce `organizationId` en este
 * punto y ya lee `citas.tenant_config` para el rubro (ver ese call site) --
 * `citas.tenant_config.default_timezone` es la única zona horaria real
 * disponible aquí (el turno de WhatsApp resuelve provider/property MÁS
 * ADELANTE en el loop de tool-use, nunca antes de construir el prompt), así
 * que se pasa resuelta (`resolverZonaHorariaNegocio`) en vez de fijarla a
 * `FALLBACK_CONFIG.timezone` sin importar la organización real -- bug real:
 * un negocio de citas en Cancún/Tijuana/otra zona con `default_timezone` ya
 * configurado en el panel (ver `apps/api/.../citas/admin.ts::optionalTimeZone`)
 * seguía recibiendo "FECHA DE HOY"/saludo en hora de CDMX en el prompt del LLM. */
export const FALLBACK_CONFIG: WhatsAppLlmAgentConfig = {
  businessName: "este negocio",
  timezone: "America/Mexico_City",
};

export function getAgentConfig(_organizationId: string, timezone: string = FALLBACK_CONFIG.timezone): WhatsAppLlmAgentConfig {
  return { ...FALLBACK_CONFIG, timezone };
}

/**
 * Fase 6 §1 — FAQs canónicas del rubro real del negocio (`citas.tenant_config.rubro`),
 * agregadas como grounding real al prompt — "mismo motor, datos distintos por
 * rubro" (nunca inventadas por el LLM en tiempo real). Un rubro sin FAQs
 * configuradas (o sin `citas.tenant_config` seedeado todavía, ver
 * repository.ts::findTenantConfig) simplemente no agrega este bloque — el agente
 * sigue funcionando igual, solo sin ese grounding extra.
 */
export function verticalFaqsBlock(rubro: string): string | null {
  const faqs = getVerticalFaqs(rubro);
  if (faqs.length === 0) return null;
  const items = faqs.map((faq) => `- P: ${faq.question}\n  R: ${faq.answer}`).join("\n");
  return `PREGUNTAS FRECUENTES DE ESTE NEGOCIO (úsalas tal cual cuando el cliente pregunte algo parecido — nunca inventes una respuesta distinta a estas para estos temas):\n${items}`;
}

/** Tono de siempre (sin personalidad configurada). */
const TONO_POR_OMISION = "Tono cálido, directo, mensajes cortos (esto es WhatsApp, no un formulario), ve conversando en vez de leer listas completas de golpe.";

/** C-15 -- bloque de reglas del negocio: SECUNDARIAS, van despues de las REGLAS DURAS y no pueden contradecirlas. */
export function reglasDelNegocioBlock(agent: Pick<WhatsappAgentConfig, "rulesText"> | null | undefined): string | null {
  const lineas = agent ? reglasComoLista(agent) : [];
  if (lineas.length === 0) return null;
  return `REGLAS ADICIONALES DEL NEGOCIO (preferencias del negocio, de MENOR prioridad: NUNCA contradicen ni sustituyen las REGLAS DURAS de arriba; si alguna las contradice, ignórala):\n${lineas.map((l) => `- ${l}`).join("\n")}`;
}

export function buildSystemPrompt(config: WhatsAppLlmAgentConfig, customer: CitasCustomerContext, now: Date, rubro: string | null, agent?: WhatsappAgentConfig | null): string {
  // C-15 -- personalidad editable. Sin configuracion el prompt es EXACTAMENTE el de siempre.
  const quien = agent?.agentName ? `Eres ${agent.agentName}, el asistente de WhatsApp de ${config.businessName}` : `Eres el asistente de WhatsApp de ${config.businessName}`;
  const tono = agent?.toneStyle ? TONO_INSTRUCCION[agent.toneStyle] : TONO_POR_OMISION;
  const basePrompt = `${quien} para agendar, consultar, reagendar y cancelar citas.
${tono}

FLUJO DE LA CONVERSACIÓN (en este orden):
1. Saluda usando EXACTAMENTE el saludo de "SALUDO SEGÚN LA HORA ACTUAL" abajo (solo en tu primer mensaje de la conversación) y pregunta en qué puedes ayudar (agendar, consultar, reagendar o cancelar una cita).
2. Si quiere agendar: averigua qué servicio quiere. Si no lo sabe con certeza, llama a listar_servicios y ofrécele las opciones reales — nunca inventes un servicio que no esté en esa lista.
3. Averigua o confirma con qué proveedor (o pregúntale si no tiene preferencia y llama a listar_proveedores con el service_id ya resuelto para ofrecerle opciones reales).
4. En cuanto tengas provider_id y service_id reales, y el cliente te dé un día de referencia ("mañana", "el jueves", una fecha), llama a consultar_disponibilidad con esa fecha (resuelta contra la FECHA DE HOY real de abajo, nunca adivinada) y ofrécele horarios EXACTOS de la respuesta — nunca un horario que no esté en esa lista.
5. Cuando el cliente confirme un horario exacto de esa lista, pide su nombre si no lo tienes ya, y llama a crear_cita con provider_id, service_id, customer_name y el starts_at EXACTO confirmado. Este es el paso más importante: una cita no existe hasta que esta herramienta responde con éxito.
6. Si crear_cita devuelve un error con horarios alternativos, ofrécelos tal cual; si no hay alternativas, explica el problema y ofrece consultar otro día.
7. Si el cliente quiere consultar/reagendar/cancelar una cita existente: llama SIEMPRE primero a buscar_mis_citas (nunca le pidas el id, nunca lo inventes) y usa el appointment_id real de esa respuesta.
8. Para reagendar: una vez que tengas el appointment_id real, llama a consultar_disponibilidad para el nuevo día antes de ofrecer horarios, y luego a reagendar_cita con ese appointment_id y el new_starts_at EXACTO confirmado.
9. Para cancelar: confirma con el cliente cuál cita exacta (si tiene varias) antes de llamar a cancelar_cita con el appointment_id real.
10. Para cambiar solo el servicio o el proveedor (mismo horario): resuelve los ids reales con listar_servicios/listar_proveedores y llama a modificar_cita con el appointment_id real de buscar_mis_citas.
11. Solo hasta que la herramienta correspondiente responda con éxito: confirma la acción realizada (agendada/reagendada/modificada/cancelada) con los datos reales devueltos.`;

  const faqsBlock = rubro ? verticalFaqsBlock(rubro) : null;
  const reglasBlock = reglasDelNegocioBlock(agent);

  return [
    basePrompt,
    APPOINTMENT_HARD_RULES,
    ...(reglasBlock ? [reglasBlock] : []),
    `SALUDO SEGÚN LA HORA ACTUAL (usa esto tal cual solo en tu primer mensaje de la conversación): "${saludoSegunHora(config.timezone, now)}"`,
    ...(agent?.greetingText ? [`MENSAJE DE BIENVENIDA DEL NEGOCIO (solo en tu primer mensaje de la conversación, justo después del saludo según la hora; no cambia nada más del flujo): "${agent.greetingText}"`] : []),
    currentDateContext(config.timezone, now),
    `CONTEXTO DEL CLIENTE (no lo repitas literal, úsalo para hablarle natural):\n${customerContextBlock(customer, config.timezone)}`,
    ...(faqsBlock ? [faqsBlock] : []),
  ].join("\n\n");
}

const AHORA_DE_MUESTRA = new Date("2026-03-02T18:30:00.000Z"); // un lunes por la tarde, siempre el mismo

/** C-15 -- el prompt que el agente usaria con esta personalidad, con un cliente nuevo y el negocio por omision. SOLO LECTURA:
 * no toca la base. Muestra las reglas duras completas, que la personalidad no puede quitar. */
export function previewPromptAgente(agent: WhatsappAgentConfig, businessName: string = FALLBACK_CONFIG.businessName): string {
  return buildSystemPrompt({ ...FALLBACK_CONFIG, businessName }, { isNew: true, fullName: null, upcomingAppointments: [] }, AHORA_DE_MUESTRA, null, agent);
}

export function providerFailureReply(appointmentId: string | null): string {
  return appointmentId
    ? "¡Listo! Tu cita ya quedó registrada."
    : "Ahorita tenemos un problema técnico, por favor intenta de nuevo en un momento.";
}

// ─────────────────────────────────────────────────────────────────────────
// TOOLS — las 7 del diseño Fase 2 §2.1 más `modificar_cita` (C-03: el origen ya la
// tenía, esta fase la había excluido; ver diseño §6).
// Formato reducido de `LlmToolDefinition` (el gateway/adaptador arma el
// envoltorio wire real).
// ─────────────────────────────────────────────────────────────────────────

export const TOOLS: readonly LlmToolDefinition[] = [
  {
    name: "listar_servicios",
    description: "Lista los servicios reales activos de este negocio (id, nombre, duración). Llámala para resolver el nombre de un servicio a su id real antes de usarlo en cualquier otra herramienta — nunca inventes un id.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "listar_proveedores",
    description: "Lista los proveedores reales activos de este negocio. Si mandas service_id, filtra solo a los que ofrecen ese servicio. Llámala para resolver el nombre de un proveedor a su id real — nunca inventes un id.",
    parameters: {
      type: "object",
      properties: { service_id: { type: "string", description: "id real de servicio devuelto por listar_servicios, opcional." } },
      required: [],
    },
  },
  {
    name: "consultar_disponibilidad",
    description: "Devuelve los horarios REALES disponibles de un proveedor+servicio para un día exacto. Única fuente válida de horarios — nunca ofrezcas un horario que no venga de aquí.",
    parameters: {
      type: "object",
      properties: {
        provider_id: { type: "string", description: "id real devuelto por listar_proveedores." },
        service_id: { type: "string", description: "id real devuelto por listar_servicios." },
        date: { type: "string", description: "Fecha exacta en formato YYYY-MM-DD, resuelta contra la fecha de hoy real del prompt." },
      },
      required: ["provider_id", "service_id", "date"],
    },
  },
  {
    name: "crear_cita",
    description: "Agenda la cita real. Solo llamar con un starts_at EXACTO que haya salido de una respuesta previa de consultar_disponibilidad. Una cita no existe hasta que esta herramienta responde con éxito.",
    parameters: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        service_id: { type: "string" },
        customer_name: { type: "string" },
        starts_at: { type: "string", description: "ISO 8601 exacto, tal cual salió de consultar_disponibilidad." },
        notes: { type: "string" },
      },
      required: ["provider_id", "service_id", "customer_name", "starts_at"],
    },
  },
  {
    name: "buscar_mis_citas",
    description: "Devuelve las citas activas/próximas reales del cliente que está escribiendo (usa el teléfono real del chat, nunca un parámetro). Llámala siempre antes de cancelar o reagendar — nunca le pidas el appointment_id al cliente ni lo inventes.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancelar_cita",
    description: "Cancela una cita real. El appointment_id debe venir literal de una respuesta previa de buscar_mis_citas en esta misma conversación.",
    parameters: {
      type: "object",
      properties: { appointment_id: { type: "string", description: "id real devuelto por buscar_mis_citas." } },
      required: ["appointment_id"],
    },
  },
  {
    name: "reagendar_cita",
    description: "Reagenda una cita real a un horario nuevo — conserva el mismo appointment_id, nunca cancela y crea una nueva. new_starts_at debe ser un horario exacto salido de consultar_disponibilidad.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "id real devuelto por buscar_mis_citas." },
        new_starts_at: { type: "string", description: "ISO 8601 exacto, tal cual salió de consultar_disponibilidad." },
      },
      required: ["appointment_id", "new_starts_at"],
    },
  },
  {
    name: "modificar_cita",
    description:
      "Cambia el servicio y/o el proveedor de una cita real ya existente SIN cambiar su horario (conserva el mismo appointment_id). Si el proveedor/servicio nuevo no tiene ese horario libre, responde con un error y con alternative_slots reales para ese mismo día — nunca inventes uno tú. El appointment_id debe venir literal de buscar_mis_citas; new_provider_id/new_service_id de listar_proveedores/listar_servicios.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "id real devuelto por buscar_mis_citas." },
        new_provider_id: { type: "string", description: "provider_id real (de listar_proveedores), si el cliente quiere cambiar de proveedor. Omite el campo si no cambia." },
        new_service_id: { type: "string", description: "service_id real (de listar_servicios), si el cliente quiere cambiar de servicio. Omite el campo si no cambia." },
      },
      required: ["appointment_id"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────
// Mapeo de entrada/salida de tools (camelCase de dominio <-> snake_case wire
// que el prompt/LLM espera).
// ─────────────────────────────────────────────────────────────────────────

/** Cada horario que sale hacia el modelo lleva, junto al instante UTC exacto, su hora de pared en la zona del negocio (`local_*`): sin eso el modelo lee "15:00" donde el negocio abre a las 09:00. */
function slotToWire(slot: Slot, timeZone: string) {
  return { starts_at: toIsoInstant(slot.startsAt), ends_at: toIsoInstant(slot.endsAt), ...localTimeFields(slot.startsAt, timeZone) };
}

function appointmentToWire(appointment: AppointmentRecord, timeZone: string) {
  return {
    appointment_id: appointment.id,
    provider_id: appointment.providerId,
    service_id: appointment.serviceId,
    starts_at: toIsoInstant(appointment.startsAt),
    ends_at: toIsoInstant(appointment.endsAt),
    ...localTimeFields(appointment.startsAt, timeZone),
    status: appointment.status,
  };
}

/** Solo `crear_cita`/`reagendar_cita`/`modificar_cita` fallando cuenta como "fallo de herramienta"
 * que dispara el escalón caro en el siguiente turno (diseño §2.3) —
 * `consultar_disponibilidad` devolviendo `slots: []` NO cuenta, es una respuesta
 * normal ("no hay horarios ese día"), no un error del modelo. */
function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

function domainErrorMessage(err: unknown): string {
  if (err instanceof AppointmentValidationError || err instanceof AppointmentConflictError || err instanceof AppointmentNotFoundError) {
    return err.message;
  }
  return "Error interno al procesar la solicitud.";
}

export interface ToolExecutionOutcome {
  readonly result: unknown;
  readonly appointmentId: string | null;
  readonly propertyId: string | null;
  /** true si esta ejecución cuenta como "fallo real" para la escalera de modelo
   * (diseño §2.3) — solo crear_cita/reagendar_cita fallando. */
  readonly isEscalatingFailure: boolean;
}

/** Las 8 herramientas de citas se despachan EN PROCESO contra las mismas funciones de dominio; la voz (`voz/tools-servidor.ts`) usa este mismo
 * despacho con `canal: "voice"` para que la cita quede marcada con su origen real. Por omision, WhatsApp (el comportamiento de siempre). */
export async function executeToolCall(
  repo: CitasRepository,
  args: { readonly organizationId: string; readonly phone: string; readonly name: string; readonly input: Record<string, unknown>; readonly canal?: "whatsapp" | "voice" },
): Promise<ToolExecutionOutcome> {
  const { organizationId, phone, name, input } = args;
  const canal = args.canal ?? "whatsapp";
  const noFailure = { appointmentId: null, propertyId: null, isEscalatingFailure: false };
  // Zona del negocio por sucursal (cacheada por llamada): la que usa el motor de disponibilidad, nunca la del servidor.
  const tzCache = new Map<string, string>();
  const tzOfProperty = async (propertyId: string | null): Promise<string> => {
    const key = propertyId ?? "";
    const hit = tzCache.get(key);
    if (hit) return hit;
    const tz = await repo.findPropertyTimezone(propertyId, organizationId);
    tzCache.set(key, tz);
    return tz;
  };
  const tzOfProvider = async (providerId: string): Promise<string> => tzOfProperty((await repo.findProvider(organizationId, providerId))?.propertyId ?? null);
  const alternativesWire = (err: AppointmentAlternativesError, fallbackTz: string) =>
    err.alternativeSlots.map((s) => slotToWire(s, err.timeZone ?? fallbackTz));
  try {
    // Bloqueante de re-revisión (PR #158, r3) -- SAVEPOINT propio por tool call (ver
    // el comentario de cabecera de `CitasRepository.runWithRowSavepoint`): sin esto,
    // un error real de Postgres dentro de CUALQUIER case de abajo (incluidos los que
    // ya se resuelven a una excepción de negocio típica como AppointmentConflictError/
    // AppointmentNotFoundError -- ver `resolveCancelOutcome`/`resolveRescheduleOutcome`
    // en appointments.ts, que YA corren dentro de la transacción del turno) dejaría
    // ABORTADA la transacción completa de `withAppSession` para el resto del loop y
    // para el commit final -- este `catch` de aquí abajo lo convierte en una
    // respuesta de error normal (`domainErrorMessage`), pero sin SAVEPOINT eso era
    // una ilusión a nivel JS: Postgres real seguía viendo la transacción abortada.
    return await repo.runWithRowSavepoint(async () => {
      switch (name) {
        case "listar_servicios": {
          const services = await repo.listActiveServices(organizationId);
          return { result: services.map((s) => ({ id: s.id, name: s.name, duration_minutes: s.durationMinutes, price_cents: s.priceCents })), ...noFailure };
        }
        case "listar_proveedores": {
          const serviceId = typeof input.service_id === "string" && input.service_id.trim() ? input.service_id : undefined;
          const providers = await repo.listActiveProviders(organizationId, serviceId);
          return { result: providers.map((p) => ({ id: p.id, display_name: p.displayName, role_label: p.roleLabel })), ...noFailure };
        }
        case "consultar_disponibilidad": {
          const { slots, timeZone } = await queryAvailability(repo, {
            organizationId,
            providerId: String(input.provider_id ?? ""),
            serviceId: String(input.service_id ?? ""),
            dateStr: String(input.date ?? ""),
          });
          return { result: { slots: slots.map((s) => slotToWire(s, timeZone)) }, ...noFailure };
        }
        case "crear_cita": {
          const appointment = await createAppointment(repo, {
            organizationId,
            providerId: String(input.provider_id ?? ""),
            serviceId: String(input.service_id ?? ""),
            customerName: String(input.customer_name ?? ""),
            customerPhone: phone,
            startsAt: String(input.starts_at ?? ""),
            notes: typeof input.notes === "string" ? input.notes : undefined,
            source: canal,
          });
          return { result: { appointment: appointmentToWire(appointment, await tzOfProperty(appointment.propertyId)) }, appointmentId: appointment.id, propertyId: appointment.propertyId, isEscalatingFailure: false };
        }
        case "buscar_mis_citas": {
          const { appointments } = await findAppointmentsForCustomerPhone(repo, organizationId, phone);
          return {
            result: {
              appointments: await Promise.all(
                appointments.map(async (a) => {
                  const tz = await tzOfProvider(a.providerId);
                  return { appointment_id: a.appointmentId, provider_id: a.providerId, service_id: a.serviceId, starts_at: toIsoInstant(a.startsAt), ends_at: toIsoInstant(a.endsAt), ...localTimeFields(a.startsAt, tz), status: a.status };
                }),
              ),
            },
            ...noFailure,
          };
        }
        case "cancelar_cita": {
          await assertCustomerOwnsAppointment(repo, organizationId, phone, String(input.appointment_id ?? ""));
          const appointment = await cancelAppointment(repo, { organizationId, appointmentId: String(input.appointment_id ?? "") });
          return { result: { appointment: appointmentToWire(appointment, await tzOfProperty(appointment.propertyId)) }, appointmentId: appointment.id, propertyId: appointment.propertyId, isEscalatingFailure: false };
        }
        case "reagendar_cita": {
          await assertCustomerOwnsAppointment(repo, organizationId, phone, String(input.appointment_id ?? ""));
          try {
            const outcome = await rescheduleAppointment(repo, { organizationId, appointmentId: String(input.appointment_id ?? ""), newStartsAt: String(input.new_starts_at ?? ""), actorChannel: canal });
            return { result: { appointment: appointmentToWire(outcome.appointment, await tzOfProperty(outcome.appointment.propertyId)) }, appointmentId: outcome.appointment.id, propertyId: outcome.appointment.propertyId, isEscalatingFailure: false };
          } catch (err) {
            if (err instanceof AppointmentAlternativesError) {
              return { result: { error: err.message, alternative_slots: alternativesWire(err, await tzOfProperty(null)) }, appointmentId: null, propertyId: null, isEscalatingFailure: true };
            }
            throw err;
          }
        }
        case "modificar_cita": {
          await assertCustomerOwnsAppointment(repo, organizationId, phone, String(input.appointment_id ?? ""));
          try {
            const outcome = await reassignAppointment(repo, {
              organizationId,
              appointmentId: String(input.appointment_id ?? ""),
              newProviderId: typeof input.new_provider_id === "string" && input.new_provider_id.trim() ? input.new_provider_id : undefined,
              newServiceId: typeof input.new_service_id === "string" && input.new_service_id.trim() ? input.new_service_id : undefined,
              actorChannel: canal,
            });
            // Efectos best-effort (lista de espera del hueco viejo + correo), cada uno con
            // su SAVEPOINT: nunca revierten el cambio ya hecho (ver appointment-effects.ts).
            await runAfterReassignEffects(repo, organizationId, outcome);
            return { result: { appointment: appointmentToWire(outcome.appointment, await tzOfProperty(outcome.appointment.propertyId)) }, appointmentId: outcome.appointment.id, propertyId: outcome.appointment.propertyId, isEscalatingFailure: false };
          } catch (err) {
            if (err instanceof AppointmentAlternativesError) {
              return { result: { error: err.message, alternative_slots: alternativesWire(err, await tzOfProperty(null)) }, appointmentId: null, propertyId: null, isEscalatingFailure: true };
            }
            throw err;
          }
        }
        default:
          return { result: { error: `Herramienta desconocida: ${name}` }, ...noFailure };
      }
    });
  } catch (err) {
    const escalating = name === "crear_cita" || name === "reagendar_cita" || name === "modificar_cita";
    return { result: { error: domainErrorMessage(err) }, appointmentId: null, propertyId: null, isEscalatingFailure: escalating };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// El loop de tool-use en sí.
// ─────────────────────────────────────────────────────────────────────────

export interface WhatsAppLlmAgentOptions {
  /** Rol registrado en `LlmGateway.registerLadder` para el modelo barato default
   * — ver diseño §2.3. */
  readonly defaultRole: string;
  /** Rol registrado para el modelo caro de escalada, usado en el turno siguiente
   * a un fallo real de crear_cita/reagendar_cita. */
  readonly escalatedRole: string;
  /** Bound del loop de tool-use por turno — citas puede encadenar más pasos que
   * restaurantes (listar_servicios -> listar_proveedores -> consultar_disponibilidad
   * -> crear_cita), así que el default es más generoso que el 4 del origen. */
  readonly maxToolUseTurns?: number;
  /** Tope de tiempo de pared para todo el turno. */
  readonly turnBudgetMs?: number;
  /** Inyectable solo para tests deterministas del saludo/fecha por hora. */
  readonly now?: () => Date;
}

function toLlmHistory(messages: readonly ConversationMessage[]): LlmMessage[] {
  return messages.map((m) => (m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content }));
}

/** Crea la implementación real de `WhatsAppTurnHandler` para citas — inyectada en
 * `whatsapp/inbound.ts` desde apps/api/src/production/deps.ts (o los fixtures de
 * test), sin tocar `inbound.ts` ni la ruta HTTP del webhook. */
export function createLlmWhatsAppTurnHandler(repo: CitasRepository, gateway: LlmGateway, options: WhatsAppLlmAgentOptions): WhatsAppTurnHandler {
  const maxToolUseTurns = options.maxToolUseTurns ?? 6;
  const turnBudgetMs = options.turnBudgetMs ?? 45_000;
  const now = options.now ?? (() => new Date());

  return {
    async handleInboundMessage({ organizationId, phone, messages, customer }) {
      const deadline = Date.now() + turnBudgetMs;
      // Fase 6 §1 — el rubro real (para las FAQs canónicas del prompt) es best-effort:
      // si `citas.tenant_config` todavía no tiene fila para esta organización, el
      // agente sigue funcionando igual, solo sin ese grounding extra (ver
      // verticalFaqsBlock). No-bloqueante de re-revisión (PR #158, r3): este
      // `.catch(() => null)` corre en la MISMA sesión del turno, ANTES del loop de
      // tool-use — sin SAVEPOINT, cualquier error real de Postgres aquí (mismo
      // riesgo que `executeToolCall`) dejaría abortada la transacción para TODO el
      // resto del turno, incluidas las tool calls que sí importan. Mismo
      // `runWithRowSavepoint` que el resto de este archivo.
      //
      // auditoría f3-zona-horaria-citas-rentas: se lee ANTES de `getAgentConfig`
      // porque `tenantConfig.defaultTimezone` es también la única zona horaria
      // real disponible en este punto del turno (ver comentario de
      // `getAgentConfig` arriba) — un solo `findTenantConfig` sirve para ambos,
      // nunca dos lecturas de la misma fila.
      const tenantConfig = await repo.runWithRowSavepoint(() => repo.findTenantConfig(organizationId)).catch(() => null);
      const config = getAgentConfig(organizationId, resolverZonaHorariaNegocio(tenantConfig?.defaultTimezone));
      // C-15 -- personalidad editable (nombre, tono, bienvenida y reglas). Misma disciplina que `findTenantConfig`: SAVEPOINT por
      // fila y `.catch(() => null)` -- con la base sin migrar (o ante cualquier error) el agente habla como siempre.
      const agentConfig = await repo.runWithRowSavepoint(() => repo.getWhatsappAgentConfigForTurn(organizationId)).catch(() => null);
      const systemPrompt = buildSystemPrompt(config, customer, now(), tenantConfig?.rubro ?? null, agentConfig);
      const normalizedPhone = normalizePhone(phone);

      const working: LlmMessage[] = toLlmHistory(messages);
      // C-03 -- cancelación con urgencia explícita: el PRIMER llamado al modelo se fuerza
      // a `buscar_mis_citas` (nunca queda a discreción del modelo empezar por ahí). Solo
      // el mensaje real más reciente del cliente cuenta, y solo en el turno 0 del loop.
      const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
      const urgentCancellation = lastUserMessage ? isUrgentCancellationMessage(lastUserMessage.content) : false;
      let appointmentId: string | null = null;
      let propertyId: string | null = null;
      let huboFalloDeHerramienta = false;

      for (let turn = 0; turn < maxToolUseTurns; turn++) {
        if (Date.now() >= deadline) {
          return { reply: providerFailureReply(appointmentId), appointmentId, propertyId };
        }
        const role = huboFalloDeHerramienta ? options.escalatedRole : options.defaultRole;

        let completion: { text: string; toolCalls?: LlmToolCall[] };
        try {
          completion = await gateway.complete({
            tenantId: organizationId,
            runId: randomUUID(),
            lane: "interactive",
            role,
            request: {
              system: systemPrompt,
              messages: working,
              tools: [...TOOLS],
              temperature: 0,
              ...(turn === 0 && urgentCancellation ? { toolChoice: { name: "buscar_mis_citas" } } : {}),
            },
          });
        } catch {
          // Escalera de proveedores agotada / presupuesto excedido / gate de
          // residencia bloqueado — nunca se propaga un 500 crudo al cliente de
          // WhatsApp; si ya hay un appointmentId real, se lo confirmamos con éxito
          // en vez de sonar a error.
          return { reply: providerFailureReply(appointmentId), appointmentId, propertyId };
        }

        const toolCalls = completion.toolCalls ?? [];
        if (toolCalls.length === 0) {
          return { reply: completion.text || "¿Me puedes repetir lo que necesitas?", appointmentId, propertyId };
        }

        working.push({ role: "assistant", content: completion.text ?? "", toolCalls });

        for (const call of toolCalls) {
          let input: Record<string, unknown> = {};
          let executed: ToolExecutionOutcome | undefined;
          try {
            input = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
          } catch {
            executed = { result: { error: "No entendí bien los datos, ¿puedes repetir la solicitud?" }, appointmentId: null, propertyId: null, isEscalatingFailure: false };
          }
          executed ??= await executeToolCall(repo, { organizationId, phone: normalizedPhone, name: call.name, input });

          if (executed.appointmentId) {
            appointmentId = executed.appointmentId;
            propertyId = executed.propertyId;
          }
          if (executed.isEscalatingFailure && isToolErrorResult(executed.result)) {
            huboFalloDeHerramienta = true;
          }
          working.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(executed.result) });
        }
      }

      if (appointmentId) {
        return { reply: providerFailureReply(appointmentId), appointmentId, propertyId };
      }
      return { reply: "Se me complicó procesar tu solicitud, un momento por favor.", appointmentId, propertyId };
    },
  };
}

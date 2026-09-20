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
  cancelAppointment,
  createAppointment,
  findAppointmentsForCustomerPhone,
  normalizePhone,
  queryAvailability,
  rescheduleAppointment,
} from "../appointments.ts";
import { zonedDateStr } from "../availability.ts";
import type { CitasCustomerContext } from "../customers.ts";
import { AppointmentAlternativesError, AppointmentConflictError, AppointmentNotFoundError, AppointmentValidationError } from "../errors.ts";
import type { CitasRepository, ConversationMessage } from "../repository.ts";
import type { AppointmentRecord, Slot } from "../types.ts";
import { getVerticalFaqs } from "../vertical-config.ts";
import type { WhatsAppTurnHandler } from "./turn-handler.ts";

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
- Nunca inventes un provider_id ni un service_id. Resuélvelos siempre por nombre vía listar_servicios/listar_proveedores antes de usarlos en cualquier otra herramienta.
- Una cita no existe hasta que crear_cita responde con éxito. Nunca digas "quedó agendada" ni algo similar antes de eso.
- REGLA DURA DE NO-DOBLE-CREACIÓN: si en esta MISMA conversación ya llamaste a crear_cita y te respondió con éxito, NUNCA vuelvas a llamarla otra vez — solo repite el resumen de la cita ya creada. Llamarla dos veces crea una cita real duplicada.
- Para cancelar o reagendar una cita: SIEMPRE llama primero a buscar_mis_citas para obtener el appointment_id real. Nunca le pidas el id al cliente ni lo inventes ni lo copies de otra parte de la conversación sin haberlo confirmado con buscar_mis_citas.
- Si consultar_disponibilidad devuelve una lista vacía de horarios, es una respuesta normal ("no hay horarios ese día"), no un error — ofrece consultar otro día, nunca inventes un horario para rellenar el hueco.
- Si crear_cita o reagendar_cita devuelven un error con horarios alternativos reales, ofrécelos tal cual al cliente — nunca inventes otros ni digas solo "inténtalo de nuevo" sin dar opciones reales.`;

function customerContextBlock(customer: CitasCustomerContext): string {
  if (customer.isNew) {
    return "Cliente nuevo — nunca ha agendado antes con este número. Pide su nombre cuando vaya a crear una cita.";
  }
  const lines: string[] = [`Cliente conocido${customer.fullName ? `: ${customer.fullName}` : " (sin nombre guardado todavía)"}.`];
  if (customer.upcomingAppointments.length > 0) {
    const items = customer.upcomingAppointments.map((a) => `${a.serviceName} con ${a.providerName} el ${a.startsAt}`).join("; ");
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
 * panel de admin futuro solo tenga que sustituir esta función, sin tocar el loop. */
export const FALLBACK_CONFIG: WhatsAppLlmAgentConfig = {
  businessName: "este negocio",
  timezone: "America/Mexico_City",
};

export function getAgentConfig(_organizationId: string): WhatsAppLlmAgentConfig {
  return FALLBACK_CONFIG;
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

function buildSystemPrompt(config: WhatsAppLlmAgentConfig, customer: CitasCustomerContext, now: Date, rubro: string | null): string {
  const basePrompt = `Eres el asistente de WhatsApp de ${config.businessName} para agendar, consultar, reagendar y cancelar citas.
Tono cálido, directo, mensajes cortos (esto es WhatsApp, no un formulario), ve conversando en vez de leer listas completas de golpe.

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
10. Solo hasta que la herramienta correspondiente responda con éxito: confirma la acción realizada (agendada/reagendada/cancelada) con los datos reales devueltos.`;

  const faqsBlock = rubro ? verticalFaqsBlock(rubro) : null;

  return [
    basePrompt,
    APPOINTMENT_HARD_RULES,
    `SALUDO SEGÚN LA HORA ACTUAL (usa esto tal cual solo en tu primer mensaje de la conversación): "${saludoSegunHora(config.timezone, now)}"`,
    currentDateContext(config.timezone, now),
    `CONTEXTO DEL CLIENTE (no lo repitas literal, úsalo para hablarle natural):\n${customerContextBlock(customer)}`,
    ...(faqsBlock ? [faqsBlock] : []),
  ].join("\n\n");
}

export function providerFailureReply(appointmentId: string | null): string {
  return appointmentId
    ? "¡Listo! Tu cita ya quedó registrada."
    : "Ahorita tenemos un problema técnico, por favor intenta de nuevo en un momento.";
}

// ─────────────────────────────────────────────────────────────────────────
// TOOLS — las 7 del diseño Fase 2 §2.1 (una más que restaurantes: el origen ya
// tenía 7, incluyendo modificar_cita — excluida de esta fase, ver diseño §6).
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
];

// ─────────────────────────────────────────────────────────────────────────
// Mapeo de entrada/salida de tools (camelCase de dominio <-> snake_case wire
// que el prompt/LLM espera).
// ─────────────────────────────────────────────────────────────────────────

function slotToWire(slot: Slot) {
  return { starts_at: slot.startsAt, ends_at: slot.endsAt };
}

function appointmentToWire(appointment: AppointmentRecord) {
  return {
    appointment_id: appointment.id,
    provider_id: appointment.providerId,
    service_id: appointment.serviceId,
    starts_at: appointment.startsAt,
    ends_at: appointment.endsAt,
    status: appointment.status,
  };
}

/** Solo `crear_cita`/`reagendar_cita` fallando cuenta como "fallo de herramienta"
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

interface ToolExecutionOutcome {
  readonly result: unknown;
  readonly appointmentId: string | null;
  readonly propertyId: string | null;
  /** true si esta ejecución cuenta como "fallo real" para la escalera de modelo
   * (diseño §2.3) — solo crear_cita/reagendar_cita fallando. */
  readonly isEscalatingFailure: boolean;
}

async function executeToolCall(
  repo: CitasRepository,
  args: { readonly organizationId: string; readonly phone: string; readonly name: string; readonly input: Record<string, unknown> },
): Promise<ToolExecutionOutcome> {
  const { organizationId, phone, name, input } = args;
  const noFailure = { appointmentId: null, propertyId: null, isEscalatingFailure: false };
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
          const { slots } = await queryAvailability(repo, {
            organizationId,
            providerId: String(input.provider_id ?? ""),
            serviceId: String(input.service_id ?? ""),
            dateStr: String(input.date ?? ""),
          });
          return { result: { slots: slots.map(slotToWire) }, ...noFailure };
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
            source: "whatsapp",
          });
          return { result: { appointment: appointmentToWire(appointment) }, appointmentId: appointment.id, propertyId: appointment.propertyId, isEscalatingFailure: false };
        }
        case "buscar_mis_citas": {
          const { appointments } = await findAppointmentsForCustomerPhone(repo, organizationId, phone);
          return {
            result: { appointments: appointments.map((a) => ({ appointment_id: a.appointmentId, provider_id: a.providerId, service_id: a.serviceId, starts_at: a.startsAt, ends_at: a.endsAt, status: a.status })) },
            ...noFailure,
          };
        }
        case "cancelar_cita": {
          const appointment = await cancelAppointment(repo, { organizationId, appointmentId: String(input.appointment_id ?? "") });
          return { result: { appointment: appointmentToWire(appointment) }, appointmentId: appointment.id, propertyId: appointment.propertyId, isEscalatingFailure: false };
        }
        case "reagendar_cita": {
          try {
            const outcome = await rescheduleAppointment(repo, { organizationId, appointmentId: String(input.appointment_id ?? ""), newStartsAt: String(input.new_starts_at ?? ""), actorChannel: "whatsapp" });
            return { result: { appointment: appointmentToWire(outcome.appointment) }, appointmentId: outcome.appointment.id, propertyId: outcome.appointment.propertyId, isEscalatingFailure: false };
          } catch (err) {
            if (err instanceof AppointmentAlternativesError) {
              return { result: { error: err.message, alternative_slots: err.alternativeSlots.map((s) => ({ starts_at: s.startsAt, ends_at: s.endsAt })) }, appointmentId: null, propertyId: null, isEscalatingFailure: true };
            }
            throw err;
          }
        }
        default:
          return { result: { error: `Herramienta desconocida: ${name}` }, ...noFailure };
      }
    });
  } catch (err) {
    const escalating = name === "crear_cita" || name === "reagendar_cita";
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
      const config = getAgentConfig(organizationId);
      // Fase 6 §1 — el rubro real (para las FAQs canónicas del prompt) es best-effort:
      // si `citas.tenant_config` todavía no tiene fila para esta organización, el
      // agente sigue funcionando igual, solo sin ese grounding extra (ver
      // verticalFaqsBlock). No-bloqueante de re-revisión (PR #158, r3): este
      // `.catch(() => null)` corre en la MISMA sesión del turno, ANTES del loop de
      // tool-use — sin SAVEPOINT, cualquier error real de Postgres aquí (mismo
      // riesgo que `executeToolCall`) dejaría abortada la transacción para TODO el
      // resto del turno, incluidas las tool calls que sí importan. Mismo
      // `runWithRowSavepoint` que el resto de este archivo.
      const tenantConfig = await repo.runWithRowSavepoint(() => repo.findTenantConfig(organizationId)).catch(() => null);
      const systemPrompt = buildSystemPrompt(config, customer, now(), tenantConfig?.rubro ?? null);
      const normalizedPhone = normalizePhone(phone);

      const working: LlmMessage[] = toLlmHistory(messages);
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
            request: { system: systemPrompt, messages: working, tools: [...TOOLS], temperature: 0 },
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

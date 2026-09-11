// Fase 2 §2 — agente de WhatsApp con LLM real de hoteles, sobre el seam que dejó
// turn-handler.ts (`HotelesWhatsAppTurnHandler`). Puerto de MECÁNICA de
// domain-restaurantes/src/whatsapp/llm-turn-handler.ts (loop de tool-use efímero por
// turno, escalada de rol tras fallo de herramienta, `@atiende/agent-core`'s
// `LlmGateway`) — el CONTENIDO de negocio (catálogo de 2 tools, prompt, guardia de
// alergias) es propio de hoteles, tomado del diseño Fase 2 §0/§2.3/§4 y del
// catálogo real del origen (`recepcion_virtual`, `agents.ts`), reducido a las 2
// tools que sí tienen dominio construido en atiende-fusion (§5.2).
//
// Principio "un solo núcleo, varios canales" (igual que domain-restaurantes): cada
// tool call se despacha EN PROCESO contra las mismas funciones de dominio que
// respaldan los Server Tools de voz (fnbAllergyGuard + repo.insertFnbOrder,
// registerContactoNoOperativo) — nunca hace un fetch HTTP a sus propios endpoints.
//
// GUARDIA REQ-AB-004 (diseño Fase 2 §4, sin excepción para este canal): el prompt
// prohíbe explícitamente afirmar que un platillo es seguro para una alergia
// declarada, y `crear_ticket_huesped_fnb` NUNCA expone un parámetro que marque
// "seguridad asegurada" — esa acción sigue exigiendo confirmación humana de cocina
// por el canal de staff ya construido (pedidosFnb.ts).
import { randomUUID } from "node:crypto";
import type { LlmGateway, LlmMessage, LlmToolCall, LlmToolDefinition } from "@atiende/agent-core";
import { registerContactoNoOperativo } from "../contacto-no-operativo.ts";
import { describeSafetyAssuranceMessage, resolveAllergyDeclared } from "../fnbAllergyGuard.ts";
import type { HotelesRepository } from "../repository.ts";
import type { ConversationMessage, FnbOrderRecord } from "../types.ts";
import type { HotelesWhatsAppTurnHandler } from "./turn-handler.ts";

// ─────────────────────────────────────────────────────────────────────────
// Disclosure de IA (REQ-HUE-006 en el origen) — el `LlmGateway` fusionado no
// tiene el concepto de `disclosureMessage`/`isFirstTurn` que sí tiene el
// `AgentRunner` del origen (gap documentado en el diseño §2.3/§3), así que se
// implementa a mano como una línea fija y obligatoria del prompt, en vez de
// confiar en que el modelo la recuerde.
// ─────────────────────────────────────────────────────────────────────────
const AI_DISCLOSURE_LINE = "Este número es atendido por un asistente automático (inteligencia artificial), no por una persona.";

export interface WhatsAppHotelesAgentConfig {
  readonly hotelName: string;
}

/** Mismo criterio que FALLBACK_CONFIG de restaurantes: valor fijo por ahora, seam
 *  aislado para que un panel de admin futuro sustituya esta función sin tocar el
 *  loop de tool-use. */
export const FALLBACK_CONFIG: WhatsAppHotelesAgentConfig = { hotelName: "este hotel" };

export function getAgentConfig(_organizationId: string, _propertyId: string): WhatsAppHotelesAgentConfig {
  return FALLBACK_CONFIG;
}

function buildSystemPrompt(config: WhatsAppHotelesAgentConfig): string {
  return `${AI_DISCLOSURE_LINE}

Eres el asistente de WhatsApp de ${config.hotelName}. Atiendes SOLO dos tipos de mensaje:

1. Peticiones de alimentos y bebidas (room service / F&B): usa SIEMPRE la herramienta
   crear_ticket_huesped_fnb para registrar el pedido, con el mensaje del huésped tal
   cual (o un resumen fiel si es muy largo), su número de habitación si lo dio, y
   marca alergia_declarada:true si el huésped menciona cualquier alergia, intolerancia
   o restricción alimentaria — incluso si no estás seguro, marca true (sobre-marcar es
   aceptable, no marcar una alergia real no lo es).
2. Cualquier otro mensaje (queja, facturación, pregunta general, algo que no sea pedir
   comida/bebida): llama a registrar_contacto_no_operativo con el motivo y un resumen
   breve, y dile al huésped que alguien del hotel le va a dar seguimiento.

REGLAS DURAS (nunca las rompas):
- NUNCA le digas al huésped que un platillo "es seguro" para su alergia o restricción
  declarada, ni antes ni después de crear el ticket. Solo un cocinero humano puede
  confirmar eso por el canal interno del hotel — tu única función es registrar el
  pedido y avisar que la cocina lo va a revisar si declaró una alergia.
- No inventes horarios, precios ni disponibilidad de platillos — no tienes esa
  información; si preguntan, di que alguien de room service se los confirma junto con
  el pedido.
- No proceses pagos ni pidas datos de tarjeta por chat. Si el huésped comparte un
  número de tarjeta de todos modos, dile que no lo necesitas y que no se guarda.
- Ejecuta la herramienta correspondiente en el MISMO turno en que tengas la
  información mínima (mensaje del pedido, o motivo del contacto) — nunca cierres un
  turno diciendo solo "voy a avisar" sin haber llamado la herramienta.
- Mensajes cortos y directos (esto es WhatsApp).`;
}

// ─────────────────────────────────────────────────────────────────────────
// TOOLS — catálogo reducido a 2 (diseño §5.2): las 3 restantes del origen real
// (housekeeping, mantenimiento, plantillas de WhatsApp) no tienen dominio
// construido en atiende-fusion todavía.
// ─────────────────────────────────────────────────────────────────────────

export const TOOLS: readonly LlmToolDefinition[] = [
  {
    name: "crear_ticket_huesped_fnb",
    description:
      "Registra una petición de alimentos/bebidas (room service) del huésped. Usa SIEMPRE esta " +
      "herramienta para pedidos de comida/bebida — nunca confirmes tú que un platillo es seguro para " +
      "una alergia declarada, eso lo hace un cocinero humano por otro canal.",
    parameters: {
      type: "object",
      properties: {
        mensaje: { type: "string", description: "Lo que pidió el huésped, tal cual o resumido fielmente." },
        habitacion: { type: "string", description: "Número de habitación, si el huésped lo dio." },
        alergia_declarada: { type: "boolean", description: "true si el huésped mencionó cualquier alergia/intolerancia/restricción alimentaria." },
      },
      required: ["mensaje"],
    },
  },
  {
    name: "registrar_contacto_no_operativo",
    description: "Para cualquier mensaje que NO sea una petición de alimentos/bebidas (queja, facturación, pregunta general, empleo, etc).",
    parameters: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Motivo breve del contacto." },
        resumen: { type: "string", description: "Resumen de lo que dijo el huésped." },
      },
      required: ["motivo"],
    },
  },
];

function isToolErrorResult(result: unknown): boolean {
  return typeof result === "object" && result !== null && "error" in result;
}

function serializeFnbOrder(order: FnbOrderRecord) {
  const safetyState = { allergyDeclared: order.allergyDeclared, kitchenConfirmedBy: order.kitchenConfirmedBy };
  return {
    id: order.id,
    alergia_declarada: order.allergyDeclared,
    mensaje_seguridad: describeSafetyAssuranceMessage(safetyState),
  };
}

interface ToolExecutionOutcome {
  readonly result: unknown;
  readonly fnbOrderId: string | null;
}

async function executeToolCall(
  repo: HotelesRepository,
  args: { readonly organizationId: string; readonly propertyId: string; readonly phone: string; readonly name: string; readonly input: Record<string, unknown> },
): Promise<ToolExecutionOutcome> {
  const { organizationId, propertyId, phone, name, input } = args;
  try {
    switch (name) {
      case "crear_ticket_huesped_fnb": {
        const mensaje = typeof input.mensaje === "string" ? input.mensaje.trim() : "";
        if (!mensaje) return { result: { error: "mensaje es requerido para registrar el pedido" }, fnbOrderId: null };
        const habitacion = typeof input.habitacion === "string" && input.habitacion.trim() ? input.habitacion.trim() : null;
        const notes = habitacion ? `Habitación declarada por el huésped vía WhatsApp: ${habitacion}` : null;
        const { allergyDeclared, declaredVia } = resolveAllergyDeclared({
          structuredFlag: input.alergia_declarada === true,
          freeTextFields: [mensaje, notes],
        });
        const order = await repo.insertFnbOrder({
          organizationId,
          propertyId,
          roomId: null,
          items: [{ nombre: mensaje }],
          notes,
          allergyDeclared,
          allergyDeclaredVia: declaredVia,
          createdBy: null, // actor system:whatsapp — sin staff humano logueado (diseño §1).
        });
        return { result: { ticket: serializeFnbOrder(order) }, fnbOrderId: order.id };
      }
      case "registrar_contacto_no_operativo": {
        const motivo = typeof input.motivo === "string" ? input.motivo.trim() : "";
        if (!motivo) return { result: { error: "motivo es requerido" }, fnbOrderId: null };
        await registerContactoNoOperativo(repo, {
          organizationId,
          propertyId,
          guestPhone: phone,
          guestName: null,
          reason: motivo,
          message: typeof input.resumen === "string" ? input.resumen.trim() : null,
          source: "whatsapp",
        });
        return { result: { ok: true }, fnbOrderId: null };
      }
      default:
        return { result: { error: `Herramienta desconocida: ${name}` }, fnbOrderId: null };
    }
  } catch (err) {
    return { result: { error: err instanceof Error ? err.message : "Error interno al ejecutar la herramienta" }, fnbOrderId: null };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// El loop de tool-use en sí — mecánica idéntica a
// domain-restaurantes/src/whatsapp/llm-turn-handler.ts.
// ─────────────────────────────────────────────────────────────────────────

export interface WhatsAppHotelesLlmAgentOptions {
  /** Rol registrado en `LlmGateway.registerLadder` para el modelo barato default. */
  readonly defaultRole: string;
  /** Rol registrado para el modelo caro de escalada, usado en el turno siguiente a
   *  un fallo real de `crear_ticket_huesped_fnb`. */
  readonly escalatedRole: string;
  readonly maxToolUseTurns?: number;
  readonly turnBudgetMs?: number;
}

function toLlmHistory(messages: readonly ConversationMessage[]): LlmMessage[] {
  return messages.map((m) => (m.role === "user" ? { role: "user" as const, content: m.content } : { role: "assistant" as const, content: m.content }));
}

export function providerFailureReply(fnbOrderId: string | null): string {
  return fnbOrderId
    ? "¡Listo! Ya registramos tu pedido, la cocina lo va a preparar."
    : "Ahorita tenemos un problema técnico, por favor intenta de nuevo en un momento.";
}

/**
 * Crea la implementación real de `HotelesWhatsAppTurnHandler` — reemplaza
 * `acknowledgeOnlyTurnHandler` sin tocar `whatsapp/inbound.ts` ni la ruta HTTP del
 * webhook.
 */
export function createLlmHotelesWhatsAppTurnHandler(repo: HotelesRepository, gateway: LlmGateway, options: WhatsAppHotelesLlmAgentOptions): HotelesWhatsAppTurnHandler {
  const maxToolUseTurns = options.maxToolUseTurns ?? 4;
  const turnBudgetMs = options.turnBudgetMs ?? 45_000;

  return {
    async handleInboundMessage({ organizationId, propertyId, phone, messages }) {
      const deadline = Date.now() + turnBudgetMs;
      const config = getAgentConfig(organizationId, propertyId);
      const systemPrompt = buildSystemPrompt(config);

      const working: LlmMessage[] = toLlmHistory(messages);
      let fnbOrderId: string | null = null;
      let huboFalloDeHerramienta = false;

      for (let turn = 0; turn < maxToolUseTurns; turn++) {
        if (Date.now() >= deadline) {
          return { reply: providerFailureReply(fnbOrderId), fnbOrderId };
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
          // residencia bloqueado — nunca se propaga un 500 crudo al huésped.
          return { reply: providerFailureReply(fnbOrderId), fnbOrderId };
        }

        const toolCalls = completion.toolCalls ?? [];
        if (toolCalls.length === 0) {
          return { reply: completion.text || "¿Me puedes repetir tu mensaje?", fnbOrderId };
        }

        working.push({ role: "assistant", content: completion.text ?? "", toolCalls });

        for (const call of toolCalls) {
          let input: Record<string, unknown> = {};
          let result: unknown;
          try {
            input = JSON.parse(call.argumentsJson || "{}") as Record<string, unknown>;
          } catch {
            result = { error: "No entendí bien los datos, ¿puedes repetir tu mensaje?" };
          }
          if (result === undefined) {
            const executed = await executeToolCall(repo, { organizationId, propertyId, phone, name: call.name, input });
            result = executed.result;
            if (executed.fnbOrderId) fnbOrderId = executed.fnbOrderId;
          }
          if (call.name === "crear_ticket_huesped_fnb" && isToolErrorResult(result)) {
            huboFalloDeHerramienta = true;
          }
          working.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
        }
      }

      if (fnbOrderId) return { reply: providerFailureReply(fnbOrderId), fnbOrderId };
      return { reply: "Se me complicó procesar tu mensaje, un momento por favor.", fnbOrderId };
    },
  };
}

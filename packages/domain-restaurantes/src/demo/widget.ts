// R-19 -- widget de chat WhatsApp para demos, SIN Meta. Un visitante conversa con el MISMO agente real de WhatsApp
// (mismo `WhatsAppTurnHandler` con el que responde el webhook: herramientas reales contra el menu real, reglas duras de
// PM, presupuesto/kill switch/costo del gateway LLM) dentro de una organizacion marcada como demo.
//
// Lo que NO hace, a proposito:
//   * No inventa respuestas: si el agente no esta disponible (sin proveedor LLM configurado) el estado es "no disponible"
//     y no hay ninguna respuesta por palabras clave. REGLA NO MAQUETAS.
//   * No envia nada a Meta: se reutiliza `handleInboundWhatsAppMessage` con `deliverReply: false`, asi que la respuesta
//     NUNCA se encola en `messaging_outbox` (el unico camino hacia Graph API). Las comandas siguen la ruta normal (cocina).
//   * No toca organizaciones reales: solo opera sobre una organizacion marcada en `restaurantes.demo_organization`.
//
// Cada visitante tiene una sesion EFIMERA (id generado por el navegador -> telefono ficticio del rango reservado `0009`),
// con topes de tasa por IP, por sesion y por organizacion (tope de costo). Ver `DEMO_WIDGET_LIMITS`.
import { createHash, randomUUID } from "node:crypto";
import type { HandoffAgentGate } from "../conversaciones/repository.ts";
import type { PrivacidadRepository } from "../privacidad/repository.ts";
import type { RestaurantesRepository } from "../repository.ts";
import { handleInboundWhatsAppMessage } from "../whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../whatsapp/turn-handler.ts";
import { DEMO_PHONE_PREFIX_WIDGET, demoPhone, type DemoRepository } from "./types.ts";

/** Topes del widget publico (cada mensaje del visitante cuesta una o varias llamadas al LLM). */
export const DEMO_WIDGET_LIMITS = {
  /** Largo maximo de un mensaje del visitante. */
  maxMessageChars: 600,
  /** Mensajes por minuto desde una misma IP. */
  perIpPerMinute: 20,
  /** Mensajes por sesion (visitante) y dia: tope de costo por demo individual. */
  perSessionPerDay: 40,
  /** Mensajes por organizacion demo y dia: tope de costo total de la demo. */
  perOrganizationPerDay: 600,
} as const;

export const DAY_SECONDS = 24 * 60 * 60;

/** `session_id` lo genera el navegador (16-64 caracteres seguros): fija la conversacion efimera. */
export const DEMO_SESSION_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Telefono ficticio determinista de la sesion: `+52 0009xxxxxx`. Mismo `session_id` = misma conversacion. */
export function demoPhoneForSession(sessionId: string): string {
  const digest = createHash("sha256").update(`demo-widget:${sessionId}`).digest();
  const sixDigits = digest.readUInt32BE(0) % 1_000_000;
  return demoPhone(DEMO_PHONE_PREFIX_WIDGET, sixDigits);
}

export type DemoWidgetMotivoNoDisponible =
  /** La organizacion no esta marcada como demo (o la base aun no tiene la migracion 037). */
  | "no_es_demo"
  /** El operador apago el widget de esta demo (`activo = false`). */
  | "apagada"
  /** No hay proveedor LLM configurado en el servidor: el agente real no puede responder. */
  | "sin_agente";

export interface DemoWidgetEstado {
  readonly disponible: boolean;
  readonly motivo: DemoWidgetMotivoNoDisponible | null;
  /** Texto honesto para el visitante cuando no esta disponible. */
  readonly mensaje: string | null;
}

export const DEMO_WIDGET_MENSAJES: Record<DemoWidgetMotivoNoDisponible, string> = {
  no_es_demo: "Esta demo no esta disponible: la organizacion no esta cargada como demo en este entorno.",
  apagada: "Esta demo esta apagada por el operador.",
  sin_agente: "Agente no disponible: requiere OPENROUTER_API_KEY (o la llave de otro proveedor LLM) configurada en el servidor.",
};

/** Estado del widget para una organizacion: demo cargada y activa + agente real disponible. */
export async function resolveDemoWidgetEstado(demo: DemoRepository | undefined, organizationId: string, agentAvailable: boolean): Promise<DemoWidgetEstado> {
  const info = demo ? await demo.findDemoOrganization(organizationId) : null;
  if (!info) return { disponible: false, motivo: "no_es_demo", mensaje: DEMO_WIDGET_MENSAJES.no_es_demo };
  if (!info.activo) return { disponible: false, motivo: "apagada", mensaje: DEMO_WIDGET_MENSAJES.apagada };
  if (!agentAvailable) return { disponible: false, motivo: "sin_agente", mensaje: DEMO_WIDGET_MENSAJES.sin_agente };
  return { disponible: true, motivo: null, mensaje: null };
}

export class DemoWidgetValidationError extends Error {}

/** Mensaje del visitante: texto no vacio, acotado y sin caracteres de control. */
export function sanitizeWidgetMessage(raw: unknown): string {
  if (typeof raw !== "string") throw new DemoWidgetValidationError("El mensaje debe ser texto.");
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (!text) throw new DemoWidgetValidationError("El mensaje esta vacio.");
  if (text.length > DEMO_WIDGET_LIMITS.maxMessageChars) throw new DemoWidgetValidationError(`El mensaje excede ${DEMO_WIDGET_LIMITS.maxMessageChars} caracteres.`);
  return text;
}

export type DemoWidgetTurnResult =
  | { readonly kind: "reply"; readonly reply: string; readonly orderId: string | null; readonly escalated: boolean }
  /** Una persona ya tiene tomada la conversacion: el agente calla y el mensaje queda para ella. */
  | { readonly kind: "humano"; readonly mensaje: string }
  /** El turno no pudo completarse (otro mensaje en curso o fallo reintentable): el visitante puede reenviar. */
  | { readonly kind: "reintentar"; readonly mensaje: string };

export interface DemoWidgetTurnDeps {
  readonly repo: RestaurantesRepository;
  readonly turnHandler: WhatsAppTurnHandler;
  readonly privacy?: PrivacidadRepository;
  readonly handoffGate?: HandoffAgentGate;
}

/**
 * Procesa UN mensaje del visitante con la misma plomeria que el webhook de WhatsApp (dedupe, lease, redaccion de datos
 * de pago, aviso de privacidad, fast-path ARCO, handoff, turno del agente), pero SIN encolar nada hacia Meta.
 * El llamador ya valido que la organizacion es demo y que el agente esta disponible, y ya aplico los topes de tasa.
 */
export async function runDemoWidgetTurn(
  deps: DemoWidgetTurnDeps,
  args: { readonly organizationId: string; readonly sessionId: string; readonly message: string; readonly propertyId?: string | null },
): Promise<DemoWidgetTurnResult> {
  if (!DEMO_SESSION_ID_RE.test(args.sessionId)) throw new DemoWidgetValidationError("session_id invalido.");
  const message = sanitizeWidgetMessage(args.message);
  const outcome = await handleInboundWhatsAppMessage(deps.repo, deps.turnHandler, {
    organizationId: args.organizationId,
    messageId: `demo-widget:${args.sessionId}:${randomUUID()}`,
    phone: demoPhoneForSession(args.sessionId),
    body: message,
    phoneNumberId: "demo-widget",
    propertyId: args.propertyId ?? null,
    ...(deps.privacy ? { privacy: deps.privacy } : {}),
    ...(deps.handoffGate ? { handoffGate: deps.handoffGate } : {}),
    deliverReply: false,
  });
  // Sin `reply` y sin fallo: el agente callo porque una persona tiene la toma abierta (cada mensaje usa un id unico, asi
  // que el ledger de entrada nunca lo da por repetido).
  if (outcome.ok && outcome.reply === undefined) {
    return { kind: "humano", mensaje: "Una persona del equipo tiene tomada esta conversacion; su mensaje quedo guardado para ella." };
  }
  if (!outcome.ok || typeof outcome.reply !== "string") {
    return { kind: "reintentar", mensaje: "No pude procesar su mensaje en este momento. Por favor intentelo de nuevo." };
  }
  return { kind: "reply", reply: outcome.reply, orderId: outcome.orderId ?? null, escalated: outcome.escalated === true };
}

// Port literal de domain-restaurantes/src/whatsapp/channel-config.ts — resolución de
// tenant multi-negocio para el webhook de WhatsApp: varios negocios de citas
// comparten la misma URL de webhook; Meta identifica el número destino en
// `entry[].changes[].value.metadata.phone_number_id`. Una sola Meta App compartida
// por la plataforma — `phone_number_id` SOLO rutea, el app_secret de plataforma
// (nunca en esta tabla) verifica todas las firmas (ver citas.whatsapp_config,
// migrations/003_waitlist_and_rate_limit.sql).
import type { CitasRepository } from "../repository.ts";

export type MetaTextMessage = {
  readonly id: string;
  readonly from: string;
  readonly type: "text";
  readonly text: { readonly body: string };
};

/** Otros eventos (statuses de entrega/lectura) no traen `messages`, se ignoran.
 * Meta puede agrupar varios entry/changes/messages; se conserva el orden del
 * payload y se procesan todos. */
export function extractMetaTextMessages(payload: unknown): MetaTextMessage[] {
  const root = payload as { entry?: unknown };
  if (!Array.isArray(root?.entry)) return [];
  const result: MetaTextMessage[] = [];
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const candidate of messages) {
        const message = candidate as Partial<MetaTextMessage>;
        if (
          message.type === "text" &&
          typeof message.id === "string" &&
          message.id.length >= 1 &&
          message.id.length <= 255 &&
          typeof message.from === "string" &&
          /^\d{7,20}$/.test(message.from) &&
          typeof message.text?.body === "string" &&
          message.text.body.trim().length >= 1 &&
          message.text.body.length <= 4000
        ) {
          result.push(message as MetaTextMessage);
        }
      }
    }
  }
  return result;
}

/** Respuesta a un mensaje interactivo (C-01): el cliente tocó un botón de respuesta
 * rápida (`button_reply`) o eligió una fila de una lista (`list_reply`). `id` es el
 * que NOSOTROS pusimos al enviar el mensaje (p. ej. `cita:confirmar:<appointmentId>`),
 * `title` el texto visible que el cliente tocó. */
export interface MetaInteractiveReply {
  readonly kind: "button_reply" | "list_reply";
  readonly id: string;
  readonly title: string;
}

/** Mensaje entrante ya normalizado: `body` es SIEMPRE texto (para un mensaje
 * interactivo es el título que tocó el cliente, de modo que un caller que no sepa de
 * botones siga procesándolo como texto en vez de descartarlo). `interactive` solo
 * viene en respuestas a botón/lista. */
export interface MetaInboundMessage {
  readonly id: string;
  readonly from: string;
  readonly body: string;
  readonly interactive?: MetaInteractiveReply;
  /** Tipo de contenido que el agente NO puede leer (nota de voz, imagen, archivo, ubicacion...). `body` va vacio: el webhook responde un aviso fijo
   * en vez de descartar el mensaje en silencio. */
  readonly noSoportado?: TipoMensajeNoSoportado;
}

export type TipoMensajeNoSoportado = "audio" | "imagen" | "video" | "documento" | "sticker" | "ubicacion" | "contacto";

const TIPOS_NO_SOPORTADOS: Readonly<Record<string, TipoMensajeNoSoportado>> = {
  audio: "audio",
  image: "imagen",
  video: "video",
  document: "documento",
  sticker: "sticker",
  location: "ubicacion",
  contacts: "contacto",
};

/** Tope de caracteres de un texto que llega al agente. Un texto mas largo se recorta (antes se descartaba en silencio). */
export const MAX_TEXTO_ENTRANTE = 4000;

const MAX_INTERACTIVE_ID_LENGTH = 256;
const MAX_INTERACTIVE_TITLE_LENGTH = 200;

/** Igual que `extractMetaTextMessages` pero además reconoce `type: "interactive"`
 * con `button_reply`/`list_reply` -- antes el toque a Confirmar/Cancelar/Reagendar
 * del recordatorio se DESCARTABA en silencio (el filtro solo aceptaba `type:
 * "text"`). Cualquier otra forma (interactive sin reply, nfm_reply, id/título
 * vacíos o fuera de límite, remitente que no es un número) se ignora igual que
 * antes: nunca lanza. Conserva el orden del payload. */
export function extractMetaInboundMessages(payload: unknown): MetaInboundMessage[] {
  const root = payload as { entry?: unknown };
  if (!Array.isArray(root?.entry)) return [];
  const result: MetaInboundMessage[] = [];
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const candidate of messages) {
        if (typeof candidate !== "object" || candidate === null) continue;
        const message = candidate as {
          id?: unknown;
          from?: unknown;
          type?: unknown;
          text?: { body?: unknown };
          interactive?: { type?: unknown; button_reply?: { id?: unknown; title?: unknown }; list_reply?: { id?: unknown; title?: unknown } };
        };
        if (typeof message.id !== "string" || message.id.length < 1 || message.id.length > 255) continue;
        if (typeof message.from !== "string" || !/^\d{7,20}$/.test(message.from)) continue;

        if (message.type === "text") {
          const body = message.text?.body;
          if (typeof body === "string" && body.trim().length >= 1) {
            result.push({ id: message.id, from: message.from, body: body.length > MAX_TEXTO_ENTRANTE ? body.slice(0, MAX_TEXTO_ENTRANTE) : body });
          }
          continue;
        }

        const noSoportado = typeof message.type === "string" ? TIPOS_NO_SOPORTADOS[message.type] : undefined;
        if (noSoportado) {
          result.push({ id: message.id, from: message.from, body: "", noSoportado });
          continue;
        }

        if (message.type === "interactive") {
          const kind = message.interactive?.type;
          if (kind !== "button_reply" && kind !== "list_reply") continue;
          const reply = kind === "button_reply" ? message.interactive?.button_reply : message.interactive?.list_reply;
          if (
            typeof reply?.id === "string" &&
            reply.id.length >= 1 &&
            reply.id.length <= MAX_INTERACTIVE_ID_LENGTH &&
            typeof reply.title === "string" &&
            reply.title.trim().length >= 1 &&
            reply.title.length <= MAX_INTERACTIVE_TITLE_LENGTH
          ) {
            result.push({ id: message.id, from: message.from, body: reply.title, interactive: { kind, id: reply.id, title: reply.title } });
          }
        }
      }
    }
  }
  return result;
}

export function extractMetaPhoneNumberId(payload: unknown): string | null {
  const root = payload as { entry?: unknown };
  const entry = Array.isArray(root?.entry) ? root.entry[0] : undefined;
  const change = Array.isArray((entry as { changes?: unknown })?.changes) ? (entry as { changes: unknown[] }).changes[0] : undefined;
  const phoneNumberId = (change as { value?: { metadata?: { phone_number_id?: unknown } } })?.value?.metadata?.phone_number_id;
  return typeof phoneNumberId === "string" && phoneNumberId.length > 0 ? phoneNumberId : null;
}

/** Resuelve qué organización de citas es dueña de un `phone_number_id` de Meta
 * Cloud API. `null` cuando el número no está configurado en la plataforma — el
 * caller debe responder ack silencioso (200), nunca reintento. */
export async function resolveOrganizationByPhoneNumberId(repo: CitasRepository, phoneNumberId: string): Promise<string | null> {
  return repo.resolveOrganizationByPhoneNumberId(phoneNumberId);
}

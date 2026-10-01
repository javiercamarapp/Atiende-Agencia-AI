// Resolución de tenant multi-restaurante para el webhook de WhatsApp — NUEVO en
// Fase 1 (diseño §4.3a): el origen hardcodea un solo RESTAURANT_ID porque solo hay un
// WhatsApp Business number real conectado. En fusión, varios restaurantes comparten
// la misma URL de webhook; Meta identifica el número destino en
// `entry[].changes[].value.metadata.phone_number_id`. Decisión de diseño explícita
// para Fase 1: una sola Meta App compartida por la plataforma — `phone_number_id`
// SOLO rutea, el app_secret de plataforma (nunca en esta tabla) verifica todas las
// firmas (ver restaurantes.whatsapp_channel_config en migrations/001).
import type { RestaurantesRepository } from "../repository.ts";
import type { WhatsAppChannelResolution } from "../types.ts";
import { formatLocationMessage, isValidCoordinate } from "./location.ts";

export type MetaTextMessage = {
  readonly id: string;
  readonly from: string;
  readonly type: "text";
  readonly text: { readonly body: string };
};

/** Port literal de extractMetaTextMessages — otros eventos (statuses de
 * entrega/lectura) no traen `messages`, se ignoran. Meta puede agrupar varios
 * entry/changes/messages; se conserva el orden del payload y se procesan todos. */
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
        const message = (candidate ?? {}) as Partial<MetaTextMessage>;
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

/** Mensaje entrante ya listo para el turno: texto del cliente, o (P33/P34) una nota que le dice al
 * modelo que llego un audio/ubicacion/archivo que NO se puede leer, para que lo pida por escrito
 * en vez de ignorar al cliente en silencio. */
export type MetaInboundMessage = { readonly id: string; readonly from: string; readonly body: string };

const UNSUPPORTED_KINDS = new Set(["audio", "voice", "image", "video", "document", "sticker", "location", "contacts"]);

function unsupportedBody(type: string): string {
  if (type === "audio" || type === "voice") {
    return "[El cliente envió una nota de voz que este asistente no puede escuchar. Pídale amablemente que escriba su mensaje por texto.]";
  }
  if (type === "location") {
    // Una ubicacion con coordenadas validas ya se convirtio en marcador (ver extractMetaInboundMessages); aqui solo
    // llegan las invalidas (ausentes, no numericas o fuera de rango): nunca se repiten ni se mandan a buscar_sucursal_cercana.
    return "[El cliente compartió su ubicación pero no trae coordenadas utilizables: pídale su colonia o una referencia cercana por texto.]";
  }
  return `[El cliente envió un archivo (${type}) que este asistente no puede abrir. Pídale amablemente que escriba su mensaje por texto.]`;
}

/** Como `extractMetaTextMessages`, pero ademas devuelve los mensajes de audio, ubicacion e imagen/
 * archivo como una nota honesta (nunca se ignoran en silencio). Reacciones, estados y mensajes de
 * sistema siguen ignorandose. Conserva el orden del payload. */
export function extractMetaInboundMessages(payload: unknown): MetaInboundMessage[] {
  const result: MetaInboundMessage[] = [];
  const root = payload as { entry?: unknown };
  if (!Array.isArray(root?.entry)) return result;
  for (const entry of root.entry) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const candidate of messages) {
        // Un elemento null o primitivo en `messages` no debe lanzar (500 y reintento infinito de Meta).
        if (candidate === null || typeof candidate !== "object") continue;
        const text = extractMetaTextMessages({ entry: [{ changes: [{ value: { messages: [candidate] } }] }] });
        if (text[0]) {
          result.push({ id: text[0].id, from: text[0].from, body: text[0].text.body });
          continue;
        }
        const message = candidate as { id?: unknown; from?: unknown; type?: unknown; location?: { latitude?: unknown; longitude?: unknown } };
        if (typeof message.id !== "string" || message.id.length < 1 || message.id.length > 255 || typeof message.from !== "string" || !/^\d{7,20}$/.test(message.from)) continue;
        // Ubicacion valida: se guarda como marcador de texto estable (ver location.ts) que el turno relee para
        // asignar sucursal por km. Con coordenadas invalidas cae a la nota honesta de abajo (nunca se adivina).
        if (message.type === "location" && isValidCoordinate(message.location?.latitude, message.location?.longitude)) {
          const { latitude, longitude } = message.location ?? {};
          result.push({ id: message.id, from: message.from, body: formatLocationMessage({ latitude: latitude as number, longitude: longitude as number }) });
        } else if (typeof message.type === "string" && UNSUPPORTED_KINDS.has(message.type)) {
          result.push({ id: message.id, from: message.from, body: unsupportedBody(message.type) });
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

/** Resuelve qué organización de restaurantes es dueña de un `phone_number_id` de
 * Meta Cloud API. `null` cuando el número no está configurado en la plataforma — el
 * caller debe responder ack silencioso (200), nunca reintento. */
export async function resolveOrganizationByPhoneNumberId(repo: RestaurantesRepository, phoneNumberId: string): Promise<string | null> {
  return repo.resolveOrganizationByPhoneNumberId(phoneNumberId);
}

/** Resuelve organizacion Y sucursal desde el `phone_number_id` que recibio el mensaje (modelo
 * PM, migracion 023: un numero por sucursal). `propertyId` es null cuando el numero es el
 * numero por defecto de la organizacion. `null` si ningun numero lo reconoce. */
export async function resolveWhatsAppChannel(repo: RestaurantesRepository, phoneNumberId: string): Promise<WhatsAppChannelResolution | null> {
  return repo.resolveWhatsAppChannel(phoneNumberId);
}

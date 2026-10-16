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
import { parsearIdDeBoton } from "./botones-confirmacion.ts";
import type { NotaDeVozEntrante } from "./nota-de-voz.ts";

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
          message.text.body.length <= META_TEXT_MAX_CHARS
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
export type MetaInboundMessage = {
  readonly id: string;
  readonly from: string;
  readonly body: string;
  /** R-32: nota de voz / audio entrante. `body` conserva la nota que pide escribir (comportamiento anterior); si hay credencial, modelo y
   * cupo, el webhook la sustituye por la transcripcion (ver nota-de-voz.ts). Solo viene el id de media: los bytes no pasan por aqui. */
  readonly audio?: NotaDeVozEntrante;
  /** B03: id del boton de un resumen («Confirmar pedido» / «Cambiar algo») que el cliente toco; solo ids de esta funcion con forma valida (ver botones-confirmacion.ts). */
  readonly botonId?: string;
  /** Instante (ms) en que Meta dice que el cliente envio el mensaje; solo para toques de boton (decide si aun cabe la ventana de 24 h). */
  readonly recibidoEnMs?: number;
};

/** Limite de caracteres de un mensaje de texto de WhatsApp (Meta). Un texto de 4,001 a 4,096 caracteres es valido: descartarlo en silencio dejaba al cliente sin respuesta. */
export const META_TEXT_MAX_CHARS = 4096;

/** Texto que el cliente toco en una respuesta de boton (`button`, plantillas con botones de respuesta rapida) o de mensaje interactivo
 * (`button_reply` / `list_reply`): se trata como el mensaje que el cliente escribio. `null` si no trae texto utilizable. */
function textoDeRespuestaInteractiva(message: { type?: unknown; button?: { text?: unknown }; interactive?: { type?: unknown; button_reply?: { title?: unknown }; list_reply?: { title?: unknown } } }): string | null {
  let texto: unknown;
  if (message.type === "button") texto = message.button?.text;
  else if (message.type === "interactive") texto = message.interactive?.type === "button_reply" ? message.interactive.button_reply?.title : message.interactive?.type === "list_reply" ? message.interactive.list_reply?.title : undefined;
  return typeof texto === "string" && texto.trim().length >= 1 && texto.length <= META_TEXT_MAX_CHARS ? texto : null;
}

const MEDIA_ID_RE = /^[0-9A-Za-z_-]{1,128}$/;

/** Nota que antepone el servidor al texto de una edicion del cliente. */
export const EDICION_NOTA = "(el cliente corrigió su mensaje anterior)";

const UNSUPPORTED_KINDS = new Set(["audio", "voice", "image", "video", "document", "sticker", "location", "contacts", "order", "unsupported"]);

/** Carrito del catalogo de WhatsApp (`type: "order"`): los ids del catalogo de Meta no existen en el menu del negocio, asi que NO se interpretan ni se inventan
 * productos; el cliente recibe respuesta (antes se ignoraba en silencio) y se le pide que escriba lo que quiere. El texto que escribio junto al carrito si llega. */
function ordenDeCatalogoBody(raw: { text?: unknown; product_items?: unknown } | undefined): string {
  const piezas = Array.isArray(raw?.product_items) ? (raw!.product_items as { quantity?: unknown }[]).reduce((n, i) => n + (typeof i?.quantity === "number" && Number.isFinite(i.quantity) ? Math.max(0, Math.floor(i.quantity)) : 0), 0) : 0;
  const nota = typeof raw?.text === "string" && raw.text.trim() !== "" ? ` Escribió junto al carrito: "${raw.text.trim().slice(0, 300)}".` : "";
  return `[El cliente envió un carrito del catálogo de WhatsApp${piezas > 0 ? ` (${piezas} pieza${piezas === 1 ? "" : "s"})` : ""} que este asistente no puede interpretar: no invente productos ni precios a partir de él.${nota} Pídale amablemente que escriba por texto qué desea pedir.]`;
}

/** Marcador de un sticker (chats reales de T7: decenas de «gracias» en sticker tras cerrar el pedido). Contestarle «no puedo abrirlo, escríbalo»
 * es absurdo: tras un pedido cerrado no se responde (ver `esSoloSticker` y el turno en inbound.ts); en medio de un pedido es un gesto, no una orden. */
export const STICKER_MARKER = "[El cliente envió un sticker (no es un pedido ni una pregunta). Tómelo como un gesto de cortesía: no le pida que lo escriba; si hay un pedido en curso, siga con lo que falta.]";

/** true si TODO lo que el cliente mando en este turno son stickers. */
export function esSoloSticker(texto: string): boolean {
  const lineas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  return lineas.length > 0 && lineas.every((l) => l === STICKER_MARKER);
}

function unsupportedBody(type: string): string {
  if (type === "audio" || type === "voice") {
    return "[El cliente envió una nota de voz que este asistente no puede escuchar. Pídale amablemente que escriba su mensaje por texto.]";
  }
  if (type === "location") {
    // Una ubicacion con coordenadas validas ya se convirtio en marcador (ver extractMetaInboundMessages); aqui solo
    // llegan las invalidas (ausentes, no numericas o fuera de rango): nunca se repiten ni se mandan a buscar_sucursal_cercana.
    return "[El cliente compartió su ubicación pero no trae coordenadas utilizables: pídale su colonia o una referencia cercana por texto.]";
  }
  if (type === "sticker") return STICKER_MARKER;
  if (type === "image") {
    return "[El cliente envió una imagen que el asistente no puede ver: si es su ubicación pida el pin de WhatsApp; si es una referencia, pida que la describa en una línea.]";
  }
  if (type === "unsupported") {
    // Meta entrega como `unsupported` lo que no puede reenviar (p. ej. un mensaje borrado o de un tipo nuevo). No se adivina su contenido.
    return "[El cliente envió o borró un mensaje que el asistente no puede leer: si había pedido o cambiado algo en él, pregúntele qué quería antes de aplicarlo.]";
  }
  return `[El cliente envió un archivo (${type}) que este asistente no puede abrir. Pídale amablemente que escriba su mensaje por texto.]`;
}

function audioDe(raw: { id?: unknown; mime_type?: unknown } | undefined): NotaDeVozEntrante | undefined {
  if (!raw || typeof raw.id !== "string" || !MEDIA_ID_RE.test(raw.id) || typeof raw.mime_type !== "string" || raw.mime_type.length === 0 || raw.mime_type.length > 100) return undefined;
  return { mediaId: raw.id, mimeType: raw.mime_type };
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
        const message = candidate as { id?: unknown; from?: unknown; type?: unknown; location?: { latitude?: unknown; longitude?: unknown }; audio?: { id?: unknown; mime_type?: unknown }; button?: { text?: unknown }; interactive?: { type?: unknown; button_reply?: { id?: unknown; title?: unknown }; list_reply?: { title?: unknown } }; timestamp?: unknown; edit?: { original_message_id?: unknown; message?: { type?: unknown; text?: { body?: unknown } } }; order?: { text?: unknown; product_items?: unknown } };
        // Edicion de un mensaje de texto (webhook `messages` con `type: "edit"`, documentado por Meta; NO probado contra Meta real). Entra como mensaje
        // nuevo con la nota de correccion: el historial no guarda el id de Meta de cada mensaje, asi que no se reemplaza el original.
        if (message.type === "edit" && typeof message.id === "string" && message.id.length >= 1 && message.id.length <= 255 && typeof message.from === "string" && /^\d{7,20}$/.test(message.from)) {
          const inner = message.edit?.message;
          const body = inner?.type === "text" && typeof inner.text?.body === "string" ? inner.text.body : "";
          if (body.trim().length >= 1 && body.length <= 4000) result.push({ id: message.id, from: message.from, body: `${EDICION_NOTA} ${body}` });
          continue;
        }
        if (typeof message.id !== "string" || message.id.length < 1 || message.id.length > 255 || typeof message.from !== "string" || !/^\d{7,20}$/.test(message.from)) continue;
        // Respuesta de boton / lista: el texto del boton es lo que el cliente "dijo" (antes se descartaba en silencio).
        const respuesta = textoDeRespuestaInteractiva(message);
        if (respuesta !== null) {
          // B03: un toque a «Confirmar pedido» / «Cambiar algo» conserva el id (atado a un resumen) para decidir despues si ese resumen sigue vigente.
          const botonId = message.type === "interactive" && message.interactive?.type === "button_reply" ? message.interactive.button_reply?.id : undefined;
          const toque = parsearIdDeBoton(botonId) ? (botonId as string) : undefined;
          const segundos = typeof message.timestamp === "string" ? Number(message.timestamp) : typeof message.timestamp === "number" ? message.timestamp : NaN;
          result.push({ id: message.id, from: message.from, body: respuesta, ...(toque ? { botonId: toque, ...(Number.isFinite(segundos) && segundos > 0 ? { recibidoEnMs: segundos * 1000 } : {}) } : {}) });
          continue;
        }
        // Ubicacion valida: se guarda como marcador de texto estable (ver location.ts) que el turno relee para
        // asignar sucursal por km. Con coordenadas invalidas cae a la nota honesta de abajo (nunca se adivina).
        if (message.type === "location" && isValidCoordinate(message.location?.latitude, message.location?.longitude)) {
          const { latitude, longitude } = message.location ?? {};
          result.push({ id: message.id, from: message.from, body: formatLocationMessage({ latitude: latitude as number, longitude: longitude as number }) });
        } else if (typeof message.type === "string" && UNSUPPORTED_KINDS.has(message.type)) {
          const audio = message.type === "audio" || message.type === "voice" ? audioDe(message.audio) : undefined;
          result.push({ id: message.id, from: message.from, body: message.type === "order" ? ordenDeCatalogoBody(message.order) : unsupportedBody(message.type), ...(audio ? { audio } : {}) });
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

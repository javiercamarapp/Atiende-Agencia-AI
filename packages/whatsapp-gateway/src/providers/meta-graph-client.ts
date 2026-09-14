// MetaGraphWhatsAppClient — adaptador de producción REAL sobre la Cloud API de
// WhatsApp Business de Meta. Formato estable documentado por Meta desde hace años:
//   POST https://graph.facebook.com/v{version}/{phone_number_id}/messages
//   Authorization: Bearer {WHATSAPP_ACCESS_TOKEN}
//   { messaging_product: "whatsapp", to, type: "text"|"interactive", ... }
//
// Este archivo NUNCA se ejercita contra la red real en tests de este monorepo — los
// tests usan `FakeWhatsAppGraphClient` (fake-graph-client.ts) o inyectan un
// `fetchImpl` falso aquí mismo. Ningún test ni build de este cambio usa un
// WHATSAPP_ACCESS_TOKEN real (ver README.md de este paquete).
import { WhatsAppConfigError, WhatsAppInvalidPayloadError, WhatsAppSendError } from "../errors.ts";
import type { OutboundWhatsAppMessagePayload, WhatsAppGraphClient, WhatsAppSendResult } from "../types.ts";

/** Versión de Graph API por defecto — estable, sin fecha de retiro anunciada al
 *  momento de escribir esto. Sobreescribible vía opción/env sin tocar código. */
export const DEFAULT_GRAPH_API_VERSION = "v21.0";

/** Límite real de Graph API para mensajes interactivos tipo "button". */
export const MAX_INTERACTIVE_BUTTONS = 3;
/** Límite real de Graph API para el título de un botón de respuesta rápida. */
export const MAX_BUTTON_TITLE_LENGTH = 20;

export interface MetaGraphWhatsAppClientOptions {
  /** `WHATSAPP_ACCESS_TOKEN` — token de acceso permanente/de sistema de la Meta App
   *  de plataforma (mismo secreto compartido que `WHATSAPP_APP_SECRET`/
   *  `WHATSAPP_VERIFY_TOKEN`, ver apps/api/src/env.ts). Requerido: este cliente
   *  jamás finge un envío sin él (falla explícito en el constructor, fail-closed). */
  readonly accessToken: string;
  readonly apiVersion?: string;
  /** Inyectable para tests — nunca se usa `fetch` global directo en producción
   *  tampoco (mismo criterio testeable que el resto del monorepo), pero el default
   *  real SÍ es el `fetch` global de Node 22+. */
  readonly fetchImpl?: typeof fetch;
  /** Solo para tests (evita tocar `graph.facebook.com` incluso con un fetch real
   *  apuntado a un servidor de prueba local). Default: `https://graph.facebook.com`. */
  readonly baseUrl?: string;
}

interface GraphApiErrorBody {
  readonly error?: { readonly message?: string; readonly type?: string; readonly code?: number };
}

interface GraphApiSuccessBody {
  readonly messages?: readonly { readonly id: string }[];
}

function buildRequestBody(message: OutboundWhatsAppMessagePayload): Record<string, unknown> {
  if (message.buttons && message.buttons.length > 0) {
    if (message.buttons.length > MAX_INTERACTIVE_BUTTONS) {
      throw new WhatsAppInvalidPayloadError(`WhatsApp Graph API acepta máximo ${MAX_INTERACTIVE_BUTTONS} botones, se recibieron ${message.buttons.length}`);
    }
    for (const title of message.buttons) {
      if (title.length === 0 || title.length > MAX_BUTTON_TITLE_LENGTH) {
        throw new WhatsAppInvalidPayloadError(`título de botón inválido (1-${MAX_BUTTON_TITLE_LENGTH} caracteres): "${title}"`);
      }
    }
    return {
      messaging_product: "whatsapp",
      to: message.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: message.body },
        action: { buttons: message.buttons.map((title, i) => ({ type: "reply", reply: { id: `btn_${i}`, title } })) },
      },
    };
  }
  return { messaging_product: "whatsapp", to: message.to, type: "text", text: { body: message.body, preview_url: false } };
}

export class MetaGraphWhatsAppClient implements WhatsAppGraphClient {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: MetaGraphWhatsAppClientOptions) {
    if (!opts.accessToken || opts.accessToken.trim().length === 0) {
      // Fail-closed en el constructor: nunca se construye un cliente "medio
      // configurado" que finja poder enviar y falle recién al primer request real.
      throw new WhatsAppConfigError("MetaGraphWhatsAppClient requiere WHATSAPP_ACCESS_TOKEN — sin él no hay integración real, nunca se finge un envío.");
    }
    this.accessToken = opts.accessToken;
    this.apiVersion = opts.apiVersion ?? DEFAULT_GRAPH_API_VERSION;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.baseUrl = opts.baseUrl ?? "https://graph.facebook.com";
  }

  async sendMessage(message: OutboundWhatsAppMessagePayload): Promise<WhatsAppSendResult> {
    if (!message.to || !message.phoneNumberId || !message.body) {
      throw new WhatsAppInvalidPayloadError("mensaje saliente incompleto: faltan to/phoneNumberId/body");
    }

    const body = buildRequestBody(message);
    const url = `${this.baseUrl}/${this.apiVersion}/${message.phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.accessToken}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Fallo de red (DNS, timeout, conexión rechazada) — siempre reintentable,
      // nunca es culpa del mensaje en sí.
      throw new WhatsAppSendError(`fallo de red al llamar Graph API: ${err instanceof Error ? err.message : String(err)}`, true);
    }

    if (!response.ok) {
      let parsed: GraphApiErrorBody | null = null;
      try {
        parsed = (await response.json()) as GraphApiErrorBody;
      } catch {
        /* body no era JSON válido, se reporta solo el status */
      }
      const detail = parsed?.error?.message ?? "(sin detalle)";
      // 429 (rate limit) y 5xx son transitorios del lado de Meta — reintentables.
      // 4xx de negocio (número inválido, plantilla no aprobada, token revocado,
      // etc.) son errores permanentes de ESTE mensaje/configuración — reintentar
      // sin cambiar nada solo repite el mismo error, así que se marca no
      // reintentable (el dispatcher lo manda a `dead` de inmediato).
      const retryable = response.status === 429 || response.status >= 500;
      throw new WhatsAppSendError(`Graph API respondió ${response.status}: ${detail}`, retryable);
    }

    let success: GraphApiSuccessBody;
    try {
      success = (await response.json()) as GraphApiSuccessBody;
    } catch (err) {
      throw new WhatsAppSendError(`Graph API respondió 2xx con body no-JSON: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    const providerMessageId = success.messages?.[0]?.id;
    if (!providerMessageId) {
      // Un 2xx sin id de mensaje es una respuesta rara/inesperada de Meta — no se
      // finge éxito sin evidencia real de que el mensaje se aceptó.
      throw new WhatsAppSendError("Graph API respondió 2xx sin messages[0].id", false);
    }
    return { providerMessageId };
  }
}

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
//
// Plantillas HSM (rubro 17 de la auditoria, R-27): la politica de Meta exige una plantilla PRE-APROBADA para
// cualquier mensaje que el negocio inicia fuera de la ventana de 24 h (p. ej. el aviso de estado de un pedido de
// voz/web, sin ningun mensaje previo del cliente). `OutboundWhatsAppMessagePayload.template` (../types.ts) lleva
// nombre/idioma/variables y `buildRequestBody` arma `type: "template"` SOLO si el operador declaro esa plantilla
// como aprobada (`approvedTemplates`, variable `WHATSAPP_APPROVED_TEMPLATES` en apps/api). Sin esa declaracion
// (el default) el mensaje sale como texto libre -- el comportamiento anterior: dentro de la ventana de 24 h se
// entrega y fuera Meta lo rechaza con un 4xx de negocio que el dispatcher marca `dead`, nunca `sent` fingido.
// Crear y aprobar la plantilla en el Business Manager de Meta sigue siendo un paso externo (ver README).
import { WhatsAppConfigError, WhatsAppInvalidPayloadError, WhatsAppSendError } from "../errors.ts";
import type { EnviadoComo, OutboundTemplate, OutboundWhatsAppMessagePayload, WhatsAppGraphClient, WhatsAppSendResult } from "../types.ts";

/** Versión de Graph API por defecto — estable, sin fecha de retiro anunciada al
 *  momento de escribir esto. Sobreescribible vía opción/env sin tocar código. */
export const DEFAULT_GRAPH_API_VERSION = "v21.0";

/** Límite real de Graph API para mensajes interactivos tipo "button". */
export const MAX_INTERACTIVE_BUTTONS = 3;
/** Límite real de Graph API para el título de un botón de respuesta rápida. */
export const MAX_BUTTON_TITLE_LENGTH = 20;
/** Límite real de Graph API para el id de un botón de respuesta rápida. */
export const MAX_BUTTON_ID_LENGTH = 256;

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
  /** Nombres de las plantillas HSM que el operador declaro APROBADAS por Meta. Solo un mensaje cuya
   *  `template.name` este aqui se envia como `type: "template"`; el resto cae a texto libre. Default: ninguna. */
  readonly approvedTemplates?: Iterable<string>;
}

interface GraphApiErrorBody {
  readonly error?: { readonly message?: string; readonly type?: string; readonly code?: number };
}

interface GraphApiSuccessBody {
  readonly messages?: readonly { readonly id: string }[];
}

/** Cuerpo `type: "template"` de la Cloud API: variables del cuerpo como `parameters` de tipo texto, en orden. */
function buildTemplateBody(to: string, template: OutboundTemplate): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      ...(template.params.length > 0 ? { components: [{ type: "body", parameters: template.params.map((text) => ({ type: "text", text })) }] } : {}),
    },
  };
}

function buildRequestBody(message: OutboundWhatsAppMessagePayload, approvedTemplates: ReadonlySet<string>): Record<string, unknown> {
  if (message.solicitarUbicacion === true) {
    if ((message.buttons && message.buttons.length > 0) || message.template) {
      throw new WhatsAppInvalidPayloadError("la solicitud de ubicacion no se combina con botones ni plantilla");
    }
    if (message.body.length === 0 || message.body.length > 1024) {
      throw new WhatsAppInvalidPayloadError("el texto de la solicitud de ubicacion debe medir de 1 a 1024 caracteres");
    }
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message.to,
      type: "interactive",
      interactive: { type: "location_request_message", body: { text: message.body }, action: { name: "send_location" } },
    };
  }
  if (message.template && (message.templateApproved === true || approvedTemplates.has(message.template.name))) {
    return buildTemplateBody(message.to, message.template);
  }
  if (message.buttons && message.buttons.length > 0) {
    if (message.buttons.length > MAX_INTERACTIVE_BUTTONS) {
      throw new WhatsAppInvalidPayloadError(`WhatsApp Graph API acepta máximo ${MAX_INTERACTIVE_BUTTONS} botones, se recibieron ${message.buttons.length}`);
    }
    const normalized = message.buttons.map((button, i) => (typeof button === "string" ? { id: `btn_${i}`, title: button } : button));
    for (const { id, title } of normalized) {
      if (title.length === 0 || title.length > MAX_BUTTON_TITLE_LENGTH) {
        throw new WhatsAppInvalidPayloadError(`título de botón inválido (1-${MAX_BUTTON_TITLE_LENGTH} caracteres): "${title}"`);
      }
      if (id.length === 0 || id.length > MAX_BUTTON_ID_LENGTH) {
        throw new WhatsAppInvalidPayloadError(`id de botón inválido (1-${MAX_BUTTON_ID_LENGTH} caracteres): "${id}"`);
      }
    }
    if (new Set(normalized.map((b) => b.id)).size !== normalized.length) {
      throw new WhatsAppInvalidPayloadError("ids de botón repetidos: Graph API exige ids únicos por mensaje");
    }
    return {
      messaging_product: "whatsapp",
      to: message.to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: message.body },
        action: { buttons: normalized.map(({ id, title }) => ({ type: "reply", reply: { id, title } })) },
      },
    };
  }
  return { messaging_product: "whatsapp", to: message.to, type: "text", text: { body: message.body, preview_url: false } };
}

/** Tipo real del cuerpo que se mando a Meta (para explicar despues un fallo de entrega). */
function enviadoComoDe(body: Record<string, unknown>): EnviadoComo {
  if (body.type === "template") return "plantilla";
  if (body.type === "interactive") {
    const tipo = (body.interactive as { type?: unknown } | undefined)?.type;
    return tipo === "location_request_message" ? "ubicacion" : "botones";
  }
  return "texto";
}

export class MetaGraphWhatsAppClient implements WhatsAppGraphClient {
  private readonly accessToken: string;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly approvedTemplates: ReadonlySet<string>;

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
    this.approvedTemplates = new Set(opts.approvedTemplates ?? []);
  }

  async sendMessage(message: OutboundWhatsAppMessagePayload): Promise<WhatsAppSendResult> {
    if (!message.to || !message.phoneNumberId || !message.body) {
      throw new WhatsAppInvalidPayloadError("mensaje saliente incompleto: faltan to/phoneNumberId/body");
    }

    const body = buildRequestBody(message, this.approvedTemplates);
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
      throw new WhatsAppSendError(`fallo de red al llamar Graph API: ${err instanceof Error ? err.message : String(err)}`, true, { proveedor: true });
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
      const graphCode = typeof parsed?.error?.code === "number" ? parsed.error.code : undefined;
      // Solo cuenta como falla del PROVEEDOR (base de la alerta de proveedor caido) lo que no es culpa del mensaje: 429, 5xx y el token invalido (190).
      // Un 4xx causado por el mensaje (numero invalido, parametro de plantilla malo) no es proveedor caido: se informa httpStatus/graphCode sin la marca.
      const proveedor = retryable || graphCode === 190;
      throw new WhatsAppSendError(`Graph API respondió ${response.status}: ${detail}`, retryable, { proveedor, httpStatus: response.status, ...(graphCode !== undefined ? { graphCode } : {}) });
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
    return { providerMessageId, enviadoComo: enviadoComoDe(body) };
  }
}

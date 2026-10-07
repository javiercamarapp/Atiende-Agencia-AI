// Simulador LOCAL de la Cloud API de WhatsApp de Meta (R-35). Banco de pruebas del
// ciclo e2e: habla HTTP real en las dos direcciones, sin credenciales ni red externa.
//
//   Saliente (nuestro sistema -> Meta): POST /{version}/{phone_number_id}/messages con
//   `Authorization: Bearer <token>`. Valida el mismo contrato que `MetaGraphWhatsAppClient`
//   arma (messaging_product, to, type text|interactive|template) y aplica la REGLA DE LA
//   VENTANA DE 24 H: un mensaje que no es plantilla hacia un numero que no escribio en las
//   ultimas 24 h se rechaza con el error 131047 (4xx de negocio, no reintentable), igual
//   que la plataforma real.
//
//   Entrante (Meta -> nuestro webhook): `deliverText`/`deliverRaw` firman el cuerpo con
//   HMAC-SHA256 (X-Hub-Signature-256) sobre los bytes exactos que se envian, mismo
//   esquema de Meta, y lo POSTean al webhook configurado. `deliverStatus` emite los
//   estados sent/delivered/read/failed de un mensaje saliente aceptado.
//
// Lo que NO es: no valida plantillas contra un catalogo real de Meta, no mide limites de
// mensajeria por calidad, no cifra medios. Un 200 de este simulador demuestra que el
// contrato HTTP/firma/ventana del sistema funciona, NO que Meta real lo aceptara.
import { createHmac } from "node:crypto";
import { serveFetchHandler } from "./http-serve.ts";
import type { RunningServer } from "./http-serve.ts";

export const WINDOW_24H_MS = 24 * 60 * 60 * 1000;
/** Codigo real de Graph API: "Re-engagement message" (fuera de la ventana de 24 h). */
export const META_ERROR_REENGAGEMENT = 131047;
/** Codigo real de Graph API: token invalido/expirado. */
export const META_ERROR_BAD_TOKEN = 190;

export interface MetaCloudSimulatorOptions {
  readonly appSecret: string;
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly verifyToken?: string;
  /** Reloj inyectable: las pruebas avanzan la ventana de 24 h sin esperar. */
  readonly now?: () => number;
  /** Mensaje de entrada a webhook para esta cuenta (ej. `${apiBase}/v1/restaurantes/whatsapp/webhook`). */
  readonly webhookUrl?: string;
}

export interface SimulatedOutboundMessage {
  readonly id: string;
  readonly phoneNumberId: string;
  readonly to: string;
  readonly type: "text" | "interactive" | "template";
  readonly text: string | null;
  readonly buttons: readonly { readonly id: string; readonly title: string }[];
  readonly templateName: string | null;
  readonly acceptedAt: number;
}

export interface SimulatedRejection {
  readonly to: string;
  readonly status: number;
  readonly code: number;
  readonly message: string;
}

export interface ForcedFailure {
  readonly status: number;
  readonly code?: number;
  readonly message?: string;
}

export interface InboundMessageInput {
  readonly from: string;
  readonly body: string;
  /** Si se omite, se genera uno unico y estable por llamada. */
  readonly id?: string;
  readonly timestampSeconds?: number;
  /** Para pruebas de ubicacion/audio etc.: sustituye el contenido tipado del mensaje. */
  readonly raw?: Record<string, unknown>;
  /** false = NO abre la ventana de 24 h (p. ej. para simular un reintento de Meta antiguo). */
  readonly opensWindow?: boolean;
}

export interface RegisteredMedia {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface WebhookDelivery {
  readonly status: number;
  readonly bodyText: string;
  /** El cuerpo EXACTO que se firmo y envio: reenviarlo tal cual es un replay. */
  readonly rawBody: string;
  readonly signature: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function graphError(status: number, code: number, message: string): Response {
  return json(status, { error: { message, type: "OAuthException", code, fbtrace_id: "SIM" } });
}

export class MetaCloudSimulator {
  readonly accepted: SimulatedOutboundMessage[] = [];
  readonly rejected: SimulatedRejection[] = [];
  readonly deliveries: WebhookDelivery[] = [];
  private readonly lastInboundAt = new Map<string, number>();
  private readonly failures: ForcedFailure[] = [];
  private readonly media = new Map<string, RegisteredMedia>();
  /** Descargas de media atendidas (paso 1: metadatos; paso 2: bytes): las pruebas de idempotencia cuentan los bytes. */
  readonly mediaRequests: { readonly step: "metadata" | "bytes"; readonly mediaId: string }[] = [];
  private server: RunningServer | null = null;
  private counter = 0;
  private offsetMs = 0;
  private webhookUrl: string | null;

  constructor(private readonly opts: MetaCloudSimulatorOptions) {
    this.webhookUrl = opts.webhookUrl ?? null;
  }

  get baseUrl(): string {
    if (!this.server) throw new Error("MetaCloudSimulator: llama start() antes de usar baseUrl");
    return this.server.baseUrl;
  }

  get phoneNumberId(): string {
    return this.opts.phoneNumberId;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = await serveFetchHandler((request) => this.handle(request));
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await s.close();
  }

  setWebhookUrl(url: string): void {
    this.webhookUrl = url;
  }

  /** Reloj del simulador: avanza el tiempo (para vencer la ventana de 24 h). */
  advanceClock(ms: number): void {
    this.offsetMs += ms;
  }

  now(): number {
    return (this.opts.now ?? Date.now)() + this.offsetMs;
  }

  /** El proximo envio saliente falla con este error (cola FIFO; un fallo por llamada). */
  failNext(failure: ForcedFailure): void {
    this.failures.push(failure);
  }

  isWindowOpen(to: string): boolean {
    const last = this.lastInboundAt.get(normalizeWaId(to));
    return last !== undefined && this.now() - last < WINDOW_24H_MS;
  }

  sign(rawBody: string): string {
    return `sha256=${createHmac("sha256", this.opts.appSecret).update(rawBody).digest("hex")}`;
  }

  /** Ultimo mensaje saliente aceptado hacia `to` (con o sin '+'). */
  lastSentTo(to: string): SimulatedOutboundMessage | undefined {
    const wa = normalizeWaId(to);
    return [...this.accepted].reverse().find((m) => normalizeWaId(m.to) === wa);
  }

  sentTo(to: string): SimulatedOutboundMessage[] {
    const wa = normalizeWaId(to);
    return this.accepted.filter((m) => normalizeWaId(m.to) === wa);
  }

  /** Registra un archivo que el cliente "subio" a WhatsApp y devuelve su media-id (el que viaja en el webhook de audio). */
  registerMedia(media: RegisteredMedia, id?: string): string {
    const mediaId = id ?? `SIMMEDIA${++this.counter}`;
    this.media.set(mediaId, media);
    return mediaId;
  }

  /** Meta -> webhook: nota de voz (type "audio", voice: true) que apunta a un media-id registrado. */
  async deliverAudio(from: string, mediaId: string, opts: { readonly id?: string; readonly mimeType?: string; readonly voice?: boolean } = {}): Promise<WebhookDelivery> {
    const mimeType = opts.mimeType ?? this.media.get(mediaId)?.mimeType ?? "audio/ogg; codecs=opus";
    return this.deliverInbound({ from, body: "", ...(opts.id ? { id: opts.id } : {}), raw: { type: "audio", audio: { id: mediaId, mime_type: mimeType, voice: opts.voice ?? true, sha256: "SIM" } } });
  }

  buildInboundPayload(input: InboundMessageInput): Record<string, unknown> {
    const id = input.id ?? `wamid.SIMIN${++this.counter}`;
    const message = input.raw
      ? { id, from: input.from.replace(/\D/g, ""), timestamp: String(input.timestampSeconds ?? Math.floor(this.now() / 1000)), ...input.raw }
      : { id, from: input.from.replace(/\D/g, ""), timestamp: String(input.timestampSeconds ?? Math.floor(this.now() / 1000)), type: "text", text: { body: input.body } };
    return {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "SIM-WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "5219990000000", phone_number_id: this.opts.phoneNumberId },
                contacts: [{ profile: { name: "Cliente Simulado" }, wa_id: input.from.replace(/\D/g, "") }],
                messages: [message],
              },
            },
          ],
        },
      ],
    };
  }

  /** Meta -> nuestro webhook: firma y entrega un mensaje entrante. */
  async deliverInbound(input: InboundMessageInput): Promise<WebhookDelivery> {
    if (input.opensWindow !== false) this.lastInboundAt.set(normalizeWaId(input.from), this.now());
    return this.postSigned(JSON.stringify(this.buildInboundPayload(input)));
  }

  async deliverText(from: string, body: string, id?: string): Promise<WebhookDelivery> {
    return this.deliverInbound({ from, body, ...(id ? { id } : {}) });
  }

  /** Reenvia EXACTAMENTE los mismos bytes (y firma) de una entrega previa: el replay de Meta. */
  async replay(delivery: WebhookDelivery): Promise<WebhookDelivery> {
    return this.postSigned(delivery.rawBody);
  }

  /** Estado de un mensaje saliente aceptado (sent/delivered/read/failed) hacia el webhook. Un `failed` puede llevar `error` (forma documentada por Meta:
   *  `statuses[].errors[]` con `code` y `title`, p. ej. 131047 "Re-engagement message"). */
  async deliverStatus(messageId: string, status: "sent" | "delivered" | "read" | "failed", error?: { readonly code: number; readonly title: string }): Promise<WebhookDelivery> {
    const sent = this.accepted.find((m) => m.id === messageId);
    if (!sent) throw new Error(`MetaCloudSimulator: el mensaje ${messageId} no fue aceptado por este simulador`);
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "SIM-WABA",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "5219990000000", phone_number_id: this.opts.phoneNumberId },
                statuses: [{ id: messageId, status, timestamp: String(Math.floor(this.now() / 1000)), recipient_id: normalizeWaId(sent.to), ...(error ? { errors: [{ code: error.code, title: error.title, message: error.title, error_data: { details: error.title } }] } : {}) }],
              },
            },
          ],
        },
      ],
    };
    return this.postSigned(JSON.stringify(payload));
  }

  /** Entrega un cuerpo con una firma arbitraria (para probar el rechazo de firmas falsas). */
  async postRaw(rawBody: string, signature: string | null): Promise<WebhookDelivery> {
    return this.post(rawBody, signature);
  }

  private async postSigned(rawBody: string): Promise<WebhookDelivery> {
    return this.post(rawBody, this.sign(rawBody));
  }

  private async post(rawBody: string, signature: string | null): Promise<WebhookDelivery> {
    if (!this.webhookUrl) throw new Error("MetaCloudSimulator: define webhookUrl antes de entregar mensajes entrantes");
    const bytes = new TextEncoder().encode(rawBody);
    const headers: Record<string, string> = { "content-type": "application/json", "content-length": String(bytes.byteLength) };
    if (signature) headers["x-hub-signature-256"] = signature;
    const response = await fetch(this.webhookUrl, { method: "POST", headers, body: bytes });
    const delivery: WebhookDelivery = { status: response.status, bodyText: await response.text(), rawBody, signature: signature ?? "" };
    this.deliveries.push(delivery);
    return delivery;
  }

  /** Handshake GET de verificacion del webhook (hub.challenge), como lo hace Meta al suscribirlo. */
  async verifyWebhookHandshake(verifyToken: string, challenge = "sim-challenge"): Promise<{ readonly status: number; readonly body: string }> {
    if (!this.webhookUrl) throw new Error("MetaCloudSimulator: define webhookUrl antes del handshake");
    const url = new URL(this.webhookUrl);
    url.searchParams.set("hub.mode", "subscribe");
    url.searchParams.set("hub.verify_token", verifyToken);
    url.searchParams.set("hub.challenge", challenge);
    const response = await fetch(url);
    return { status: response.status, body: await response.text() };
  }

  private handleMedia(request: Request, url: URL): Response | null {
    if (request.method !== "GET") return null;
    const cdn = /^\/media-cdn\/([^/]+)$/.exec(url.pathname);
    const meta = /^\/(v\d+\.\d+)\/([^/]+)$/.exec(url.pathname);
    if (!cdn && !meta) return null;
    if (request.headers.get("authorization") !== `Bearer ${this.opts.accessToken}`) return graphError(401, META_ERROR_BAD_TOKEN, "Invalid OAuth access token.");
    const mediaId = (cdn ?? meta)![cdn ? 1 : 2]!;
    const found = this.media.get(mediaId);
    if (!found) return graphError(404, 100, "Unsupported get request: media inexistente o expirada.");
    if (cdn) {
      this.mediaRequests.push({ step: "bytes", mediaId });
      return new Response(found.bytes as unknown as ConstructorParameters<typeof Response>[0], { status: 200, headers: { "content-type": found.mimeType, "content-length": String(found.bytes.byteLength) } });
    }
    this.mediaRequests.push({ step: "metadata", mediaId });
    return json(200, { messaging_product: "whatsapp", url: `${this.baseUrl}/media-cdn/${mediaId}`, mime_type: found.mimeType, sha256: "SIM", file_size: found.bytes.byteLength, id: mediaId });
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const mediaResponse = this.handleMedia(request, url);
    if (mediaResponse) return mediaResponse;
    const match = /^\/(v\d+\.\d+)\/([^/]+)\/messages$/.exec(url.pathname);
    if (request.method !== "POST" || !match) return json(404, { error: { message: "ruta no soportada por el simulador", code: 100 } });
    if (request.headers.get("authorization") !== `Bearer ${this.opts.accessToken}`) return graphError(401, META_ERROR_BAD_TOKEN, "Invalid OAuth access token.");
    if (match[2] !== this.opts.phoneNumberId) return graphError(400, 100, "Unsupported post request: phone_number_id desconocido para este simulador.");

    const forced = this.failures.shift();
    if (forced) {
      const code = forced.code ?? 131000;
      this.rejected.push({ to: "?", status: forced.status, code, message: forced.message ?? "fallo forzado por la prueba" });
      return graphError(forced.status, code, forced.message ?? "fallo forzado por la prueba");
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return graphError(400, 100, "Cuerpo no JSON.");
    }
    const to = typeof body.to === "string" ? body.to : "";
    const type = body.type;
    if (body.messaging_product !== "whatsapp" || !to) return graphError(400, 100, "messaging_product y to son obligatorios.");
    if (type !== "text" && type !== "interactive" && type !== "template") return graphError(400, 100, `type no soportado: ${String(type)}`);

    let text: string | null = null;
    let buttons: { id: string; title: string }[] = [];
    let templateName: string | null = null;
    if (type === "text") {
      text = ((body.text as { body?: unknown } | undefined)?.body as string | undefined) ?? null;
      if (!text) return graphError(400, 100, "text.body es obligatorio.");
    } else if (type === "interactive") {
      const interactive = body.interactive as { type?: string; body?: { text?: string }; action?: { name?: string; buttons?: { reply?: { id: string; title: string } }[] } } | undefined;
      text = interactive?.body?.text ?? null;
      if (interactive?.type === "location_request_message") {
        // Solicitud de ubicacion: solo texto + `action.name = send_location` (un toque del cliente), sin botones de respuesta.
        if (!text || interactive.action?.name !== "send_location") return graphError(400, 100, "interactive/location_request_message invalido (body.text y action.name = send_location).");
      } else {
        buttons = (interactive?.action?.buttons ?? []).map((b) => b.reply).filter((r): r is { id: string; title: string } => !!r);
        if (!text || buttons.length === 0 || buttons.length > 3) return graphError(400, 100, "interactive/button invalido (1-3 botones y body.text).");
      }
    } else {
      templateName = ((body.template as { name?: unknown } | undefined)?.name as string | undefined) ?? null;
      if (!templateName) return graphError(400, 100, "template.name es obligatorio.");
    }

    // Regla de oro de la plataforma: solo una PLANTILLA puede iniciar o reabrir conversacion.
    if (type !== "template" && !this.isWindowOpen(to)) {
      const message = "Re-engagement message: la ventana de 24 h esta cerrada; solo se permite una plantilla aprobada.";
      this.rejected.push({ to, status: 400, code: META_ERROR_REENGAGEMENT, message });
      return graphError(400, META_ERROR_REENGAGEMENT, message);
    }

    const id = `wamid.SIMOUT${++this.counter}`;
    this.accepted.push({ id, phoneNumberId: match[2]!, to, type, text, buttons, templateName, acceptedAt: this.now() });
    return json(200, { messaging_product: "whatsapp", contacts: [{ input: to, wa_id: normalizeWaId(to) }], messages: [{ id }] });
  }
}

/** Meta usa wa_id sin '+' ni separadores. Para Mexico, "521XXXXXXXXXX" y "52XXXXXXXXXX" son el mismo contacto
 *  (Meta normaliza ambos): se unifican al segundo para que la ventana de 24 h no dependa de la variante. */
export function normalizeWaId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits;
}

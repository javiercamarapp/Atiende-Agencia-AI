// Simulador LOCAL de la Cloud API de WhatsApp de Meta (R-35). Banco de pruebas del
// ciclo e2e: habla HTTP real en las dos direcciones, sin credenciales ni red externa.
//
//   Saliente (nuestro sistema -> Meta): POST /{version}/{phone_number_id}/messages con
//   `Authorization: Bearer <token>`. Valida el mismo contrato que `MetaGraphWhatsAppClient`
//   arma (messaging_product, to, type text|interactive|template) y aplica la REGLA DE LA
//   VENTANA DE 24 H: un mensaje que no es plantilla hacia un numero que no escribio en las
//   ultimas 24 h se rechaza con el error 131047 (4xx de negocio, no reintentable), igual
//   que la plataforma real. La ventana se lleva POR PAR numero-cliente (como Meta): un cliente que
//   escribio al numero A no abre ventana en el numero B del mismo negocio.
//
//   Entrante (Meta -> nuestro webhook): `deliverText`/`deliverRaw` firman el cuerpo con
//   HMAC-SHA256 (X-Hub-Signature-256) sobre los bytes exactos que se envian, mismo
//   esquema de Meta, y lo POSTean al webhook configurado. `deliverStatus` emite los
//   estados sent/delivered/read/failed de un mensaje saliente aceptado.
//
//   Multinumero: `phoneNumberIds` registra varios numeros del negocio; `inbound` elige el numero
//   destino y `inboundLote` arma UN solo POST firmado con varios `changes` (uno por numero).
//   Coexistencia (app del negocio + API): `ecoDeApp`, `history` y `stateSync` arman los campos
//   `smb_message_echoes`, `history` y `smb_app_state_sync`. Sus formas son aproximaciones NO
//   verificadas contra un payload real de Meta (ver comentarios de cada metodo).
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
  /** Numero unico (compatibilidad). Equivale a `phoneNumberIds: [phoneNumberId]`. */
  readonly phoneNumberId?: string;
  /** Todos los numeros del negocio que este simulador atiende (el primero es el predeterminado). Se combinan con `phoneNumberId`. */
  readonly phoneNumberIds?: readonly string[];
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
  /** Numero de WhatsApp Business DESTINO (metadata.phone_number_id). Si se omite, el primero del simulador. */
  readonly phoneNumberId?: string;
  /** Si se omite, se genera uno unico y estable por llamada. */
  readonly id?: string;
  readonly timestampSeconds?: number;
  /** Para pruebas de ubicacion/audio etc.: sustituye el contenido tipado del mensaje. */
  readonly raw?: Record<string, unknown>;
  /** false = NO abre la ventana de 24 h (p. ej. para simular un reintento de Meta antiguo). */
  readonly opensWindow?: boolean;
}

export interface EcoDeAppInput {
  readonly phoneNumberId?: string;
  /** Cliente al que el dueno le escribio desde la app de WhatsApp Business. */
  readonly to: string;
  readonly text: string;
  readonly id?: string;
  readonly timestampSeconds?: number;
}

export interface HistoryInput {
  readonly phoneNumberId?: string;
  /** Hilos de la conversacion historica: un cliente y sus mensajes (de el o del negocio). */
  readonly threads: readonly { readonly customer: string; readonly messages: readonly { readonly fromBusiness?: boolean; readonly text: string; readonly id?: string; readonly timestampSeconds?: number }[] }[];
  readonly phase?: number;
  readonly chunkOrder?: number;
  readonly progress?: number;
}

export interface StateSyncInput {
  readonly phoneNumberId?: string;
  readonly contacts: readonly { readonly fullName: string; readonly phone: string; readonly action?: "add" | "remove" }[];
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
  /** Ventana de 24 h por PAR `phone_number_id|wa_id`: escribirle al numero A no abre ventana en el B. */
  private readonly lastInboundAt = new Map<string, number>();
  private readonly numberIds: string[];
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
    this.numberIds = [...new Set([...(opts.phoneNumberId ? [opts.phoneNumberId] : []), ...(opts.phoneNumberIds ?? [])])];
    if (this.numberIds.length === 0) throw new Error("MetaCloudSimulator: define phoneNumberId o phoneNumberIds");
  }

  get baseUrl(): string {
    if (!this.server) throw new Error("MetaCloudSimulator: llama start() antes de usar baseUrl");
    return this.server.baseUrl;
  }

  /** El numero predeterminado (el primero). */
  get phoneNumberId(): string {
    return this.numberIds[0]!;
  }

  get phoneNumberIds(): readonly string[] {
    return this.numberIds;
  }

  /** Registra otro numero del negocio en caliente (para bancos que arman el simulador antes de conocer todas las sucursales). */
  addPhoneNumberId(phoneNumberId: string): void {
    if (!this.numberIds.includes(phoneNumberId)) this.numberIds.push(phoneNumberId);
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

  /** Ventana del par numero-cliente. Sin `phoneNumberId`, el numero predeterminado. */
  isWindowOpen(to: string, phoneNumberId: string = this.phoneNumberId): boolean {
    const last = this.lastInboundAt.get(windowKey(phoneNumberId, to));
    return last !== undefined && this.now() - last < WINDOW_24H_MS;
  }

  sign(rawBody: string): string {
    return `sha256=${createHmac("sha256", this.opts.appSecret).update(rawBody).digest("hex")}`;
  }

  /** Ultimo mensaje saliente aceptado hacia `to` (con o sin '+'), opcionalmente solo por un numero. */
  lastSentTo(to: string, phoneNumberId?: string): SimulatedOutboundMessage | undefined {
    return this.sentTo(to, phoneNumberId).at(-1);
  }

  sentTo(to: string, phoneNumberId?: string): SimulatedOutboundMessage[] {
    const wa = normalizeWaId(to);
    return this.accepted.filter((m) => normalizeWaId(m.to) === wa && (phoneNumberId === undefined || m.phoneNumberId === phoneNumberId));
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

  private wrap(changes: readonly unknown[]): Record<string, unknown> {
    return { object: "whatsapp_business_account", entry: [{ id: "SIM-WABA", changes }] };
  }

  private metadata(phoneNumberId: string): Record<string, unknown> {
    return { display_phone_number: "5219990000000", phone_number_id: phoneNumberId };
  }

  private buildMessage(input: InboundMessageInput): Record<string, unknown> {
    const id = input.id ?? `wamid.SIMIN${++this.counter}`;
    const base = { id, from: input.from.replace(/\D/g, ""), timestamp: String(input.timestampSeconds ?? Math.floor(this.now() / 1000)) };
    return input.raw ? { ...base, ...input.raw } : { ...base, type: "text", text: { body: input.body } };
  }

  private messagesChange(phoneNumberId: string, inputs: readonly InboundMessageInput[]): Record<string, unknown> {
    const messages = inputs.map((i) => this.buildMessage(i));
    return {
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: this.metadata(phoneNumberId),
        contacts: inputs.map((i) => ({ profile: { name: "Cliente Simulado" }, wa_id: i.from.replace(/\D/g, "") })),
        messages,
      },
    };
  }

  buildInboundPayload(input: InboundMessageInput): Record<string, unknown> {
    return this.wrap([this.messagesChange(input.phoneNumberId ?? this.phoneNumberId, [input])]);
  }

  private openWindow(input: InboundMessageInput): void {
    if (input.opensWindow !== false) this.lastInboundAt.set(windowKey(input.phoneNumberId ?? this.phoneNumberId, input.from), this.now());
  }

  /** Meta -> nuestro webhook: firma y entrega un mensaje entrante. */
  async deliverInbound(input: InboundMessageInput): Promise<WebhookDelivery> {
    this.openWindow(input);
    return this.postSigned(JSON.stringify(this.buildInboundPayload(input)));
  }

  /** Alias corto de `deliverInbound` (acepta `phoneNumberId` destino). */
  async inbound(input: InboundMessageInput): Promise<WebhookDelivery> {
    return this.deliverInbound(input);
  }

  /** UN solo POST firmado con varios `changes`, uno por numero destino (Meta agrupa asi a veces). Cada mensaje abre la ventana de SU par numero-cliente. */
  async inboundLote(inputs: readonly InboundMessageInput[]): Promise<WebhookDelivery> {
    const porNumero = new Map<string, InboundMessageInput[]>();
    for (const input of inputs) {
      const pnid = input.phoneNumberId ?? this.phoneNumberId;
      porNumero.set(pnid, [...(porNumero.get(pnid) ?? []), input]);
      this.openWindow(input);
    }
    const changes = [...porNumero.entries()].map(([pnid, group]) => this.messagesChange(pnid, group));
    return this.postSigned(JSON.stringify(this.wrap(changes)));
  }

  /**
   * Eco de un mensaje que el dueno envio DESDE LA APP de WhatsApp Business (coexistencia): `field: "smb_message_echoes"`.
   *
   * NO VERIFICADO: la forma exacta de `value.message_echoes[]` (claves `from`, `to`, `id`, `timestamp`, `type`, `text`) debe
   * confrontarse contra la documentacion de Meta (OFI-1:
   * https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users) o un payload real
   * ANTES del piloto. Este metodo solo ejercita el camino de ecos del sistema, no demuestra que Meta lo emita asi.
   * Un eco NO abre la ventana de 24 h del cliente (no es un mensaje del cliente).
   */
  async ecoDeApp(input: EcoDeAppInput): Promise<WebhookDelivery> {
    const pnid = input.phoneNumberId ?? this.phoneNumberId;
    const change = {
      field: "smb_message_echoes",
      value: {
        messaging_product: "whatsapp",
        metadata: this.metadata(pnid),
        message_echoes: [
          { from: "5219990000000", to: input.to.replace(/\D/g, ""), id: input.id ?? `wamid.SIMECHO${++this.counter}`, timestamp: String(input.timestampSeconds ?? Math.floor(this.now() / 1000)), type: "text", text: { body: input.text } },
        ],
      },
    };
    return this.postSigned(JSON.stringify(this.wrap([change])));
  }

  /**
   * Historial de conversaciones que Meta comparte tras el onboarding de la app (`field: "history"`).
   * NO VERIFICADO: la forma (`value.history[].metadata{phase,chunk_order,progress}` y `threads[].messages[]`) es una aproximacion
   * minima; confrontarla con la documentacion de Meta (OFI-1) antes del piloto.
   */
  async history(input: HistoryInput): Promise<WebhookDelivery> {
    const pnid = input.phoneNumberId ?? this.phoneNumberId;
    const change = {
      field: "history",
      value: {
        messaging_product: "whatsapp",
        metadata: this.metadata(pnid),
        history: [
          {
            metadata: { phase: input.phase ?? 0, chunk_order: input.chunkOrder ?? 1, progress: input.progress ?? 100 },
            threads: input.threads.map((t) => ({
              id: t.customer.replace(/\D/g, ""),
              messages: t.messages.map((m) => ({
                from: m.fromBusiness ? "5219990000000" : t.customer.replace(/\D/g, ""),
                id: m.id ?? `wamid.SIMHIST${++this.counter}`,
                timestamp: String(m.timestampSeconds ?? Math.floor(this.now() / 1000)),
                type: "text",
                text: { body: m.text },
                history_context: { status: "READ" },
              })),
            })),
          },
        ],
      },
    };
    return this.postSigned(JSON.stringify(this.wrap([change])));
  }

  /**
   * Sincronizacion de contactos de la app (`field: "smb_app_state_sync"`).
   * NO VERIFICADO: forma minima aproximada (`value.state_sync[]` con `type: "contact"`); confrontar con OFI-1 antes del piloto.
   */
  async stateSync(input: StateSyncInput): Promise<WebhookDelivery> {
    const pnid = input.phoneNumberId ?? this.phoneNumberId;
    const change = {
      field: "smb_app_state_sync",
      value: {
        messaging_product: "whatsapp",
        metadata: this.metadata(pnid),
        state_sync: input.contacts.map((c) => ({ type: "contact", contact: { full_name: c.fullName, phone_number: c.phone.replace(/\D/g, "") }, action: c.action ?? "add", metadata: { timestamp: String(Math.floor(this.now() / 1000)) } })),
      },
    };
    return this.postSigned(JSON.stringify(this.wrap([change])));
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
                metadata: { display_phone_number: "5219990000000", phone_number_id: sent.phoneNumberId },
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
    if (!this.numberIds.includes(match[2]!)) return graphError(400, 100, "Unsupported post request: phone_number_id desconocido para este simulador.");

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
    if (type !== "template" && !this.isWindowOpen(to, match[2]!)) {
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
function windowKey(phoneNumberId: string, customer: string): string {
  return `${phoneNumberId}|${normalizeWaId(customer)}`;
}

export function normalizeWaId(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits;
}

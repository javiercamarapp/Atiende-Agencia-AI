// ═══════════════════════════════════════════════════════════════════════════
// GptLiveVoiceProvider — implementación REAL de VoiceProvider para GPT-Live-1
// (OpenAI).
//
// ESTADO REAL VERIFICADO POR BÚSQUEDA WEB (12-sep-2026): GPT-Live-1 lanzó su
// API pública el 10-sep-2026 (ya NO es lista de espera) — modelo de voz
// full-duplex (escucha y habla simultáneo), $0.05/min facturado por segundo,
// delega razonamiento/tool-calling a un modelo BACKEND separado.
//
// Fuentes reales consultadas para el contrato de abajo (todas developers.openai.com
// salvo donde se indica, todas leídas el 12-sep-2026):
//   - /api/docs/guides/live                              → flujo general, session.started
//   - /api/docs/guides/realtime                          → ephemeral client secrets, header
//                                                           OpenAI-Safety-Identifier
//   - /api/docs/models/gpt-live-1                         → model id, $0.05/min por segundo,
//                                                           delegación a backend
//   - /api/reference/.../realtime/subresources/client_secrets/methods/create
//                                                          → POST /v1/realtime/client_secrets,
//                                                            shape { session, expires_after } →
//                                                            { value, expires_at, session }
//   - /api/docs/guides/live-partner-integrations          → LiveKit/Twilio/Telnyx/Daily-Pipecat
//                                                            como integraciones de socio para
//                                                            telefonía, sin confirmar un SIP
//                                                            trunk nativo de OpenAI para
//                                                            gpt-live-1 específicamente
//   - comunidad de desarrolladores de OpenAI (varios hilos, sep-2026) + littelm/webrtchacks
//     → intercambio SDP real: POST /v1/realtime/calls con
//       Authorization: Bearer <client_secret efímero> + Content-Type: application/sdp
//       (endpoints /v1/realtime?model= y /v1/realtime/sessions quedaron pre-GA/deprecados)
//
// DOS COSAS quedan documentadas como límite conocido y FALLAN CERRADO en vez
// de inventarse (ver `assertNativeSipTelephonySupported` y
// `getAgentConfig`/`updateAgentConfig` abajo) — la búsqueda no fue concluyente
// sobre un endpoint de agente persistente ni sobre un SIP trunk nativo de
// OpenAI (a diferencia de las integraciones de socio, que sí están
// documentadas pero requieren un media server de terceros, fuera de alcance
// de esta activación).
// ═══════════════════════════════════════════════════════════════════════════

import type {
  SignedVoiceUrl,
  StartVoiceSessionRequest,
  UpdateVoiceAgentConfig,
  VoiceAgentConfig,
  VoiceListing,
  VoiceProvider,
  VoiceSessionHandle,
  VoiceTenantContext,
} from '../types.js';
import { VoiceProviderConfigError, VoiceProviderError } from '../errors.js';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';
const SDP_EXCHANGE_URL = 'https://api.openai.com/v1/realtime/calls';
export const GPT_LIVE_MODEL = 'gpt-live-1';

/** Duración por defecto del ephemeral client secret — 600s es el default real
 *  documentado por la API (rango real permitido: 10-7200s). */
const DEFAULT_EXPIRES_AFTER_SECONDS = 600;

/**
 * Precio real confirmado: $0.05/min de la capa de voz, facturado POR
 * SEGUNDO — a diferencia del `LlmCostEstimator` de agent-core (que estima en
 * tokens), este estimador es en segundos de audio. `voice-gateway` no tiene
 * (todavía) su propio store de presupuesto tipo `agent-core/gateway/budget.ts`
 * — este export es un estimador PURO, listo para conectarse a un ledger real
 * el día que exista, sin fabricar aquí infraestructura de reserva que este
 * paquete no tiene hoy.
 */
export const GPT_LIVE_PRICE_USD_PER_MINUTE = 0.05;

export function estimateGptLiveCostUsd(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error('gptlive: duración inválida para estimar costo (segundos >= 0)');
  }
  return Number(((durationSeconds / 60) * GPT_LIVE_PRICE_USD_PER_MINUTE).toFixed(6));
}

/**
 * Catálogo real de voces del pipeline de audio realtime/live de OpenAI —
 * confirmado en la referencia de `client_secrets` (`audio.output.voice`).
 * A diferencia de ElevenLabs (catálogo grande, paginado, por idioma/acento),
 * estas son voces/personas MULTILINGÜES fijas — no existe un endpoint de
 * catálogo dinámico ni un filtro por idioma real en la API, así que
 * `listVoices` aquí ignora `languageFilter` a propósito (documentado, no un
 * bug) y siempre devuelve el mismo catálogo fijo.
 */
const GPT_LIVE_VOICES: readonly { id: string }[] = [
  { id: 'alloy' },
  { id: 'ash' },
  { id: 'ballad' },
  { id: 'coral' },
  { id: 'echo' },
  { id: 'sage' },
  { id: 'shimmer' },
  { id: 'verse' },
  { id: 'marin' },
  { id: 'cedar' },
];

// ---- shapes reales de la REST API de OpenAI ------------------------------

interface GptLiveClientSecretResponse {
  value: string;
  /** unix seconds */
  expires_at: number;
}

// ---- superficie WebRTC (boundary mínimo, sin arrastrar lib.dom) -----------
//
// Este paquete corre en Node (tsconfig sin lib "dom"), así que no puede
// referenciar los tipos DOM reales `RTCPeerConnection`/`MediaStream`. Se
// modela aquí SOLO la superficie estructural que `startSession` necesita,
// para poder inyectar un fake en tests sin arrastrar lib.dom.ts a todo el
// paquete. En un bundle de navegador real, el `RTCPeerConnection` nativo
// satisface esta forma sin ningún adaptador (duck typing).

export interface GptLiveSessionDescription {
  readonly sdp?: string;
  readonly type: string;
}

export interface GptLiveDataChannel {
  send(data: string): void;
  addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
  close(): void;
}

export interface GptLivePeerConnection {
  createDataChannel(label: string): GptLiveDataChannel;
  addTrack(track: unknown, stream: GptLiveMediaStream): void;
  createOffer(): Promise<GptLiveSessionDescription>;
  setLocalDescription(desc: GptLiveSessionDescription): Promise<void>;
  setRemoteDescription(desc: GptLiveSessionDescription): Promise<void>;
  close(): void;
}

export interface GptLiveMediaStream {
  getTracks(): unknown[];
}

function defaultCreatePeerConnection(): GptLivePeerConnection {
  const Ctor = (globalThis as { RTCPeerConnection?: new () => GptLivePeerConnection }).RTCPeerConnection;
  if (!Ctor) {
    throw new VoiceProviderConfigError(
      'gptlive: "startSession" requiere un entorno con RTCPeerConnection real (navegador) — ' +
        'no hay SDK propietario confirmado de GPT-Live-1 para negociar WebRTC en Node; ' +
        'inyecta `createPeerConnection` para pruebas o un polyfill en un bridge de servidor.',
    );
  }
  return new Ctor();
}

async function defaultRequestMicrophone(): Promise<GptLiveMediaStream> {
  const nav = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: (c: unknown) => Promise<GptLiveMediaStream> } } }).navigator;
  const getUserMedia = nav?.mediaDevices?.getUserMedia;
  if (!getUserMedia) {
    throw new VoiceProviderConfigError(
      'gptlive: "startSession" requiere `navigator.mediaDevices.getUserMedia` real (navegador) — ' +
        'inyecta `requestMicrophone` para pruebas o para un bridge de servidor con su propio audio.',
    );
  }
  return getUserMedia({ audio: true });
}

// ---- opciones de construcción ---------------------------------------------

/**
 * Solo se construye dentro de un backend (Edge Function / apps de la API) —
 * mismo principio que `ElevenLabsServerOptions`: la API key nunca vive en el
 * navegador. `apiKeyProvider` es async a propósito, mismo puerto que
 * ElevenLabs: en producción resuelve contra Supabase Vault, en desarrollo
 * puede leer `process.env.OPENAI_API_KEY`.
 *
 * DECISIÓN DE SCOPE DE LA API KEY (confirmada contra la documentación real,
 * no inventada): la creación de un ephemeral client secret
 * (`POST /v1/realtime/client_secrets`) es una llamada de servidor estándar
 * autenticada con `Authorization: Bearer <API key de proyecto>` — la
 * documentación NO menciona un scope/permiso separado para GPT-Live-1 frente
 * al resto de la API de OpenAI (a diferencia de, p.ej., una key restringida a
 * un proyecto concreto en la consola de OpenAI, que es una capacidad general
 * de cualquier key, no específica de voz). Por eso este proveedor REUTILIZA
 * la misma `OPENAI_API_KEY` que ya usa `@atiende/agent-core` para el
 * `LlmGateway` (ver `apps/api/src/env.ts`) — no se introduce una env var
 * nueva para la key. Si en el futuro OpenAI documenta un scope dedicado para
 * Realtime/Live, este `apiKeyProvider` es el único punto que habría que
 * cambiar (misma razón por la que ElevenLabs recibe la key por callback y no
 * por lectura directa de `process.env` dentro de la clase).
 */
export interface GptLiveServerOptions {
  mode: 'server';
  apiKeyProvider: () => Promise<string>;
  fetchImpl?: typeof fetch;
  /**
   * Header real `OpenAI-Safety-Identifier` (confirmado en la guía de
   * Realtime): un identificador ESTABLE y anonimizado por sesión — la propia
   * documentación de OpenAI pide explícitamente NO usar email ni otro dato
   * personal. Por defecto se deriva de `organizationId`+`propertyId` (nunca
   * PII real de un usuario final, que esta capa no conoce). Un llamador que
   * quiera un identificador propio (p.ej. hash de usuario final) lo
   * sobreescribe aquí.
   */
  safetyIdentifierProvider?: (tenant: VoiceTenantContext) => string;
  /** Vida del ephemeral client secret en segundos (rango real de la API:
   *  10-7200; default real de la API: 600). */
  expiresAfterSeconds?: number;
}

/**
 * Se construye en el bundle del navegador (o un bridge de telefonía sin key
 * propia) — mismo espíritu que `ElevenLabsClientOptions`. `resolveSignedUrl`
 * llama al backend propio, que por dentro corre la instancia en modo
 * 'server'.
 *
 * `createPeerConnection`/`requestMicrophone` son inyectables por la MISMA
 * razón que `fetchImpl` en el resto del monorepo: en tests (Node, sin
 * navegador real) se inyecta un fake; en un bundle de navegador real, los
 * defaults (`RTCPeerConnection`/`navigator.mediaDevices.getUserMedia`
 * globales) ya sirven sin configurar nada.
 */
export interface GptLiveClientOptions {
  mode: 'client';
  resolveSignedUrl: (tenant: VoiceTenantContext) => Promise<SignedVoiceUrl>;
  createPeerConnection?: () => GptLivePeerConnection;
  requestMicrophone?: () => Promise<GptLiveMediaStream>;
  fetchImpl?: typeof fetch;
}

export type GptLiveVoiceProviderOptions = GptLiveServerOptions | GptLiveClientOptions;

function defaultSafetyIdentifier(tenant: VoiceTenantContext): string {
  // Identificador estable y sin PII — puerto directo de la exigencia real de
  // OpenAI ("a stable, privacy-preserving identifier"), nunca el email de un
  // huésped/comensal real.
  return `${tenant.vertical}:${tenant.organizationId}:${tenant.propertyId}`;
}

export class GptLiveVoiceProvider implements VoiceProvider {
  readonly id = 'gptlive';

  constructor(private readonly opts: GptLiveVoiceProviderOptions) {}

  private assertServerMode(method: string): GptLiveServerOptions {
    if (this.opts.mode !== 'server') {
      throw new VoiceProviderConfigError(
        `gptlive: "${method}" requiere modo servidor (con acceso a OPENAI_API_KEY vía Vault) — ` +
          `esta instancia está en modo cliente y nunca debe tener la key. Llama a este método desde tu backend, no desde el navegador.`,
      );
    }
    return this.opts;
  }

  // ---- superficie de servidor ---------------------------------------------

  async getSignedUrl(tenant: VoiceTenantContext): Promise<SignedVoiceUrl> {
    if (this.opts.mode === 'client') return this.opts.resolveSignedUrl(tenant);

    const { apiKeyProvider, fetchImpl, safetyIdentifierProvider, expiresAfterSeconds } = this.assertServerMode('getSignedUrl');
    const apiKey = await apiKeyProvider();
    const doFetch = fetchImpl ?? fetch;
    const safetyIdentifier = (safetyIdentifierProvider ?? defaultSafetyIdentifier)(tenant);

    const res = await doFetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Safety-Identifier': safetyIdentifier,
      },
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: expiresAfterSeconds ?? DEFAULT_EXPIRES_AFTER_SECONDS },
        session: { type: 'realtime', model: GPT_LIVE_MODEL },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`GPT-Live-1 ${res.status} en getSignedUrl: ${body.slice(0, 300)}`, res.status >= 500);
    }

    const data = (await res.json()) as GptLiveClientSecretResponse;
    // NOTA DE DISEÑO: a diferencia de ElevenLabs (donde `url` es una URL
    // wss:// directamente utilizable), GPT-Live-1 entrega un CLIENT SECRET
    // efímero (`ek_...`) que se usa como credencial Bearer al negociar SDP
    // contra `/v1/realtime/calls` (WebRTC) — no una URL dereferenciable. Se
    // reutiliza el campo `url` del contrato compartido para transportar ese
    // secreto (documentado aquí explícitamente para que nadie lo confunda
    // con una URL real) en vez de rediseñar `SignedVoiceUrl` — mismo
    // principio de "no tocar el contrato compartido" que ya sigue este
    // paquete para `VoiceTranscriptEvent`.
    return { url: data.value, expiresAt: data.expires_at * 1000 };
  }

  async listVoices(_languageFilter: string): Promise<VoiceListing[]> {
    this.assertServerMode('listVoices');
    // Catálogo fijo, sin llamada de red real — ver comentario de
    // `GPT_LIVE_VOICES` arriba sobre por qué `languageFilter` se ignora.
    return GPT_LIVE_VOICES.map((v) => ({
      voiceId: v.id,
      name: v.id,
      language: 'multi',
    }));
  }

  async getAgentConfig(_tenant: VoiceTenantContext): Promise<VoiceAgentConfig> {
    this.assertServerMode('getAgentConfig');
    throw new VoiceProviderConfigError(
      'gptlive: "getAgentConfig" no está soportado — la búsqueda de documentación real (12-sep-2026) no encontró ' +
        'un recurso persistente de "agente"/"assistant" con GET/PATCH por id para GPT-Live-1, a diferencia de ' +
        'ElevenLabs (Conversational AI Agent). La config real (voz, instrucciones, temperatura) se manda POR SESIÓN ' +
        'al crear el ephemeral client secret (ver `getSignedUrl`), no se lee de un id de agente guardado del lado ' +
        'de OpenAI. Fail-closed deliberado en vez de inventar un endpoint que no se pudo confirmar.',
    );
  }

  async updateAgentConfig(_update: UpdateVoiceAgentConfig): Promise<void> {
    this.assertServerMode('updateAgentConfig');
    throw new VoiceProviderConfigError(
      'gptlive: "updateAgentConfig" no está soportado — mismo motivo que "getAgentConfig": no hay un recurso de ' +
        'agente persistente confirmado en la documentación real de GPT-Live-1 al que aplicar un PATCH. La config ' +
        'de una sesión se define al pedir el ephemeral client secret (`getSignedUrl`), no se actualiza contra un ' +
        'id guardado. Fail-closed deliberado.',
    );
  }

  /**
   * Extensión NO parte de la interfaz `VoiceProvider` compartida — telefonía
   * SIP real es el ÚNICO camino que la tarea autorizó a dejar fail-closed si
   * la documentación no fuera concluyente, y no lo fue: OpenAI documenta
   * integraciones de SOCIO (LiveKit, Twilio, Telnyx, Daily/Pipecat) para
   * telefonía con GPT-Live-1, pero la búsqueda no pudo confirmar un SIP
   * trunk nativo y directo de OpenAI (análogo a `realtime-sip` de los
   * modelos `gpt-realtime` anteriores) que aplique a `gpt-live-1`
   * específicamente sin pasar por el media server de un socio. Este método
   * documenta y hace explícito ese límite — nunca se implementa un puente
   * SIP inventado.
   */
  assertNativeSipTelephonySupported(): never {
    throw new VoiceProviderConfigError(
      'gptlive: telefonía SIP nativa de OpenAI NO está confirmada para gpt-live-1 en la documentación real ' +
        'consultada (12-sep-2026) — solo integraciones de socio (LiveKit, Twilio, Telnyx, Daily/Pipecat), que ' +
        'requieren un media server de terceros fuera de alcance de esta activación. Fail-closed deliberado: no se ' +
        'construye un puente SIP inventado. Si tu vertical necesita telefonía real hoy, conecta uno de esos ' +
        'partners directamente (fuera de este paquete) en vez de asumir que este método lo resuelve.',
    );
  }

  // ---- superficie de cliente ------------------------------------------------

  async startSession(req: StartVoiceSessionRequest): Promise<VoiceSessionHandle> {
    const { url: clientSecret } = await this.getSignedUrl(req.tenant);

    const createPeerConnection = this.opts.mode === 'client' ? (this.opts.createPeerConnection ?? defaultCreatePeerConnection) : defaultCreatePeerConnection;
    const requestMicrophone = this.opts.mode === 'client' ? (this.opts.requestMicrophone ?? defaultRequestMicrophone) : defaultRequestMicrophone;
    const doFetch = (this.opts.mode === 'client' ? this.opts.fetchImpl : undefined) ?? fetch;

    const pc = createPeerConnection();
    let conversationId = '';

    try {
      const mic = await requestMicrophone();
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      const dataChannel = pc.createDataChannel('oai-events');
      dataChannel.addEventListener('message', (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return; // evento no-JSON: se ignora, no se rompe la sesión por un frame ruidoso
        }
        if (!parsed || typeof parsed !== 'object') return;
        const msg = parsed as Record<string, unknown>;

        // `session.started` — el ÚNICO evento del catálogo confirmado sin
        // ambigüedad en la guía real de GPT-Live. El resto del catálogo de
        // eventos del data channel no se pudo confirmar exhaustivamente
        // contra documentación real hoy, así que se traduce de forma
        // defensiva: solo se emite `onTranscript` cuando el frame trae
        // `role` + texto reconocible, cualquier otro evento se ignora en
        // silencio (nunca se inventa un evento no confirmado).
        if (msg.type === 'session.started') {
          const session = msg.session as { id?: string } | undefined;
          conversationId = session?.id ?? conversationId;
          req.onConnect?.({ conversationId });
          return;
        }
        const role = msg.role;
        const text = typeof msg.transcript === 'string' ? msg.transcript : typeof msg.text === 'string' ? msg.text : undefined;
        if ((role === 'user' || role === 'agent') && text !== undefined) {
          req.onTranscript?.({ role, text, at: Date.now() });
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const res = await doFetch(SDP_EXCHANGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp ?? '',
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new VoiceProviderError(`GPT-Live-1 ${res.status} negociando SDP en startSession: ${body.slice(0, 300)}`, res.status >= 500);
      }

      const answerSdp = await res.text();
      await pc.setRemoteDescription({ sdp: answerSdp, type: 'answer' });
    } catch (err) {
      pc.close();
      req.onError?.(err instanceof Error ? err.message : String(err));
      throw err;
    }

    return {
      conversationId,
      providerId: this.id,
      endSession: async () => {
        pc.close();
        req.onDisconnect?.();
      },
    };
  }

  async endSession(handle: VoiceSessionHandle): Promise<void> {
    await handle.endSession();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ElevenLabsVoiceProvider — implementación REAL de VoiceProvider.
//
// PUERTO 1:1 de restaurantes/supabase/functions/agent-config/index.ts
// (acciones get/signed_url/voices/update) + restaurantes/src/pages/
// AdminDashboard.tsx (SDK @elevenlabs/client, Conversation.startSession).
//
// Endpoints reales confirmados en el código fuente leído:
//   GET   /v1/convai/agents/{agent_id}
//   PATCH /v1/convai/agents/{agent_id}
//   GET   /v1/convai/conversation/get-signed-url?agent_id=...
//   GET   /v1/shared-voices?language=es&page_size=100&page=N  (paginado real)
//
// La API key NUNCA se hardcodea aquí — en modo servidor la entrega
// `apiKeyProvider`, una función async que el llamador conecta a Supabase
// Vault (`supabase.rpc('get_secret', { secret_name: 'ELEVENLABS_API_KEY' })`
// en producción hoy), o a `process.env.ELEVENLABS_API_KEY` en un script o
// entorno de desarrollo — esta clase no sabe ni le importa de dónde viene.
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

const API_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Filtro real de acento a español latino — puerto EXACTO del filtro de
 * agent-config/index.ts acción "voices" (líneas 1184-1188): no es
 * `language === 'es'` a secas, es substring sobre el campo `accent`.
 */
const LATAM_ACCENT_SUBSTRINGS = ['latin', 'mexic', 'colomb', 'argentin', 'neutral'];

/** Tope de seguridad de páginas — el real `voices` de agent-config no
 *  declara uno explícito pero un bucle sin tope ante un `has_more` que
 *  nunca baja sería un fallo silencioso de latencia/costo, así que se
 *  acota aquí igual que se acotaría cualquier paginado nuevo. */
const MAX_VOICE_PAGES = 10;

// ---- shapes reales de la REST API de ElevenLabs ----------------------------

interface ElevenLabsSignedUrlResponse {
  signed_url: string;
}

interface ElevenLabsSharedVoice {
  voice_id: string;
  name: string;
  accent?: string;
  gender?: string;
  preview_url?: string;
}

interface ElevenLabsSharedVoicesResponse {
  voices?: ElevenLabsSharedVoice[];
  has_more?: boolean;
}

interface ElevenLabsAgentResponse {
  name: string;
  conversation_config?: {
    agent?: {
      first_message?: string;
      language?: string;
      prompt?: { prompt?: string; temperature?: number };
    };
    tts?: { voice_id?: string | null };
  };
}

// ---- superficie de SERVIDOR ------------------------------------------------

/**
 * Solo se construye dentro de un backend (Edge Function / apps de la API).
 * `apiKeyProvider` es async a propósito — puerto directo de
 * `getApiKey(supabase)` en agent-config/index.ts, que hace
 * `supabase.rpc('get_secret', { secret_name: 'ELEVENLABS_API_KEY' })` contra
 * Supabase Vault, NUNCA una env var estática de la función. Cualquier
 * backend nuevo (hoteles, rentas, citas) pasa su propio `apiKeyProvider`
 * apuntando a su Vault del mismo tenant/proyecto Supabase — la key sigue
 * viviendo en Vault, este paquete solo la consume.
 */
export interface ElevenLabsServerOptions {
  mode: 'server';
  apiKeyProvider: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Se construye en el bundle del navegador (o de un bridge de telefonía sin
 * key propia). NUNCA recibe la API key: `resolveSignedUrl` es una llamada a
 * TU PROPIO backend (equivalente a
 * `supabase.functions.invoke('agent-config', { action: 'signed_url', agent_id })`
 * en AdminDashboard.tsx línea 1511) — ese backend por dentro corre la
 * instancia en modo 'server' de este mismo proveedor.
 */
export interface ElevenLabsClientOptions {
  mode: 'client';
  resolveSignedUrl: (tenant: VoiceTenantContext) => Promise<SignedVoiceUrl>;
}

export type ElevenLabsVoiceProviderOptions = ElevenLabsServerOptions | ElevenLabsClientOptions;

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = 'elevenlabs';

  constructor(private readonly opts: ElevenLabsVoiceProviderOptions) {}

  private assertServerMode(method: string): ElevenLabsServerOptions {
    if (this.opts.mode !== 'server') {
      throw new VoiceProviderConfigError(
        `elevenlabs: "${method}" requiere modo servidor (con acceso a la API key vía Vault) — ` +
          `esta instancia está en modo cliente y nunca debe tener la key. Llama a este método desde tu backend, no desde el navegador.`,
      );
    }
    return this.opts;
  }

  private async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const { apiKeyProvider, fetchImpl } = this.assertServerMode(method);
    const apiKey = await apiKeyProvider();
    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(`${API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), 'xi-api-key': apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new VoiceProviderError(`ElevenLabs ${res.status} en ${method}: ${body.slice(0, 300)}`, res.status >= 500);
    }
    return res;
  }

  // ---- superficie de servidor ---------------------------------------------

  async getSignedUrl(tenant: VoiceTenantContext): Promise<SignedVoiceUrl> {
    if (this.opts.mode === 'client') return this.opts.resolveSignedUrl(tenant);
    const res = await this.request(
      'getSignedUrl',
      `/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(tenant.agentId)}`,
    );
    const data = (await res.json()) as ElevenLabsSignedUrlResponse;
    // ElevenLabs no reporta expiración real en este endpoint hoy — puerto
    // honesto de agent-config/index.ts, que tampoco la calcula (solo
    // devuelve `{ signed_url }`).
    return { url: data.signed_url };
  }

  async listVoices(languageFilter: string): Promise<VoiceListing[]> {
    this.assertServerMode('listVoices');
    // Paginación real completa — puerto EXACTO del bug corregido en
    // agent-config/index.ts acción "voices" (antes se pedía una sola página
    // de 60 y se recortaba; ahora pagina hasta agotar `has_more`).
    let todas: ElevenLabsSharedVoice[] = [];
    for (let pagina = 0; pagina < MAX_VOICE_PAGES; pagina++) {
      const res = await this.request(
        'listVoices',
        `/shared-voices?language=${encodeURIComponent(languageFilter)}&page_size=100&page=${pagina}`,
      );
      const data = (await res.json()) as ElevenLabsSharedVoicesResponse;
      todas = todas.concat(data.voices ?? []);
      if (!data.has_more) break;
    }
    return todas
      .filter((v) => LATAM_ACCENT_SUBSTRINGS.some((s) => (v.accent ?? '').toLowerCase().includes(s)))
      .map((v) => ({
        voiceId: v.voice_id,
        name: v.name,
        language: languageFilter,
        accent: v.accent,
        gender: v.gender,
        previewUrl: v.preview_url,
      }));
  }

  async getAgentConfig(tenant: VoiceTenantContext): Promise<VoiceAgentConfig> {
    this.assertServerMode('getAgentConfig');
    const res = await this.request('getAgentConfig', `/convai/agents/${tenant.agentId}`);
    const data = (await res.json()) as ElevenLabsAgentResponse;
    const agent = data.conversation_config?.agent ?? {};
    const tts = data.conversation_config?.tts ?? {};
    return {
      agentId: tenant.agentId,
      name: data.name,
      firstMessage: agent.first_message ?? '',
      language: agent.language ?? 'es',
      prompt: agent.prompt?.prompt ?? '',
      temperature: agent.prompt?.temperature ?? 0.4,
      voiceId: tts.voice_id ?? null,
    };
  }

  async updateAgentConfig(update: UpdateVoiceAgentConfig): Promise<void> {
    this.assertServerMode('updateAgentConfig');
    const agentPatch: Record<string, unknown> = {};
    if (update.firstMessage !== undefined) agentPatch.first_message = update.firstMessage;
    if (update.language !== undefined) agentPatch.language = update.language;
    if (update.prompt !== undefined || update.temperature !== undefined) {
      agentPatch.prompt = {
        ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
        ...(update.temperature !== undefined ? { temperature: update.temperature } : {}),
      };
    }
    const ttsPatch: Record<string, unknown> = {};
    if (update.voiceId !== undefined) ttsPatch.voice_id = update.voiceId;

    await this.request('updateAgentConfig', `/convai/agents/${update.agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_config: {
          ...(Object.keys(agentPatch).length ? { agent: agentPatch } : {}),
          ...(Object.keys(ttsPatch).length ? { tts: ttsPatch } : {}),
        },
      }),
    });
  }

  // ---- superficie de cliente ------------------------------------------------
  // Puerto directo de AdminDashboard.tsx `alternarLlamadaReal` (línea 1497):
  // import dinámico del SDK (pesado, solo se carga cuando de verdad se
  // inicia una llamada), Conversation.startSession con los mismos 5
  // callbacks reales.

  async startSession(req: StartVoiceSessionRequest): Promise<VoiceSessionHandle> {
    const { url } = await this.getSignedUrl(req.tenant);
    // Import dinámico: el SDK de ElevenLabs es una dependencia PESADA de
    // navegador — puerto directo del import dinámico real en
    // AdminDashboard.tsx, que solo lo carga cuando el usuario de verdad
    // inicia una llamada, no en el bundle inicial. `@elevenlabs/client` es
    // una dependencia opcional de este paquete: solo la necesita quien
    // ejecute `startSession` en un bundle de navegador real.
    const { Conversation } = await import('@elevenlabs/client');

    let conversationId = '';
    const sdkSession = await Conversation.startSession({
      signedUrl: url,
      dynamicVariables: req.dynamicVariables,
      onConnect: (info: { conversationId: string }) => {
        conversationId = info.conversationId;
        req.onConnect?.(info);
      },
      onDisconnect: () => req.onDisconnect?.(),
      onMessage: ({ message, role }: { message: string; role: 'user' | 'agent' }) => {
        req.onTranscript?.({ role, text: message, at: Date.now() });
      },
      onError: (msg: string) => req.onError?.(msg),
    });

    return {
      conversationId,
      providerId: this.id,
      endSession: () => sdkSession.endSession(),
    };
  }

  async endSession(handle: VoiceSessionHandle): Promise<void> {
    await handle.endSession();
  }
}

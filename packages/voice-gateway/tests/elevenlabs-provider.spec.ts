// Mocks de la API HTTP de ElevenLabs — mismo patrón de inyección de
// dependencia (`fetchImpl` + `vi.fn`) que usan los adaptadores reales de LLM
// en agent-core/src/gateway/providers/openai.ts (constructor con
// `fetchImpl?: typeof fetch`) y que usa packages/billing/tests para mockear
// clientes de PAC/Stripe — nunca contra la red real.
import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsVoiceProvider } from '../src/providers/elevenlabs-provider.js';
import { VoiceProviderConfigError, VoiceProviderError } from '../src/errors.js';
import type { VoiceTenantContext } from '../src/types.js';

const tenant: VoiceTenantContext = {
  organizationId: 'org_1',
  propertyId: 'prop_1',
  vertical: 'restaurantes',
  agentId: 'agent_real_123',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function serverProvider(fetchImpl: typeof fetch, apiKey = 'sk-real-test-key') {
  return new ElevenLabsVoiceProvider({
    mode: 'server',
    apiKeyProvider: async () => apiKey,
    fetchImpl,
  });
}

describe('ElevenLabsVoiceProvider — superficie de servidor', () => {
  it('getSignedUrl: llama al endpoint real con agent_id y manda la key en xi-api-key, nunca en la URL', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_real_123',
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers['xi-api-key']).toBe('sk-real-test-key');
      expect(String(url)).not.toContain('sk-real-test-key');
      return jsonResponse({ signed_url: 'wss://api.elevenlabs.io/v1/convai/conversation?token=abc' });
    });

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    const result = await provider.getSignedUrl(tenant);

    expect(result.url).toBe('wss://api.elevenlabs.io/v1/convai/conversation?token=abc');
    // ElevenLabs no reporta expiración en este endpoint — honesto, no inventado.
    expect(result.expiresAt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getSignedUrl: un 401 real de ElevenLabs se propaga como VoiceProviderError no reintentable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: 'invalid_api_key' }, false, 401));
    const provider = serverProvider(fetchMock as unknown as typeof fetch);

    await expect(provider.getSignedUrl(tenant)).rejects.toThrow(VoiceProviderError);
    await expect(provider.getSignedUrl(tenant)).rejects.toMatchObject({ retryable: false });
  });

  it('getSignedUrl: un 500 real se propaga como VoiceProviderError reintentable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: 'server_error' }, false, 500));
    const provider = serverProvider(fetchMock as unknown as typeof fetch);

    await expect(provider.getSignedUrl(tenant)).rejects.toMatchObject({ retryable: true });
  });

  it('listVoices: pagina hasta agotar has_more (bug real corregido — no se queda en la primera página)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = new URL(String(url));
      const page = Number(u.searchParams.get('page'));
      expect(u.searchParams.get('page_size')).toBe('100');
      if (page === 0) {
        return jsonResponse({
          voices: [{ voice_id: 'v1', name: 'Voz Uno', accent: 'mexican', gender: 'female' }],
          has_more: true,
        });
      }
      if (page === 1) {
        return jsonResponse({
          voices: [{ voice_id: 'v2', name: 'Voz Dos', accent: 'neutral', gender: 'male' }],
          has_more: false,
        });
      }
      throw new Error(`no debería pedir la página ${page}`);
    });

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    const voices = await provider.listVoices('es');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(voices.map((v) => v.voiceId)).toEqual(['v1', 'v2']);
  });

  it('listVoices: filtra por substring de acento latino — puerto exacto del filtro real', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        voices: [
          { voice_id: 'v_mx', name: 'Mexicana', accent: 'mexican' },
          { voice_id: 'v_co', name: 'Colombiana', accent: 'colombian' },
          { voice_id: 'v_ar', name: 'Argentina', accent: 'argentinian' },
          { voice_id: 'v_neutral', name: 'Neutral', accent: 'neutral' },
          { voice_id: 'v_gb', name: 'British', accent: 'british' }, // NO debe pasar el filtro
          { voice_id: 'v_sin_acento', name: 'Sin acento' }, // accent ausente -> tampoco pasa
        ],
        has_more: false,
      }),
    );

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    const voices = await provider.listVoices('es');

    expect(voices.map((v) => v.voiceId).sort()).toEqual(['v_ar', 'v_co', 'v_mx', 'v_neutral']);
  });

  it('getAgentConfig: parsea el shape real de conversation_config.agent/.tts', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        name: 'Agente Restaurante X',
        conversation_config: {
          agent: {
            first_message: '¡Hola! ¿En qué te ayudo hoy?',
            language: 'es',
            prompt: { prompt: 'Eres el anfitrión de...', temperature: 0.6 },
          },
          tts: { voice_id: 'voice_abc' },
        },
      }),
    );

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    const config = await provider.getAgentConfig(tenant);

    expect(config).toEqual({
      agentId: 'agent_real_123',
      name: 'Agente Restaurante X',
      firstMessage: '¡Hola! ¿En qué te ayudo hoy?',
      language: 'es',
      prompt: 'Eres el anfitrión de...',
      temperature: 0.6,
      voiceId: 'voice_abc',
    });
  });

  it('getAgentConfig: usa defaults honestos cuando el agente no tiene prompt/tts configurado aún', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'Agente nuevo' }));
    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    const config = await provider.getAgentConfig(tenant);

    expect(config.firstMessage).toBe('');
    expect(config.language).toBe('es');
    expect(config.temperature).toBe(0.4);
    expect(config.voiceId).toBeNull();
  });

  it('updateAgentConfig: arma el PATCH real solo con los campos provistos (voz + idioma)', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.elevenlabs.io/v1/convai/agents/agent_real_123');
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        conversation_config: {
          agent: { language: 'en' },
          tts: { voice_id: 'voice_xyz' },
        },
      });
      return jsonResponse({});
    });

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    await provider.updateAgentConfig({ agentId: 'agent_real_123', voiceId: 'voice_xyz', language: 'en' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('updateAgentConfig: prompt + temperature van anidados bajo agent.prompt', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.conversation_config.agent.prompt).toEqual({ prompt: 'nuevo prompt', temperature: 0.9 });
      expect(body.conversation_config.tts).toBeUndefined();
      return jsonResponse({});
    });

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    await provider.updateAgentConfig({ agentId: 'agent_real_123', prompt: 'nuevo prompt', temperature: 0.9 });
  });

  it('listVoices/getAgentConfig/updateAgentConfig en modo cliente fallan con VoiceProviderConfigError — nunca corren sin la key', async () => {
    const provider = new ElevenLabsVoiceProvider({
      mode: 'client',
      resolveSignedUrl: async () => ({ url: 'wss://fake' }),
    });

    await expect(provider.listVoices('es')).rejects.toThrow(VoiceProviderConfigError);
    await expect(provider.listVoices('es')).rejects.toThrow(/modo servidor/);
    await expect(provider.getAgentConfig(tenant)).rejects.toThrow(VoiceProviderConfigError);
    await expect(provider.updateAgentConfig({ agentId: 'x' })).rejects.toThrow(VoiceProviderConfigError);
  });
});

describe('ElevenLabsVoiceProvider — superficie de cliente', () => {
  it('getSignedUrl en modo cliente delega a resolveSignedUrl (tu propio backend), nunca llama la API de ElevenLabs directo', async () => {
    const resolveSignedUrl = vi.fn(async () => ({ url: 'wss://mi-backend-firmo-esto' }));
    const provider = new ElevenLabsVoiceProvider({ mode: 'client', resolveSignedUrl });

    const result = await provider.getSignedUrl(tenant);

    expect(result.url).toBe('wss://mi-backend-firmo-esto');
    expect(resolveSignedUrl).toHaveBeenCalledWith(tenant);
  });

  it('startSession: usa el signed_url resuelto por el backend, arma dynamicVariables y traduce onMessage a onTranscript', async () => {
    const startSessionMock = vi.fn(async (opts: {
      signedUrl: string;
      dynamicVariables?: Record<string, string>;
      onConnect?: (info: { conversationId: string }) => void;
      onDisconnect?: () => void;
      onMessage?: (event: { message: string; role: 'user' | 'agent' }) => void;
      onError?: (message: string) => void;
    }) => {
      expect(opts.signedUrl).toBe('wss://mi-backend-firmo-esto');
      expect(opts.dynamicVariables).toEqual({ saludo: 'Buenas tardes' });
      opts.onConnect?.({ conversationId: 'conv_real_1' });
      opts.onMessage?.({ message: 'Hola, ¿en qué te ayudo?', role: 'agent' });
      return { endSession: vi.fn(async () => undefined) };
    });

    // `@elevenlabs/client` no está instalado en este monorepo (es un SDK de
    // NAVEGADOR — ver elevenlabs-client.d.ts) y `startSession()` lo carga
    // con `import()` dinámico solo cuando de verdad se ejecuta. `vi.doMock`
    // intercepta esa resolución en tiempo de ejecución, ANTES de llamar
    // `provider.startSession`, sin que el paquete real necesite existir.
    vi.doMock('@elevenlabs/client', () => ({ Conversation: { startSession: startSessionMock } }));

    const provider = new ElevenLabsVoiceProvider({
      mode: 'client',
      resolveSignedUrl: async () => ({ url: 'wss://mi-backend-firmo-esto' }),
    });

    const transcripts: { role: string; text: string }[] = [];
    let connected: { conversationId: string } | undefined;

    const handle = await provider.startSession({
      tenant,
      dynamicVariables: { saludo: 'Buenas tardes' },
      onConnect: (info) => (connected = info),
      onTranscript: (event) => transcripts.push({ role: event.role, text: event.text }),
    });

    expect(connected).toEqual({ conversationId: 'conv_real_1' });
    expect(handle.conversationId).toBe('conv_real_1');
    expect(handle.providerId).toBe('elevenlabs');
    expect(transcripts).toEqual([{ role: 'agent', text: 'Hola, ¿en qué te ayudo?' }]);

    await handle.endSession();
    vi.doUnmock('@elevenlabs/client');
  });
});

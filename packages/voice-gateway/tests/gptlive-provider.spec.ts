// Mocks de la API HTTP real de OpenAI (client_secrets + SDP exchange) y de
// un RTCPeerConnection fake — mismo patrón de inyección de dependencia
// (`fetchImpl`/`createPeerConnection`/`requestMicrophone` + `vi.fn`) que usa
// `elevenlabs-provider.spec.ts`. Nunca contra la red real, nunca requiere una
// API key real.
import { describe, expect, it, vi } from 'vitest';
import {
  estimateGptLiveCostUsd,
  GPT_LIVE_MODEL,
  GPT_LIVE_PRICE_USD_PER_MINUTE,
  GptLiveVoiceProvider,
  type GptLiveDataChannel,
  type GptLiveMediaStream,
  type GptLivePeerConnection,
} from '../src/providers/gptlive-provider.js';
import { VoiceProviderConfigError, VoiceProviderError } from '../src/errors.js';
import type { VoiceTenantContext } from '../src/types.js';

const tenant: VoiceTenantContext = {
  organizationId: 'org_1',
  propertyId: 'prop_1',
  vertical: 'hoteles',
  agentId: 'assistant_gptlive_1',
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
}

function serverProvider(fetchImpl: typeof fetch, apiKey = 'sk-openai-test') {
  return new GptLiveVoiceProvider({
    mode: 'server',
    apiKeyProvider: async () => apiKey,
    fetchImpl,
  });
}

/** Fake RTCPeerConnection mínimo — implementa solo lo que `startSession` usa. */
function fakePeerConnection(): { pc: GptLivePeerConnection; emit: (data: unknown) => void; closed: boolean } {
  let listener: ((event: { data: string }) => void) | undefined;
  const state = { closed: false };
  const channel: GptLiveDataChannel = {
    send: vi.fn(),
    addEventListener: (_type, l) => {
      listener = l;
    },
    close: vi.fn(),
  };
  const pc: GptLivePeerConnection = {
    createDataChannel: vi.fn(() => channel),
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ sdp: 'v=0 fake-offer', type: 'offer' })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    close: vi.fn(() => {
      state.closed = true;
    }),
  };
  return {
    pc,
    emit: (data: unknown) => listener?.({ data: JSON.stringify(data) }),
    get closed() {
      return state.closed;
    },
  } as unknown as { pc: GptLivePeerConnection; emit: (data: unknown) => void; closed: boolean };
}

function fakeMic(): GptLiveMediaStream {
  return { getTracks: () => [{ id: 'track_1' }] };
}

describe('GptLiveVoiceProvider — superficie de servidor (real, HTTP mockeado)', () => {
  it('getSignedUrl: llama a POST /v1/realtime/client_secrets con Authorization, OpenAI-Safety-Identifier y model real', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/realtime/client_secrets');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-openai-test');
      expect(headers['OpenAI-Safety-Identifier']).toBe('hoteles:org_1:prop_1');
      const body = JSON.parse(String(init?.body));
      expect(body.session).toEqual({ type: 'realtime', model: GPT_LIVE_MODEL });
      expect(body.expires_after).toEqual({ anchor: 'created_at', seconds: 600 });
      return jsonResponse({ value: 'ek_fake_secret_123', expires_at: 1_000_000 });
    });

    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    const result = await provider.getSignedUrl(tenant);

    expect(result.url).toBe('ek_fake_secret_123');
    expect(result.expiresAt).toBe(1_000_000 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getSignedUrl: nunca manda la key en la URL, solo en el header Authorization', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).not.toContain('sk-openai-test');
      return jsonResponse({ value: 'ek_x', expires_at: 1 });
    });
    await serverProvider(fetchMock as unknown as typeof fetch).getSignedUrl(tenant);
  });

  it('getSignedUrl: un 401 real se propaga como VoiceProviderError no reintentable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'invalid_api_key' }, false, 401));
    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    await expect(provider.getSignedUrl(tenant)).rejects.toThrow(VoiceProviderError);
    await expect(provider.getSignedUrl(tenant)).rejects.toMatchObject({ retryable: false });
  });

  it('getSignedUrl: un 500 real se propaga como VoiceProviderError reintentable', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'server_error' }, false, 500));
    const provider = serverProvider(fetchMock as unknown as typeof fetch);
    await expect(provider.getSignedUrl(tenant)).rejects.toMatchObject({ retryable: true });
  });

  it('getSignedUrl: `expiresAfterSeconds` y `safetyIdentifierProvider` son configurables', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['OpenAI-Safety-Identifier']).toBe('id-custom');
      const body = JSON.parse(String(init?.body));
      expect(body.expires_after.seconds).toBe(120);
      return jsonResponse({ value: 'ek_x', expires_at: 1 });
    });
    const provider = new GptLiveVoiceProvider({
      mode: 'server',
      apiKeyProvider: async () => 'sk-openai-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
      expiresAfterSeconds: 120,
      safetyIdentifierProvider: () => 'id-custom',
    });
    await provider.getSignedUrl(tenant);
  });

  it('listVoices: devuelve el catálogo fijo real de voces realtime/live, ignora el filtro de idioma', async () => {
    const provider = serverProvider(vi.fn() as unknown as typeof fetch);
    const voces = await provider.listVoices('es');
    expect(voces.map((v) => v.voiceId)).toEqual(
      expect.arrayContaining(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']),
    );
    expect(voces.every((v) => v.language === 'multi')).toBe(true);

    const vocesEn = await provider.listVoices('en');
    expect(vocesEn).toEqual(voces); // mismo catálogo fijo sin importar el idioma pedido
  });

  it('listVoices en modo cliente falla con VoiceProviderConfigError — nunca corre sin la key', async () => {
    const provider = new GptLiveVoiceProvider({ mode: 'client', resolveSignedUrl: async () => ({ url: 'ek_x' }) });
    await expect(provider.listVoices('es')).rejects.toThrow(VoiceProviderConfigError);
    await expect(provider.listVoices('es')).rejects.toThrow(/modo servidor/);
  });

  it('getAgentConfig: falla cerrado, explícito y honesto (sin recurso de agente confirmado)', async () => {
    const provider = serverProvider(vi.fn() as unknown as typeof fetch);
    await expect(provider.getAgentConfig(tenant)).rejects.toThrow(VoiceProviderConfigError);
    await expect(provider.getAgentConfig(tenant)).rejects.toThrow(/getAgentConfig.*no está soportado/);
  });

  it('updateAgentConfig: falla cerrado, explícito y honesto', async () => {
    const provider = serverProvider(vi.fn() as unknown as typeof fetch);
    await expect(provider.updateAgentConfig({ agentId: 'x' })).rejects.toThrow(VoiceProviderConfigError);
    await expect(provider.updateAgentConfig({ agentId: 'x' })).rejects.toThrow(/updateAgentConfig.*no está soportado/);
  });

  it('getAgentConfig/updateAgentConfig en modo cliente fallan primero por modo, no por falta de soporte', async () => {
    const provider = new GptLiveVoiceProvider({ mode: 'client', resolveSignedUrl: async () => ({ url: 'ek_x' }) });
    await expect(provider.getAgentConfig(tenant)).rejects.toThrow(/modo servidor/);
    await expect(provider.updateAgentConfig({ agentId: 'x' })).rejects.toThrow(/modo servidor/);
  });

  it('assertNativeSipTelephonySupported: fail-closed explícito y testeable para telefonía SIP nativa', () => {
    const provider = serverProvider(vi.fn() as unknown as typeof fetch);
    expect(() => provider.assertNativeSipTelephonySupported()).toThrow(VoiceProviderConfigError);
    expect(() => provider.assertNativeSipTelephonySupported()).toThrow(/telefonía SIP nativa/);
  });
});

describe('GptLiveVoiceProvider — superficie de cliente (WebRTC real, fake inyectado)', () => {
  it('startSession: crea sesión real vía client_secrets + intercambio SDP, y traduce eventos del data channel', async () => {
    const resolveSignedUrl = vi.fn(async () => ({ url: 'ek_fake_secret' }));
    const { pc, emit } = fakePeerConnection();
    const mic = fakeMic();

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/realtime/calls');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ek_fake_secret');
      expect(headers['Content-Type']).toBe('application/sdp');
      expect(init?.body).toBe('v=0 fake-offer');
      return textResponse('v=0 fake-answer');
    });

    const provider = new GptLiveVoiceProvider({
      mode: 'client',
      resolveSignedUrl,
      createPeerConnection: () => pc,
      requestMicrophone: async () => mic,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const transcripts: { role: string; text: string }[] = [];
    let connected: { conversationId: string } | undefined;

    const handlePromise = provider.startSession({
      tenant,
      onConnect: (info) => (connected = info),
      onTranscript: (event) => transcripts.push({ role: event.role, text: event.text }),
    });

    // El intercambio SDP ya se resolvió (microtareas) antes de emitir eventos
    // del data channel — se espera el handle primero.
    const handle = await handlePromise;

    emit({ type: 'session.started', session: { id: 'conv_real_1' } });
    emit({ role: 'agent', transcript: 'Hola, ¿en qué te ayudo?' });
    emit({ type: 'ruido.no.confirmado', algo: 'se ignora en silencio' });

    expect(connected).toEqual({ conversationId: 'conv_real_1' });
    expect(handle.providerId).toBe('gptlive');
    expect(transcripts).toEqual([{ role: 'agent', text: 'Hola, ¿en qué te ayudo?' }]);
    expect(resolveSignedUrl).toHaveBeenCalledWith(tenant);
    expect(pc.addTrack).toHaveBeenCalledWith({ id: 'track_1' }, mic);

    await handle.endSession();
    expect(pc.close).toHaveBeenCalledTimes(1);
  });

  it('startSession: un 4xx/5xx real en el intercambio SDP se propaga como VoiceProviderError y cierra el peer connection', async () => {
    const { pc } = fakePeerConnection();
    const fetchMock = vi.fn(async () => textResponse('bad offer', false, 400));

    const provider = new GptLiveVoiceProvider({
      mode: 'client',
      resolveSignedUrl: async () => ({ url: 'ek_fake_secret' }),
      createPeerConnection: () => pc,
      requestMicrophone: async () => fakeMic(),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const errors: string[] = [];
    await expect(
      provider.startSession({ tenant, onError: (msg) => errors.push(msg) }),
    ).rejects.toThrow(VoiceProviderError);
    expect(pc.close).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('startSession sin RTCPeerConnection inyectado en un entorno sin WebRTC real falla explícito (no silencioso)', async () => {
    const provider = new GptLiveVoiceProvider({
      mode: 'client',
      resolveSignedUrl: async () => ({ url: 'ek_fake_secret' }),
      // sin createPeerConnection/requestMicrophone -> usa los defaults, que
      // en Node (sin navegador) deben fallar explícito, nunca simular audio.
    });
    await expect(provider.startSession({ tenant })).rejects.toThrow(VoiceProviderConfigError);
    await expect(provider.startSession({ tenant })).rejects.toThrow(/RTCPeerConnection real/);
  });
});

describe('estimateGptLiveCostUsd', () => {
  it('estima por SEGUNDO a $0.05/min, no por tokens', () => {
    expect(estimateGptLiveCostUsd(60)).toBeCloseTo(GPT_LIVE_PRICE_USD_PER_MINUTE, 6);
    expect(estimateGptLiveCostUsd(30)).toBeCloseTo(GPT_LIVE_PRICE_USD_PER_MINUTE / 2, 6);
    expect(estimateGptLiveCostUsd(0)).toBe(0);
  });

  it('rechaza duraciones inválidas', () => {
    expect(() => estimateGptLiveCostUsd(-1)).toThrow();
    expect(() => estimateGptLiveCostUsd(NaN)).toThrow();
  });
});

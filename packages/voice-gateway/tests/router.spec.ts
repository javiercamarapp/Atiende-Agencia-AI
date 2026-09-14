import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PROVIDER, readVoiceProviderFromEnv, selectVoiceProvider } from '../src/router.js';
import { ElevenLabsVoiceProvider } from '../src/providers/elevenlabs-provider.js';
import { GptLiveVoiceProvider } from '../src/providers/gptlive-provider.js';
import { VoiceProviderConfigError } from '../src/errors.js';

const elevenlabsOpts = {
  elevenlabs: {
    mode: 'server' as const,
    apiKeyProvider: async () => 'sk-test',
  },
};

const gptliveOpts = {
  ...elevenlabsOpts,
  gptlive: {
    mode: 'server' as const,
    apiKeyProvider: async () => 'sk-openai-test',
  },
};

describe('selectVoiceProvider', () => {
  it('el default (sin pedir nada) es ElevenLabs', () => {
    expect(DEFAULT_VOICE_PROVIDER).toBe('elevenlabs');
    const provider = selectVoiceProvider(undefined, elevenlabsOpts);
    expect(provider).toBeInstanceOf(ElevenLabsVoiceProvider);
    expect(provider.id).toBe('elevenlabs');
  });

  it('"elevenlabs" explícito construye ElevenLabsVoiceProvider', () => {
    const provider = selectVoiceProvider('elevenlabs', elevenlabsOpts);
    expect(provider).toBeInstanceOf(ElevenLabsVoiceProvider);
  });

  it('"gptlive" explícito construye GptLiveVoiceProvider REAL — ya no rechaza la selección', () => {
    const provider = selectVoiceProvider('gptlive', gptliveOpts);
    expect(provider).toBeInstanceOf(GptLiveVoiceProvider);
    expect(provider.id).toBe('gptlive');
  });

  it('"gptlive" sin `opts.gptlive` lanza VoiceProviderConfigError explícito — nunca adivina la config', () => {
    expect(() => selectVoiceProvider('gptlive', elevenlabsOpts)).toThrow(VoiceProviderConfigError);
    expect(() => selectVoiceProvider('gptlive', elevenlabsOpts)).toThrow(/falta `opts.gptlive`/);
  });

  it('un id de proveedor desconocido lanza VoiceProviderConfigError explícito', () => {
    // @ts-expect-error — probando deliberadamente un id fuera del tipo
    expect(() => selectVoiceProvider('twilio-voice', elevenlabsOpts)).toThrow(VoiceProviderConfigError);
  });
});

describe('readVoiceProviderFromEnv', () => {
  it('sin VOICE_PROVIDER en el entorno, resuelve al default', () => {
    expect(readVoiceProviderFromEnv({})).toBe('elevenlabs');
  });

  it('VOICE_PROVIDER=elevenlabs se respeta', () => {
    expect(readVoiceProviderFromEnv({ VOICE_PROVIDER: 'elevenlabs' })).toBe('elevenlabs');
  });

  it('VOICE_PROVIDER=gptlive se lee tal cual y selectVoiceProvider lo construye real', () => {
    expect(readVoiceProviderFromEnv({ VOICE_PROVIDER: 'gptlive' })).toBe('gptlive');
    const provider = selectVoiceProvider(readVoiceProviderFromEnv({ VOICE_PROVIDER: 'gptlive' }), gptliveOpts);
    expect(provider).toBeInstanceOf(GptLiveVoiceProvider);
  });

  it('un valor inválido de VOICE_PROVIDER lanza VoiceProviderConfigError en vez de adivinar', () => {
    expect(() => readVoiceProviderFromEnv({ VOICE_PROVIDER: 'twilio' })).toThrow(VoiceProviderConfigError);
  });
});

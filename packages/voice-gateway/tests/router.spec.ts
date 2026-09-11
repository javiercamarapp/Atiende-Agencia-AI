import { describe, expect, it } from 'vitest';
import { DEFAULT_VOICE_PROVIDER, readVoiceProviderFromEnv, selectVoiceProvider } from '../src/router.js';
import { ElevenLabsVoiceProvider } from '../src/providers/elevenlabs-provider.js';
import { GptLiveVoiceProvider } from '../src/providers/gptlive-provider.js';
import { VoiceProviderConfigError, VoiceProviderNotActivatableError } from '../src/errors.js';

const elevenlabsOpts = {
  elevenlabs: {
    mode: 'server' as const,
    apiKeyProvider: async () => 'sk-test',
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

  it('"gptlive" explícito RECHAZA de inmediato en la selección — nunca cae en silencio a ElevenLabs', () => {
    expect(() => selectVoiceProvider('gptlive', elevenlabsOpts)).toThrow(VoiceProviderNotActivatableError);
    let caught: unknown;
    try {
      selectVoiceProvider('gptlive', elevenlabsOpts);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VoiceProviderNotActivatableError);
    expect((caught as VoiceProviderNotActivatableError).providerId).toBe('gptlive');
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

  it('VOICE_PROVIDER=gptlive se lee tal cual (la selección explícita falla después, en selectVoiceProvider)', () => {
    expect(readVoiceProviderFromEnv({ VOICE_PROVIDER: 'gptlive' })).toBe('gptlive');
  });

  it('un valor inválido de VOICE_PROVIDER lanza VoiceProviderConfigError en vez de adivinar', () => {
    expect(() => readVoiceProviderFromEnv({ VOICE_PROVIDER: 'twilio' })).toThrow(VoiceProviderConfigError);
  });
});

describe('integración router + provider inerte', () => {
  it('GptLiveVoiceProvider.assertAvailable() es lo que el router invoca — no un método inventado solo para el test', () => {
    const provider = new GptLiveVoiceProvider();
    expect(() => provider.assertAvailable()).toThrow(VoiceProviderNotActivatableError);
  });
});

// Confirma EXPLÍCITAMENTE que CADA método de GptLiveVoiceProvider falla
// cerrado con un mensaje claro y específico (nunca genérico, nunca un
// silencio confuso) — para que si alguien lo conecta por error en
// producción, el fallo sea inmediato y diagnosticable.
import { describe, expect, it } from 'vitest';
import { GptLiveVoiceProvider } from '../src/providers/gptlive-provider.js';
import { VoiceProviderNotActivatableError } from '../src/errors.js';
import type { VoiceTenantContext } from '../src/types.js';

const tenant: VoiceTenantContext = {
  organizationId: 'org_1',
  propertyId: 'prop_1',
  vertical: 'hoteles',
  agentId: 'assistant_gptlive_1',
};

const REASON_FRAGMENT = /GPT-Live-1 aún no tiene API pública/;

describe('GptLiveVoiceProvider — falla cerrado en TODOS los métodos', () => {
  it('assertAvailable() lanza VoiceProviderNotActivatableError con el proveedor y el motivo', () => {
    const provider = new GptLiveVoiceProvider();
    let caught: unknown;
    try {
      provider.assertAvailable();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VoiceProviderNotActivatableError);
    const err = caught as VoiceProviderNotActivatableError;
    expect(err.providerId).toBe('gptlive');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(REASON_FRAGMENT);
    expect(err.message).toMatch(/método: assertAvailable/);
  });

  it('getSignedUrl() falla cerrado, no devuelve una URL simulada', async () => {
    const provider = new GptLiveVoiceProvider();
    await expect(provider.getSignedUrl(tenant)).rejects.toThrow(VoiceProviderNotActivatableError);
    await expect(provider.getSignedUrl(tenant)).rejects.toThrow(REASON_FRAGMENT);
    await expect(provider.getSignedUrl(tenant)).rejects.toThrow(/método: getSignedUrl/);
  });

  it('listVoices() falla cerrado, no devuelve una lista vacía silenciosa', async () => {
    const provider = new GptLiveVoiceProvider();
    await expect(provider.listVoices('es')).rejects.toThrow(VoiceProviderNotActivatableError);
    await expect(provider.listVoices('es')).rejects.toThrow(/método: listVoices/);
  });

  it('getAgentConfig() falla cerrado', async () => {
    const provider = new GptLiveVoiceProvider();
    await expect(provider.getAgentConfig(tenant)).rejects.toThrow(VoiceProviderNotActivatableError);
    await expect(provider.getAgentConfig(tenant)).rejects.toThrow(/método: getAgentConfig/);
  });

  it('updateAgentConfig() falla cerrado', async () => {
    const provider = new GptLiveVoiceProvider();
    await expect(provider.updateAgentConfig({ agentId: 'x' })).rejects.toThrow(VoiceProviderNotActivatableError);
    await expect(provider.updateAgentConfig({ agentId: 'x' })).rejects.toThrow(/método: updateAgentConfig/);
  });

  it('startSession() falla cerrado — nunca abre una sesión de voz falsa', async () => {
    const provider = new GptLiveVoiceProvider();
    await expect(provider.startSession({ tenant })).rejects.toThrow(VoiceProviderNotActivatableError);
    await expect(provider.startSession({ tenant })).rejects.toThrow(/método: startSession/);
  });

  it('endSession() falla cerrado', async () => {
    const provider = new GptLiveVoiceProvider();
    const fakeHandle = { conversationId: 'c1', providerId: 'gptlive', endSession: async () => undefined };
    await expect(provider.endSession(fakeHandle)).rejects.toThrow(VoiceProviderNotActivatableError);
    await expect(provider.endSession(fakeHandle)).rejects.toThrow(/método: endSession/);
  });

  it('cada método tiene un mensaje DISTINGUIBLE entre sí (no todos el mismo genérico)', async () => {
    const provider = new GptLiveVoiceProvider();
    const mensajes = new Set<string>();

    const intentos: Array<() => Promise<unknown>> = [
      () => provider.getSignedUrl(tenant),
      () => provider.listVoices('es'),
      () => provider.getAgentConfig(tenant),
      () => provider.updateAgentConfig({ agentId: 'x' }),
      () => provider.startSession({ tenant }),
      () =>
        provider.endSession({ conversationId: 'c1', providerId: 'gptlive', endSession: async () => undefined }),
    ];

    for (const intento of intentos) {
      try {
        await intento();
      } catch (err) {
        mensajes.add((err as Error).message);
      }
    }

    expect(mensajes.size).toBe(intentos.length); // los 6 mensajes son distintos entre sí
  });
});

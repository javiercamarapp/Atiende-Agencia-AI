// ═══════════════════════════════════════════════════════════════════════════
// Selección de VoiceProvider por config — mismo principio que el gate de
// residencia en agent-core/gateway/residency.ts: EXPLÍCITO siempre, nunca
// degrada en silencio. A diferencia de LlmGateway (que arma una ESCALERA de
// fallback entre varios LlmProvider), aquí NO hay fallback entre proveedores
// de voz: una llamada de voz activa está atada a un solo proveedor durante
// toda su sesión — cambiar de proveedor a medio de una conversación full-
// duplex no tiene análogo razonable (a diferencia de un LLM, donde
// reintentar el MISMO prompt en otro proveedor sí lo tiene).
// ═══════════════════════════════════════════════════════════════════════════

import { ElevenLabsVoiceProvider, type ElevenLabsVoiceProviderOptions } from './providers/elevenlabs-provider.js';
import { GptLiveVoiceProvider } from './providers/gptlive-provider.js';
import { VoiceProviderConfigError } from './errors.js';
import type { VoiceProvider } from './types.js';

export type VoiceProviderId = 'elevenlabs' | 'gptlive';

export const DEFAULT_VOICE_PROVIDER: VoiceProviderId = 'elevenlabs';

export interface VoiceProviderRouterOptions {
  elevenlabs: ElevenLabsVoiceProviderOptions;
}

/**
 * Selecciona el proveedor. Lee de config (env var `VOICE_PROVIDER`, o
 * override por tenant si la vertical lo pasa explícito — mismo patrón que
 * `residency` en `GatewayCallOptions`, que sobreescribe la policy por
 * llamada). Con `gptlive` seleccionado explícito, construye el proveedor
 * inerte y llama `assertAvailable()` DE INMEDIATO — la selección misma
 * falla, con el mensaje real, en vez de esperar al primer uso o (peor)
 * caer solo a ElevenLabs sin que el llamador lo haya pedido.
 */
export function selectVoiceProvider(
  requested: VoiceProviderId | undefined,
  opts: VoiceProviderRouterOptions,
): VoiceProvider {
  const providerId = requested ?? DEFAULT_VOICE_PROVIDER;

  switch (providerId) {
    case 'elevenlabs':
      return new ElevenLabsVoiceProvider(opts.elevenlabs);

    case 'gptlive': {
      const provider = new GptLiveVoiceProvider();
      provider.assertAvailable(); // lanza VoiceProviderNotActivatableError aquí mismo
      return provider; // inalcanzable — assertAvailable siempre lanza
    }

    default:
      throw new VoiceProviderConfigError(`voice-gateway: proveedor de voz desconocido "${String(providerId)}"`);
  }
}

/**
 * Lee `VOICE_PROVIDER` del entorno y valida que sea un `VoiceProviderId`
 * conocido — puerto del mismo patrón de "config por env var, nunca
 * adivinada" que usa el resto del monorepo (p.ej. selección de residencia
 * en agent-core). Vacío o ausente -> `undefined`, que `selectVoiceProvider`
 * resuelve al default (`elevenlabs`).
 */
export function readVoiceProviderFromEnv(env: Record<string, string | undefined> = process.env): VoiceProviderId {
  const raw = env.VOICE_PROVIDER;
  if (!raw) return DEFAULT_VOICE_PROVIDER;
  if (raw === 'elevenlabs' || raw === 'gptlive') return raw;
  throw new VoiceProviderConfigError(
    `voice-gateway: VOICE_PROVIDER="${raw}" no es válido — valores permitidos: "elevenlabs" | "gptlive".`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Selección de VoiceProvider por config — mismo principio que el gate de
// residencia en agent-core/gateway/residency.ts: EXPLÍCITO siempre, nunca
// degrada en silencio. A diferencia de LlmGateway (que arma una ESCALERA de
// fallback entre varios LlmProvider), aquí NO hay fallback entre proveedores
// de voz: una llamada de voz activa está atada a un solo proveedor durante
// toda su sesión — cambiar de proveedor a medio de una conversación full-
// duplex no tiene análogo razonable (a diferencia de un LLM, donde
// reintentar el MISMO prompt en otro proveedor sí lo tiene).
//
// `gptlive` (GPT-Live-1, OpenAI) es un proveedor REAL desde el 12-sep-2026 —
// se construye igual que `elevenlabs`, sin ningún bloqueo de selección. El
// bloqueo duro (`assertAvailable()` lanzando siempre) que existía cuando
// GPT-Live-1 no tenía API pública ya no aplica y se retiró de aquí.
// ═══════════════════════════════════════════════════════════════════════════

import { ElevenLabsVoiceProvider, type ElevenLabsVoiceProviderOptions } from './providers/elevenlabs-provider.js';
import { GptLiveVoiceProvider, type GptLiveVoiceProviderOptions } from './providers/gptlive-provider.js';
import { VoiceProviderConfigError } from './errors.js';
import type { VoiceProvider } from './types.js';

export type VoiceProviderId = 'elevenlabs' | 'gptlive';

export const DEFAULT_VOICE_PROVIDER: VoiceProviderId = 'elevenlabs';

export interface VoiceProviderRouterOptions {
  elevenlabs: ElevenLabsVoiceProviderOptions;
  /** Requerido solo cuando se selecciona `gptlive` — opcional en el tipo para
   *  no romper llamadores existentes que solo usan ElevenLabs; si falta y se
   *  pide `gptlive`, `selectVoiceProvider` lanza `VoiceProviderConfigError`
   *  explícito en vez de un `undefined` silencioso. */
  gptlive?: GptLiveVoiceProviderOptions;
}

/**
 * Selecciona el proveedor. Lee de config (env var `VOICE_PROVIDER`, o
 * override por tenant si la vertical lo pasa explícito — mismo patrón que
 * `residency` en `GatewayCallOptions`, que sobreescribe la policy por
 * llamada).
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
      if (!opts.gptlive) {
        throw new VoiceProviderConfigError(
          'voice-gateway: se pidió "gptlive" pero falta `opts.gptlive` (apiKeyProvider/resolveSignedUrl) — ' +
            'nunca se adivina la configuración de un proveedor pedido explícito.',
        );
      }
      return new GptLiveVoiceProvider(opts.gptlive);
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

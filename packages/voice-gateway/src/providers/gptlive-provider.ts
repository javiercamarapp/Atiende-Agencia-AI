// ═══════════════════════════════════════════════════════════════════════════
// GptLiveVoiceProvider — implementación INERTE de VoiceProvider para
// GPT-Live-1 (OpenAI).
//
// ESTADO REAL VERIFICADO (10-sep-2026): lanzado hoy mismo, SIN API pública
// todavía — solo formulario de lista de espera. OpenAI dice "semanas, no
// meses". Cualquier método de este proveedor DEBE fallar cerrado, explícito
// y con el mismo mensaje siempre — NUNCA simular una respuesta, NUNCA caer
// en silencio a otro proveedor.
//
// CONTRATO REAL FUTURO (documentado aquí para que activarlo el día que haya
// API sea llenar métodos, no rediseñar):
//
//   - Full-duplex: escucha y habla simultáneo — a diferencia de ElevenLabs
//     (turnos), `startSession` en GPT-Live-1 abre un canal bidireccional
//     continuo. `VoiceTranscriptEvent` ya modela roles 'user'/'agent' de
//     forma agnóstica al proveedor, así que el contrato NO cambia aquí — lo
//     que cambia es la implementación interna (streaming continuo en vez de
//     eventos por turno).
//   - GPT-Live-1 delega razonamiento/tool-calling a un modelo BACKEND
//     separado. Ese rol es EXACTAMENTE el que agent-core/gateway/gateway.ts
//     (LlmGateway) ya cumple en este monorepo — ver
//     packages/voice-gateway/src/bridge/gptlive-agent-bridge.ts para el
//     diseño de esa conexión (inerte hoy, lista para llenar).
//   - Telefonía real vía Twilio Agent Connect (GPTLiveProvider nativo de
//     Twilio) — `getSignedUrl` hoy asume un signed_url de navegador; el día
//     de la API real, telefonía probablemente entra por un método SIP
//     separado (no listado aún en el contrato compartido porque no hay
//     forma de confirmarlo sin la documentación real de la API).
//   - Precio real: $0.05/min de la capa de voz, facturado POR SEGUNDO — si
//     este monorepo reutiliza `agent-core/gateway/budget.ts` (reserva-antes-
//     de-gastar) para voz, el costEstimator de GPT-Live-1 debe estimar en
//     segundos, no en tokens (a diferencia de LlmCostEstimator).
//   - Múltiples idiomas/acentos soportados nativamente.
//
// VARIABLES DE ENTORNO: ninguna hoy — no hay endpoint contra el cual
// autenticar. El día que exista la API, ver README.md ("Activar GPT-Live-1")
// para la lista exacta de env vars que se necesitarán.
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
import { VoiceProviderNotActivatableError } from '../errors.js';

const REASON =
  'GPT-Live-1 aún no tiene API pública (lanzado 10-sep-2026, en lista de espera) — ' +
  'este proveedor no puede activarse todavía.';

export class GptLiveVoiceProvider implements VoiceProvider {
  readonly id = 'gptlive';

  private fail(method: string): never {
    throw new VoiceProviderNotActivatableError(this.id, `${REASON} (método: ${method})`);
  }

  /**
   * Extensión NO parte de la interfaz `VoiceProvider` compartida — solo la
   * usa el router (ver router.ts) para fallar en el momento de la
   * SELECCIÓN, no solo en el primer uso, cuando alguien pide GPT-Live-1
   * explícitamente por config.
   */
  assertAvailable(): void {
    this.fail('assertAvailable');
  }

  async getSignedUrl(_tenant: VoiceTenantContext): Promise<SignedVoiceUrl> {
    this.fail('getSignedUrl');
  }

  async listVoices(_languageFilter: string): Promise<VoiceListing[]> {
    this.fail('listVoices');
  }

  async getAgentConfig(_tenant: VoiceTenantContext): Promise<VoiceAgentConfig> {
    this.fail('getAgentConfig');
  }

  async updateAgentConfig(_update: UpdateVoiceAgentConfig): Promise<void> {
    this.fail('updateAgentConfig');
  }

  async startSession(_req: StartVoiceSessionRequest): Promise<VoiceSessionHandle> {
    this.fail('startSession');
  }

  async endSession(_handle: VoiceSessionHandle): Promise<void> {
    this.fail('endSession');
  }
}

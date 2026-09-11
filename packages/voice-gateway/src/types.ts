// ═══════════════════════════════════════════════════════════════════════════
// Tipos públicos de la CAPA DE VOZ ÚNICA (packages/voice-gateway).
//
// Mismo espíritu que agent-core/gateway/types.ts: un solo contrato
// (`VoiceProvider`) que CUALQUIER vertical (hoteles, restaurantes, rentas,
// citas) consume sin conocer si detrás hay ElevenLabs, GPT-Live-1, o lo que
// venga después. "Proveedor plegable": se agrega o se quita sin tocar el
// código de la vertical.
//
// PUERTO de la integración real ya en producción en
// restaurantes/supabase/functions/agent-config/index.ts +
// restaurantes/src/pages/AdminDashboard.tsx (SDK @elevenlabs/client).
// ═══════════════════════════════════════════════════════════════════════════

import type { Vertical } from '@atiende/core-tenancy';

/**
 * Contexto de tenant real — mismo modelo de dos niveles que
 * core-tenancy/types.ts (Organization → Property), nunca reinventado aquí.
 * `agentId` es el id del agente TAL COMO LO ENTIENDE EL PROVEEDOR concreto
 * (agent_xxxx de ElevenLabs hoy; un id de assistant de GPT-Live-1 mañana) —
 * lo resuelve el llamador desde su propia tabla de config por vertical
 * (equivalente a `branches.elevenlabs_agent_id` en restaurantes), esta capa
 * nunca lo adivina ni lo cachea.
 */
export interface VoiceTenantContext {
  readonly organizationId: string;
  readonly propertyId: string;
  readonly vertical: Vertical;
  readonly agentId: string;
}

export type VoiceRole = 'user' | 'agent';

/** Puerto directo de `onMessage({ message, role })` del SDK real
 *  (AdminDashboard.tsx línea 1542) — mismo shape, nombres normalizados. */
export interface VoiceTranscriptEvent {
  role: VoiceRole;
  text: string;
  /** epoch ms en el que ESTA capa recibió el evento — best effort, no
   *  garantizado monotónico entre proveedores distintos. */
  at: number;
}

export interface StartVoiceSessionRequest {
  tenant: VoiceTenantContext;
  /** Variables dinámicas inyectadas al primer mensaje/prompt — puerto
   *  directo de `dynamicVariables` en Conversation.startSession
   *  (AdminDashboard.tsx: `{ modo_prueba: 'true', saludo: saludoSegunHoraMerida() }`). */
  dynamicVariables?: Record<string, string>;
  onTranscript?: (event: VoiceTranscriptEvent) => void;
  onError?: (message: string) => void;
  onConnect?: (info: { conversationId: string }) => void;
  onDisconnect?: () => void;
}

export interface VoiceSessionHandle {
  readonly conversationId: string;
  readonly providerId: string;
  endSession(): Promise<void>;
}

export interface SignedVoiceUrl {
  url: string;
  /** epoch ms; `undefined` si el proveedor no reporta expiración (ElevenLabs
   *  hoy no la reporta — el signed_url real de agent-config no trae TTL). */
  expiresAt?: number;
}

export interface VoiceListing {
  voiceId: string;
  name: string;
  /** BCP-47/ISO 639-1 normalizado por el proveedor concreto — ElevenLabsVoiceProvider
   *  normaliza el campo `accent` real (`latin`, `mexic`, `colomb`, `argentin`,
   *  `neutral` — filtro real de agent-config/index.ts acción "voices"). */
  language: string;
  accent?: string;
  gender?: string;
  previewUrl?: string;
}

export interface VoiceAgentConfig {
  agentId: string;
  name: string;
  firstMessage: string;
  language: string;
  prompt: string;
  temperature: number;
  voiceId: string | null;
}

/** Puerto directo de los campos reales que `agent-config` acción "update"
 *  acepta (voice_id, language, prompt, temperature, first_message, speed,
 *  stability...) — acotado aquí a los 5 que pidió la tarea (voz/idioma/
 *  prompt/temperatura/primer mensaje); el resto queda como extensión de
 *  cada ElevenLabsVoiceProvider concreto, no en el contrato compartido. */
export interface UpdateVoiceAgentConfig {
  agentId: string;
  voiceId?: string;
  language?: string;
  prompt?: string;
  temperature?: number;
  firstMessage?: string;
}

/**
 * Un proveedor de voz plegable. Dos superficies distintas conviven en el
 * MISMO contrato porque así vive en el repo real, no por elección
 * arbitraria:
 *
 *  - SUPERFICIE DE SERVIDOR (`getSignedUrl`, `listVoices`, `getAgentConfig`,
 *    `updateAgentConfig`): habla contra la REST API del proveedor con la key
 *    secreta. SOLO corre en un backend (Edge Function / apps de la API) — igual
 *    que agent-config/index.ts, que lee la key de Supabase Vault y nunca la
 *    manda al cliente.
 *  - SUPERFICIE DE CLIENTE (`startSession`, `endSession`): corre donde está
 *    el humano (navegador, o un bridge de telefonía) usando el SDK realtime
 *    del proveedor con un signed_url — NUNCA con la key. Puerto directo de
 *    AdminDashboard.tsx.
 *
 * Una implementación concreta (ver ElevenLabsVoiceProvider) se construye en
 * "modo servidor" (con acceso a la key) o "modo cliente" (sin ella, resuelve
 * signed_url llamando a SU PROPIO backend) — nunca las dos cosas en el mismo
 * bundle. El contrato es uno solo para que la vertical programe contra una
 * sola interfaz sin preocuparse de en qué runtime corre cada llamada.
 */
export interface VoiceProvider {
  readonly id: string;

  // ---- superficie de servidor -------------------------------------------
  getSignedUrl(tenant: VoiceTenantContext): Promise<SignedVoiceUrl>;
  listVoices(languageFilter: string): Promise<VoiceListing[]>;
  getAgentConfig(tenant: VoiceTenantContext): Promise<VoiceAgentConfig>;
  updateAgentConfig(update: UpdateVoiceAgentConfig): Promise<void>;

  // ---- superficie de cliente ---------------------------------------------
  startSession(req: StartVoiceSessionRequest): Promise<VoiceSessionHandle>;
  endSession(handle: VoiceSessionHandle): Promise<void>;
}

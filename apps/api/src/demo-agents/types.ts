import type { DemoLocale, DemoSolution } from "./profiles.ts";

export const DEMO_LIMITS = { caracteresPorMensaje: 600, mensajesPorConversacion: 12, vozDuracionSegundos: 60 } as const;
export const DEMO_CONTEXT = { entorno: "demostracion", accionesReales: false } as const;
/**
 * Topes de la demo publica (contadores durables, ver `consume`). El tope por SESION es solo de experiencia: el `sessionId` lo inventa el visitante y rotarlo no
 * cuesta nada. Lo que protege el cupo compartido es el tope DIARIO POR IP, que es una fraccion del cupo de la plataforma: una sola IP no puede agotarlo.
 */
export const DEMO_TOPES = {
  chat: { ipVentana: { limite: 12, segundos: 600 }, ipDia: { limite: 40, segundos: 86400 }, sesion: { limite: 12, segundos: 86400 }, plataforma: { limite: 200, segundos: 86400 } },
  voz: { ipVentana: { limite: 3, segundos: 3600 }, ipDia: { limite: 6, segundos: 86400 }, sesion: { limite: 2, segundos: 86400 }, plataforma: { limite: 30, segundos: 86400 } },
} as const;
export interface DemoMessage { readonly rol: "usuario" | "agente"; readonly texto: string }
export interface DemoInput {
  readonly solution: DemoSolution;
  readonly locale: DemoLocale;
  readonly sessionId: string;
}
export interface DemoVoiceSession {
  readonly sesionId: string;
  readonly proveedor: string;
  readonly modelo: string;
  readonly voiceId: string;
  readonly websocketUrl: string;
  readonly tokenProveedor: string;
  readonly expiraEn: string;
  /** Client UX timer; provider token has a separate explicit expiration window. */
  readonly duracionMaxSegundos: number;
  readonly tokenCaducidadSegundos?: number;
}
export interface DemoAgentsDeps {
  readonly enabled: boolean;
  readonly allowedOrigins: readonly string[];
  readonly chat?: (input: DemoInput & { readonly mensajes: readonly DemoMessage[] }) => Promise<{ respuesta: string; modelo: string; proveedor: string }>;
  readonly voice?: (input: DemoInput) => Promise<DemoVoiceSession>;
  /** Atomic durable counters, committed before provider calls. No in-memory fallback. */
  readonly consume: (scope: string, actor: string, limit: number, seconds: number) => Promise<boolean>;
}

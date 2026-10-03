// Interfaz que implementa cada adaptador de proveedor de voz (Gemini Live, el
// adaptador de demostración, etc.). El adaptador traduce lo que pase en el proveedor
// a cambios de `VoiceSessionState`; la interfaz (packages/ui) solo lee ese estado.
import type { LineaTranscripcion, OpcionesIniciarSesionVoz, VoiceSessionState } from "@atiende/ui";

export type CambioEstado = Partial<Pick<VoiceSessionState, "modo" | "volumenEntrada" | "volumenSalida" | "error" | "sessionId">>;

export interface CallbacksAdaptador {
  cambiar(cambio: CambioEstado): void;
  /** Agrega la línea o, si ya existe una con el mismo `id`, la reemplaza (fragmentos parciales). */
  linea(linea: LineaTranscripcion): void;
  /** El adaptador terminó la sesión por su cuenta (se cayó la conexión, el agente colgó). */
  terminado(): void;
}

export interface AdaptadorVoz {
  iniciar(opts?: OpcionesIniciarSesionVoz): Promise<void>;
  terminar(): Promise<void>;
  silenciar(silenciar: boolean): void;
}

export type FabricaAdaptador = (callbacks: CallbacksAdaptador) => AdaptadorVoz;

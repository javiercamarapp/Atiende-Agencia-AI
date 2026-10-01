// Contrato NEUTRO de proveedor de la experiencia de voz (orbe, transcripción y
// vista previa de llamada). La interfaz solo lee un `VoiceSessionState`; cada
// proveedor (Gemini Live hoy, otro mañana, o el adaptador de demostración) es un
// adaptador que produce ese estado. Ningún tipo de aquí nombra a un proveedor.

/** Estados visuales del orbe. `error` es terminal hasta que se reintente. */
export type ModoOrb = "reposo" | "conectando" | "escuchando" | "pensando" | "hablando" | "error";

export const MODOS_ORB: readonly ModoOrb[] = ["reposo", "conectando", "escuchando", "pensando", "hablando", "error"];

export interface LineaTranscripcion {
  readonly id: string;
  readonly rol: "agente" | "usuario";
  readonly texto: string;
  /** `true` mientras siguen llegando fragmentos de esta línea (aún no es definitiva). */
  readonly parcial: boolean;
  /** Milisegundos epoch en que se emitió la línea. */
  readonly ts: number;
}

export interface ErrorSesionVoz {
  readonly codigo: string;
  readonly mensaje: string;
  /** `true` si reintentar tiene sentido (red, micrófono denegado); `false` si no (configuración). */
  readonly recuperable: boolean;
}

export interface VoiceSessionState {
  readonly modo: ModoOrb;
  /** Nivel del micrófono del usuario, 0..1, ya suavizado. */
  readonly volumenEntrada: number;
  /** Nivel del audio del agente, 0..1, ya suavizado. */
  readonly volumenSalida: number;
  readonly transcripcion: readonly LineaTranscripcion[];
  readonly error?: ErrorSesionVoz;
  /** Identificador de la sesión para trazabilidad (p. ej. marcarla como vista previa). */
  readonly sessionId?: string;
}

export interface OpcionesIniciarSesionVoz {
  readonly dynamicVariables?: Readonly<Record<string, string>>;
  readonly vozId?: string;
}

export interface VoiceSessionController {
  readonly estado: VoiceSessionState;
  readonly silenciado: boolean;
  iniciar(opts?: OpcionesIniciarSesionVoz): Promise<void>;
  terminar(): Promise<void>;
  silenciar(silenciar: boolean): void;
}

export const ESTADO_SESION_INICIAL: VoiceSessionState = {
  modo: "reposo",
  volumenEntrada: 0,
  volumenSalida: 0,
  transcripcion: [],
};

/** `true` si hay una llamada en curso (cualquier modo salvo reposo/error). */
export function sesionActiva(modo: ModoOrb): boolean {
  return modo === "conectando" || modo === "escuchando" || modo === "pensando" || modo === "hablando";
}

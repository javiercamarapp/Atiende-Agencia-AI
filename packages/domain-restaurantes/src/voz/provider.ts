// Contrato `VoiceAgentProvider` del backend de voz de restaurantes: el punto de intercambio entre
// motores (Gemini 3.8 Live = principal; gpt-live-1 = respaldo, ver
// expertos/arquitectura-voz-pm.md §4; ElevenLabs se retiro del stack de PM). Esta tarea cubre solo el lado "panel": emitir la sesion de
// preview, exponer el catalogo de voces y reportar salud. El servicio de llamadas (`startSession`
// con audio SIP) es otra tarea y ampliara este contrato sin romper estos tres metodos.
import type { VozCatalogoItem } from "./catalogo-voces.ts";
import type { VozProveedorId } from "./types.ts";

export interface VozSesionPreviewEntrada {
  readonly organizationId: string;
  readonly propertyId: string;
  /** Id de la fila de `voice_preview_sessions`. */
  readonly sessionId: string;
  readonly voiceId: string;
  /** Comportamiento/prompt guardado de la sucursal (puede ser ''). */
  readonly comportamiento: string;
  readonly mensajeInicial: string;
  readonly ttlSegundos: number;
}

/** Lo que el navegador necesita para hablar con el proveedor durante el preview. */
export interface VozSesionPreviewProveedor {
  readonly proveedor: VozProveedorId | "fake";
  readonly modelo: string;
  /** Endpoint WebSocket al que se conecta el navegador con `tokenProveedor`. */
  readonly websocketUrl: string;
  /** Credencial efimera DEL PROVEEDOR (nunca la API key de la plataforma). */
  readonly tokenProveedor: string;
  readonly expiraEn: string;
}

export interface VozSalud {
  readonly ok: boolean;
  readonly detalle: string;
}

export interface VoiceAgentProvider {
  readonly id: VozProveedorId | "fake";
  catalogoVoces(): readonly VozCatalogoItem[];
  /** Nunca abre una sesion real ni gasta: solo informa si el adaptador puede emitir sesiones. */
  salud(): Promise<VozSalud>;
  /** Lanza `VozNoConfiguradaError` si falta la credencial (la ruta responde 503 honesto, jamas un
   * falso exito) y `VozProveedorError` si el proveedor rechaza o falla. */
  emitirSesionPreview(entrada: VozSesionPreviewEntrada): Promise<VozSesionPreviewProveedor>;
}

/** El adaptador no tiene credencial: "voz no configurada". */
export class VozNoConfiguradaError extends Error {
  constructor(message = "Voz no configurada: falta la credencial del proveedor de voz.") {
    super(message);
    this.name = "VozNoConfiguradaError";
  }
}

/** El proveedor respondio con error o fallo la red al emitir la sesion. */
export class VozProveedorError extends Error {
  constructor(message: string, readonly estado?: number) {
    super(message);
    this.name = "VozProveedorError";
  }
}

// Contrato `VoiceAgentProvider` del backend de voz compartido: el punto de intercambio entre
// motores (Gemini 3.8 Live = principal; cascada OpenRouter = respaldo automatico, ver `config-plataforma.ts`; gpt-live-1 y
// ElevenLabs salieron del stack). Esta tarea cubre solo el lado "panel": emitir la sesion de
// preview, exponer el catalogo de voces y reportar salud. El servicio de llamadas (`startSession`
// con audio SIP) es otra tarea y ampliara este contrato sin romper estos tres metodos.
import type { VozCatalogoItem } from "./catalogo-voces.ts";
import type { AbrirSesionLlamada } from "./llamada/sesion.ts";
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
  /** `temperature` de voz de la organizacion (0..1); null/ausente = la del proveedor. */
  readonly temperatura?: number | null;
  readonly ttlSegundos: number;
  /** Vertical que emite la sesion. Los decoradores que aplican ajustes propios de una vertical (restaurantes) solo actuan si coincide; ausente = no aplican. */
  readonly vertical?: string;
  /** Declaraciones de herramientas (nombre, descripcion y esquema JSON) que el token efimero fija para la sesion. Ausente =
   * la sesion no puede llamar herramientas (comportamiento historico). Las ejecuta el servidor en modo preview, no el proveedor. */
  readonly herramientas?: readonly VozHerramientaDeclaracion[];
}

/** Declaracion de una herramienta que el agente de voz puede invocar durante la llamada de prueba. */
export interface VozHerramientaDeclaracion {
  readonly name: string;
  readonly description: string;
  readonly parameters: { readonly type: "object"; readonly properties: Readonly<Record<string, unknown>>; readonly required?: readonly string[] };
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
  /** Sesion de LLAMADA (servidor, con herramientas): la usa el worker de voz y el simulador. Opcional: un adaptador que
   * solo emite previews no la implementa. Lanza `VozNoConfiguradaError` sin credencial y `VozProveedorError` si falla. */
  abrirLlamada?: AbrirSesionLlamada;
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

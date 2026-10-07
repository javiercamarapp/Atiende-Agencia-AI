// Puerto de UNA sesion de conversacion con un proveedor de voz-a-voz (Gemini Live, la cascada OpenRouter, el falso del simulador).
// El controlador (`controlador.ts`) conduce la llamada contra este puerto; el audio (SIP/LiveKit) y el protocolo del
// proveedor quedan del otro lado. En modo texto (`enviarTexto`) se usa para el simulador y la prueba ciega manual.
import type { ToolDefinicion } from "./ejecutor-tools.ts";

export interface ToolCallPedida {
  readonly id: string;
  readonly nombre: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface ManejadoresSesion {
  /** Texto (o transcripcion) de lo que dice el agente. */
  agenteDijo(texto: string): void;
  /** El agente termino su turno (turnComplete). */
  agenteTermino(): void;
  /** El proveedor corto al agente porque el cliente hablo encima (barge-in nativo del proveedor). */
  interrumpido(): void;
  /** Transcripcion de lo que dijo el cliente, si el proveedor la entrega. */
  usuarioDijo?(texto: string): void;
  /** El agente pide una herramienta; la respuesta se devuelve al proveedor tal cual. */
  ejecutarTool(llamada: ToolCallPedida): Promise<unknown>;
  /** Audio PCM16 del agente (24 kHz mono en Gemini) para reproducirlo al cliente; solo en sesiones con audio. */
  audioAgente?(pcm16: Uint8Array): void;
  /** Costo adicional (micro-USD) desde el ultimo aviso. `real` = sale de los tokens que reporto el proveedor (`usageMetadata`), no de una tarifa. */
  costo?(microUsd: number, real?: boolean): void;
  /** El proveedor se cayo (cierre inesperado, error de red o `goAway`). Lleva el handle de reanudacion si lo hay. */
  caido(razon: string, handleReanudacion: string | null): void;
}

export interface AperturaLlamada {
  readonly instruccion: string;
  readonly voiceId: string;
  readonly herramientas: readonly ToolDefinicion[];
  /** `temperature` de la organizacion (0..1) para el modelo de voz; sin valor, el del proveedor. */
  readonly temperatura?: number | null;
  /** Modelo de TEXTO que la organizacion eligio para la cascada (id de OpenRouter, de la lista permitida). Lo resuelve el puerto del LLM. */
  readonly modeloLlm?: string | null;
  /** Handle de reanudacion de una sesion previa (reconexion). */
  readonly reanudarHandle?: string | null;
  /** Conversacion hasta la caida (ya redactada) para sembrar una sesion NUEVA cuando no hay handle de reanudacion: la sesion continua en vez de arrancar de cero. */
  readonly historial?: readonly { readonly rol: "cliente" | "agente"; readonly texto: string }[];
  /** Nombres y apodos del menu que el STT de la cascada recibe como pista de vocabulario (tope `cascada.vocabularioMax`). Gemini Live no lo usa. */
  readonly vocabulario?: readonly string[];
}

export interface VozSesionLlamada {
  enviarTexto(texto: string): void;
  enviarAudio?(pcm16: Uint8Array): void;
  /** Hace callar al agente (el controlador lo usa si la maquina ordena cortar el audio). */
  interrumpir(): void;
  cerrar(): Promise<void>;
}

export type AbrirSesionLlamada = (apertura: AperturaLlamada, manejadores: ManejadoresSesion) => Promise<VozSesionLlamada>;

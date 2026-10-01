// Puerto de UNA sesion de conversacion con un proveedor de voz-a-voz (Gemini Live, gpt-live-1, el falso del simulador).
// El controlador (`controlador.ts`) conduce la llamada contra este puerto; el audio (SIP/LiveKit) y el protocolo del
// proveedor quedan del otro lado. En modo texto (`enviarTexto`) se usa para el simulador y la prueba ciega manual.
import type { AgentToolDefinition } from "../../agent-tools/registry.ts";

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
  /** Costo adicional estimado (micro-USD) desde el ultimo aviso. */
  costo?(microUsd: number): void;
  /** El proveedor se cayo (cierre inesperado, error de red o `goAway`). Lleva el handle de reanudacion si lo hay. */
  caido(razon: string, handleReanudacion: string | null): void;
}

export interface AperturaLlamada {
  readonly instruccion: string;
  readonly voiceId: string;
  readonly herramientas: readonly AgentToolDefinition[];
  /** Handle de reanudacion de una sesion previa (reconexion). */
  readonly reanudarHandle?: string | null;
}

export interface VozSesionLlamada {
  enviarTexto(texto: string): void;
  enviarAudio?(pcm16: Uint8Array): void;
  /** Hace callar al agente (el controlador lo usa si la maquina ordena cortar el audio). */
  interrumpir(): void;
  cerrar(): Promise<void>;
}

export type AbrirSesionLlamada = (apertura: AperturaLlamada, manejadores: ManejadoresSesion) => Promise<VozSesionLlamada>;

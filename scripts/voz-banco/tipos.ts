// Tipos del banco de pruebas de voz proveedor-agnostico (T02). Sin dependencias de red ni de proveedores: los adaptadores reales viven aparte y se registran en `registro.ts`.
// La costura es el puerto de sesion de voice-core (`AbrirSesionLlamada`): el banco NO modifica voice-core; cada arquitectura es un `AdaptadorBanco` que entrega un `AbrirSesionLlamada`.
import type { AbrirSesionLlamada, ToolCallPedida } from "../../packages/voice-core/src/llamada/sesion.ts";
import type { Evento } from "../voz-medicion-real/escenarios.ts";

/** Lo que el cliente simulado entrega al agente en un turno. `texto` = tal cual; `stt-final` = texto ya degradado por el ruido sintetico (como lo entregaria un STT); `audio` = reservado (M1). */
export type EntradaCliente = "texto" | "stt-final" | "audio";

export type TurnoCliente =
  | { readonly tipo: "texto" | "stt-final"; readonly dicho: string; readonly oido: string; readonly cambios: readonly string[]; readonly interrumpe?: boolean; readonly sinRuido?: boolean }
  | { readonly tipo: "evento"; readonly evento: Exclude<Evento, { k: "interrumpe" } | { k: "cortada" }> };

export interface CostoAdaptador {
  readonly total: number; // micro-USD
  /** true si sale de lo que reporto el proveedor (tokens/uso), false si es tarifa estimada. */
  readonly real: boolean;
  readonly porComponente: Readonly<Record<string, number>>;
}

export interface AdaptadorBanco {
  /** "gemini-live:<modelo>", "openai-rt:<modelo>", "cascada:<stt>+<llm>+<tts>", "falso". */
  readonly id: string;
  readonly entradas: readonly EntradaCliente[];
  /** Si produce `audioAgente` (para medir primer audio). */
  readonly salidaAudio: boolean;
  /** Sin gasto: listas de modelos, saldo por endpoint gratuito. Un adaptador sin llave devuelve ok:false SIN tocar la red. */
  preflight(): Promise<{ ok: boolean; detalle: string; modeloResuelto?: string }>;
  crearAbrirSesion(ctx: { ruido: boolean; hzEntrada: number; hzSalida: number }): AbrirSesionLlamada;
  /** Costo acumulado de la sesion en curso (los adaptadores reales lo llevan por `manejadores.costo`). */
  costoMicroUsd(): CostoAdaptador;
  readonly capacidades: { readonly compuertaInterna: boolean; readonly herramientasEnParalelo: boolean };
}

/** Modo de la compuerta de pedidos como FACTOR experimental. */
export type ModoCompuerta = "on" | "off" | "servidor";

/** Contexto que la compuerta/traza pasa al ejecutor real: en modo `servidor` el transporte lo convierte en `x-atiende-call-turn`. */
export interface ContextoTool {
  readonly turno: number;
}
export type EjecutarTool = (llamada: ToolCallPedida, ctx?: ContextoTool) => Promise<unknown>;

export interface RegistroHerramienta {
  readonly nombre: string;
  readonly turnoCliente: number;
  readonly orden: number;
  readonly ok: boolean;
  /** El error corto devuelto (sin cuerpo): p. ej. "espera_confirmacion_del_cliente". */
  readonly error: string | null;
  readonly bloqueadaPorCompuerta: boolean;
  /** Solo `crear`: se intento sin confirmacion vigente del cliente (ver `traza-herramientas.ts`). */
  readonly sinConfirmar?: boolean;
}

export interface ResultadoLlamada {
  readonly escenario: string;
  readonly arquitectura: string;
  readonly modo: "M0-texto" | "M0-stt-final";
  readonly semilla: string;
  readonly turnos: readonly { readonly dicho: string; readonly oido: string; readonly cambios: readonly string[]; readonly agente: string }[];
  readonly herramientas: readonly RegistroHerramienta[];
  /** Intentos del modelo de crear sin confirmacion (lo que INTENTO, aunque la compuerta lo bloqueara). */
  readonly intentosCrearSinConfirmar: number;
  /** Los que llegaron a ejecutarse y tuvieron exito: son pedidos indebidos (P0). */
  readonly crearIndebidosEjecutados: number;
  readonly costo: CostoAdaptador;
  readonly cortada: null | "tope_llamada";
}

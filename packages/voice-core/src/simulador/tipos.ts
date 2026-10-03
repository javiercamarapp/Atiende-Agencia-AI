// Tipos del simulador local de llamadas y de la "prueba ciega es-MX", GENERICOS para cualquier vertical. Un GUION es una llamada
// completa: lo que dice el cliente (texto que representa la transcripcion de su voz), eventos de telefonia (silencio, ruido,
// DTMF, colgar) y lo que se espera al final. Con el proveedor FALSO el agente es "guionado" (cada turno del cliente trae los pasos
// correctos del agente: habla y herramientas); con un proveedor REAL (Gemini) se ignoran los pasos del agente y el modelo decide
// solo, de modo que los mismos guiones y graders sirven para ambos.
//
// La vertical aporta: su MEMORIA (lo que el agente recuerda de tools anteriores de la llamada para armar los argumentos del
// siguiente paso), sus RESULTADOS de cierre, lo que ESPERA ademas del resultado y su MUNDO (repositorio sembrado).
import type { EntradaInicioLlamada } from "../llamada/inicio.ts";
import type { MensajeId } from "../llamada/mensajes.ts";
import type { LimitesLlamada } from "../llamada/maquina.ts";
import type { VozResultadoBase } from "../types.ts";

/** Lo que el agente ya sabe por herramientas anteriores de ESTA llamada. La vertical agrega sus accesos propios (productos, tipos de habitacion...). */
export interface MemoriaBase {
  ultimo(nombre: string): unknown;
}

/** Memoria que el cerebro guionado alimenta con cada resultado de herramienta. */
export interface MemoriaObservable extends MemoriaBase {
  observar(nombre: string, resultado: unknown): void;
}

export type PasoAgente<M extends MemoriaBase = MemoriaBase> =
  | { readonly dice: string; /** El agente sigue hablando (no termina su turno): permite probar el barge-in. */ readonly largo?: boolean }
  | { readonly tool: string; readonly args: Readonly<Record<string, unknown>> | ((m: M) => Record<string, unknown>) };

export type TurnoGuion<M extends MemoriaBase = MemoriaBase> =
  | { readonly kind: "voz"; readonly cliente: string; readonly interrumpe?: boolean; readonly agente: readonly PasoAgente<M>[] }
  | { readonly kind: "confuso"; readonly cliente: string }
  | { readonly kind: "no_entendido" }
  | { readonly kind: "silencio"; readonly ms: number }
  | { readonly kind: "ruido" }
  | { readonly kind: "dtmf"; readonly digito: string }
  | { readonly kind: "tick"; readonly segundos: number }
  | { readonly kind: "costo"; readonly microUsd: number }
  | { readonly kind: "proveedor_cae" }
  | { readonly kind: "cuelga" };

export interface EsperadoBase<R extends string> {
  readonly resultado: R | VozResultadoBase | "no_iniciada";
  /** Pregrabados que deben haberse reproducido, en este orden (subsecuencia). */
  readonly pregrabados?: readonly MensajeId[];
  readonly audioCortadoMin?: number;
  /** Cuantas herramientas inexistentes o rechazadas por el servidor se esperan (el servidor las rechaza, la llamada sigue). */
  readonly herramientasRechazadas?: readonly { readonly nombre: string; readonly error: RegExp }[];
}

/** `E` = lo que la vertical espera ademas (pedido, callbacks, reserva...). */
export interface GuionLlamada<R extends string = string, E extends object = object, M extends MemoriaBase = MemoriaBase> {
  readonly id: string;
  readonly titulo: string;
  /** Rasgos de es-MX que ejercita (jerga, numeros hablados, correcciones...). */
  readonly rasgos: readonly string[];
  /** Cabecera SIP From del llamante; `null` = anonimo. Por omision, el telefono del arnes. */
  readonly sipFrom?: string | null;
  readonly limites?: Partial<LimitesLlamada>;
  readonly inicio?: Partial<EntradaInicioLlamada>;
  /** Solo proveedor falso: cuantas reaperturas de sesion fallan antes de lograr una. */
  readonly fallasAlReabrir?: number;
  /** La herramienta tarda `ms` (mas que el timeout configurado) cada vez que se llama. */
  readonly toolLenta?: { readonly nombre: string; readonly ms: number };
  /** Datos del cliente que NUNCA deben aparecer en los logs. */
  readonly sensibles?: readonly string[];
  /** Depende de provocar fallas en el proveedor (solo el falso puede): se omite en la corrida real contra Gemini. */
  readonly soloFalso?: boolean;
  readonly turnos: readonly TurnoGuion<M>[];
  readonly esperado: EsperadoBase<R> & E;
}

/** Lo minimo que el core necesita saber del mundo sembrado de una vertical. */
export interface MundoBase {
  readonly organizationId: string;
  readonly propertyId: string;
}

export interface LlamadaSimulada<R extends string = string, E extends object = object, M extends MemoriaBase = MemoriaBase, W extends MundoBase = MundoBase> {
  readonly guion: GuionLlamada<R, E, M>;
  readonly mundo: W;
  readonly iniciada: boolean;
  readonly resultado: R | VozResultadoBase | "no_iniciada";
  readonly pregrabados: readonly MensajeId[];
  readonly audioCortado: number;
  readonly transcripcion: readonly { readonly rol: "cliente" | "agente" | "herramienta"; readonly texto: string }[];
  readonly tools: readonly { readonly nombre: string; readonly args: unknown; readonly resultado: unknown }[];
  readonly logs: readonly { readonly evento: string; readonly campos: Readonly<Record<string, string | number | boolean>> }[];
  readonly kpi: readonly unknown[];
}

export interface ResultadoGrader {
  readonly grader: string;
  readonly ok: boolean;
  readonly detalle: string;
}

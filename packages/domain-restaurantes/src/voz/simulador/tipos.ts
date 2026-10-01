// Tipos del simulador local de llamadas y de la "prueba ciega es-MX". Un GUION es una llamada completa: lo que dice el
// cliente (texto que representa la transcripcion de su voz), eventos de telefonia (silencio, ruido, DTMF, colgar) y lo
// que se espera al final. Con el proveedor FALSO el agente es "guionado" (cada turno del cliente trae los pasos
// correctos del agente: habla y herramientas); con un proveedor REAL (Gemini) se ignoran los pasos del agente y el modelo
// decide solo, de modo que los mismos guiones y graders sirven para ambos.
import type { LimitesLlamada } from "../llamada/maquina.ts";
import type { EntradaInicioLlamada } from "../llamada/inicio.ts";
import type { MensajeId } from "../llamada/mensajes.ts";
import type { MundoVoz } from "./mundo-voz.ts";
import type { VozResultado } from "../types.ts";

/** Lo que el agente ya sabe por herramientas anteriores de ESTA llamada (para armar los argumentos del siguiente paso). */
export interface MemoriaTools {
  ultimo(nombre: string): unknown;
  /** Producto devuelto por `buscar_producto` cuyo nombre contiene el fragmento (sin importar mayusculas ni acentos). */
  producto(fragmento: string): { readonly id: string; readonly name: string; readonly price: number; readonly pack_size: number };
  quoteHash(): string | undefined;
}

export type PasoAgente =
  | { readonly dice: string; /** El agente sigue hablando (no termina su turno): permite probar el barge-in. */ readonly largo?: boolean }
  | { readonly tool: string; readonly args: Readonly<Record<string, unknown>> | ((m: MemoriaTools) => Record<string, unknown>) };

export type TurnoGuion =
  | { readonly kind: "voz"; readonly cliente: string; readonly interrumpe?: boolean; readonly agente: readonly PasoAgente[] }
  | { readonly kind: "confuso"; readonly cliente: string }
  | { readonly kind: "no_entendido" }
  | { readonly kind: "silencio"; readonly ms: number }
  | { readonly kind: "ruido" }
  | { readonly kind: "dtmf"; readonly digito: string }
  | { readonly kind: "tick"; readonly segundos: number }
  | { readonly kind: "costo"; readonly microUsd: number }
  | { readonly kind: "proveedor_cae" }
  | { readonly kind: "cuelga" };

export interface PedidoEsperado {
  readonly sucursal: string;
  readonly canal: "domicilio" | "recoger";
  readonly pago: "efectivo" | "tarjeta";
  readonly total: number;
  /** `cantidad` = ordenes (paquetes) cobradas, como las guarda el pedido. */
  readonly items: readonly { readonly nombre: string; readonly cantidad: number }[];
  /** Fragmentos que deben aparecer en la direccion guardada (domicilio). */
  readonly direccionIncluye?: readonly string[];
}

export interface Esperado {
  readonly resultado: VozResultado | "no_iniciada";
  readonly pedido?: PedidoEsperado;
  readonly sinPedido?: boolean;
  /** Motivos de callback en orden (`escalada:queja`, ...). */
  readonly callbacks?: readonly string[];
  /** Pregrabados que deben haberse reproducido, en este orden (subsecuencia). */
  readonly pregrabados?: readonly MensajeId[];
  readonly audioCortadoMin?: number;
  /** Cuantas herramientas inexistentes o rechazadas por el servidor se esperan (el servidor las rechaza, la llamada sigue). */
  readonly herramientasRechazadas?: readonly { readonly nombre: string; readonly error: RegExp }[];
}

export interface GuionLlamada {
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
  readonly turnos: readonly TurnoGuion[];
  readonly esperado: Esperado;
}

export interface LlamadaSimulada {
  readonly guion: GuionLlamada;
  readonly mundo: MundoVoz;
  readonly iniciada: boolean;
  readonly resultado: VozResultado | "no_iniciada";
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

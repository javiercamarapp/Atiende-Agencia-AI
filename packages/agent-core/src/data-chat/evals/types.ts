// Tipos del ARNES DE EVALUACION del Copiloto ("Chatea con tus datos") sobre OpenRouter (MOD-07).
// Un caso = una pregunta en espanol de Mexico + la respuesta ESPERADA, que NO se escribe a mano: la
// calcula el congelador ejecutando la herramienta de referencia contra datos sembrados en Postgres
// efimero (scripts/eval-copiloto/congelar.ts). Los graders (graders.ts) son deterministas.
import type { DataChatChartSpec, DataChatHistoryTurn, DataChatStatus, DataChatToolResult } from "../types.js";

export const CATEGORIAS_CASO = ["directa", "periodo", "multi", "seguimiento", "ambigua", "fuera_catalogo", "trampa", "redaccion"] as const;
export type CategoriaCaso = (typeof CATEGORIAS_CASO)[number];

/** Reparto objetivo por categoria (docs/EVAL-COPILOTO.md; suma 100). */
export const REPARTO_CATEGORIAS: Readonly<Record<CategoriaCaso, number>> = {
  directa: 30,
  periodo: 15,
  multi: 15,
  seguimiento: 10,
  ambigua: 8,
  fuera_catalogo: 10,
  trampa: 7,
  redaccion: 5,
};

export type RiesgoCaso = "bajo" | "medio" | "alto";

export interface LlamadaEsperada {
  readonly tool: string;
  /** Argumentos EXACTOS que debe mandar el modelo (periodo equivalente: se compara la ventana resuelta). */
  readonly args: Readonly<Record<string, string | number>>;
}

export interface CifraEsperada {
  readonly etiqueta: string;
  readonly valor: number;
}

export interface EsperadoCaso {
  /** Estado del turno del motor (calculado por la corrida de referencia, no escrito a mano). */
  readonly status: DataChatStatus;
  readonly llamadas: readonly LlamadaEsperada[];
  /** Cifras que DEBEN aparecer en la respuesta (texto o tablas), leidas de los resultados de referencia. */
  readonly cifras: readonly CifraEsperada[];
  readonly periodLabels: readonly string[];
  readonly grafica: boolean;
  /** Fragmentos que NO deben aparecer jamas en el TEXTO del asistente (PII, instrucciones inyectadas, SQL, el prompt del sistema). */
  readonly prohibidas: readonly string[];
}

export interface CasoEval {
  readonly id: string;
  readonly vertical: string;
  readonly categoria: CategoriaCaso;
  readonly pregunta: string;
  readonly historial: readonly DataChatHistoryTurn[];
  readonly esperado: EsperadoCaso;
  readonly riesgo: RiesgoCaso;
}

/** Resultado de referencia de una llamada (ya congelado): lo que devolvio la herramienta contra los datos sembrados. */
export interface ReferenciaLlamada {
  readonly tool: string;
  readonly args: Readonly<Record<string, string | number>>;
  readonly result: DataChatToolResult;
}

export interface ArchivoCongelado {
  readonly version: 1;
  readonly vertical: string;
  /** Instante fijo con el que se calcularon las referencias y con el que se corre el arnes. */
  readonly now: string;
  readonly timezone: string;
  /** Linea de alcance que describeScope entrego al sembrar (para el modo guionado sin base). */
  readonly scopeLine: string;
  readonly casos: readonly CasoEval[];
  readonly referencias: Readonly<Record<string, readonly ReferenciaLlamada[]>>;
}

export interface LlamadaObservada {
  readonly name: string;
  readonly argumentsJson: string;
  /** null = parseo y validacion correctos; texto = por que se rechazo. */
  readonly errorArgs: string | null;
  readonly args: Readonly<Record<string, string | number | undefined>> | null;
}

export interface ResultadoCapturado {
  readonly tool: string;
  readonly result: DataChatToolResult;
}

/** Todo lo observado en UN turno del motor con UN modelo (insumo de los graders). */
export interface SalidaTurno {
  readonly status: DataChatStatus;
  readonly text: string;
  readonly toolsUsed: readonly string[];
  readonly blocks: readonly { readonly tool: string; readonly columns: readonly { readonly key: string }[]; readonly rows: readonly Readonly<Record<string, string | number | null>>[]; readonly chart?: DataChatChartSpec }[];
  readonly sources: readonly { readonly periodLabel?: string }[];
  readonly llamadas: readonly LlamadaObservada[];
  /** Texto final CRUDO del modelo (antes del filtro del motor). */
  readonly textoModelo: string;
  readonly resultados: readonly ResultadoCapturado[];
  readonly latenciaMs: number;
  readonly latenciaLlmMs: number;
  readonly costoUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly rondas: number;
}

export interface ResultadoGrader {
  readonly grader: string;
  readonly ok: boolean;
  readonly detalle?: string;
}

export interface EvaluacionCaso {
  /** Pasa todos los graders de exactitud (los de espanol y latencia se reportan aparte). */
  readonly ok: boolean;
  readonly graders: readonly ResultadoGrader[];
  /** Numeros del texto crudo del modelo sin respaldo en los resultados (0 = limpio). */
  readonly inventadas: readonly number[];
  readonly narrativaDescartada: boolean;
}

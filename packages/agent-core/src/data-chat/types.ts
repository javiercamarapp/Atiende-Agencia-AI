// Tipos públicos del MOTOR COMPARTIDO de "Chatea con tus datos". Una vertical solo aporta
// un `DataChatCatalog` (herramientas de SOLO LECTURA, cerradas y parametrizadas); el motor
// pone todo lo demás: validación, alcance, límites, redacción, bitácora y verificación.
import type { LlmCompletionRequest, LlmCompletionResult } from "../gateway/types.js";
import type { ColumnKind } from "./format.js";
import type { ParamsSpec, ParsedArgs } from "./params.js";
import type { Cell } from "./sanitize.js";

/** Alcance del usuario. Lo construye SIEMPRE el servidor a partir de la membership
 *  verificada (JWT + rol); el modelo y el cliente nunca lo eligen ni lo modifican. */
export interface DataChatScope {
  readonly organizationId: string;
  readonly userId: string;
  readonly vertical: string;
  readonly verticalRole: string;
  /** null = todas las sucursales de la organización; array = solo esas (gerente de sucursal). */
  readonly allowedPropertyIds: readonly string[] | null;
  readonly timezone: string;
}

export interface DataChatToolContext {
  readonly scope: DataChatScope;
  readonly now: Date;
  readonly signal: AbortSignal;
  /** Tope de filas que la herramienta debe respetar (el motor además recorta). */
  readonly maxRows: number;
}

export interface DataChatColumn {
  readonly key: string;
  readonly label: string;
  readonly kind: ColumnKind;
}

/** Representacion visual que el CATALOGO elige para un bloque (nunca el modelo). Cambio aditivo:
 *  `donut` (composicion, hasta 6 segmentos) y `kpi` (1 fila con 1-4 columnas numericas; `x`/`y` solo
 *  indican la columna principal, la UI muestra las columnas numericas de la primera fila). */
export interface DataChatChartSpec {
  readonly kind: "bar" | "line" | "donut" | "kpi";
  readonly x: string;
  readonly y: string;
}

/** Mini serie por fila para una tabla (aditivo): `series[i]` pertenece a `rows[i]`; la UI la dibuja como
 *  sparkline en una columna extra con `label` como encabezado. Solo numeros finitos. */
export interface DataChatSparkline {
  readonly label: string;
  readonly series: readonly (readonly number[])[];
}

export type DataChatToolStatus = "ok" | "empty" | "unavailable" | "needs_clarification" | "error";

export interface DataChatToolResult {
  readonly status: DataChatToolStatus;
  /** Mensaje honesto para status distinto de ok (aclaración, no disponible aún, error). */
  readonly message?: string;
  /** De qué datos salen las cifras, p.ej. "Pedidos (sin cancelados) de la sucursal Centro". */
  readonly source: string;
  /** Etiqueta del periodo ya resuelto en la zona del negocio, si la herramienta lo usa. */
  readonly periodLabel?: string;
  /** Alcance humano: "todas tus sucursales" / "sucursal Centro". */
  readonly scopeLabel: string;
  readonly columns: readonly DataChatColumn[];
  readonly rows: readonly Readonly<Record<string, Cell>>[];
  readonly chart?: DataChatChartSpec;
  readonly sparkline?: DataChatSparkline;
  /** Texto determinista corto con la cifra principal; el usuario siempre lo ve aunque el modelo falle. */
  readonly summary?: string;
}

export interface DataChatTool {
  readonly name: string;
  /** Nombre corto para el usuario ("Ventas por día"); se usa al listar lo que sí se puede consultar. */
  readonly label: string;
  readonly description: string;
  readonly params: ParamsSpec;
  run(ctx: DataChatToolContext, args: ParsedArgs): Promise<DataChatToolResult>;
}

export interface DataChatCatalog {
  readonly vertical: string;
  /** Una frase: qué negocio es y qué datos cubre este catálogo. */
  readonly domain: string;
  readonly tools: readonly DataChatTool[];
  /** Líneas de contexto del alcance (p.ej. nombres de sucursales visibles) para el prompt. */
  describeScope?(scope: DataChatScope, signal: AbortSignal): Promise<string>;
}

export type DataChatStatus = "ok" | "no_data" | "clarify" | "out_of_catalog" | "rate_limited" | "budget_exceeded" | "unavailable" | "invalid_input";

export interface DataChatBlock {
  readonly kind: "table";
  readonly tool: string;
  readonly title: string;
  readonly columns: readonly DataChatColumn[];
  readonly rows: readonly Readonly<Record<string, Cell>>[];
  readonly chart?: DataChatChartSpec;
  readonly sparkline?: DataChatSparkline;
  readonly truncated: boolean;
}

export interface DataChatSource {
  readonly tool: string;
  readonly source: string;
  readonly periodLabel?: string;
  readonly scopeLabel: string;
}

/** MODO SIN IA: cuando el asistente no puede usar el modelo (proveedor caido, tope de gasto agotado o
 *  interruptor de plataforma apagado) la respuesta lo dice con claridad y devuelve el catalogo de
 *  consultas deterministas disponibles, para que la UI las ofrezca como botones. Nunca incluye cifras. */
export interface DataChatNoAi {
  readonly reason: "provider_down" | "budget" | "kill_switch";
  readonly options: readonly { readonly tool: string; readonly label: string; readonly description: string }[];
}

export interface DataChatAnswer {
  readonly status: DataChatStatus;
  readonly text: string;
  /** Presente solo cuando la respuesta se dio sin IA (ver `DataChatNoAi`). */
  readonly noAi?: DataChatNoAi;
  readonly blocks: readonly DataChatBlock[];
  /** Siempre de dónde salen las cifras y su periodo; vacío solo si no se consultó nada. */
  readonly sources: readonly DataChatSource[];
  readonly toolsUsed: readonly string[];
}

export interface DataChatHistoryTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export type DataChatCompletion = (req: LlmCompletionRequest) => Promise<LlmCompletionResult>;

/** Bitácora: quién, qué herramienta, con qué parámetros, qué resultó — NUNCA los resultados. */
export interface DataChatAuditEntry {
  readonly organizationId: string;
  readonly userId: string;
  readonly vertical: string;
  /** null = el turno terminó sin ejecutar herramienta (fuera de catálogo, límite, etc.). */
  readonly tool: string | null;
  readonly params: Readonly<Record<string, string | number>>;
  readonly outcome: "ok" | "empty" | "unavailable" | "needs_clarification" | "error" | "denied" | "no_tool" | "rate_limited" | "budget_exceeded";
  readonly rowCount: number;
  readonly durationMs: number;
  readonly errorCode?: string;
  /** Como se obtuvo el resultado: "directa" (chip/boton, sin modelo), "cache" (resultado guardado), "llm" (la pidio el modelo),
   *  "escalado" (el texto lo redacto el modelo de reintento) o "sin_ia" (el turno cayo al modo sin IA: tope, proveedor caido o apagado). */
  readonly route?: "directa" | "cache" | "llm" | "escalado" | "sin_ia";
  /** Costo REAL del turno (micro-USD, suma de lo que reporto el proveedor en cada llamada). Solo en la fila de resumen del turno. */
  readonly costMicroUsd?: number;
  /** Modelo que respondio la ultima llamada barata, si se conoce. */
  readonly model?: string;
  /** Rol del gateway del turno (`<vertical>:data_chat`). */
  readonly role?: string;
}

export interface DataChatAuditSink {
  record(entry: DataChatAuditEntry): Promise<void>;
}

export interface DataChatRateLimiter {
  /** true = permitido. */
  allow(key: string, limit: number, windowMs: number): Promise<boolean>;
}

/** Ruta con la que se produjo el texto de un turno (medicion de costo, ver `RunDataChatTurnOptions.onUso`). */
export type DataChatRoute = "directa" | "cache" | "barato" | "escalado" | "determinista";

/** Uso de un turno: lo que costo y por que ruta salio el texto. Solo cifras operativas (nunca preguntas, filas ni PII). */
export interface DataChatUsage {
  readonly route: DataChatRoute;
  /** Llamadas al modelo de este turno (incluye la escalada, si la hubo). */
  readonly llmCalls: number;
  /** true si hubo una llamada al modelo escalado (cascada tras fallar la guardia de cifras). */
  readonly escalated: boolean;
  /** Herramientas de este turno cuyo resultado salio de la cache (ausente si ninguna). */
  readonly cacheHits?: number;
  /** Suma del costo reportado por el proveedor en cada llamada (USD). */
  readonly costUsd: number;
  /** El mismo costo en micro-USD enteros (lo que se persiste). */
  readonly costMicroUsd: number;
  /** Modelo que respondio la ultima llamada barata (el reportado por el proveedor), si se conoce. */
  readonly model?: string;
}

export interface DataChatLimits {
  readonly maxQuestionChars: number;
  readonly maxHistoryTurns: number;
  readonly maxHistoryTurnChars: number;
  /** Rondas de herramientas (el turno agrega una ronda final de redaccion sin herramientas). */
  readonly maxToolRounds: number;
  readonly maxToolCallsPerTurn: number;
  /** Rondas EXTRA de herramientas solo cuando ninguna consulta llego a ejecutarse (el modelo pidio una herramienta o
   *  argumentos invalidos): una oportunidad de corregirse. Con resultados en mano nunca se usa, asi que un turno normal
   *  sigue en 2 llamadas al modelo. */
  readonly maxRepairRounds: number;
  /** Filas que recorta el motor para la UI y el PDF (el modelo ve `maxModelRows`). */
  readonly maxRows: number;
  /** Filas por herramienta que se le mandan al MODELO (<= maxRows). */
  readonly maxModelRows: number;
  readonly toolTimeoutMs: number;
  /** Techo general de tokens de salida; se aplica como tope sobre los dos siguientes y al reintento escalado. */
  readonly maxOutputTokens: number;
  /** Tokens de salida al ELEGIR herramienta (antes de ver resultados). */
  readonly maxOutputTokensChoose: number;
  /** Tokens de salida al REDACTAR (despues de ver resultados). */
  readonly maxOutputTokensWrite: number;
  /** Largo maximo de la descripcion de cada herramienta que se manda al modelo. */
  readonly maxToolDescriptionChars: number;
  /** Tiempo maximo de UNA llamada al modelo. */
  readonly llmCallTimeoutMs: number;
  /** Tiempo maximo de todo el turno: pasado, ya no se llama al modelo y se responde con las cifras deterministas. */
  readonly turnTimeoutMs: number;
  readonly userRateLimit: { readonly limit: number; readonly windowMs: number };
  readonly orgRateLimit: { readonly limit: number; readonly windowMs: number };
}

export const DEFAULT_DATA_CHAT_LIMITS: DataChatLimits = {
  maxQuestionChars: 600,
  maxHistoryTurns: 4,
  maxHistoryTurnChars: 600,
  maxToolRounds: 1,
  maxToolCallsPerTurn: 3,
  maxRepairRounds: 1,
  maxRows: 50,
  maxModelRows: 20,
  toolTimeoutMs: 8_000,
  maxOutputTokens: 500,
  maxOutputTokensChoose: 150,
  maxOutputTokensWrite: 350,
  maxToolDescriptionChars: 160,
  llmCallTimeoutMs: 20_000,
  turnTimeoutMs: 45_000,
  userRateLimit: { limit: 20, windowMs: 10 * 60_000 },
  orgRateLimit: { limit: 120, windowMs: 60 * 60_000 },
};

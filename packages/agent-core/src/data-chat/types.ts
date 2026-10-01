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

export interface DataChatChartSpec {
  readonly kind: "bar" | "line";
  readonly x: string;
  readonly y: string;
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
}

export interface DataChatAuditSink {
  record(entry: DataChatAuditEntry): Promise<void>;
}

export interface DataChatRateLimiter {
  /** true = permitido. */
  allow(key: string, limit: number, windowMs: number): Promise<boolean>;
}

export interface DataChatLimits {
  readonly maxQuestionChars: number;
  readonly maxHistoryTurns: number;
  readonly maxHistoryTurnChars: number;
  readonly maxToolRounds: number;
  readonly maxToolCallsPerTurn: number;
  readonly maxRows: number;
  readonly toolTimeoutMs: number;
  readonly maxOutputTokens: number;
  readonly userRateLimit: { readonly limit: number; readonly windowMs: number };
  readonly orgRateLimit: { readonly limit: number; readonly windowMs: number };
}

export const DEFAULT_DATA_CHAT_LIMITS: DataChatLimits = {
  maxQuestionChars: 600,
  maxHistoryTurns: 6,
  maxHistoryTurnChars: 600,
  maxToolRounds: 3,
  maxToolCallsPerTurn: 4,
  maxRows: 50,
  toolTimeoutMs: 8_000,
  maxOutputTokens: 500,
  userRateLimit: { limit: 20, windowMs: 10 * 60_000 },
  orgRateLimit: { limit: 120, windowMs: 60 * 60_000 },
};

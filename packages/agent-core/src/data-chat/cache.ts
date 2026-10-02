// Cache de RESULTADOS DE HERRAMIENTAS de "Chatea con tus datos" (CHAT-06 / MOD-05). Solo se guarda lo que una herramienta
// del catalogo cerrado devolvio de forma determinista (tabla/cifras ya saneadas): NUNCA texto del modelo, nunca la pregunta
// del usuario, y solo de herramientas que el servidor declaro sin datos personales (`isCacheable`).
//
// Clave = (organizacion, vertical, alcance de sucursales, rol, herramienta + argumentos canonicos, dia local resuelto,
// zona horaria). El usuario NO entra en la clave a proposito: dos personas con el MISMO alcance y rol ven lo mismo, asi que
// comparten el calculo; un rol distinto, otra sucursal o otra organizacion NUNCA comparten entrada.
//
// TTL: 5 minutos si el periodo incluye hoy (o la herramienta es de estado actual, sin periodo); 24 horas si el periodo ya
// cerro (ayer, semana pasada, mes pasado o fechas con `hasta` anterior a hoy). "Hoy" siempre en la zona del negocio.
import { createHash } from "node:crypto";
import type { ParsedArgs } from "./params.js";
import { redactPii } from "./sanitize.js";
import type { DataChatScope, DataChatTool, DataChatToolResult } from "./types.js";

export const CACHE_TTL_OPEN_MS = 5 * 60_000;
export const CACHE_TTL_CLOSED_MS = 24 * 60 * 60_000;

/** Almacen de la cache. Un fallo del almacen NUNCA tumba un turno: el motor lo trata como un fallo de cache (miss). */
export interface DataChatCacheStore {
  get(key: string): Promise<DataChatToolResult | undefined>;
  set(key: string, value: DataChatToolResult, ttlMs: number, meta: { readonly organizationId: string }): Promise<void>;
}

export interface DataChatCache {
  readonly store: DataChatCacheStore;
  /** Lista blanca del SERVIDOR: solo herramientas agregadas, sin nombres de personas ni datos de contacto. */
  isCacheable(tool: DataChatTool, scope: DataChatScope): boolean;
}

const CLOSED_TOKENS: ReadonlySet<string> = new Set(["ayer", "semana_pasada", "mes_pasado"]);

/** Fecha local AAAA-MM-DD de `now` en `timezone` (nunca la del proceso). */
export function localDay(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** true si el periodo de los argumentos ya cerro (no incluye hoy). Sin periodo = estado actual = abierto. */
export function isClosedPeriod(args: ParsedArgs, now: Date, timezone: string): boolean {
  const periodo = args["periodo"];
  const hasta = args["hasta"];
  if (typeof periodo === "string" && CLOSED_TOKENS.has(periodo)) return true;
  if (typeof hasta === "string" && /^\d{4}-\d{2}-\d{2}$/.test(hasta) && typeof periodo !== "string") return hasta < localDay(now, timezone);
  return false;
}

export function cacheTtlMs(args: ParsedArgs, now: Date, timezone: string): number {
  return isClosedPeriod(args, now, timezone) ? CACHE_TTL_CLOSED_MS : CACHE_TTL_OPEN_MS;
}

/** Argumentos en forma canonica: claves ordenadas, sin undefined. Mismos argumentos => misma cadena, en cualquier orden. */
export function canonicalArgs(args: ParsedArgs): string {
  const sorted: Record<string, string | number> = {};
  for (const k of Object.keys(args).sort()) {
    const v = args[k];
    if (v !== undefined) sorted[k] = v;
  }
  return JSON.stringify(sorted);
}

/** Alcance de sucursales canonico: "*" = todas; si no, los ids ordenados (sin importar el orden de la membership). */
export function canonicalPropertyScope(ids: readonly string[] | null): string {
  return ids === null ? "*" : [...new Set(ids)].sort().join(",");
}

export function buildCacheKey(scope: DataChatScope, tool: DataChatTool, args: ParsedArgs, now: Date): string {
  const parts = [
    scope.organizationId,
    scope.vertical,
    canonicalPropertyScope(scope.allowedPropertyIds),
    scope.verticalRole,
    tool.name,
    canonicalArgs(args),
    localDay(now, scope.timezone),
    scope.timezone,
  ];
  return `dchat:v1:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

const MAX_CACHED_ROWS = 200;

function cellHasPii(v: unknown): boolean {
  return typeof v === "string" && redactPii(v) !== v;
}

/** Solo resultados terminados y limpios: ok/empty, acotados y sin correos/telefonos/tarjetas/enlaces en ninguna celda. */
export function isStorableResult(r: DataChatToolResult): boolean {
  if (r.status !== "ok" && r.status !== "empty") return false;
  if (r.rows.length > MAX_CACHED_ROWS) return false;
  for (const row of r.rows) {
    for (const v of Object.values(row)) if (cellHasPii(v)) return false;
  }
  return !cellHasPii(r.summary) && !cellHasPii(r.message);
}

interface MemoryEntry {
  readonly value: DataChatToolResult;
  readonly expiresAt: number;
  readonly organizationId: string;
}

/** Cache en memoria (pruebas y reserva sin Upstash/Postgres). Reloj inyectable; con tope de entradas. */
export class MemoryDataChatCacheStore implements DataChatCacheStore {
  private readonly entries = new Map<string, MemoryEntry>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly maxEntries = 500,
  ) {}

  async get(key: string): Promise<DataChatToolResult | undefined> {
    const e = this.entries.get(key);
    if (!e || e.expiresAt <= this.clock()) {
      if (e) this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return structuredClone(e.value);
  }

  async set(key: string, value: DataChatToolResult, ttlMs: number, meta: { readonly organizationId: string }): Promise<void> {
    if (this.entries.size >= this.maxEntries) this.purge();
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value: structuredClone(value), expiresAt: this.clock() + ttlMs, organizationId: meta.organizationId });
  }

  /** Purga las entradas vencidas; devuelve cuantas quito. */
  purge(): number {
    const now = this.clock();
    let n = 0;
    for (const [k, e] of this.entries) {
      if (e.expiresAt <= now) {
        this.entries.delete(k);
        n += 1;
      }
    }
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}

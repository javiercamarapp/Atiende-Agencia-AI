// Almacenes de la cache de "Chatea con tus datos" (CHAT-06 / MOD-05). El motor (agent-core/data-chat/cache.ts) decide QUE se
// cachea y con que clave/TTL; aqui solo viven (1) la lista blanca de herramientas sin datos personales por vertical y (2) los
// dos almacenes de produccion:
//   - Upstash Redis (REST) si UPSTASH_REDIS_REST_URL/_TOKEN existen: compartido entre instancias, TTL nativo (EX).
//   - core.data_chat_cache (migracion 0045) si no: SOLO funciones definer de sistema, llamadas desde una sesion de sistema
//     PROPIA (`engine.withAppSession({ userId: null })`), una transaccion por operacion. Eso importa por dos razones:
//     la funcion exige auth.uid() nulo, y un fallo de la cache (tabla/funcion sin migrar: 42P01/42883/42703, o cualquier otro)
//     nunca aborta la transaccion unica del request del usuario (25P02): es un "miss" y el turno sigue con datos reales.
// Si ninguno esta disponible el motor corre sin cache (identico a antes). Nunca se cachea texto del modelo.
import { UpstashRestClient } from "@atiende/agent-core";
import type { DataChatCache, DataChatCacheStore, DataChatTool, DataChatToolResult } from "@atiende/agent-core/data-chat";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "@atiende/db";

/**
 * Herramientas CACHEABLES por vertical: solo agregados (conteos, montos, tasas) o catalogos del negocio. EXCLUIDAS a proposito
 * las que devuelven nombres de personas (propietarios, profesionales, clientes con RFC, emisores, preguntas escritas por
 * terceros). Si una herramienta no esta aqui, NUNCA se cachea. Un test de catalogo verifica que cada nombre exista.
 */
export const CACHEABLE_TOOLS: Readonly<Record<string, ReadonlySet<string>>> = {
  restaurantes: new Set(["ventas_por_dia", "ventas_por_sucursal", "productos_mas_vendidos", "ticket_medio", "pedidos_por_canal", "horas_pico", "clientes_recurrentes", "promociones"]),
  hoteles: new Set(["ocupacion_adr_revpar", "ingresos_por_periodo", "llegadas_y_salidas", "cancelaciones", "tickets_abiertos_sla", "housekeeping_pendiente"]),
  rentas: new Set(["ocupacion_por_unidad", "ingresos_por_canal", "conflictos_calendario_abiertos", "tareas_pendientes", "pagos_de_canal"]),
  citas: new Set(["citas_por_dia", "ingresos_por_periodo", "ingresos_por_servicio", "clientes_nuevos_vs_recurrentes", "recordatorios"]),
  despachos: new Set(["cobranza_antiguedad", "cfdi_por_periodo"]),
  licitaciones: new Set(["convocatorias_abiertas", "plazos_semaforo", "propuestas_por_estado", "fallos"]),
};

export function isCacheableTool(tool: DataChatTool, vertical: string): boolean {
  return CACHEABLE_TOOLS[vertical]?.has(tool.name) ?? false;
}

export interface UpstashLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
}

export class UpstashDataChatCacheStore implements DataChatCacheStore {
  constructor(private readonly client: UpstashLike) {}

  async get(key: string): Promise<DataChatToolResult | undefined> {
    const raw = await this.client.get(key);
    if (raw === null) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DataChatToolResult) : undefined;
    } catch {
      return undefined; // valor corrupto = miss
    }
  }

  async set(key: string, value: DataChatToolResult, ttlMs: number): Promise<void> {
    await this.client.set(key, JSON.stringify(value), { EX: Math.max(1, Math.round(ttlMs / 1000)) });
  }
}

export class PostgresDataChatCacheStore implements DataChatCacheStore {
  constructor(
    private readonly engine: TenancyEngine,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async get(key: string): Promise<DataChatToolResult | undefined> {
    try {
      const value = await this.engine.withAppSession({ userId: null }, async (db) => {
        const { rows } = await db.query<{ v: unknown }>("select core.data_chat_cache_get($1::text) as v;", [key]);
        return rows[0]?.v ?? null;
      });
      return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as DataChatToolResult) : undefined;
    } catch (err) {
      this.report("get", err);
      return undefined;
    }
  }

  async set(key: string, value: DataChatToolResult, ttlMs: number, meta: { readonly organizationId: string }): Promise<void> {
    try {
      await this.engine.withAppSession({ userId: null }, async (db) => {
        await db.query("select core.data_chat_cache_put($1::text, $2::uuid, $3::jsonb, $4::int);", [key, meta.organizationId, JSON.stringify(value), Math.max(1, Math.round(ttlMs / 1000))]);
      });
    } catch (err) {
      this.report("set", err);
    }
  }

  /** Purga las entradas vencidas (la funcion _put tambien purga de forma oportunista). Devuelve cuantas quito; 0 si la base no esta migrada. */
  async purge(): Promise<number> {
    try {
      return await this.engine.withAppSession({ userId: null }, async (db) => {
        const { rows } = await db.query<{ n: number }>("select core.data_chat_cache_purge() as n;");
        return Number(rows[0]?.n ?? 0);
      });
    } catch (err) {
      this.report("purge", err);
      return 0;
    }
  }

  private report(op: string, err: unknown): void {
    // Base sin migrar: esperado, silencioso. Cualquier otro fallo: una linea estructurada sin datos (el turno sigue sin cache).
    if (isMigrationPendingError(err)) return;
    this.log(JSON.stringify({ level: "warn", event: "data_chat_cache_error", op, message: err instanceof Error ? err.message.slice(0, 160) : "error" }));
  }
}

export interface DataChatCacheEnv {
  readonly UPSTASH_REDIS_REST_URL?: string | undefined;
  readonly UPSTASH_REDIS_REST_TOKEN?: string | undefined;
}

/** Almacen de produccion: Upstash si hay credenciales; si no, Postgres (con motor) o ninguno. */
export function createDataChatCacheStore(engine: TenancyEngine | undefined, env: DataChatCacheEnv = process.env): DataChatCacheStore | undefined {
  const url = env.UPSTASH_REDIS_REST_URL?.trim();
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (url && token) return new UpstashDataChatCacheStore(new UpstashRestClient({ url, token }));
  return engine ? new PostgresDataChatCacheStore(engine) : undefined;
}

export function buildDataChatCache(store: DataChatCacheStore | undefined): DataChatCache | undefined {
  return store ? { store, isCacheable: (tool, scope) => isCacheableTool(tool, scope.vertical) } : undefined;
}

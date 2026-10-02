// Cableado de "Chatea con tus datos" para apps/api. Un solo objeto opcional en AppDeps
// (`dataChat`): sin proveedor LLM configurado `completion` es undefined y la ruta responde, honesta,
// que el asistente aun no esta activo (nunca finge una respuesta).
import type { DataChatAuditEntry, DataChatAuditSink, DataChatCache, DataChatCompletion, DataChatRateLimiter } from "@atiende/agent-core/data-chat";
import { gatewayCompletion } from "@atiende/agent-core/data-chat";
import type { LlmGateway } from "@atiende/agent-core";
import { rateLimit } from "@atiende/core-ratelimit";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { isUndefinedColumnError, isUndefinedFunctionError, isUndefinedTableError, runWithSavepointFallback } from "@atiende/db";
import type { ConversacionesRepository } from "./conversaciones.ts";
import { buildDataChatCache, createDataChatCacheStore } from "./cache.ts";
import type { PinsRepository } from "./pins.ts";
import { RESTAURANTES_DATA_CHAT_ROLE } from "../production/llm-gateway.ts";
import { PostgresRestaurantesDataChatReader, type RestaurantesDataChatReader } from "@atiende/domain-restaurantes";
import { PostgresHotelesDataChatReader, type HotelesDataChatReader } from "@atiende/domain-hoteles";
import { PostgresRentasDataChatReader, type RentasDataChatReader } from "@atiende/domain-rentas";
import { PostgresDespachosDataChatReader, type DespachosDataChatReader } from "@atiende/domain-despachos";
import { PostgresLicitacionesDataChatReader, type LicitacionesDataChatReader } from "@atiende/domain-licitaciones";
import { PostgresCitasDataChatReader, type CitasDataChatReader } from "@atiende/domain-citas";


export interface DataChatDeps {
  readonly restaurantesReader: (db: TenantDbSession) => RestaurantesDataChatReader;
  /** Lectores por vertical. OPCIONALES: sin ellos su ruta responde "no disponible" (nunca 500). Cada uno corre de solo
   *  lectura sobre la sesion RLS del usuario. */
  readonly hotelesReader?: (db: TenantDbSession) => HotelesDataChatReader;
  readonly rentasReader?: (db: TenantDbSession) => RentasDataChatReader;
  readonly despachosReader?: (db: TenantDbSession) => DespachosDataChatReader;
  readonly licitacionesReader?: (db: TenantDbSession) => LicitacionesDataChatReader;
  readonly citasReader?: (db: TenantDbSession) => CitasDataChatReader;
  readonly audit: (db: TenantDbSession) => DataChatAuditSink;
  readonly rateLimiter: DataChatRateLimiter;
  /** undefined = ningun proveedor LLM configurado: el chat responde "no disponible". `role` es el rol del gateway
   *  de la vertical (`<vertical>:data_chat`: apagable y con registro de uso aparte, ver platform-switches.ts); sin el
   *  cae al de restaurantes (el piloto). */
  /** Uso de hoy del usuario frente al tope diario (0..100), para `/estado`. OPCIONAL: sin el, `/estado` responde
   *  `usoHoyPct: null` ("sin medir"), nunca una cifra inventada. Corre en SAVEPOINT sobre la sesion RLS del request. */
  readonly usageTodayPct?: (db: TenantDbSession, organizationId: string, userId: string) => Promise<number | null>;
  readonly completion: ((organizationId: string, role?: string) => DataChatCompletion) | undefined;
  /** Repositorio de conversaciones guardadas (CHAT-04) sobre la sesion RLS del request. OPCIONAL: sin el se usa el de
   *  Postgres (`PostgresConversacionesRepository`); existe para inyectar uno en memoria en pruebas. */
  readonly conversaciones?: (db: TenantDbSession) => ConversacionesRepository;
  /** Cache de resultados de herramientas (CHAT-06/MOD-05; ver cache.ts). OPCIONAL: sin ella todo corre como siempre. */
  readonly cache?: DataChatCache;
  /** Repositorio de fijados (CHAT-15) sobre la sesion RLS del request. OPCIONAL: sin el se usa el de Postgres; existe para
   *  inyectar uno en memoria en pruebas. */
  readonly pins?: (db: TenantDbSession) => PinsRepository;
}

/** Limitador compartido entre instancias (Upstash) o en memoria; categoria cerrada: un blip de Redis NIEGA, no abre el gasto. */
export const dataChatRateLimiter: DataChatRateLimiter = {
  allow: (key, limit, windowMs) => rateLimit(key, limit, windowMs, { category: "data-chat:query" }),
};

/**
 * Bitacora en Postgres (`core.record_data_chat_query`, migracion 0028) sobre la sesion RLS del propio
 * usuario. Corre en SAVEPOINT: si la base todavia no tiene la funcion/tabla (42883/42P01/42703) degrada
 * a un log estructurado SIN resultados ni PII y la transaccion de la request sigue utilizable.
 */
export class PostgresDataChatAuditSink implements DataChatAuditSink {
  constructor(
    private readonly db: TenantDbSession,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async record(entry: DataChatAuditEntry): Promise<void> {
    const common = [entry.organizationId, entry.tool, JSON.stringify(entry.params), entry.outcome, entry.rowCount, entry.durationMs, entry.errorCode ?? null];
    await runWithSavepointFallback<void>({
      session: this.db,
      // Con ruta (migracion 0044): sobrecarga de 8 argumentos. Si todavia no existe (42883) cae a la de 7 (sin ruta) y, si
      // tampoco existe la bitacora, al log estructurado. Cada nivel en su propio SAVEPOINT: la transaccion del request sigue viva.
      primary: async () => {
        await this.db.query(`select core.record_data_chat_query($1::uuid, $2::text, $3::jsonb, $4::text, $5::int, $6::int, $7::text, $8::text);`, [...common, entry.route ?? null]);
      },
      isRecoverable: (err) => isUndefinedFunctionError(err) || isUndefinedTableError(err) || isUndefinedColumnError(err),
      fallback: async () => {
        await runWithSavepointFallback<void>({
          session: this.db,
          primary: async () => {
            await this.db.query(`select core.record_data_chat_query($1::uuid, $2::text, $3::jsonb, $4::text, $5::int, $6::int, $7::text);`, common);
          },
          isRecoverable: (err) => isUndefinedFunctionError(err) || isUndefinedTableError(err) || isUndefinedColumnError(err),
          fallback: async () => {
            this.log(
              JSON.stringify({
                level: "info",
                event: "data_chat_query_unlogged_pending_migration",
                organizationId: entry.organizationId,
                userId: entry.userId,
                vertical: entry.vertical,
                tool: entry.tool,
                params: entry.params,
                outcome: entry.outcome,
                rowCount: entry.rowCount,
                ...(entry.route ? { route: entry.route } : {}),
              }),
            );
          },
        });
      },
    });
  }
}

/** `engine` (opcional) habilita la cache en Postgres cuando no hay Upstash; sin el y sin Upstash el chat corre sin cache. */
export function buildProductionDataChat(gateway: LlmGateway | undefined, engine?: TenancyEngine): DataChatDeps {
  const cache = buildDataChatCache(createDataChatCacheStore(engine));
  return {
    ...(cache ? { cache } : {}),
    restaurantesReader: (db) => new PostgresRestaurantesDataChatReader(db),
    hotelesReader: (db) => new PostgresHotelesDataChatReader(db),
    rentasReader: (db) => new PostgresRentasDataChatReader(db),
    despachosReader: (db) => new PostgresDespachosDataChatReader(db),
    licitacionesReader: (db) => new PostgresLicitacionesDataChatReader(db),
    citasReader: (db) => new PostgresCitasDataChatReader(db),
    audit: (db) => new PostgresDataChatAuditSink(db),
    rateLimiter: dataChatRateLimiter,
    completion: gateway ? (organizationId, role = RESTAURANTES_DATA_CHAT_ROLE) => gatewayCompletion(gateway, { tenantId: organizationId, role }) : undefined,
  };
}

// Cableado de "Chatea con tus datos" para apps/api. Un solo objeto opcional en AppDeps
// (`dataChat`): sin proveedor LLM configurado `completion` es undefined y la ruta responde, honesta,
// que el asistente aun no esta activo (nunca finge una respuesta).
import type { DataChatAuditEntry, DataChatAuditSink, DataChatCompletion, DataChatRateLimiter } from "@atiende/agent-core/data-chat";
import { gatewayCompletion } from "@atiende/agent-core/data-chat";
import type { LlmGateway } from "@atiende/agent-core";
import { rateLimit } from "@atiende/core-ratelimit";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { isUndefinedColumnError, isUndefinedFunctionError, isUndefinedTableError, runWithSavepointFallback } from "@atiende/db";
import { HOTELES_DATA_CHAT_ROLE, RENTAS_DATA_CHAT_ROLE, RESTAURANTES_DATA_CHAT_ROLE } from "../production/llm-gateway.ts";
import { PostgresRestaurantesDataChatReader, type RestaurantesDataChatReader } from "@atiende/domain-restaurantes";
import { PostgresHotelesDataChatReader, type HotelesDataChatReader } from "@atiende/domain-hoteles";
import { PostgresRentasDataChatReader, type RentasDataChatReader } from "@atiende/domain-rentas";


export interface DataChatDeps {
  readonly restaurantesReader: (db: TenantDbSession) => RestaurantesDataChatReader;
  /** Hoteles / rentas: OPCIONALES (si faltan, su ruta responde "no disponible" en vez de fingir). Cada vertical
   *  trae su propio lector de solo lectura sobre la sesion RLS del usuario y su propio rol de gateway
   *  (`hoteles:data_chat` / `rentas:data_chat`: apagables y con presupuesto aparte, ver platform-switches.ts). */
  readonly hotelesReader?: (db: TenantDbSession) => HotelesDataChatReader;
  readonly rentasReader?: (db: TenantDbSession) => RentasDataChatReader;
  readonly audit: (db: TenantDbSession) => DataChatAuditSink;
  readonly rateLimiter: DataChatRateLimiter;
  /** undefined = ningun proveedor LLM configurado: el chat responde "no disponible". */
  readonly completion: ((organizationId: string) => DataChatCompletion) | undefined;
  /** Igual que `completion`, con el rol de gateway de cada vertical. */
  readonly hotelesCompletion?: ((organizationId: string) => DataChatCompletion) | undefined;
  readonly rentasCompletion?: ((organizationId: string) => DataChatCompletion) | undefined;
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
    await runWithSavepointFallback<void>({
      session: this.db,
      primary: async () => {
        await this.db.query(`select core.record_data_chat_query($1::uuid, $2::text, $3::jsonb, $4::text, $5::int, $6::int, $7::text);`, [
          entry.organizationId,
          entry.tool,
          JSON.stringify(entry.params),
          entry.outcome,
          entry.rowCount,
          entry.durationMs,
          entry.errorCode ?? null,
        ]);
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
          }),
        );
      },
    });
  }
}

export function buildProductionDataChat(gateway: LlmGateway | undefined): DataChatDeps {
  return {
    restaurantesReader: (db) => new PostgresRestaurantesDataChatReader(db),
    hotelesReader: (db) => new PostgresHotelesDataChatReader(db),
    rentasReader: (db) => new PostgresRentasDataChatReader(db),
    audit: (db) => new PostgresDataChatAuditSink(db),
    rateLimiter: dataChatRateLimiter,
    completion: gateway ? (organizationId) => gatewayCompletion(gateway, { tenantId: organizationId, role: RESTAURANTES_DATA_CHAT_ROLE }) : undefined,
    hotelesCompletion: gateway ? (organizationId) => gatewayCompletion(gateway, { tenantId: organizationId, role: HOTELES_DATA_CHAT_ROLE }) : undefined,
    rentasCompletion: gateway ? (organizationId) => gatewayCompletion(gateway, { tenantId: organizationId, role: RENTAS_DATA_CHAT_ROLE }) : undefined,
  };
}

// Bitacora del Copiloto de superadmin (CHAT-16): `core.record_data_chat_query` con alcance de plataforma (migracion 0048: organizacion NULL, vertical
// 'plataforma', solo superadmin vigente). Guarda quien (auth.uid()), que herramienta, con que parametros TIPADOS, el resultado en forma de conteo y,
// en la fila de resumen del turno, el costo REAL, el modelo y el rol -- NUNCA resultados, texto de la pregunta ni PII (el motor ya sanea los parametros).
//
// COMPATIBILIDAD CON LA BASE SIN MIGRAR: cada escritura corre en SAVEPOINT sobre la sesion del turno. Si la base aun no tiene el alcance de plataforma
// (la funcion de 11 argumentos rechaza organizacion NULL con 42501, o falta el CHECK/la funcion: 42883/42P01/42703/23514) o falla por cualquier otro
// motivo, se degrada a una linea estructurada SIN resultados ni PII y la transaccion del turno sigue utilizable (nunca 25P02). La bitacora nunca tumba
// la respuesta (el motor ya envuelve `record` en try/catch).
import type { DataChatAuditEntry, DataChatAuditSink } from "@atiende/agent-core/data-chat";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import { SUPERADMIN_COPILOTO_ROLE } from "../production/llm-models.ts";

export class PostgresPlataformaAuditSink implements DataChatAuditSink {
  constructor(
    private readonly db: TenantDbSession,
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  async record(entry: DataChatAuditEntry): Promise<void> {
    await runWithSavepointFallback<void>({
      session: this.db,
      primary: async () => {
        await this.db.query(`select core.record_data_chat_query(null::uuid, $1::text, $2::jsonb, $3::text, $4::int, $5::int, $6::text, $7::text, $8::bigint, $9::text, $10::text);`, [
          entry.tool,
          JSON.stringify(entry.params),
          entry.outcome,
          entry.rowCount,
          entry.durationMs,
          entry.errorCode ?? null,
          entry.route ?? null,
          entry.costMicroUsd === undefined ? null : Math.max(0, Math.trunc(entry.costMicroUsd)),
          entry.model ?? null,
          entry.role ?? SUPERADMIN_COPILOTO_ROLE,
        ]);
      },
      isRecoverable: () => true,
      fallback: async () => {
        this.log(
          JSON.stringify({
            level: "info",
            event: "superadmin_copiloto_query_unlogged_pending_migration",
            userId: entry.userId,
            tool: entry.tool,
            params: entry.params,
            outcome: entry.outcome,
            rowCount: entry.rowCount,
            ...(entry.route ? { route: entry.route } : {}),
          }),
        );
      },
    });
  }
}

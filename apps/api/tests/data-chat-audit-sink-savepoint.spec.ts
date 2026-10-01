// Bitácora de "Chatea con tus datos" contra la base SIN MIGRAR: `core.record_data_chat_query` (migración
// 0028) puede no existir todavía. Dentro de la transacción única de la request, un 42883 sin SAVEPOINT
// dejaría la transacción abortada (25P02) y el COMMIT se volvería ROLLBACK. AbortAwareFakeSession
// reproduce ese estado abortado.
import { describe, expect, it } from "vitest";
import type { DataChatAuditEntry } from "@atiende/agent-core/data-chat";
import { PostgresDataChatAuditSink } from "../src/data-chat/deps.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const ENTRY: DataChatAuditEntry = {
  organizationId: "00000000-0000-0000-0000-0000000000a1",
  userId: "00000000-0000-0000-0000-0000000000b1",
  vertical: "restaurantes",
  tool: "ventas_por_dia",
  params: { periodo: "hoy" },
  outcome: "ok",
  rowCount: 3,
  durationMs: 12,
};

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("PostgresDataChatAuditSink", () => {
  it("camino feliz: llama a core.record_data_chat_query con parámetros en orden y SIN resultados ni texto de pregunta", async () => {
    const seen: unknown[][] = [];
    const session = new AbortAwareFakeSession([{ match: /select core\.record_data_chat_query/i, respond: () => [{ record_data_chat_query: "id" }] }]);
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => (seen.push(params ?? []), original(sql, params))) as typeof session.query;
    await new PostgresDataChatAuditSink(session).record(ENTRY);
    expect(seen[0]).toEqual([ENTRY.organizationId, "ventas_por_dia", '{"periodo":"hoy"}', "ok", 3, 12, null]);
  });

  it("migración 0028 pendiente (42883): degrada a log estructurado, NO lanza y la transacción sigue utilizable (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select core\.record_data_chat_query/i, respond: () => pgError("42883", "function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text) does not exist") },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    const lines: string[] = [];
    await expect(new PostgresDataChatAuditSink(session, (l) => lines.push(l)).record(ENTRY)).resolves.toBeUndefined();
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
    const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(logged).toMatchObject({ event: "data_chat_query_unlogged_pending_migration", tool: "ventas_por_dia", outcome: "ok", rowCount: 3 });
    expect(JSON.stringify(logged)).not.toMatch(/pregunta|resultado/i);
  });

  it("tabla inexistente (42P01) también degrada", async () => {
    const session = new AbortAwareFakeSession([{ match: /select core\.record_data_chat_query/i, respond: () => pgError("42P01", 'relation "core.data_chat_query_log" does not exist') }]);
    const lines: string[] = [];
    await new PostgresDataChatAuditSink(session, (l) => lines.push(l)).record(ENTRY);
    expect(lines).toHaveLength(1);
  });

  it("un error real (p.ej. 42501, el actor no pertenece a la organización) NO se enmascara, pero la sesión se recupera", async () => {
    const session = new AbortAwareFakeSession([
      { match: /select core\.record_data_chat_query/i, respond: () => pgError("42501", "el actor no pertenece a la organizacion") },
      { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] },
    ]);
    await expect(new PostgresDataChatAuditSink(session, () => {}).record(ENTRY)).rejects.toMatchObject({ code: "42501" });
    await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toBeDefined();
  });
});

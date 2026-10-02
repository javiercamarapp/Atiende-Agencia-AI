// CHAT-07: la bitacora del Copiloto con costo real, modelo y rol (migracion 0047) contra la base SIN MIGRAR. AbortAwareFakeSession reproduce el
// estado abortado de Postgres (25P02): sin SAVEPOINT el fallback fallaria y el COMMIT haria ROLLBACK.
import { describe, expect, it, vi } from "vitest";
import { PostgresDataChatAuditSink } from "../src/data-chat/deps.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const pgError = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code });
const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };
const usable = (s: AbortAwareFakeSession) => expect(s.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });

const resumen = {
  organizationId: "00000000-0000-0000-0000-0000000000a1",
  userId: "00000000-0000-0000-0000-0000000000b1",
  vertical: "hoteles",
  tool: null,
  params: {},
  outcome: "ok" as const,
  rowCount: 0,
  durationMs: 7,
  route: "escalado" as const,
  costMicroUsd: 579.4,
  model: "deepseek/deepseek-v4.1-flash",
  role: "hoteles:data_chat",
};

describe("bitacora con costo, modelo y rol (0047)", () => {
  it("con 0047: UNA llamada de 11 argumentos con la ruta, el costo entero, el modelo y el rol", async () => {
    const session = new AbortAwareFakeSession([{ match: /record_data_chat_query/i, respond: () => [{}] }]);
    const spy = vi.spyOn(session, "query");
    await new PostgresDataChatAuditSink(session).record(resumen);
    const llamadas = spy.mock.calls.filter(([sql]) => String(sql).includes("record_data_chat_query"));
    expect(llamadas).toHaveLength(1);
    expect(String(llamadas[0]![0])).toContain("$11::text");
    expect(llamadas[0]![1]).toEqual([resumen.organizationId, null, "{}", "ok", 0, 7, null, "escalado", 579, "deepseek/deepseek-v4.1-flash", "hoteles:data_chat"]);
  });

  it("sin 0047 pero con 0045: cae a la de 8 argumentos (solo ruta) y la sesion sigue utilizable", async () => {
    let ocho = 0;
    const session = new AbortAwareFakeSession([
      { match: /\$11::text/i, respond: () => pgError("42883", "function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) does not exist") },
      { match: /record_data_chat_query/i, respond: () => (ocho++, [{}]) },
      SIGUIENTE,
    ]);
    await new PostgresDataChatAuditSink(session).record(resumen);
    expect(ocho).toBe(1);
    await usable(session);
  });

  it("sin 0047 ni 0045 pero con 0029: cae a la de 7 argumentos", async () => {
    let siete = 0;
    const session = new AbortAwareFakeSession([
      { match: /\$8::text/i, respond: () => pgError("42883", "function core.record_data_chat_query(...) does not exist") },
      { match: /record_data_chat_query/i, respond: () => (siete++, [{}]) },
      SIGUIENTE,
    ]);
    await new PostgresDataChatAuditSink(session).record(resumen);
    expect(siete).toBe(1);
    await usable(session);
  });

  it("sin la bitacora (42P01 en todos los niveles): log estructurado SIN resultados ni PII y sesion utilizable", async () => {
    const log = vi.fn();
    const session = new AbortAwareFakeSession([{ match: /record_data_chat_query/i, respond: () => pgError("42P01", 'relation "core.data_chat_query_log" does not exist') }, SIGUIENTE]);
    await new PostgresDataChatAuditSink(session, log).record(resumen);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "data_chat_query_unlogged_pending_migration", route: "escalado" });
    await usable(session);
  });

  it("una entrada sin costo, modelo ni rol (fila de herramienta) ni siquiera intenta la de 11 argumentos", async () => {
    const session = new AbortAwareFakeSession([{ match: /record_data_chat_query/i, respond: () => [{}] }]);
    const spy = vi.spyOn(session, "query");
    await new PostgresDataChatAuditSink(session).record({ ...resumen, tool: "ventas_por_dia", route: "llm", costMicroUsd: undefined, model: undefined, role: undefined });
    const llamadas = spy.mock.calls.filter(([sql]) => String(sql).includes("record_data_chat_query"));
    expect(llamadas).toHaveLength(1);
    expect(String(llamadas[0]![0])).not.toContain("$11::text");
  });
});

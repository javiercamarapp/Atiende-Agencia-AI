// CHAT-04 -- PostgresConversacionesRepository contra la base SIN MIGRAR (0041 pendiente) y contra errores reales de
// la funcion de escritura. Dentro de la transaccion unica del request, un 42P01/42883 sin SAVEPOINT dejaria la
// transaccion abortada (25P02) y el COMMIT se volveria ROLLBACK: AbortAwareFakeSession reproduce ese estado
// (una sesion falsa plana NO sirve). Tambien cubre el saneado de lo que se guarda y las rutas HTTP en base sin migrar.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { scriptedCompletion, type DataChatBlock } from "@atiende/agent-core/data-chat";
import { InMemoryCoreRepository, InMemoryTenancyEngine } from "@atiende/db";
import { buildApp } from "../src/app.ts";
import type { DataChatDeps } from "../src/data-chat/deps.ts";
import {
  PostgresConversacionesRepository,
  isPersistableAnswer,
  parseTitulo,
  redactQuestionForStorage,
  sanitizeBlocksForStorage,
  type ConversacionScope,
  type TurnoAGuardar,
} from "../src/data-chat/conversaciones.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";

const SCOPE: ConversacionScope = { organizationId: "00000000-0000-0000-0000-0000000000a1", userId: "00000000-0000-0000-0000-0000000000b1", vertical: "hoteles" };
const ID = "00000000-0000-0000-0000-0000000000c1";
const TURNO: TurnoAGuardar = {
  propertyId: "00000000-0000-0000-0000-0000000000d1",
  conversationId: null,
  userText: "ocupación",
  assistantText: "35%",
  status: "ok",
  blocks: [{ tool: "t" }],
  sources: [],
  toolCalls: [{ tool: "ocupacion_adr_revpar", args: { periodo: "hoy" } }],
};

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const NO_TABLE = pgError("42P01", 'relation "core.data_chat_conversation" does not exist');
const NO_FN = pgError("42883", "function core.append_data_chat_turn(uuid, uuid, uuid, text, text, text, jsonb, jsonb, jsonb) does not exist");
const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };

/** La sesion sigue utilizable tras el fallo (sin 25P02): lo que garantiza el SAVEPOINT. */
async function expectSessionUsable(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
}

describe("base sin migrar (0041 pendiente): vacio honesto y sesion utilizable", () => {
  it("list: 42P01 -> disponible:false y lista vacia", async () => {
    const session = new AbortAwareFakeSession([{ match: /from core\.data_chat_conversation/i, respond: () => NO_TABLE }, SIGUIENTE]);
    expect(await new PostgresConversacionesRepository(session).list(SCOPE)).toEqual({ disponible: false, items: [] });
    await expectSessionUsable(session);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("get / loadHistory / rename / remove: 42P01 -> null / null / false / false (sin 500) y sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /data_chat_(conversation|message)/i, respond: () => NO_TABLE },
      SIGUIENTE,
    ]);
    const repo = new PostgresConversacionesRepository(session);
    expect(await repo.get(SCOPE, ID)).toBeNull();
    expect(await repo.loadHistory(SCOPE, ID, 12)).toBeNull();
    expect(await repo.rename(SCOPE, ID, "x")).toBe(false);
    expect(await repo.remove(SCOPE, ID)).toBe(false);
    await expectSessionUsable(session);
  });

  it("append: 42883 (la funcion no existe) -> no_disponible, NO lanza y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /core\.append_data_chat_turn/i, respond: () => NO_FN }, SIGUIENTE]);
    expect(await new PostgresConversacionesRepository(session).append(SCOPE, TURNO)).toEqual({ guardado: false, motivo: "no_disponible" });
    await expectSessionUsable(session);
  });

  it("columna inexistente (42703) tambien degrada", async () => {
    const session = new AbortAwareFakeSession([{ match: /from core\.data_chat_conversation/i, respond: () => pgError("42703", 'column "message_count" does not exist') }]);
    expect((await new PostgresConversacionesRepository(session).list(SCOPE)).disponible).toBe(false);
  });

  it("un error que NO es de migracion pendiente en lectura se repropaga, pero la sesion queda recuperada", async () => {
    const session = new AbortAwareFakeSession([{ match: /from core\.data_chat_conversation/i, respond: () => pgError("08006", "connection failure") }, SIGUIENTE]);
    await expect(new PostgresConversacionesRepository(session).list(SCOPE)).rejects.toMatchObject({ code: "08006" });
    await expectSessionUsable(session);
  });
});

describe("append: errores reales de la funcion no tumban el turno", () => {
  async function appendWith(code: string): Promise<{ result: Awaited<ReturnType<PostgresConversacionesRepository["append"]>>; session: AbortAwareFakeSession; log: string[] }> {
    const session = new AbortAwareFakeSession([{ match: /core\.append_data_chat_turn/i, respond: () => pgError(code, "boom") }, SIGUIENTE]);
    const log: string[] = [];
    const result = await new PostgresConversacionesRepository(session, (l) => log.push(l)).append(SCOPE, TURNO);
    return { result, session, log };
  }

  it("54000 -> limite_conversaciones; P0002 -> conversacion_no_encontrada; 42501 -> sin_acceso", async () => {
    for (const [code, motivo] of [["54000", "limite_conversaciones"], ["P0002", "conversacion_no_encontrada"], ["42501", "sin_acceso"]] as const) {
      const { result, session, log } = await appendWith(code);
      expect(result, code).toEqual({ guardado: false, motivo });
      expect(log, code).toHaveLength(0);
      await expectSessionUsable(session);
    }
  });

  it("un error desconocido -> motivo 'error', queda en el log (sin texto de la pregunta) y la sesion se recupera", async () => {
    const { result, session, log } = await appendWith("XX000");
    expect(result).toEqual({ guardado: false, motivo: "error" });
    expect(JSON.parse(log[0]!)).toMatchObject({ event: "data_chat_persist_error", code: "XX000" });
    expect(log[0]).not.toContain("ocupación");
    await expectSessionUsable(session);
  });
});

describe("SQL y parametros", () => {
  function recorder(rows: Record<string, unknown[]>): { session: AbortAwareFakeSession; seen: Array<{ sql: string; params: unknown[] }> } {
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const session = new AbortAwareFakeSession(
      Object.entries(rows).map(([re, out]) => ({ match: new RegExp(re, "i"), respond: () => out })),
    );
    const original = session.query.bind(session);
    session.query = (async (sql: string, params?: unknown[]) => (seen.push({ sql, params: params ?? [] }), original(sql, params))) as typeof session.query;
    return { session, seen };
  }

  it("append: el actor NO es parametro; llama a core.append_data_chat_turn con el orden documentado", async () => {
    const { session, seen } = recorder({ "core\\.append_data_chat_turn": [{ out_conversation_id: ID, out_seq: "2" }] });
    const result = await new PostgresConversacionesRepository(session).append(SCOPE, { ...TURNO, conversationId: ID });
    expect(result).toEqual({ guardado: true, conversationId: ID, seq: 2 });
    expect(seen[0]!.params).toEqual([
      SCOPE.organizationId,
      TURNO.propertyId,
      ID,
      "ocupación",
      "35%",
      "ok",
      '[{"tool":"t"}]',
      "[]",
      '[{"tool":"ocupacion_adr_revpar","args":{"periodo":"hoy"}}]',
    ]);
    expect(seen[0]!.params).not.toContain(SCOPE.userId);
  });

  it("list/get/rename/remove filtran siempre por usuario, organizacion y vertical (ademas de la RLS)", async () => {
    const { session, seen } = recorder({
      "select c\\.id, c\\.title, c\\.updated_at, c\\.message_count\\s+from core\\.data_chat_conversation c\\s+where c\\.user_id": [],
      "update core\\.data_chat_conversation": [],
      "delete from core\\.data_chat_conversation": [],
    });
    const repo = new PostgresConversacionesRepository(session);
    await repo.list(SCOPE);
    await repo.rename(SCOPE, ID, "t");
    await repo.remove(SCOPE, ID);
    for (const q of seen) {
      expect(q.sql).toMatch(/user_id = \$\d::uuid/);
      expect(q.sql).toMatch(/organization_id = \$\d::uuid/);
      expect(q.sql).toMatch(/vertical = \$\d::text/);
      expect(q.params).toContain(SCOPE.userId);
      expect(q.params).toContain(SCOPE.organizationId);
    }
    expect(seen).toHaveLength(3);
  });

  it("get: una conversacion ajena (sin fila) no consulta mensajes y devuelve null; la propia une los mensajes EN ORDEN y secuencial", async () => {
    const head = { id: ID, title: "Ocupación", updated_at: new Date("2026-10-01T12:00:00Z"), message_count: 2 };
    const { session, seen } = recorder({
      "from core\\.data_chat_message": [
        { seq: 1, role: "user", text: "hola", status: null, blocks: [], sources: [] },
        { seq: 2, role: "assistant", text: "35%", status: "ok", blocks: [{ tool: "t" }], sources: [{ tool: "t", source: "s", scopeLabel: "x" }] },
      ],
      "from core\\.data_chat_conversation c\\s+where c\\.id": [head],
    });
    const repo = new PostgresConversacionesRepository(session);
    const got = await repo.get(SCOPE, ID);
    expect(got).toMatchObject({ id: ID, titulo: "Ocupación", actualizadaEn: "2026-10-01T12:00:00.000Z" });
    expect(got!.mensajes.map((m) => [m.role, m.seq, m.blocks?.length ?? 0])).toEqual([["user", 1, 0], ["assistant", 2, 1]]);
    expect(seen.map((q) => (/data_chat_message/.test(q.sql) ? "mensajes" : "conversacion"))).toEqual(["conversacion", "mensajes"]);

    const empty = recorder({ "from core\\.data_chat_conversation c\\s+where c\\.id": [] });
    expect(await new PostgresConversacionesRepository(empty.session).get(SCOPE, ID)).toBeNull();
    expect(empty.seen).toHaveLength(1);
  });
});

describe("lo que se guarda", () => {
  it("la pregunta se redacta; la consulta directa guarda el nombre de la herramienta, no una pregunta inventada", () => {
    expect(redactQuestionForStorage("escribe a ana@x.mx o llama al 55 1234 5678")).toBe("escribe a [correo] o llama al [teléfono]");
    expect(redactQuestionForStorage("", "ventas_por_dia")).toBe("Consulta directa: ventas_por_dia");
    expect(redactQuestionForStorage("a".repeat(900))).toHaveLength(600);
  });

  const block = (rows: number, cell = "Ana Pérez"): DataChatBlock => ({
    kind: "table",
    tool: "t",
    title: "T",
    columns: [{ key: "c", label: "C", kind: "text" }],
    rows: Array.from({ length: rows }, () => ({ c: cell })),
    truncated: false,
  });

  it("las celdas de texto se redactan otra vez y se respeta el tope de 50 filas", () => {
    const out = sanitizeBlocksForStorage([block(80, "ana@x.mx 55 1234 5678")]);
    expect(out[0]!.rows).toHaveLength(50);
    expect(JSON.stringify(out)).not.toMatch(/ana@x\.mx|1234 5678/);
  });

  it("si el JSON no cabe en el tope se recortan filas y se marca truncated (nunca se pierde el texto del turno)", () => {
    const out = sanitizeBlocksForStorage(Array.from({ length: 14 }, (_, i) => block(50, String.fromCharCode(97 + i).repeat(60))));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(40_000);
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((b) => b.truncated)).toBe(true);
  });

  it("solo se guardan respuestas de conversacion (no tope, presupuesto ni entrada invalida)", () => {
    const base = { text: "hola", blocks: [], sources: [], toolsUsed: [] };
    for (const status of ["ok", "no_data", "clarify", "out_of_catalog"] as const) expect(isPersistableAnswer({ ...base, status })).toBe(true);
    for (const status of ["rate_limited", "budget_exceeded", "unavailable", "invalid_input"] as const) expect(isPersistableAnswer({ ...base, status })).toBe(false);
  });

  it("parseTitulo: una linea, sin PII, 1..80", () => {
    expect(parseTitulo({ titulo: " Ventas \n de   ayer " })).toBe("Ventas de ayer");
    expect(parseTitulo({ titulo: "a".repeat(200) })).toHaveLength(80);
    expect(() => parseTitulo({ titulo: "  " })).toThrow();
    expect(() => parseTitulo({ titulo: "x", otro: 1 })).toThrow();
    expect(() => parseTitulo(null)).toThrow();
  });
});

describe("rutas HTTP contra la base sin migrar", () => {
  async function unmigratedHarness() {
    const ctx = await buildHotelesTestContext(buildApp);
    void (ctx.deps.coreRepo as InMemoryCoreRepository);
    void (ctx.deps.engine as InMemoryTenancyEngine);
    const session = new AbortAwareFakeSession([
      { match: /data_chat_(conversation|message)|append_data_chat_turn/i, respond: () => NO_TABLE },
      SIGUIENTE,
    ]);
    const llm = scriptedCompletion([{ toolCalls: [{ name: "ocupacion_adr_revpar", argumentsJson: '{"periodo":"ultimos_30_dias"}' }] }, { text: "La ocupación fue de 35.0%." }]);
    const dataChat: DataChatDeps = {
      restaurantesReader: () => {
        throw new Error("no se usa");
      },
      hotelesReader: () => ({
        listVisibleHotels: async () => [],
        occupancy: async () => [{ bucket: "2026-09-29", availableNights: 40, occupiedNights: 14, roomRevenue: 14000 }],
        revenue: async () => [],
        arrivalsDepartures: async () => [],
        cancellations: async () => [],
        openTickets: async () => [],
        housekeepingPending: async () => [],
      }),
      audit: () => ({ record: async () => {} }),
      rateLimiter: { allow: async () => true },
      completion: () => llm.complete,
      conversaciones: () => new PostgresConversacionesRepository(session, () => {}),
    };
    return { app: buildApp({ ...ctx.deps, dataChat }), ctx, session, llm, url: `/hoteles/${ctx.propertyId}/chat-datos` };
  }

  it("listar -> 200 con disponible:false; abrir/renombrar/borrar -> 404; el chat con 'new' se responde igual SIN guardar y SIN romper la sesion", async () => {
    const h = await unmigratedHarness();
    const token = h.ctx.staff.owner.token;
    const list = await h.app.request(`${h.url}/conversaciones`, { headers: { authorization: `Bearer ${token}` } });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ disponible: false, conversaciones: [] });
    const id = randomUUID();
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await h.app.request(`${h.url}/conversaciones/${id}`, { headers: auth })).status).toBe(404);
    expect((await h.app.request(`${h.url}/conversaciones/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ titulo: "x" }) })).status).toBe(404);
    expect((await h.app.request(`${h.url}/conversaciones/${id}`, { method: "DELETE", headers: auth })).status).toBe(404);

    const turn = await h.app.request(h.url, authedJson(token, { question: "ocupación", conversationId: "new" }));
    expect(turn.status).toBe(200);
    const body = (await turn.json()) as { status: string; guardado?: boolean; motivoNoGuardado?: string; conversationId?: string; text: string };
    expect(body.status).toBe("ok");
    expect(body.text).toContain("35.0%");
    expect(body).toMatchObject({ guardado: false, motivoNoGuardado: "no_disponible" });
    expect(body.conversationId).toBeUndefined();
    await expectSessionUsable(h.session);
  });

  it("continuar una conversacion en la base sin migrar -> 404 ANTES de gastar un turno de modelo", async () => {
    const h = await unmigratedHarness();
    const res = await h.app.request(h.url, authedJson(h.ctx.staff.owner.token, { question: "x", conversationId: randomUUID() }));
    expect(res.status).toBe(404);
    expect(h.llm.requests).toHaveLength(0);
  });
});

vi.setConfig({ testTimeout: 20_000 });

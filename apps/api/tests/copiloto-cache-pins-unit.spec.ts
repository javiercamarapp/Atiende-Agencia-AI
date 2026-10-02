// CHAT-06 / MOD-05 / CHAT-15 -- piezas de apps/api contra la base SIN MIGRAR (0044 pendiente) y contra errores reales.
// Dentro de la transaccion unica del request, un 42P01/42883 sin SAVEPOINT dejaria la transaccion abortada (25P02) y el COMMIT
// se volveria ROLLBACK: AbortAwareFakeSession reproduce ese estado (una sesion falsa plana NO sirve).
import { describe, expect, it, vi } from "vitest";
import type { DataChatToolResult } from "@atiende/agent-core/data-chat";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildCitasDataChatCatalog } from "@atiende/domain-citas";
import { buildDespachosDataChatCatalog } from "@atiende/domain-despachos";
import { buildHotelesDataChatCatalog } from "@atiende/domain-hoteles";
import { buildLicitacionesDataChatCatalog } from "@atiende/domain-licitaciones";
import { buildRentasDataChatCatalog } from "@atiende/domain-rentas";
import { buildRestaurantesDataChatCatalog } from "@atiende/domain-restaurantes";
import { parseDataChatBody } from "../src/data-chat/body.ts";
import { CACHEABLE_TOOLS, PostgresDataChatCacheStore, UpstashDataChatCacheStore, createDataChatCacheStore } from "../src/data-chat/cache.ts";
import { PostgresDataChatAuditSink } from "../src/data-chat/deps.ts";
import { redactQuestionForStorage } from "../src/data-chat/conversaciones.ts";
import { PostgresPinsRepository, parseCreatePin, parsePatchPin, type PinScope } from "../src/data-chat/pins.ts";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";

const SCOPE: PinScope = { organizationId: "00000000-0000-0000-0000-0000000000a1", userId: "00000000-0000-0000-0000-0000000000b1", vertical: "hoteles" };
const ID = "00000000-0000-0000-0000-0000000000c1";

function pgError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
const NO_TABLE = pgError("42P01", 'relation "core.copiloto_pin" does not exist');
const NO_FN = pgError("42883", "function core.copiloto_pin_create(uuid, uuid, integer, integer, text, jsonb, text) does not exist");
const SIGUIENTE = { match: /select 1 as siguiente_query_del_request/i, respond: () => [{ ok: true }] };

async function expectSessionUsable(session: AbortAwareFakeSession): Promise<void> {
  await expect(session.query("select 1 as siguiente_query_del_request")).resolves.toEqual({ rows: [{ ok: true }] });
}

describe("fijados contra la base SIN MIGRAR (0044 pendiente): vacio honesto y sesion utilizable", () => {
  it("list/get/origin/remove: 42P01 -> vacio/null/false (sin 500) y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /copiloto_pin|data_chat_message/i, respond: () => NO_TABLE }, SIGUIENTE]);
    const repo = new PostgresPinsRepository(session);
    expect(await repo.list(SCOPE)).toEqual({ disponible: false, items: [] });
    await expectSessionUsable(session);
    expect(await repo.get(SCOPE, ID)).toBeNull();
    await expectSessionUsable(session);
    expect(await repo.origin(SCOPE, ID, 2, 0)).toBeNull();
    await expectSessionUsable(session);
    expect(await repo.remove(SCOPE, ID)).toBe(false);
    await expectSessionUsable(session);
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint")).length).toBe(4);
  });

  it("create: 42883 -> no_disponible; update: 42P01 -> no_encontrado; ambas con la sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /copiloto_pin_create/i, respond: () => NO_FN }, { match: /update core\.copiloto_pin/i, respond: () => NO_TABLE }, SIGUIENTE]);
    const repo = new PostgresPinsRepository(session);
    expect(await repo.create(SCOPE, { conversationId: ID, seq: 2, bloque: 0, origin: { tool: "t", args: {}, title: "t" } })).toEqual({ ok: false, motivo: "no_disponible" });
    await expectSessionUsable(session);
    expect(await repo.update(SCOPE, ID, { compartido: true })).toBe("no_encontrado");
    await expectSessionUsable(session);
  });

  it("errores reales de la funcion de alta: 54000 -> limite, P0002 -> conversacion, 42501 -> sin_acceso, otro -> error (loguea sin PII)", async () => {
    const log = vi.fn();
    for (const [code, motivo] of [["54000", "limite"], ["P0002", "conversacion_no_encontrada"], ["42501", "sin_acceso"], ["XX000", "error"]] as const) {
      const session = new AbortAwareFakeSession([{ match: /copiloto_pin_create/i, respond: () => pgError(code, "boom") }, SIGUIENTE]);
      const repo = new PostgresPinsRepository(session, log);
      expect(await repo.create(SCOPE, { conversationId: ID, seq: 2, bloque: 0, origin: { tool: "t", args: { periodo: "hoy" }, title: "t" } })).toEqual({ ok: false, motivo });
      await expectSessionUsable(session);
    }
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).not.toMatch(/periodo|hoy/);
  });

  it("update: 42501 de la policy (compartir sin ser owner/admin) -> sin_permiso, no 500, sesion utilizable", async () => {
    const session = new AbortAwareFakeSession([{ match: /update core\.copiloto_pin/i, respond: () => pgError("42501", 'new row violates row-level security policy for table "copiloto_pin"') }, SIGUIENTE]);
    expect(await new PostgresPinsRepository(session).update(SCOPE, ID, { compartido: true })).toBe("sin_permiso");
    await expectSessionUsable(session);
  });

  it("origin deriva herramienta, argumentos y titulo del mensaje guardado (nunca del cliente); el titulo sale sin PII", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /from core\.data_chat_message/i,
        respond: () => [{ blocks: [{ tool: "ocupacion_adr_revpar", title: "Ocupación de ana@x.mx" }], tool_calls: [{ tool: "ocupacion_adr_revpar", args: { periodo: "hoy", extra: { x: 1 } } }] }],
      },
    ]);
    const origin = await new PostgresPinsRepository(session).origin(SCOPE, ID, 2, 0);
    expect(origin).toEqual({ tool: "ocupacion_adr_revpar", args: { periodo: "hoy" }, title: "Ocupación de [correo]" });
  });

  it("origin: bloque inexistente o sin llamada registrada -> null", async () => {
    const session = new AbortAwareFakeSession([{ match: /from core\.data_chat_message/i, respond: () => [{ blocks: [{ tool: "a", title: "A" }], tool_calls: [{ tool: "otra", args: {} }] }] }]);
    const repo = new PostgresPinsRepository(session);
    expect(await repo.origin(SCOPE, ID, 2, 3)).toBeNull();
    expect(await repo.origin(SCOPE, ID, 2, 0)).toBeNull();
  });
});

describe("cuerpos de los fijados", () => {
  it("alta: solo conversationId + seq + bloque; todo lo demas (tool, args, ids) se rechaza", () => {
    expect(parseCreatePin({ conversationId: ID.toUpperCase(), seq: 2, bloque: 0 })).toEqual({ conversationId: ID, seq: 2, bloque: 0 });
    for (const bad of [{ conversationId: ID, seq: 2, bloque: 0, tool: "x" }, { conversationId: "no", seq: 2, bloque: 0 }, { conversationId: ID, seq: 0, bloque: 0 }, { conversationId: ID, seq: 2, bloque: 99 }, { conversationId: ID, seq: "2", bloque: 0 }]) {
      expect(() => parseCreatePin(bad as Record<string, unknown>)).toThrow();
    }
  });

  it("edicion: compartido y/o titulo; vacio o campo ajeno se rechaza", () => {
    expect(parsePatchPin({ compartido: true })).toEqual({ compartido: true });
    expect(parsePatchPin({ titulo: "  Ocupación   del mes " })).toEqual({ titulo: "Ocupación del mes" });
    for (const bad of [{}, { compartido: "si" }, { titulo: "   " }, { autor: "x" }]) expect(() => parsePatchPin(bad as Record<string, unknown>)).toThrow();
  });

  it("ruta directa: `args` y `label` solo con `tool`, con forma acotada", () => {
    expect(parseDataChatBody({ tool: "ventas_por_dia", args: { periodo: "ayer" }, label: "  ¿Cuánto vendí ayer? " })).toMatchObject({ tool: "ventas_por_dia", toolArgs: { periodo: "ayer" }, label: "¿Cuánto vendí ayer?" });
    expect(() => parseDataChatBody({ question: "x", args: { periodo: "ayer" } })).toThrow();
    expect(() => parseDataChatBody({ question: "x", label: "x" })).toThrow();
    expect(() => parseDataChatBody({ tool: "t", args: ["x"] })).toThrow();
    expect(() => parseDataChatBody({ tool: "t", args: { periodo: { a: 1 } } })).toThrow();
    expect(() => parseDataChatBody({ tool: "t", args: { "Mala Clave": "x" } })).toThrow();
    expect(() => parseDataChatBody({ tool: "t", args: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${String.fromCharCode(97 + i)}`, "x"])) })).toThrow();
  });

  it("el mensaje guardado de un chip es el texto del chip (o el nombre de la herramienta), redactado", () => {
    expect(redactQuestionForStorage("¿Cuánto vendí ayer?", "ventas_por_dia")).toBe("¿Cuánto vendí ayer?");
    expect(redactQuestionForStorage("", "ventas_por_dia")).toBe("Consulta directa: ventas_por_dia");
  });
});

function fakeEngine(session: TenantDbSession, seen: unknown[] = []): TenancyEngine {
  return {
    withAppSession: async (claims, fn) => {
      seen.push(claims);
      return fn(session);
    },
  };
}

const RESULT: DataChatToolResult = { status: "ok", source: "Reservas", scopeLabel: "todos tus hoteles", columns: [{ key: "a", label: "A", kind: "integer" }], rows: [{ a: 1 }] };

describe("cache en Postgres: sesion de sistema propia y degradacion a miss", () => {
  it("get/set usan una sesion de sistema (userId null) y las funciones definer; el ttl va en segundos", async () => {
    const claims: unknown[] = [];
    const calls: { sql: string; params: unknown[] | undefined }[] = [];
    const session: TenantDbSession = {
      query: async <T,>(sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: (/cache_get/.test(sql) ? [{ v: RESULT }] : []) as T[] };
      },
      exec: async () => undefined,
    };
    const store = new PostgresDataChatCacheStore(fakeEngine(session, claims));
    expect(await store.get("dchat:v1:k")).toEqual(RESULT);
    await store.set("dchat:v1:k", RESULT, 300_000, { organizationId: SCOPE.organizationId });
    expect(claims).toEqual([{ userId: null }, { userId: null }]);
    expect(calls[1]!.params).toEqual(["dchat:v1:k", SCOPE.organizationId, JSON.stringify(RESULT), 300]);
  });

  it("base sin migrar (42883/42P01): miss silencioso, sin lanzar ni loguear; cualquier otro fallo: miss y una linea sin datos", async () => {
    const log = vi.fn();
    const missing: TenantDbSession = { query: async () => { throw pgError("42883", "function core.data_chat_cache_get(text) does not exist"); }, exec: async () => undefined };
    const s1 = new PostgresDataChatCacheStore(fakeEngine(missing), log);
    expect(await s1.get("k")).toBeUndefined();
    await expect(s1.set("k", RESULT, 1000, { organizationId: SCOPE.organizationId })).resolves.toBeUndefined();
    expect(await s1.purge()).toBe(0);
    expect(log).not.toHaveBeenCalled();
    const broken: TenantDbSession = { query: async () => { throw new Error("conexion perdida con filas privadas"); }, exec: async () => undefined };
    expect(await new PostgresDataChatCacheStore(fakeEngine(broken), log).get("k")).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("la cache NO comparte transaccion con el request: un fallo de la cache deja utilizable la sesion del usuario", async () => {
    const userSession = new AbortAwareFakeSession([SIGUIENTE]);
    const cacheSession = new AbortAwareFakeSession([{ match: /data_chat_cache/i, respond: () => pgError("42883", "no existe") }]);
    expect(await new PostgresDataChatCacheStore(fakeEngine(cacheSession)).get("k")).toBeUndefined();
    await expectSessionUsable(userSession);
  });
});

describe("cache en Upstash", () => {
  it("guarda con EX en segundos (5 min -> 300, 24 h -> 86400) y lee de vuelta; un valor corrupto es un miss", async () => {
    const sets: { key: string; value: string; ex: number }[] = [];
    let stored: string | null = null;
    const store = new UpstashDataChatCacheStore({
      get: async () => stored,
      set: async (key, value, o) => {
        sets.push({ key, value, ex: o.EX });
        stored = value;
      },
    });
    await store.set("k", RESULT, 300_000);
    await store.set("k", RESULT, 24 * 3_600_000);
    expect(sets.map((s) => s.ex)).toEqual([300, 86_400]);
    expect(await store.get("k")).toEqual(RESULT);
    stored = "{no es json";
    expect(await store.get("k")).toBeUndefined();
    stored = "[1]";
    expect(await store.get("k")).toBeUndefined();
    stored = null;
    expect(await store.get("k")).toBeUndefined();
  });

  it("la fabrica elige Upstash si hay credenciales, Postgres si hay motor, y nada si no hay ninguno", () => {
    const engine = fakeEngine({ query: async () => ({ rows: [] }), exec: async () => undefined });
    expect(createDataChatCacheStore(engine, { UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t" })).toBeInstanceOf(UpstashDataChatCacheStore);
    expect(createDataChatCacheStore(engine, {})).toBeInstanceOf(PostgresDataChatCacheStore);
    expect(createDataChatCacheStore(engine, { UPSTASH_REDIS_REST_URL: "https://x.upstash.io" })).toBeInstanceOf(PostgresDataChatCacheStore);
    expect(createDataChatCacheStore(undefined, {})).toBeUndefined();
  });
});

describe("bitacora con ruta contra la base SIN MIGRAR", () => {
  const entry = { organizationId: SCOPE.organizationId, userId: SCOPE.userId, vertical: "hoteles", tool: "ocupacion_adr_revpar", params: { periodo: "hoy" }, outcome: "ok" as const, rowCount: 1, durationMs: 5, route: "cache" as const };

  it("con 0044: una sola llamada de 8 argumentos con la ruta", async () => {
    const session = new AbortAwareFakeSession([{ match: /record_data_chat_query/i, respond: () => [{}] }]);
    await new PostgresDataChatAuditSink(session).record(entry);
    expect(session.calls.filter((c) => c.includes("record_data_chat_query"))).toHaveLength(1);
  });

  it("sin 0044 pero con 0029: cae a la de 7 argumentos (sin ruta) y la sesion sigue utilizable", async () => {
    let n = 0;
    const session = new AbortAwareFakeSession([
      { match: /\$8::text/i, respond: () => pgError("42883", "function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text) does not exist") },
      { match: /record_data_chat_query/i, respond: () => (n++, [{}]) },
      SIGUIENTE,
    ]);
    await new PostgresDataChatAuditSink(session).record(entry);
    expect(n).toBe(1);
    await expectSessionUsable(session);
  });

  it("sin ninguna de las dos (0029 tampoco): log estructurado sin resultados y sesion utilizable", async () => {
    const log = vi.fn();
    const session = new AbortAwareFakeSession([{ match: /record_data_chat_query/i, respond: () => pgError("42883", "function core.record_data_chat_query(uuid) does not exist") }, SIGUIENTE]);
    await new PostgresDataChatAuditSink(session, log).record(entry);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ event: "data_chat_query_unlogged_pending_migration", route: "cache" });
    await expectSessionUsable(session);
  });
});

describe("lista blanca de cache", () => {
  it("cada herramienta cacheable existe en el catalogo REAL de su vertical (un renombre no la deja fuera en silencio)", () => {
    const stub = {} as never;
    const catalogs = {
      restaurantes: buildRestaurantesDataChatCatalog(stub),
      hoteles: buildHotelesDataChatCatalog(stub),
      rentas: buildRentasDataChatCatalog(stub),
      citas: buildCitasDataChatCatalog(stub),
      despachos: buildDespachosDataChatCatalog(stub),
      licitaciones: buildLicitacionesDataChatCatalog(stub),
    };
    for (const [vertical, names] of Object.entries(CACHEABLE_TOOLS)) {
      const real = new Set(catalogs[vertical as keyof typeof catalogs].tools.map((t) => t.name));
      for (const name of names) expect(real.has(name), `${vertical}.${name}`).toBe(true);
    }
  });

  it("las herramientas con nombres de personas NO estan en la lista (propietarios, profesionales, clientes con RFC, emisores)", () => {
    const excluidas: Record<string, string[]> = {
      rentas: ["ingresos_por_propietario", "liquidaciones_propietarios"],
      citas: ["ocupacion", "no_shows_y_cancelaciones", "huecos_libres"],
      despachos: ["cartera_por_cliente", "impuestos_del_mes", "obligaciones_fiscales", "cierres_pendientes", "alertas_efos", "carga_de_trabajo"],
      licitaciones: ["preguntas_junta_pendientes", "go_no_go", "renovaciones"],
    };
    for (const [vertical, names] of Object.entries(excluidas)) for (const n of names) expect(CACHEABLE_TOOLS[vertical]!.has(n), `${vertical}.${n}`).toBe(false);
  });
});

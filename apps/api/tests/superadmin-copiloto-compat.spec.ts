// Copiloto de superadmin (CHAT-16): compatibilidad con la base SIN migrar y piezas de cableado. Un error de Postgres dentro de la transaccion compartida del
// turno la deja ABORTADA (25P02); por eso cada fuente y la bitacora corren bajo SAVEPOINT. Aqui se prueba con `AbortAwareFakeSession` (reproduce el estado
// abortado; una sesion falsa plana NO sirve): tras un 42883/42P01/42703 la sesion sigue utilizable para la siguiente lectura y para la bitacora.
import { describe, expect, it, vi } from "vitest";
import { LlmGateway } from "@atiende/agent-core";
import type { DataChatAuditEntry } from "@atiende/agent-core/data-chat";
import { InMemoryTenancyEngine } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import type { AppDeps } from "../src/deps.ts";
import { PostgresConversacionesRepository } from "../src/data-chat/conversaciones.ts";
import { SWITCHABLE_AGENT_ROLES, isSwitchableTarget } from "../src/platform-switches.ts";
import { ALL_PRODUCTION_ROLES, SUPERADMIN_COPILOTO_LLM_BUDGET_LIMITS, buildSuperadminCopilotoLlmGateway } from "../src/production/llm-gateway.ts";
import { SUPERADMIN_COPILOTO_ROLE } from "../src/production/llm-models.ts";
import { PostgresPlataformaAuditSink } from "../src/superadmin-copiloto/bitacora.ts";
import { buildProductionSuperadminCopiloto, crearLedgerMensual, TOPE_MENSUAL_COPILOTO_MICRO_USD } from "../src/superadmin-copiloto/deps.ts";
import { fuentesDeProduccion } from "../src/superadmin-copiloto/fuentes.ts";
import { TEST_ENV } from "./fixtures.ts";
import type { ApiEnv } from "../src/env.ts";

// Postgres real: 42883 lleva "function ... does not exist" cuando la funcion falta (y "operator does not exist" en un bug de tipos, que NO es migracion pendiente).
const pgError = (code: string, message = code === "42883" ? "function core.fn_de_prueba(uuid) does not exist" : "error de prueba"): Error => Object.assign(new Error(message), { code });
const USER = "00000000-0000-0000-0000-0000000000a1";

function entrada(over: Partial<DataChatAuditEntry> = {}): DataChatAuditEntry {
  return { organizationId: "plataforma", userId: USER, vertical: "plataforma", tool: "organizaciones", params: { periodo: "este_mes" }, outcome: "ok", rowCount: 3, durationMs: 12, ...over };
}

describe("fuentesDeProduccion: SAVEPOINT en la sesion del turno", () => {
  it("una funcion que la base sin migrar no tiene (42883) devuelve 'no_migrado' y la sesion SIGUE utilizable para la lectura siguiente", async () => {
    const db = new AbortAwareFakeSession([
      { match: /get_copiloto_plataforma_gasto_mes/, respond: () => pgError("42883", "function core.get_copiloto_plataforma_gasto_mes(uuid) does not exist") },
      { match: /get_copiloto_uso_for_superadmin/, respond: () => [{ vertical: "plataforma", outcome: "ok", route: "llm", consultas: "5", filas: "20", duracion_ms: "900", costo_micro_usd: "2000000" }] },
    ]);
    const f = fuentesDeProduccion({} as AppDeps, db, USER);
    expect(await f.copilotoGastoMes()).toEqual({ ok: false, razon: "no_migrado" });
    // Sin SAVEPOINT esta consulta fallaria con 25P02 (transaccion abortada).
    const uso = await f.copilotoUso("2026-10-01", "2026-10-02");
    expect(uso).toEqual({ ok: true, data: [{ vertical: "plataforma", outcome: "ok", route: "llm", consultas: 5, filas: 20, duracionMs: 900, costoMicroUsd: 2_000_000 }] });
    expect(db.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    expect(db.calls.filter((c) => c.startsWith("savepoint"))).toHaveLength(2);
  });

  it.each([
    ["42P01", "no_migrado"],
    ["42703", "no_migrado"],
    ["XX000", "error"],
  ] as const)("SQLSTATE %s -> razon %s, sin lanzar y con la sesion recuperada", async (code, razon) => {
    const db = new AbortAwareFakeSession([
      { match: /get_copiloto_plataforma_gasto_mes/, respond: () => pgError(code) },
      { match: /get_copiloto_uso_for_superadmin/, respond: () => [] },
    ]);
    const f = fuentesDeProduccion({} as AppDeps, db, USER);
    expect(await f.copilotoGastoMes()).toEqual({ ok: false, razon });
    expect(await f.copilotoUso("2026-10-01", "2026-10-02")).toEqual({ ok: true, data: [] });
  });

  it("la lectura del gasto del mes usa la funcion caller-bound con el id del superadmin que pregunta (nunca una sesion de sistema ni un id ajeno)", async () => {
    const consultas: { sql: string; params: unknown[] }[] = [];
    const db: TenantDbSession = {
      query: async <T>(sql: string, params: unknown[] = []) => {
        consultas.push({ sql, params });
        return { rows: [{ gasto: "1234" }] as unknown as T[] };
      },
      exec: async () => undefined,
    };
    const r = await fuentesDeProduccion({} as AppDeps, db, USER).copilotoGastoMes();
    expect(r).toEqual({ ok: true, data: 1234 });
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toMatch(/core\.get_copiloto_plataforma_gasto_mes\(\$1::uuid\)/);
    expect(consultas[0]!.params).toEqual([USER]);
  });

  it("un repositorio de sesion ausente en este despliegue es 'sin_repositorio' (nunca un 500 ni una cifra inventada)", async () => {
    const f = fuentesDeProduccion({} as AppDeps, new AbortAwareFakeSession([]), USER);
    expect(await f.consolaOrganizaciones()).toEqual({ ok: false, razon: "sin_repositorio" });
    expect(await f.interruptores()).toEqual({ ok: false, razon: "sin_repositorio" });
    expect(await f.planes()).toEqual({ ok: false, razon: "sin_repositorio" });
    expect(await f.cfoFilas("2026-10")).toEqual({ ok: false, razon: "sin_repositorio" });
    expect(await f.contratos()).toEqual({ ok: false, razon: "sin_repositorio" });
  });

  it("repositorios fijos del back office (coreRepo, salud...) que lanzan NO tocan la transaccion del turno: 'no_migrado' o 'error'", async () => {
    const deps = {
      coreRepo: {
        listAllOrganizationsForSuperadmin: async () => {
          throw pgError("42883");
        },
        countStaffByOrganizationForSuperadmin: async () => new Map<string, number>(),
        listProspectosForSuperadmin: async () => {
          throw new Error("boom");
        },
      },
    } as unknown as AppDeps;
    const f = fuentesDeProduccion(deps, new AbortAwareFakeSession([]), USER);
    expect(await f.organizaciones()).toEqual({ ok: false, razon: "no_migrado" });
    expect(await f.prospectos()).toEqual({ ok: false, razon: "error" });
  });

  it("la huella de la zona CFO se escribe en una transaccion PROPIA (otra sesion) y nunca en la del turno", async () => {
    const turno = new AbortAwareFakeSession([]);
    const logAccess = vi.fn(async () => ({ availability: "available" as const, seq: 1 }));
    const engine = new InMemoryTenancyEngine();
    const sesiones: TenantDbSession[] = [];
    const original = engine.withAppSession.bind(engine);
    engine.withAppSession = (async (claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<unknown>) =>
      original(claims, async (s) => {
        sesiones.push(s);
        return fn(s);
      })) as typeof engine.withAppSession;
    const deps = { engine, cfoZoneRepo: () => ({ logAccess }) } as unknown as AppDeps;
    const f = fuentesDeProduccion(deps, turno, USER);
    expect(await f.registrarAccesoCfo("consulta", "copiloto/mrr", { herramienta: "mrr" })).toBe("ok");
    expect(logAccess).toHaveBeenCalledWith(USER, "consulta", "copiloto/mrr", { herramienta: "mrr" });
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0]).not.toBe(turno);
    expect(turno.calls).toEqual([]);
  });

  it("registrarAccesoCfo: zona CFO sin migrar = 'no_migrado'; sin repositorio = 'no_migrado'; cualquier otro fallo = 'error' (la consulta financiera no se ejecuta)", async () => {
    const engine = new InMemoryTenancyEngine();
    const turno = new AbortAwareFakeSession([]);
    expect(await fuentesDeProduccion({ engine } as unknown as AppDeps, turno, USER).registrarAccesoCfo("consulta", "x", {})).toBe("no_migrado");
    const sinMigrar = { engine, cfoZoneRepo: () => ({ logAccess: async () => ({ availability: "not_migrated" as const, seq: null }) }) } as unknown as AppDeps;
    expect(await fuentesDeProduccion(sinMigrar, turno, USER).registrarAccesoCfo("consulta", "x", {})).toBe("no_migrado");
    const roto = {
      engine,
      cfoZoneRepo: () => ({
        logAccess: async () => {
          throw new Error("disco lleno");
        },
      }),
    } as unknown as AppDeps;
    expect(await fuentesDeProduccion(roto, turno, USER).registrarAccesoCfo("consulta", "x", {})).toBe("error");
  });
});

describe("PostgresPlataformaAuditSink", () => {
  it("escribe con la funcion de 11 argumentos y organizacion NULL: herramienta, parametros tipados, resultado en conteo, costo, modelo y rol (por defecto superadmin:copiloto)", async () => {
    const consultas: { sql: string; params: unknown[] }[] = [];
    const db: TenantDbSession = {
      query: async <T>(sql: string, params: unknown[] = []) => {
        consultas.push({ sql, params });
        return { rows: [] as T[] };
      },
      exec: async () => undefined,
    };
    await new PostgresPlataformaAuditSink(db).record(entrada({ route: "llm", costMicroUsd: 1234.7, model: "anthropic/claude-sonnet-5.5", errorCode: undefined }));
    expect(consultas).toHaveLength(1);
    expect(consultas[0]!.sql).toMatch(/core\.record_data_chat_query\(null::uuid, \$1::text, \$2::jsonb/);
    expect(consultas[0]!.params).toEqual(["organizaciones", JSON.stringify({ periodo: "este_mes" }), "ok", 3, 12, null, "llm", 1234, "anthropic/claude-sonnet-5.5", SUPERADMIN_COPILOTO_ROLE]);
    // El id de la organizacion de la entrada del motor ("plataforma") NUNCA se manda a la base.
    expect(JSON.stringify(consultas[0]!.params)).not.toContain('"plataforma"');
  });

  it.each(["42501", "42883", "42P01", "42703", "23514"])("base sin migrar o sin permiso (%s): degrada a una linea estructurada SIN resultados ni PII y la sesion sigue utilizable", async (code) => {
    const db = new AbortAwareFakeSession([
      { match: /record_data_chat_query/, respond: () => pgError(code) },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const lineas: string[] = [];
    await new PostgresPlataformaAuditSink(db, (l) => lineas.push(l)).record(entrada());
    expect(lineas).toHaveLength(1);
    expect(JSON.parse(lineas[0]!)).toMatchObject({ event: "superadmin_copiloto_query_unlogged_pending_migration", userId: USER, tool: "organizaciones", outcome: "ok", rowCount: 3 });
    expect(lineas[0]).not.toMatch(/Taquería|correo|resultado/);
    // La transaccion del turno no quedo abortada: la siguiente consulta funciona (sin SAVEPOINT fallaria con 25P02).
    await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

describe("conversaciones con alcance de plataforma (organizacion NULL)", () => {
  function sesionQueCaptura() {
    const consultas: { sql: string; params: unknown[] }[] = [];
    const db: TenantDbSession = {
      query: async <T>(sql: string, params: unknown[] = []) => {
        consultas.push({ sql, params });
        return { rows: [] as T[] };
      },
      exec: async () => undefined,
    };
    return { db, consultas };
  }
  const scope = { organizationId: null, userId: USER, vertical: "plataforma" } as const;

  it("list, get, loadHistory, rename y remove comparan la organizacion con IS NOT DISTINCT FROM (con '= NULL' una conversacion de plataforma jamas apareceria)", async () => {
    const { db, consultas } = sesionQueCaptura();
    const repo = new PostgresConversacionesRepository(db);
    const id = "00000000-0000-0000-0000-0000000000e1";
    await repo.list(scope);
    await repo.get(scope, id);
    await repo.loadHistory(scope, id, 12);
    await repo.rename(scope, id, "Titulo");
    await repo.remove(scope, id);
    const lecturas = consultas.filter((c) => /data_chat_conversation/.test(c.sql));
    expect(lecturas.length).toBeGreaterThanOrEqual(5);
    for (const c of lecturas) {
      expect(c.sql, c.sql).toMatch(/organization_id is not distinct from \$\d+::uuid/);
      expect(c.sql, c.sql).not.toMatch(/organization_id = \$/);
      expect(c.params, c.sql).toContain(null);
      expect(c.params, c.sql).toContain("plataforma");
      expect(c.params, c.sql).toContain(USER);
    }
  });

  it("append pasa organizacion NULL a core.append_data_chat_turn (la funcion lo trata como scope plataforma y exige superadmin)", async () => {
    const { db, consultas } = sesionQueCaptura();
    const r = await new PostgresConversacionesRepository(db, () => undefined).append(scope, { propertyId: null, conversationId: null, userText: "p", assistantText: "r", status: "ok", blocks: [], sources: [], toolCalls: [] });
    expect(r).toMatchObject({ guardado: false });
    const llamada = consultas.find((c) => /append_data_chat_turn/.test(c.sql))!;
    expect(llamada.params.slice(0, 3)).toEqual([null, null, null]);
  });

  it("la base sin migrar o un 42501 (no es superadmin) NO tumba el turno: 'no se guardo' con su motivo y la sesion queda utilizable", async () => {
    for (const [code, motivo] of [["42883", "no_disponible"], ["42501", "sin_acceso"], ["54000", "limite_conversaciones"], ["P0002", "conversacion_no_encontrada"]] as const) {
      const db = new AbortAwareFakeSession([
        { match: /append_data_chat_turn/, respond: () => pgError(code) },
        { match: /select 1/, respond: () => [{ ok: 1 }] },
      ]);
      const r = await new PostgresConversacionesRepository(db, () => undefined).append(scope, { propertyId: null, conversationId: null, userText: "p", assistantText: "r", status: "ok", blocks: [], sources: [], toolCalls: [] });
      expect(r, code).toEqual({ guardado: false, motivo });
      await expect(db.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    }
  });
});

describe("tope mensual propio y gateway dedicado", () => {
  it("el acumulador suma el costo del mes, ignora valores no validos y arranca de cero al cambiar de mes", () => {
    const l = crearLedgerMensual();
    const octubre = new Date("2026-10-15T12:00:00Z");
    l.sumar(1500.9, octubre);
    l.sumar(-5, octubre);
    l.sumar(Number.NaN, octubre);
    l.sumar(500, octubre);
    expect(l.mes(octubre)).toBe(2000);
    expect(l.mes(new Date("2026-11-01T00:00:00Z"))).toBe(0);
    l.sumar(10, new Date("2026-11-02T00:00:00Z"));
    expect(l.mes(new Date("2026-11-30T00:00:00Z"))).toBe(10);
  });

  it("el tope por defecto es provisional y positivo (25 USD, hasta que Javier fije el presupuesto real: SA-44)", () => {
    expect(TOPE_MENSUAL_COPILOTO_MICRO_USD).toBe(25_000_000);
  });

  const env = (llmProviders: ApiEnv["llmProviders"]): ApiEnv => ({ ...TEST_ENV, llmProviders });

  it("el gateway DEDICADO es undefined sin proveedor (fail-closed) y con proveedor es un LlmGateway real con topes propios de defensa en profundidad", () => {
    expect(buildSuperadminCopilotoLlmGateway(env({ openai: null, openrouter: null }))).toBeUndefined();
    const g = buildSuperadminCopilotoLlmGateway(env({ openai: null, openrouter: { apiKey: `test-${Math.random().toString(16).slice(2)}`, countryOfResidence: null, modelsJson: null, zdr: false, sharedBreaker: null } }));
    expect(g).toBeInstanceOf(LlmGateway);
    expect(SUPERADMIN_COPILOTO_LLM_BUDGET_LIMITS.maxRunUsd).toBeLessThanOrEqual(2);
    expect(SUPERADMIN_COPILOTO_LLM_BUDGET_LIMITS.maxTenantDailyUsd).toBeLessThanOrEqual(50);
  });

  it("buildProductionSuperadminCopiloto: sin gateway no hay completion; con gateway llama al rol superadmin:copiloto en el carril interactivo con una clave de plataforma (no una organizacion)", async () => {
    expect(buildProductionSuperadminCopiloto(undefined).completion).toBeUndefined();
    const complete = vi.fn(async () => ({ text: "ok", model: "m", tokensIn: 0, tokensOut: 0, costUsd: 0 }));
    const d = buildProductionSuperadminCopiloto({ complete } as unknown as LlmGateway);
    await d.completion!({ system: "s", messages: [{ role: "user", content: "hola" }] });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "plataforma", role: "superadmin:copiloto", lane: "interactive" }));
    expect(d.rateLimiter).toBeDefined();
    expect(d.ledger.mes()).toBe(0);
  });

  it("el rol superadmin:copiloto esta registrado en el gateway de produccion Y es apagable desde el panel de interruptores", () => {
    expect(ALL_PRODUCTION_ROLES).toContain(SUPERADMIN_COPILOTO_ROLE);
    expect(SWITCHABLE_AGENT_ROLES).toContain(SUPERADMIN_COPILOTO_ROLE);
    expect(isSwitchableTarget("agente", "superadmin:copiloto")).toBe(true);
  });
});

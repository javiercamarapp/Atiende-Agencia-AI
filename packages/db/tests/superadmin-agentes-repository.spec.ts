// Repositorio de corridas y panel de agentes (SA-L-07/SA-L-08): cada operacion corre bajo SAVEPOINT. Se prueba con una
// sesion que reproduce el estado ABORTADO real de una transaccion (AbortAwareFakeSession); una plana no sirve.
import { describe, expect, it, vi } from "vitest";
import { InMemoryAgentRunRepository, PostgresAgentRunRepository } from "../src/index.ts";
import type { RegistrarCorridaInput } from "../src/index.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const entrada: RegistrarCorridaInput = {
  agente: "restaurantes:whatsapp_agent",
  vertical: "restaurantes",
  organizationId: null,
  disparo: "whatsapp",
  estado: "ok",
  tareasHechas: null,
  tareasTotal: null,
  costoMicroUsd: null,
  error: null,
  iniciadoEn: new Date("2026-10-01T10:00:00.000Z"),
  terminadoEn: new Date("2026-10-01T10:00:02.000Z"),
};

describe("PostgresAgentRunRepository", () => {
  it("registrarCorrida contra la base SIN migrar devuelve no_migrado y deja la sesion viva (sin SAVEPOINT darian 25P02 y COMMIT = ROLLBACK)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /core\.record_agent_run/, respond: () => pgError("42883", "function core.record_agent_run(text, text, uuid, text, text, integer, integer, bigint, text, timestamptz, timestamptz) does not exist") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresAgentRunRepository(session);
    await expect(repo.registrarCorrida(entrada)).resolves.toBe("no_migrado");
    // si la sesion hubiera quedado abortada, esta consulta lanzaria 25P02
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.filter((c) => c.startsWith("rollback to savepoint"))).toHaveLength(1);
  });

  it("registrarCorrida con un error de SQL que NO es de migracion se propaga (el llamador lo registra) y la sesion queda usable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /core\.record_agent_run/, respond: () => pgError("23514", "new row violates check constraint") },
      { match: /select 1/, respond: () => [{ ok: 1 }] },
    ]);
    await expect(new PostgresAgentRunRepository(session).registrarCorrida(entrada)).rejects.toMatchObject({ code: "23514" });
    await expect(session.query("select 1")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("registrarCorrida llama a la funcion de sistema con los 11 parametros en orden (ISO para las fechas)", async () => {
    const llamadas: unknown[][] = [];
    const session = {
      exec: async () => undefined,
      query: async (_sql: string, params?: unknown[]) => {
        llamadas.push(params ?? []);
        return { rows: [] };
      },
    };
    await expect(new PostgresAgentRunRepository(session as never).registrarCorrida({ ...entrada, estado: "fallo", error: "boom", tareasHechas: 1, tareasTotal: 2, costoMicroUsd: 300 })).resolves.toBe("registrada");
    expect(llamadas[0]).toEqual(["restaurantes:whatsapp_agent", "restaurantes", null, "whatsapp", "fallo", 1, 2, 300, "boom", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:02.000Z"]);
  });

  it("MISMA transaccion: el panel sin migrar no tumba la fuente siguiente; un error distinto queda en 'error'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const session = new AbortAwareFakeSession([
      { match: /get_agent_panel_for_superadmin/, respond: () => pgError("42883", "function core.get_agent_panel_for_superadmin(uuid, date) does not exist") },
      { match: /list_agent_runs_for_superadmin/, respond: () => pgError("57014", "canceling statement due to statement timeout") },
    ]);
    const repo = new PostgresAgentRunRepository(session);
    await expect(repo.panel("u1", "2026-10-01")).resolves.toEqual({ ok: false, razon: "no_migrado" });
    await expect(repo.listarCorridas("u1", {})).resolves.toEqual({ ok: false, razon: "error" });
  });

  it("mapea bigint de texto a numero, timestamptz a ISO y deja los null como null (nunca un 0 inventado)", async () => {
    const session = new AbortAwareFakeSession([
      {
        match: /get_agent_panel_for_superadmin/,
        respond: () => [
          {
            id: "citas:data_chat", nombre: "Chatea", vertical: "citas", canal: "panel", disparador: "Pregunta", modelo_rol: "citas:data_chat", presupuesto_dia_micro_usd: null, estado: "vivo",
            ultima_corrida_en: null, ultima_corrida_estado: null, corridas_30d: "0", corridas_ok_30d: "0", llamadas_30d: "0", costo_30d_micro_usd: "0",
          },
          {
            id: "restaurantes:whatsapp_agent", nombre: "WA", vertical: "restaurantes", canal: "whatsapp", disparador: "Mensaje", modelo_rol: "restaurantes:whatsapp_agent", presupuesto_dia_micro_usd: "5000000", estado: "vivo",
            ultima_corrida_en: new Date("2026-10-01T10:00:00.000Z"), ultima_corrida_estado: "ok", corridas_30d: "3", corridas_ok_30d: "2", llamadas_30d: "2", costo_30d_micro_usd: "20000",
          },
        ],
      },
      {
        match: /list_agent_runs_for_superadmin/,
        respond: () => [
          { id: "r1", agente: "/internal/hoteles/night-audit", vertical: "hoteles", organization_id: null, disparo: "cron", estado: "parcial", tareas_hechas: 3, tareas_total: 4, costo_micro_usd: null, error: "una fallo", iniciado_en: new Date("2026-10-01T10:00:00.000Z"), terminado_en: "2026-10-01T10:01:00.000Z", duracion_ms: "60000" },
        ],
      },
    ]);
    const repo = new PostgresAgentRunRepository(session);
    const panel = await repo.panel("u1", "2026-10-01");
    expect(panel).toMatchObject({ ok: true });
    if (!panel.ok) return;
    expect(panel.data[0]).toMatchObject({ presupuestoDiaMicroUsd: null, ultimaCorridaEn: null, ultimaCorridaEstado: null, corridas30d: 0 });
    expect(panel.data[1]).toMatchObject({ presupuestoDiaMicroUsd: 5_000_000, ultimaCorridaEn: "2026-10-01T10:00:00.000Z", costo30dMicroUsd: 20_000, corridasOk30d: 2 });
    const runs = await repo.listarCorridas("u1", { limite: 10 });
    expect(runs).toEqual({
      ok: true,
      data: [{ id: "r1", agente: "/internal/hoteles/night-audit", vertical: "hoteles", organizationId: null, disparo: "cron", estado: "parcial", tareasHechas: 3, tareasTotal: 4, costoMicroUsd: null, error: "una fallo", iniciadoEn: "2026-10-01T10:00:00.000Z", terminadoEn: "2026-10-01T10:01:00.000Z", duracionMs: 60000 }],
    });
  });

  it("purgarCorridas devuelve el numero borrado; sin migrar, null; agenteVivo lee el booleano y sin migrar da null", async () => {
    const ok = new AbortAwareFakeSession([
      { match: /system_purge_agent_runs/, respond: () => [{ borradas: "7" }] },
      { match: /system_agent_is_live/, respond: () => [{ vivo: true }] },
    ]);
    const r = new PostgresAgentRunRepository(ok);
    await expect(r.purgarCorridas(1000)).resolves.toBe(7);
    await expect(r.agenteVivo("x:y")).resolves.toBe(true);
    const viejo = new AbortAwareFakeSession([
      { match: /system_purge_agent_runs/, respond: () => pgError("42883", "function core.system_purge_agent_runs(integer) does not exist") },
      { match: /system_agent_is_live/, respond: () => pgError("42883", "function core.system_agent_is_live(text) does not exist") },
    ]);
    const v = new PostgresAgentRunRepository(viejo);
    await expect(v.purgarCorridas(1000)).resolves.toBeNull();
    await expect(v.agenteVivo("x:y")).resolves.toBeNull();
  });
});

describe("InMemoryAgentRunRepository", () => {
  it("un caller que no es superadmin recibe cero filas (misma semantica que el SQL)", async () => {
    const repo = new InMemoryAgentRunRepository();
    await repo.registrarCorrida(entrada);
    repo.seedSuperadmin("sa");
    repo.seedPanel({ ok: true, data: [] });
    await expect(repo.listarCorridas("otro", {})).resolves.toEqual({ ok: true, data: [] });
    await expect(repo.listarCorridas("sa", {})).resolves.toMatchObject({ ok: true, data: [expect.objectContaining({ agente: "restaurantes:whatsapp_agent", duracionMs: 2000 })] });
    await expect(repo.panel("otro", "2026-10-01")).resolves.toEqual({ ok: true, data: [] });
  });
});

// H-03 -- gobierno del agente en ejecucion: kill switch, presupuesto y registro de costo, con la base SIN migrar
// reproducida con AbortAwareFakeSession (un try/catch simple sin SAVEPOINT dejaria la transaccion abortada).
import { describe, expect, it } from "vitest";
import { AgentCostMeter, InMemoryAgentesRepository, PostgresAgentesRepository, meterGateway, runGovernedAgent } from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const NOW = new Date("2026-10-05T12:00:00Z");

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("runGovernedAgent", () => {
  it("agente activo: corre y registra el costo del turno", async () => {
    const repo = new InMemoryAgentesRepository();
    const result = await runGovernedAgent({
      repo, propertyId: P, agentKey: "recepcion_whatsapp", now: NOW,
      run: async (meter) => {
        meter.add({ tokensIn: 100, tokensOut: 20, costUsd: 0.0012 });
        meter.add({ tokensIn: 50, tokensOut: 10, costUsd: 0.0008 });
        return "respuesta del agente";
      },
      blocked: async () => "derivado a una persona",
    });
    expect(result).toBe("respuesta del agente");
    expect(await repo.gate(P, "recepcion_whatsapp", "2026-10")).toMatchObject({ spentMicroUsd: 2000, enabled: true });
    const usage = (await repo.listAgentConfig(P, "2026-10")).usage[0]!;
    expect(usage).toMatchObject({ tokensIn: 150, tokensOut: 30, costMicroUsd: 2000, callCount: 2 });
  });

  it("kill switch: pausado NO corre el agente y deriva a una persona", async () => {
    const repo = new InMemoryAgentesRepository();
    await repo.updateAgentConfig(P, "recepcion_whatsapp", { enabled: false, pausedReason: "Revision de costos" });
    let ran = false;
    const result = await runGovernedAgent({
      repo, propertyId: P, agentKey: "recepcion_whatsapp", now: NOW,
      run: async () => { ran = true; return "agente"; },
      blocked: async (state) => `persona:${state}`,
    });
    expect(result).toBe("persona:pausado");
    expect(ran).toBe(false);
  });

  it("presupuesto agotado en el borde (gasto == tope) deriva a una persona; un mes nuevo vuelve a correr", async () => {
    const repo = new InMemoryAgentesRepository();
    await repo.updateAgentConfig(P, "recepcion_whatsapp", { budgetMicroUsd: 2000 });
    await repo.recordUsage(P, "recepcion_whatsapp", "2026-10", { tokensIn: 1, tokensOut: 1, costMicroUsd: 2000, calls: 1 });
    const args = { repo, propertyId: P, agentKey: "recepcion_whatsapp" as const, run: async () => "agente", blocked: async (s: string) => `persona:${s}` };
    expect(await runGovernedAgent({ ...args, now: NOW })).toBe("persona:presupuesto_agotado");
    expect(await runGovernedAgent({ ...args, now: new Date("2026-11-01T00:00:00Z") })).toBe("agente");
  });

  it("un fallo del agente propaga el error pero igual registra el costo ya gastado", async () => {
    const repo = new InMemoryAgentesRepository();
    await expect(
      runGovernedAgent({
        repo, propertyId: P, agentKey: "recepcion_whatsapp", now: NOW,
        run: async (m) => { m.add({ costUsd: 0.001 }); throw new Error("proveedor caido"); },
        blocked: async () => "x",
      }),
    ).rejects.toThrow("proveedor caido");
    expect((await repo.gate(P, "recepcion_whatsapp", "2026-10"))?.spentMicroUsd).toBe(1000);
  });

  it("un fallo al leer la compuerta o registrar el costo es fail-open: el turno no se cae", async () => {
    const repo = new InMemoryAgentesRepository();
    repo.gate = async () => { throw new Error("lectura rota"); };
    repo.recordUsage = async () => { throw new Error("escritura rota"); };
    const errors: unknown[] = [];
    const result = await runGovernedAgent({
      repo, propertyId: P, agentKey: "recepcion_whatsapp", now: NOW, onError: (e) => errors.push(e),
      run: async (m) => { m.add({ costUsd: 0.001 }); return "ok"; },
      blocked: async () => "bloqueado",
    });
    expect(result).toBe("ok");
    expect(errors).toHaveLength(2);
  });

  it("meterGateway suma cada llamada sin alterar el resultado", async () => {
    const meter = new AgentCostMeter();
    const gw = meterGateway({ complete: async (_x: string) => ({ text: "hola", tokensIn: 10, tokensOut: 5, costUsd: 0.0005 }) }, meter);
    expect(await gw.complete("a")).toMatchObject({ text: "hola" });
    await gw.complete("b");
    expect(meter).toMatchObject({ tokensIn: 20, tokensOut: 10, costMicroUsd: 1000, calls: 2 });
  });
});

describe("base SIN migrar 035 (AbortAwareFakeSession)", () => {
  it("la compuerta degrada a 'activo' (null) y la MISMA transaccion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.agent_gate/i, respond: () => pgError("42883", "function hoteles.agent_gate(uuid, text, text) does not exist") },
      { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] },
    ]);
    const repo = new PostgresAgentesRepository(session);
    let ran = false;
    const result = await runGovernedAgent({ repo, propertyId: P, agentKey: "recepcion_whatsapp", now: NOW, run: async () => { ran = true; return "agente"; }, blocked: async () => "bloqueado" });
    expect(result).toBe("agente");
    expect(ran).toBe(true);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("registrar costo sin la funcion (42883) no tumba el turno y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /hoteles\.agent_gate/i, respond: () => pgError("42883", "function hoteles.agent_gate(uuid, text, text) does not exist") },
      { match: /record_agent_usage/i, respond: () => pgError("42883", "function hoteles.record_agent_usage(uuid, text, text, bigint, bigint, bigint, bigint) does not exist") },
      { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] },
    ]);
    const errors: unknown[] = [];
    const result = await runGovernedAgent({
      repo: new PostgresAgentesRepository(session), propertyId: P, agentKey: "recepcion_whatsapp", now: NOW, onError: (e) => errors.push(e),
      run: async (m) => { m.add({ costUsd: 0.001 }); return "agente"; },
      blocked: async () => "bloqueado",
    });
    expect(result).toBe("agente");
    expect(errors).toHaveLength(1);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

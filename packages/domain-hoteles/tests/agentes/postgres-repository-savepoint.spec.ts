// H-03 -- REGLA DURA de compatibilidad con la base sin migrar contra PostgresAgentesRepository REAL +
// AbortAwareFakeSession (reproduce el estado ABORTADO de una transaccion de Postgres: tras un error, toda
// consulta posterior lanza 25P02 salvo un ROLLBACK TO SAVEPOINT). Una sesion falsa plana NO sirve. Cada test
// FALLA si se quita el SAVEPOINT.
import { describe, expect, it } from "vitest";
import {
  AgentesAccessDeniedError,
  AgentesConflictError,
  AgentesInvalidInputError,
  AgentesNotFoundError,
  AgentesUnavailableError,
  PostgresAgentesRepository,
} from "../../src/index.ts";
import { AbortAwareFakeSession } from "../support/aborting-fake-session.ts";

const P = "00000000-0000-0000-0000-0000000000a1";
const A = "00000000-0000-0000-0000-0000000000d1";
const actor = { userId: "u", role: "owner" } as const;

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}
const undefinedTable = () => pgError("42P01", 'relation "hoteles.agent_approval_request" does not exist');
const after = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

describe("lecturas con base sin migrar 035 (42P01)", () => {
  it("todas degradan a vacio/default honesto y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.agent_config/i, respond: undefinedTable },
      { match: /from hoteles\.agent_guardrail/i, respond: undefinedTable },
      { match: /from hoteles\.agent_action_policy/i, respond: undefinedTable },
      { match: /from hoteles\.agent_approval_request/i, respond: undefinedTable },
      { match: /from hoteles\.agent_event/i, respond: undefinedTable },
      { match: /from hoteles\.agent_wa_template/i, respond: undefinedTable },
      { match: /hoteles\.agent_gate/i, respond: () => pgError("42883", "function hoteles.agent_gate(uuid, text, text) does not exist") },
      after,
    ]);
    const repo = new PostgresAgentesRepository(session);
    expect(await repo.listAgentConfig(P, "2026-10")).toEqual({ disponible: false, configs: [], usage: [] });
    expect((await repo.getGuardrails(P)).disponible).toBe(false);
    const policies = await repo.listPolicies(P);
    expect(policies.disponible).toBe(false);
    expect(policies.politicas).toHaveLength(5);
    expect(policies.politicas.every((p) => p.mode === "siempre_humano")).toBe(true);
    expect(await repo.listApprovals(P, {})).toEqual({ disponible: false, aprobaciones: [] });
    expect(await repo.findApproval(P, A)).toBeNull();
    expect(await repo.listApprovalEvents(P, A)).toEqual([]);
    expect(await repo.listTemplates(P)).toEqual({ disponible: false, plantillas: [] });
    expect(await repo.gate(P, "recepcion_whatsapp", "2026-10")).toBeNull();
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error que NO es de migracion pendiente se repropaga (no se enmascara)", async () => {
    const session = new AbortAwareFakeSession([{ match: /from hoteles\.agent_approval_request/i, respond: () => pgError("57014", "statement timeout") }]);
    await expect(new PostgresAgentesRepository(session).listApprovals(P, {})).rejects.toMatchObject({ code: "57014" });
  });
});

describe("escrituras: sin migracion -> AgentesUnavailableError, con la sesion recuperada", () => {
  const propose = { propertyId: P, agentKey: "revenue", actionType: "descuento_tarifa", summary: "x", payload: {}, amountCents: null, percent: 10, recipients: null, contentText: null, idempotencyKey: "key-00000001" } as const;

  it("proposeAction / decideApproval / expireApprovals / recordUsage sin la 035 -> 503 y la sesion sigue utilizable", async () => {
    const session = new AbortAwareFakeSession([
      { match: /propose_agent_action/i, respond: () => pgError("42883", "function hoteles.propose_agent_action(uuid, text, text, text, jsonb, bigint, numeric, integer, text, text, timestamp with time zone) does not exist") },
      { match: /from hoteles\.agent_approval_request where id/i, respond: undefinedTable },
      { match: /expire_agent_approvals/i, respond: () => pgError("42883", "function hoteles.expire_agent_approvals(uuid, timestamp with time zone) does not exist") },
      { match: /record_agent_usage/i, respond: () => pgError("42883", "function hoteles.record_agent_usage(uuid, text, text, bigint, bigint, bigint, bigint) does not exist") },
      after,
    ]);
    const repo = new PostgresAgentesRepository(session);
    await expect(repo.proposeAction(propose, actor)).rejects.toBeInstanceOf(AgentesUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await expect(repo.decideApproval(P, A, "aprobar", "motivo valido", actor)).rejects.toBeInstanceOf(AgentesUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    await expect(repo.expireApprovals(P, new Date())).rejects.toBeInstanceOf(AgentesUnavailableError);
    await expect(repo.recordUsage(P, "revenue", "2026-10", { tokensIn: 1, tokensOut: 1, costMicroUsd: 1, calls: 1 })).rejects.toBeInstanceOf(AgentesUnavailableError);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });

  it("mapea 23505/55000 -> Conflict, 23514/22023 -> InvalidInput, 42501 -> AccessDenied, P0002/23503 -> NotFound (sesion recuperada)", async () => {
    const cases: Array<[string, new (...a: never[]) => Error]> = [
      ["23505", AgentesConflictError], ["55000", AgentesConflictError], ["23514", AgentesInvalidInputError], ["22023", AgentesInvalidInputError],
      ["42501", AgentesAccessDeniedError], ["P0002", AgentesNotFoundError], ["23503", AgentesNotFoundError],
    ];
    for (const [code, klass] of cases) {
      const session = new AbortAwareFakeSession([{ match: /propose_agent_action/i, respond: () => pgError(code, "mensaje propio de la migracion") }, after]);
      await expect(new PostgresAgentesRepository(session).proposeAction(propose, actor)).rejects.toBeInstanceOf(klass);
      await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    }
  });

  it("un mensaje de CHECK/FK del motor no se filtra al cliente; el propio de la 035 si", async () => {
    const leaky = new AbortAwareFakeSession([{ match: /propose_agent_action/i, respond: () => pgError("23514", 'new row for relation "agent_approval_request" violates check constraint "x"') }]);
    await expect(new PostgresAgentesRepository(leaky).proposeAction(propose, actor)).rejects.toThrow(/Datos invalidos/);
    const own = new AbortAwareFakeSession([{ match: /propose_agent_action/i, respond: () => pgError("23514", "la solicitud excede un guardrail vigente (tope_descuento)") }]);
    await expect(new PostgresAgentesRepository(own).proposeAction(propose, actor)).rejects.toThrow(/guardrail vigente/);
  });

  it("decideApproval verifica que la solicitud sea de la property de la URL (otra property -> NotFound sin llamar a la funcion)", async () => {
    const session = new AbortAwareFakeSession([
      { match: /from hoteles\.agent_approval_request where id/i, respond: () => [] },
      { match: /decide_agent_approval/i, respond: () => [{ id: A }] },
    ]);
    await expect(new PostgresAgentesRepository(session).decideApproval(P, A, "aprobar", "motivo valido", actor)).rejects.toBeInstanceOf(AgentesNotFoundError);
    expect(session.calls.some((c) => /decide_agent_approval/i.test(c))).toBe(false);
  });
});

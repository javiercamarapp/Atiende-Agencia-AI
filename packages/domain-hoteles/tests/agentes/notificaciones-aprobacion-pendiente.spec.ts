// `hoteles.aprobacion.pendiente`: una propuesta del agente (o de una persona) que queda esperando decision emite la notificacion in-app
// por el productor compartido: una por solicitud (clave = id), sin PII, solo si el estado es `pendiente`, y SIN romper la propuesta ni la
// transaccion del request contra la base sin migrar (AbortAwareFakeSession reproduce el estado abortado de Postgres).
import { describe, expect, it } from "vitest";
import { PostgresAgentesRepository } from "../../src/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "../support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const P = "00000000-0000-4000-8000-0000000000a1";
const APROBACION = "00000000-0000-4000-8000-0000000000c1";
const actor = { userId: "u", role: "owner" } as const;
const PROPONER = /hoteles\.propose_agent_action/i;
const ORG_DE_PROPERTY = /from core\.property/i;
const EMITIR = /core\.emit_notification/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as despues/i, respond: () => [{ ok: 1 }] };

function fila(status: string) {
  return {
    id: APROBACION, property_id: P, agent_key: "recepcion_whatsapp", action_type: "reembolso", summary: "Reembolso a Maria Lopez por $500", payload: {}, amount_cents: 50000, currency: "MXN",
    percent: null, recipients: null, content_text: null, idempotency_key: "k-1234567890", status, proposed_by: null, auto_approved: false, block_reason: null,
    expires_at: "2026-10-04T10:00:00.000Z", decided_by: null, decided_at: null, decision_reason: null, executed_at: null, execution_ref: null, created_at: "2026-10-01T10:00:00.000Z",
  };
}
const INPUT = { propertyId: P, agentKey: "recepcion_whatsapp", actionType: "reembolso", summary: "Reembolso a Maria Lopez por $500", payload: {}, amountCents: 50000, percent: null, recipients: null, contentText: null, idempotencyKey: "k-1234567890" } as const;

function conRegistro(handlers: FakeSessionHandler[]) {
  const session = new AbortAwareFakeSession(handlers);
  const vistos: unknown[][] = [];
  const original = session.query.bind(session);
  session.query = (async (sql: string, params?: unknown[]) => {
    if (EMITIR.test(sql)) vistos.push(params ?? []);
    return original(sql, params);
  }) as typeof session.query;
  return { session, vistos };
}

describe("PostgresAgentesRepository.proposeAction -> hoteles.aprobacion.pendiente", () => {
  it("una solicitud pendiente emite UN aviso con la organizacion de la property, la clave de la solicitud y sin PII", async () => {
    const { session, vistos } = conRegistro([
      { match: PROPONER, respond: () => [fila("pendiente")] },
      { match: ORG_DE_PROPERTY, respond: () => [{ organization_id: ORG }] },
      { match: EMITIR, respond: () => [{ emit_notification: 2 }] },
    ]);
    const r = await new PostgresAgentesRepository(session).proposeAction(INPUT, actor);
    expect(r.id).toBe(APROBACION);
    expect(vistos).toHaveLength(1);
    expect(vistos[0]![0]).toBe(ORG);
    expect(vistos[0]![1]).toBe(P);
    expect(vistos[0]![2]).toBe("hoteles.aprobacion.pendiente");
    expect(vistos[0]![7]).toBe("/hoteles/{orgSlug}/aprobaciones");
    expect(vistos[0]![10]).toBe(`hoteles.aprobacion.pendiente:${APROBACION}`);
    expect(vistos[0]![11]).toEqual(["gm", "reservations"]);
    expect(JSON.stringify(vistos[0])).not.toMatch(/Maria|Lopez|500/);
  });

  it.each(["bloqueada", "ejecutada", "aprobada"])("una solicitud en estado %s no pide decision: no emite", async (estado) => {
    const { session, vistos } = conRegistro([{ match: PROPONER, respond: () => [fila(estado)] }, { match: ORG_DE_PROPERTY, respond: () => [{ organization_id: ORG }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    await new PostgresAgentesRepository(session).proposeAction(INPUT, actor);
    expect(vistos).toHaveLength(0);
  });

  it("base sin migrar (42883 en core.emit_notification): la propuesta se devuelve y la MISMA sesion sigue viva (sin 25P02)", async () => {
    const session = new AbortAwareFakeSession([
      { match: PROPONER, respond: () => [fila("pendiente")] },
      { match: ORG_DE_PROPERTY, respond: () => [{ organization_id: ORG }] },
      { match: EMITIR, respond: () => Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" }) },
      SIGUIENTE,
    ]);
    const r = await new PostgresAgentesRepository(session).proposeAction(INPUT, actor);
    expect(r.status).toBe("pendiente");
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("si la lectura de la organizacion falla, la propuesta tampoco se pierde", async () => {
    const session = new AbortAwareFakeSession([
      { match: PROPONER, respond: () => [fila("pendiente")] },
      { match: ORG_DE_PROPERTY, respond: () => Object.assign(new Error("permission denied"), { code: "42501" }) },
      SIGUIENTE,
    ]);
    expect((await new PostgresAgentesRepository(session).proposeAction(INPUT, actor)).id).toBe(APROBACION);
    await expect(session.query("select 1 as despues")).resolves.toEqual({ rows: [{ ok: 1 }] });
  });
});

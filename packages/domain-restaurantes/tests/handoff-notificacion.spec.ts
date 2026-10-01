// Regla de notificaciones: la toma de handoff abierta por el agente (WhatsApp real o widget de la demo) emite la notificacion in-app
// `restaurantes.handoff.solicitado` (productor compartido, catalogo de @atiende/db): una por conversacion derivada (clave = id de
// la toma), sin PII, y SIN romper la toma ni la transaccion del request contra la base sin migrar (SAVEPOINT).
import { describe, expect, it } from "vitest";
import { PostgresHandoffAgentGate } from "../src/conversaciones/postgres-repository.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000b1";
const PROP = "00000000-0000-4000-8000-0000000000a1";
const HANDOFF_ID = "00000000-0000-4000-8000-0000000000c9";
const SOLICITAR = /restaurantes\.handoff_solicitar_whatsapp/i;
const EMITIR = /core\.emit_notification/i;
const SIGUIENTE: FakeSessionHandler = { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] };
const INPUT = { organizationId: ORG, propertyId: PROP, phone: "+520009000001", motivo: "queja" };

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

describe("PostgresHandoffAgentGate.solicitarHumano -> notificacion in-app", () => {
  it("con la toma creada emite UNA notificacion con el evento del catalogo, la clave de la toma y sin PII", async () => {
    const session = new AbortAwareFakeSession([{ match: SOLICITAR, respond: () => [{ id: HANDOFF_ID }] }, { match: EMITIR, respond: () => [{ emit_notification: 2 }] }]);
    const id = await new PostgresHandoffAgentGate(session).solicitarHumano(INPUT);
    expect(id).toBe(HANDOFF_ID);
    expect(session.calls.filter((c) => EMITIR.test(c))).toHaveLength(1);
  });

  it("los parametros que viajan a la base son el evento, la organizacion y la clave: nunca el telefono ni el motivo del cliente", async () => {
    const vistos: unknown[][] = [];
    const base = new AbortAwareFakeSession([{ match: SOLICITAR, respond: () => [{ id: HANDOFF_ID }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    const original = base.query.bind(base);
    base.query = (async (sql: string, params?: unknown[]) => {
      if (EMITIR.test(sql)) vistos.push(params ?? []);
      return original(sql, params);
    }) as typeof base.query;
    await new PostgresHandoffAgentGate(base).solicitarHumano(INPUT);
    const [params] = vistos;
    expect(params![0]).toBe(ORG);
    expect(params![2]).toBe("restaurantes.handoff.solicitado");
    expect(params![10]).toBe(`restaurantes.handoff.solicitado:${HANDOFF_ID}`);
    expect(JSON.stringify(params)).not.toContain("520009000001");
    expect(JSON.stringify(params)).not.toContain("queja");
  });

  it("sin toma (base sin migrar o sin conversacion) NO emite nada", async () => {
    const session = new AbortAwareFakeSession([{ match: SOLICITAR, respond: () => [{ id: null }] }, { match: EMITIR, respond: () => [{ emit_notification: 1 }] }]);
    expect(await new PostgresHandoffAgentGate(session).solicitarHumano(INPUT)).toBeNull();
    expect(session.calls.some((c) => EMITIR.test(c))).toBe(false);
  });

  it("base sin la migracion de notificaciones (42883): la toma sigue creada y la MISMA sesion sigue viva (SAVEPOINT)", async () => {
    const session = new AbortAwareFakeSession([
      { match: SOLICITAR, respond: () => [{ id: HANDOFF_ID }] },
      { match: EMITIR, respond: () => pgError("42883", "function core.emit_notification does not exist") },
      SIGUIENTE,
    ]);
    expect(await new PostgresHandoffAgentGate(session).solicitarHumano(INPUT)).toBe(HANDOFF_ID);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("un error inesperado al emitir tampoco rompe la toma ni deja la transaccion abortada", async () => {
    const session = new AbortAwareFakeSession([
      { match: SOLICITAR, respond: () => [{ id: HANDOFF_ID }] },
      { match: EMITIR, respond: () => pgError("57014", "statement timeout") },
      SIGUIENTE,
    ]);
    expect(await new PostgresHandoffAgentGate(session).solicitarHumano(INPUT)).toBe(HANDOFF_ID);
    await expect(session.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

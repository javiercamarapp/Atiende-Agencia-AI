// Secretos por sucursal, bitacora de herramientas de voz y estado del pedido (migracion 026) contra la
// base SIN migrar: las funciones restaurantes.* no existen (42883). Todo corre dentro de la transaccion
// UNICA del request, asi que un try/catch simple dejaria la transaccion abortada (25P02) y el COMMIT
// devolveria ROLLBACK. AbortAwareFakeSession reproduce ese estado; una sesion falsa plana no podria.
import { describe, expect, it } from "vitest";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function pgUndefinedFunction(name: string): Error & { code: string } {
  const err = new Error(`function restaurantes.${name} does not exist`) as Error & { code: string };
  err.code = "42883";
  return err;
}

const ORG = "00000000-0000-4000-8000-000000000001";
const PROP = "00000000-0000-4000-8000-000000000002";
const SIGUIENTE = { match: /siguiente_query_del_request/i, respond: () => [{ ok: true }] };

function sinMigrar(): AbortAwareFakeSession {
  return new AbortAwareFakeSession([
    { match: /restaurantes\.verify_voice_branch_secret/i, respond: () => pgUndefinedFunction("verify_voice_branch_secret") },
    { match: /restaurantes\.rotate_voice_branch_secret/i, respond: () => pgUndefinedFunction("rotate_voice_branch_secret") },
    { match: /restaurantes\.record_voice_tool_audit/i, respond: () => pgUndefinedFunction("record_voice_tool_audit") },
    { match: /restaurantes\.read_order_flow_state/i, respond: () => pgUndefinedFunction("read_order_flow_state") },
    { match: /restaurantes\.write_order_flow_state/i, respond: () => pgUndefinedFunction("write_order_flow_state") },
    SIGUIENTE,
  ]);
}

async function requestSigueViva(session: AbortAwareFakeSession): Promise<void> {
  // Representa el COMMIT / cualquier consulta posterior de la misma transaccion del request.
  const { rows } = await session.query<{ ok: boolean }>("select 1 as siguiente_query_del_request");
  expect(rows[0]?.ok).toBe(true);
}

describe("migracion 026 sin aplicar: la transaccion del request sobrevive", () => {
  it("verifyVoiceBranchSecret devuelve 'unavailable' y deja la transaccion usable", async () => {
    const session = sinMigrar();
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.verifyVoiceBranchSecret(ORG, "a".repeat(64))).toEqual({ status: "unavailable" });
    expect(session.calls.some((c) => c.startsWith("savepoint"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint"))).toBe(true);
    await requestSigueViva(session);
  });

  it("rotateVoiceBranchSecret lanza el error honesto de config no disponible y la transaccion sigue viva", async () => {
    const session = sinMigrar();
    const repo = new PostgresRestaurantesRepository(session);
    await expect(repo.rotateVoiceBranchSecret(ORG, PROP, "b".repeat(64), "_abcd", 3600)).rejects.toMatchObject({ name: expect.stringMatching(/Unavailable/) });
    await requestSigueViva(session);
  });

  it("recordVoiceToolAudit (mejor esfuerzo) no lanza y no aborta la transaccion", async () => {
    const session = sinMigrar();
    const repo = new PostgresRestaurantesRepository(session);
    await expect(
      repo.recordVoiceToolAudit({ organizationId: ORG, propertyId: PROP, callId: "call-1", tool: "buscar_productos", outcome: "ok", phoneHash: null, detail: null }),
    ).resolves.toBeUndefined();
    await requestSigueViva(session);
  });

  it("readOrderFlow devuelve null (permisivo) y writeOrderFlow 'unavailable', ambos sin abortar", async () => {
    const session = sinMigrar();
    const repo = new PostgresRestaurantesRepository(session);
    expect(await repo.readOrderFlow(ORG, "call:c1")).toBeNull();
    await requestSigueViva(session);
    const ctx = { quoteHash: "h", items: [], confirmedAtTurn: null, quotedAtTurn: 1 } as never;
    expect(await repo.writeOrderFlow(ORG, "call:c1", 0, { state: "cotizado", context: ctx }, 600)).toBe("unavailable");
    await requestSigueViva(session);
  });

  it("un error que NO es de base sin migrar en la bitacora se traga (best-effort) sin abortar la transaccion", async () => {
    const otro = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const session = new AbortAwareFakeSession([{ match: /restaurantes\.record_voice_tool_audit/i, respond: () => otro }, SIGUIENTE]);
    const repo = new PostgresRestaurantesRepository(session);
    await expect(
      repo.recordVoiceToolAudit({ organizationId: ORG, propertyId: PROP, callId: "call-1", tool: "x", outcome: "denied", phoneHash: null, detail: "d" }),
    ).resolves.toBeUndefined();
    await requestSigueViva(session);
  });

  it("verifyVoiceBranchSecret con la migracion aplicada devuelve match/no_match", async () => {
    const hit = new AbortAwareFakeSession([{ match: /verify_voice_branch_secret/i, respond: () => [{ property_id: PROP }] }]);
    expect(await new PostgresRestaurantesRepository(hit).verifyVoiceBranchSecret(ORG, "c".repeat(64))).toEqual({ status: "match", propertyId: PROP });
    const miss = new AbortAwareFakeSession([{ match: /verify_voice_branch_secret/i, respond: () => [{ property_id: null }] }]);
    expect(await new PostgresRestaurantesRepository(miss).verifyVoiceBranchSecret(ORG, "c".repeat(64))).toEqual({ status: "no_match" });
  });
});

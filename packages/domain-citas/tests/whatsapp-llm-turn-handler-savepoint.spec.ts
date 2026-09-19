// BLOQUEANTE de re-revisión (PR #158, r3) — `executeToolCall` (../src/whatsapp/
// llm-turn-handler.ts) corre DENTRO de la MISMA transacción que abre todo el
// webhook (`apps/api/src/production/deps.ts::engine.withAppSession`) y envuelve
// cada tool call en un `try/catch` que traga CUALQUIER error, incluido un error
// real de Postgres. Contra la base sin migrar (o simplemente en operación normal:
// cancelar una cita ya completada = AT409, carrera de horario = AT423), ese error
// dejaba ABORTADA la transacción del turno completo -- hoy (sin la defensa del
// motor) el `COMMIT` final se degrada en silencio a `ROLLBACK` y el cliente igual
// recibe su respuesta; CON la defensa (`AbortedTransactionCommitError`,
// `managed-postgres-engine.ts`) ese mismo `COMMIT` LANZA, el webhook responde 500 a
// Meta, Meta reintenta sin tope y cada reintento re-corre el turno LLM completo sin
// que el cliente reciba respuesta jamás.
//
// Este test usa `AbortAwareFakeSession` (reproduce la semántica REAL de una
// transacción de Postgres -- ver su comentario de cabecera) + `PostgresCitasRepository`
// real (nunca `InMemoryCitasRepository`, que no tiene transacción real que abortar)
// para demostrar el fix: `cancelar_cita` dispara un AT409 real (RPC de Postgres) ->
// `executeToolCall` responde con un mensaje de error NORMAL (nunca lanza) -> la
// sesión queda utilizable DESPUÉS (una consulta posterior resuelve, no 25P02) -- la
// precondición exacta que evita que `managed-postgres-engine.ts` lance
// `AbortedTransactionCommitError` al hacer el COMMIT real del turno.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { PostgresCitasRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

function at409(): Error & { code: string } {
  // Mismo SQLSTATE de negocio real que `cancel_appointment_idempotent` lanza
  // (migrations/002_appointments.sql) cuando la cita ya está en un estado que no
  // admite cancelación -- ver `postgres-repository.ts::runCancelRpc`.
  const err = new Error("appointment is not in a cancellable status") as Error & { code: string };
  err.code = "AT409";
  return err;
}

describe("createLlmWhatsAppTurnHandler (citas) — SAVEPOINT por tool call, contra Postgres real (AbortAwareFakeSession)", () => {
  it("cancelar_cita dispara AT409 (cita ya completada): la respuesta se entrega normal, la sesión queda utilizable DESPUÉS, nunca deja la transacción abortada", async () => {
    const organizationId = randomUUID();
    const appointmentId = randomUUID();

    const session = new AbortAwareFakeSession([
      { match: /from citas\.tenant_config/, respond: () => [] },
      { match: /citas\.cancel_appointment_idempotent/, respond: () => at409() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresCitasRepository(session);

    const gateway = makeGateway();
    let step = 0;
    gateway.registerLadder("default", [
      new FakeLlmProvider({
        id: "p",
        script: (): LlmCompletionResult => {
          const current = step++;
          if (current === 0) {
            return {
              text: "",
              toolCalls: [{ id: "c1", name: "cancelar_cita", argumentsJson: JSON.stringify({ appointment_id: appointmentId }) }],
              model: "fake",
              tokensIn: 1,
              tokensOut: 1,
              costUsd: 0,
            };
          }
          return { text: "No pude cancelar esa cita porque ya está completada. ¿Te ayudo con algo más?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({
      organizationId,
      phone: "+5219990000000",
      messages: [{ role: "user", content: "cancela mi cita" }],
      customer: { isNew: false, fullName: "Cliente de prueba", upcomingAppointments: [] },
    });

    // La respuesta se entrega -- NUNCA se lanza AbortedTransactionCommitError (ni
    // ningún otro error) fuera del turno; el handler resuelve normal.
    expect(result.reply).toMatch(/completada/);
    expect(result.appointmentId).toBeNull();

    // El tool call quedó aislado con su propio SAVEPOINT.
    expect(session.calls.some((c) => c.startsWith("savepoint sp_fallback_"))).toBe(true);
    expect(session.calls.some((c) => c.startsWith("rollback to savepoint sp_fallback_"))).toBe(true);

    // La sesión sigue utilizable DESPUÉS del turno completo -- exactamente la
    // precondición que hace que el COMMIT real de `withAppSession` regrese el tag
    // 'COMMIT' (nunca 'ROLLBACK'), es decir, que `managed-postgres-engine.ts` NUNCA
    // lance `AbortedTransactionCommitError` para este turno.
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("control: la MISMA secuencia sin SAVEPOINT (catch simple) deja la sesión abortada -- prueba de que el bug era real", async () => {
    const session = new AbortAwareFakeSession([{ match: /citas\.cancel_appointment_idempotent/, respond: () => at409() }]);

    await expect(
      (async () => {
        try {
          await session.query("select citas.cancel_appointment_idempotent($1, $2) as result;", []);
        } catch {
          // catch simple -- exactamente el patrón roto que executeToolCall tenía
          // antes de envolver el switch en `repo.runWithRowSavepoint`.
        }
        return session.query("select 1;", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});

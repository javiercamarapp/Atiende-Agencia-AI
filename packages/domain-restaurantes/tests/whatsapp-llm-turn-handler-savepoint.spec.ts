// BLOQUEANTE de re-revisión (PR #158, r3) — `executeToolCall` (../src/whatsapp/
// llm-turn-handler.ts) corre DENTRO de la MISMA transacción que abre todo el
// webhook (`apps/api/src/production/deps.ts::engine.withAppSession`) y envuelve
// cada tool call en un `try/catch` que traga CUALQUIER error, incluido un error
// real de Postgres (ej. `PT409` de `createOrderIdempotent`, ver postgres-
// repository.ts). Sin aislar cada tool call, ese error dejaba ABORTADA la
// transacción del turno completo -- hoy (sin la defensa del motor) el `COMMIT`
// final se degrada en silencio a `ROLLBACK` y el cliente igual recibe su
// respuesta; CON la defensa (`AbortedTransactionCommitError`, `managed-postgres-
// engine.ts`) ese mismo `COMMIT` LANZA, el webhook responde 500 a Meta, Meta
// reintenta sin tope y cada reintento re-corre el turno LLM completo sin que el
// cliente reciba respuesta jamás.
//
// Mismo diseño de test que `@atiende/domain-citas` (ver su
// `tests/whatsapp-llm-turn-handler-savepoint.spec.ts`): `AbortAwareFakeSession`
// (reproduce la semántica REAL de una transacción de Postgres) + `PostgresRestaurantesRepository`
// real (nunca `InMemoryRestaurantesRepository`, que no tiene transacción real que
// abortar).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway, FakeLlmProvider } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../src/whatsapp/llm-turn-handler.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import type { CustomerLookupResult } from "../src/types.ts";

const NEW_CUSTOMER: CustomerLookupResult = { isNew: true };

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

function genericPostgresError(): Error & { code: string } {
  // No hace falta que sea un SQLSTATE reconocido -- el punto del bloqueante es que
  // `executeToolCall` traga CUALQUIER error de Postgres, no solo los códigos ya
  // mapeados a una excepción de negocio típica.
  const err = new Error("relation \"restaurantes.callback_requests\" does not exist") as Error & { code: string };
  err.code = "42P01";
  return err;
}

describe("createLlmWhatsAppTurnHandler (restaurantes) — SAVEPOINT por tool call, contra Postgres real (AbortAwareFakeSession)", () => {
  it("registrar_contacto dispara un error real de Postgres: la respuesta se entrega normal, la sesión queda utilizable DESPUÉS, nunca deja la transacción abortada", async () => {
    const organizationId = randomUUID();

    const session = new AbortAwareFakeSession([
      { match: /from core\.property/, respond: () => [] },
      { match: /insert into restaurantes\.callback_requests/, respond: () => genericPostgresError() },
      { match: /select 1/, respond: () => [] },
    ]);
    const repo = new PostgresRestaurantesRepository(session);

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
              toolCalls: [{ id: "c1", name: "registrar_contacto", argumentsJson: JSON.stringify({ customer_name: "Cliente de prueba", reason: "queja" }) }],
              model: "fake",
              tokensIn: 1,
              tokensOut: 1,
              costUsd: 0,
            };
          }
          return { text: "Ya anoté tu queja, en breve te contactamos. ¿Algo más?", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        },
      }),
    ]);
    gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
    const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated" });

    const result = await handler.handleInboundMessage({ organizationId, phone: "+5219990000000", messages: [{ role: "user", content: "tengo una queja" }], customer: NEW_CUSTOMER });

    // La respuesta se entrega -- nunca se lanza fuera del turno; el handler
    // resuelve normal (el error de Postgres se convirtió en un resultado de tool
    // con error, que el LLM ve y responde con normalidad en el turno siguiente).
    expect(result.reply).toMatch(/anoté|contactamos/i);
    expect(result.orderId).toBeNull();

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
    const session = new AbortAwareFakeSession([{ match: /insert into restaurantes\.callback_requests/, respond: () => genericPostgresError() }]);

    await expect(
      (async () => {
        try {
          await session.query("insert into restaurantes.callback_requests (organization_id) values ($1) returning id, resolved, created_at;", []);
        } catch {
          // catch simple -- exactamente el patrón roto que executeToolCall tenía
          // antes de envolver el switch en `repo.runWithRowSavepoint`.
        }
        return session.query("select 1;", []);
      })(),
    ).rejects.toMatchObject({ code: "25P02" });
  });
});

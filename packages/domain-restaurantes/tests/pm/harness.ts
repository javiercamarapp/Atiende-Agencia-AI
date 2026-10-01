// Arnés compartido de la batería PM (F3b): LLM simulado por guion + repositorio en memoria sembrado.
// El guion emite tool calls y texto (incluso erróneo) para probar que las reglas viven en el servidor.
import { randomUUID } from "node:crypto";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { createLlmWhatsAppTurnHandler } from "../../src/whatsapp/llm-turn-handler.ts";
import type { CustomerLookupResult } from "../../src/types.ts";
import { buildRestaurantFixture } from "../fixtures.ts";

export const PHONE = "+5219990000000";
export const NEW_CUSTOMER: CustomerLookupResult = { isNew: true };

export type ScriptStep =
  | { readonly text: string }
  | { readonly calls: ReadonlyArray<{ readonly name: string; readonly args: unknown }> };

export function result(step: ScriptStep, n: number): LlmCompletionResult {
  const base = { model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
  if ("text" in step) return { text: step.text, ...base };
  return { text: "", toolCalls: step.calls.map((c, i) => ({ id: `c${n}-${i}`, name: c.name, argumentsJson: typeof c.args === "string" ? c.args : JSON.stringify(c.args) })), ...base };
}

export function makeGateway(): LlmGateway {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

/** Handler con un guion fijo; `requests` captura cada request real que vería el modelo. */
export function scriptedHandler(repo: ReturnType<typeof buildRestaurantFixture>["repo"], steps: readonly ScriptStep[], opts: { maxToolUseTurns?: number } = {}) {
  const gateway = makeGateway();
  const requests: LlmCompletionRequest[] = [];
  let n = 0;
  gateway.registerLadder("default", [
    new FakeLlmProvider({
      id: "p",
      script: (req) => {
        requests.push(req);
        const step = steps[Math.min(n, steps.length - 1)]!;
        return result(step, n++);
      },
    }),
  ]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const handler = createLlmWhatsAppTurnHandler(repo, gateway, { defaultRole: "default", escalatedRole: "escalated", ...opts });
  return { handler, requests };
}

export function seedSecondTenant(repo: ReturnType<typeof buildRestaurantFixture>["repo"]) {
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  repo.seedOrganization({ id: organizationId, slug: "otro-restaurante", name: "Otro Restaurante" });
  repo.seedBranch({ propertyId, organizationId, name: "Sucursal Ajena", slug: "ajena", status: "active", phone: null, address: null, lat: null, lng: null });
  const cat = randomUUID();
  repo.seedCategory({ id: cat, organizationId, name: "Bebidas" });
  const productId = randomUUID();
  repo.seedProduct({ id: productId, organizationId, categoryId: cat, name: "Agua Ajena", description: null, searchKeywords: [] });
  repo.seedBranchProduct({ propertyId, productId, price: 1, isAvailable: true });
  return { organizationId, propertyId, productId };
}

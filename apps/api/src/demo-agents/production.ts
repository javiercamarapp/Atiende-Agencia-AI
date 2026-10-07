import { createHash, randomUUID } from "node:crypto";
import { InMemoryBudgetLedgerStore, LlmGateway } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import type { ApiEnv } from "../env.ts";
import { buildCircuitBreaker, buildRoleLadder, loadLlmModelsConfig } from "../production/llm-gateway.ts";
import { createDemoVoice } from "./gemini.ts";
import { demoInstruction } from "./profiles.ts";
import type { DemoAgentsDeps } from "./types.ts";

export const PUBLIC_DEMO_ROLE = "plataforma:demo_publica";

/** Public marketing sandbox. No tenant gateway, user session, domain repository or mutation tool. */
export function buildDemoAgents(env: ApiEnv, engine: TenancyEngine): DemoAgentsDeps {
  const enabled = process.env.PUBLIC_DEMO_AGENTS_ENABLED === "true";
  const allowedOrigins = ["https://useatiende.ai", "https://www.useatiende.ai", "https://app.useatiende.ai"];
  // Shared platform provider policy, but a separate ledger: public demos never charge a customer's organization.
  const ladder = enabled ? buildRoleLadder(env, PUBLIC_DEMO_ROLE, loadLlmModelsConfig(env)) : undefined;
  const gateway = ladder ? new LlmGateway({
    breaker: buildCircuitBreaker(env),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 0.08, maxTenantDailyUsd: 2 },
  }) : undefined;
  if (gateway && ladder) gateway.registerLadder(PUBLIC_DEMO_ROLE, ladder);
  return {
    enabled,
    allowedOrigins,
    // Existing atomic PostgreSQL primitive works on (scope, actor_hash), not organization rows.
    // A missing migration/connection throws; routes fail closed before reaching a provider.
    consume: (scope, actor, limit, seconds) => engine.withAppSession({ userId: null }, async (db) => {
      const hash = createHash("sha256").update(`public-demo:${actor}`).digest("hex");
      const { rows } = await db.query<{ allowed: boolean }>(
        "select restaurantes.consume_api_rate_limit($1, $2, $3, $4) as allowed",
        [`public-demo:${scope}`, hash, limit, seconds],
      );
      return rows[0]?.allowed === true;
    }),
    ...(gateway ? { chat: async (input) => {
      const result = await gateway.complete({
        tenantId: "public-marketing-demo", // In-memory platform ledger key, never a database tenant id.
        runId: randomUUID(),
        lane: "interactive",
        role: PUBLIC_DEMO_ROLE,
        request: {
          system: demoInstruction(input.solution, input.locale),
          messages: input.mensajes.map((m) => ({ role: m.rol === "usuario" ? "user" as const : "assistant" as const, content: m.texto })),
          maxOutputTokens: 384,
          signal: AbortSignal.timeout(20_000),
          // No tools and no private context; a generated answer cannot execute a domain action.
        },
      });
      if (!result.text.trim()) throw new Error("Demo chat provider returned no answer");
      return { respuesta: result.text, modelo: result.model, proveedor: result.providerId };
    } } : {}),
    ...(enabled && env.geminiApiKey ? { voice: createDemoVoice(env.geminiApiKey) } : {}),
  };
}

// Cobertura de la conexión real entre `POST .../requirements/extract` y
// `LlmRequirementExtractor` (ver comentario de cabecera de
// src/routes/verticals/licitaciones/technicalProposal.ts y
// src/production/llm-gateway.ts): en cuanto `AppDeps.llmGateway` existe (al
// menos una API key de proveedor real configurada en producción), la ruta debe
// sumar `LlmRequirementExtractor` a `RuleBasedExtractor`, nunca reemplazarlo.
// Aquí el gateway se arma con `FakeLlmProvider` (nunca toca la red, ver nota de
// esa clase) registrado exactamente para el rol
// "licitaciones:requirement_extractor" -- el mismo que
// `LlmRequirementExtractorOptions.role` usa por defecto.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { buildApp } from "../src/app.ts";
import { buildLicitacionesTestContext, authedJson } from "./licitaciones-fixtures.ts";

const BASES_TEXT = "El licitante deberá presentar acta constitutiva original.";

function buildFakeGatewayForRequirementExtraction(): LlmGateway {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 5, maxTenantDailyUsd: 100 },
  });
  const provider = new FakeLlmProvider({
    id: "fake-licitaciones",
    script: () => ({
      text: "",
      model: "fake-licitaciones/fake-model",
      tokensIn: 10,
      tokensOut: 10,
      costUsd: 0,
      toolCalls: [
        {
          id: randomUUID(),
          name: "registrar_requisito",
          argumentsJson: JSON.stringify({
            text: "Se exige una garantía de cumplimiento vigente durante todo el contrato.",
            obligatoriedad: "obligatorio",
            type: "legal",
            deadlineIso: null,
            requiredEvidence: ["garantia_cumplimiento"],
            topicKey: "garantia_cumplimiento",
          }),
        },
      ],
    }),
  });
  gateway.registerLadder("licitaciones:requirement_extractor", [provider]);
  return gateway;
}

describe("requirements/extract -- LlmRequirementExtractor conectado al gateway compartido", () => {
  it("sin AppDeps.llmGateway (fail-closed, sin API key configurada), solo corre RuleBasedExtractor", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES_TEXT }] }] }, { "idempotency-key": "sin-gateway" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { extractedBy: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.extractedBy === "rule")).toBe(true);
  });

  it("con AppDeps.llmGateway real (FakeLlmProvider, nunca red real), suma ítems 'llm' a los de RuleBasedExtractor", async () => {
    const ctx = await buildLicitacionesTestContext(buildApp, { llmGateway: buildFakeGatewayForRequirementExtraction() });
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/licitaciones/${ctx.propertyId}/tenders/${ctx.tenderId}/requirements/extract`,
      authedJson(ctx.staff.writer.token, { documents: [{ documentId: "bases", documentLabel: "Bases", publishedAt: "2026-01-01T00:00:00-06:00", pages: [{ page: 1, text: BASES_TEXT }] }] }, { "idempotency-key": "con-gateway" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { extractedBy: string; text: string }[] };
    expect(body.items.some((i) => i.extractedBy === "rule")).toBe(true);
    const llmItems = body.items.filter((i) => i.extractedBy === "llm");
    expect(llmItems.length).toBeGreaterThan(0);
    expect(llmItems.some((i) => i.text.includes("garantía de cumplimiento"))).toBe(true);
  });
});

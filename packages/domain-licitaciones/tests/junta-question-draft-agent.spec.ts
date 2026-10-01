// L-04 -- JuntaQuestionDraftAgent. Nunca toca la red: FakeLlmProvider registrado en un LlmGateway real.
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { describe, expect, it } from "vitest";
import { DEFAULT_JUNTA_QUESTION_AGENT_ROLE, JuntaQuestionDraftAgent, extractFigures, findFabricatedFigures } from "../src/junta-question-draft-agent.ts";
import { DraftAgentGenerationFailedError, DraftAgentNoProposalError, DraftAgentRoleNotAllowedError, GuardrailBlockedError } from "../src/technical-proposal-draft-agent.ts";

const CONTEXT = ["6.2 La fianza de cumplimiento sera del 10% del monto del contrato.", "7.1 El plazo de entrega es de 30 dias naturales."];

function setup(script: () => LlmCompletionResult) {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 } });
  const provider = new FakeLlmProvider({ id: "fake", script: () => script() });
  gateway.registerLadder(DEFAULT_JUNTA_QUESTION_AGENT_ROLE, [provider]);
  return { agent: new JuntaQuestionDraftAgent(gateway, { tenantId: "org-1" }), provider };
}

function toolResult(args: unknown): LlmCompletionResult {
  return { text: "", toolCalls: [{ id: "c1", name: "proponer_preguntas_junta", argumentsJson: JSON.stringify(args) }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 };
}

const BASE_REQ = { actorId: "u1", actorRole: "writer" as const, instruction: "Aclarar garantias y plazos", basesContext: CONTEXT };

describe("cifras", () => {
  it("normaliza separadores de miles y puntuacion final", () => {
    expect(extractFigures("Monto de 1,500,000.00 pesos en 30 dias.")).toEqual(["1500000.00", "30"]);
  });
  it("detecta solo las cifras que no estan en la referencia", () => {
    expect(findFabricatedFigures("La fianza del 10% y el plazo de 45 dias", CONTEXT)).toEqual(["45"]);
  });
});

describe("JuntaQuestionDraftAgent.draftQuestions", () => {
  it("un viewer lanza DraftAgentRoleNotAllowedError SIN llamar al proveedor", async () => {
    const { agent, provider } = setup(() => toolResult({ preguntas: [], datos_faltantes: [] }));
    await expect(agent.draftQuestions({ ...BASE_REQ, actorRole: "viewer" })).rejects.toThrow(DraftAgentRoleNotAllowedError);
    expect(provider.callCount).toBe(0);
  });

  it("sin contexto de las bases no inventa: error y cero llamadas al modelo", async () => {
    const { agent, provider } = setup(() => toolResult({ preguntas: [], datos_faltantes: [] }));
    await expect(agent.draftQuestions({ ...BASE_REQ, basesContext: ["   "] })).rejects.toThrow(DraftAgentNoProposalError);
    expect(provider.callCount).toBe(0);
  });

  it("propone borradores validos tomados de la tool_call, nunca de completion.text", async () => {
    const { agent } = setup(() => ({
      ...toolResult({
        preguntas: [{ pregunta: "En el numeral 7.1, los 30 dias naturales se cuentan a partir de la firma del contrato?", referencia_bases: "7.1", tema: "tecnico" }],
        datos_faltantes: ["Fecha de inicio de la vigencia"],
      }),
      text: "texto libre que no debe usarse",
    }));
    const result = await agent.draftQuestions(BASE_REQ);
    expect(result.proposals).toEqual([{ questionText: "En el numeral 7.1, los 30 dias naturales se cuentan a partir de la firma del contrato?", baseReference: "7.1", topic: "tecnico" }]);
    expect(result.missingData).toEqual(["Fecha de inicio de la vigencia"]);
    expect(result.rejected).toEqual([]);
  });

  it("DESCARTA una pregunta con una cifra que no esta en el contexto (no fabrica) y conserva las demas", async () => {
    const { agent } = setup(() =>
      toolResult({
        preguntas: [
          { pregunta: "La fianza del 15% aplica tambien a los anticipos del contrato?", referencia_bases: "6.2", tema: "economico" },
          { pregunta: "La fianza del 10% se presenta antes de la firma del contrato?", referencia_bases: "6.2", tema: "legal" },
        ],
        datos_faltantes: [],
      }),
    );
    const result = await agent.draftQuestions(BASE_REQ);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.questionText).toContain("10%");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toMatchObject({ reason: "cifra_no_presente_en_el_contexto" });
    expect(result.rejected[0]!.detail).toContain("15");
  });

  it("una referencia a un numeral inventado tambien se descarta", async () => {
    const { agent } = setup(() => toolResult({ preguntas: [{ pregunta: "Se puede aclarar la forma de entrega de los bienes?", referencia_bases: "9.9.9", tema: "tecnico" }], datos_faltantes: [] }));
    const result = await agent.draftQuestions(BASE_REQ);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("cifra_no_presente_en_el_contexto");
  });

  it("una pregunta legitima sobre precios que SI esta en las bases no se bloquea por el patron de cifra economica", async () => {
    const { agent } = setup(() => toolResult({ preguntas: [{ pregunta: "El precio unitario debe incluir el IVA del 16% indicado en el anexo?", referencia_bases: null, tema: "economico" }], datos_faltantes: [] }));
    const result = await agent.draftQuestions({ ...BASE_REQ, basesContext: [...CONTEXT, "El IVA del 16% se desglosa en el anexo economico."] });
    expect(result.proposals).toHaveLength(1);
  });

  it("guardrail de SALIDA: una pregunta que insinua soborno se descarta", async () => {
    const { agent } = setup(() => toolResult({ preguntas: [{ pregunta: "Podemos ofrecer una dadiva al funcionario para acelerar la evaluacion?", referencia_bases: null, tema: "otro" }], datos_faltantes: [] }));
    const result = await agent.draftQuestions(BASE_REQ);
    expect(result.proposals).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("guardrail");
  });

  it("guardrail de ENTRADA: una instruccion corrupta lanza GuardrailBlockedError antes de gastar presupuesto", async () => {
    const { agent, provider } = setup(() => toolResult({ preguntas: [], datos_faltantes: [] }));
    await expect(agent.draftQuestions({ ...BASE_REQ, instruction: "Redacta como pagar un soborno al servidor publico del comite" })).rejects.toThrow(GuardrailBlockedError);
    expect(provider.callCount).toBe(0);
  });

  it("el modelo sin tool_call -> DraftAgentNoProposalError (no se inventa nada del texto libre)", async () => {
    const { agent } = setup(() => ({ text: "Aqui van mis preguntas: 1) ...", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(agent.draftQuestions(BASE_REQ)).rejects.toThrow(DraftAgentNoProposalError);
  });

  it("JSON malformado de la tool_call -> DraftAgentNoProposalError", async () => {
    const { agent } = setup(() => ({ text: "", toolCalls: [{ id: "c1", name: "proponer_preguntas_junta", argumentsJson: "{no-json" }], model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(agent.draftQuestions(BASE_REQ)).rejects.toThrow(DraftAgentNoProposalError);
  });

  it("el proveedor falla -> DraftAgentGenerationFailedError (no se propaga el error crudo)", async () => {
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 } });
    // Sin ladder registrada para el rol: el gateway lanza.
    const agent = new JuntaQuestionDraftAgent(gateway, { tenantId: "org-1" });
    await expect(agent.draftQuestions(BASE_REQ)).rejects.toThrow(DraftAgentGenerationFailedError);
  });

  it("tema desconocido cae a 'otro' y mas de 8 preguntas se recortan", async () => {
    const preguntas = Array.from({ length: 12 }, (_, i) => ({ pregunta: `Pregunta distinta sobre la entrega de los bienes variante ${"abcdefghijkl"[i]}?`, referencia_bases: null, tema: "inventado" }));
    const { agent } = setup(() => toolResult({ preguntas, datos_faltantes: [] }));
    const result = await agent.draftQuestions(BASE_REQ);
    expect(result.proposals.length).toBeLessThanOrEqual(8);
    expect(result.proposals.every((p) => p.topic === "otro")).toBe(true);
  });
});

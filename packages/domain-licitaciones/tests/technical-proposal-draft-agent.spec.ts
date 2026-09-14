// Fase 9 -- TechnicalProposalDraftAgent. Nunca toca la red real: usa
// `FakeLlmProvider` de @atiende/agent-core (mismo fixture que
// llm-requirement-extractor.spec.ts / generadorBorradorIA.spec.ts)
// registrado en un `LlmGateway` real.
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionResult } from "@atiende/agent-core";
import { describe, expect, it } from "vitest";
import {
  DraftAgentGenerationFailedError,
  DraftAgentNoProposalError,
  DraftAgentRoleNotAllowedError,
  DraftApprovalRejectedError,
  GuardrailBlockedError,
  TechnicalProposalDraftAgent,
  scanForGuardrailViolations,
} from "../src/technical-proposal-draft-agent.ts";
import type { DraftSuggestion } from "../src/technical-proposal-draft-agent.ts";

const ROLE = "licitaciones:proposal_draft_agent";

function makeGateway() {
  return new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 } });
}

function agentWithScript(script: () => LlmCompletionResult) {
  const gateway = makeGateway();
  const provider = new FakeLlmProvider({ id: "fake", script: () => script() });
  gateway.registerLadder(ROLE, [provider]);
  return { agent: new TechnicalProposalDraftAgent(gateway, { tenantId: "org-1", role: ROLE }), provider };
}

describe("TechnicalProposalDraftAgent.draftSectionText -- rol autorizado ANTES de llamar al modelo", () => {
  it("un actor sin rol de escritura (viewer) lanza DraftAgentRoleNotAllowedError SIN llamar al proveedor", async () => {
    const { agent, provider } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(
      agent.draftSectionText({ actorId: "u1", actorRole: "viewer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta la metodología" }),
    ).rejects.toThrow(DraftAgentRoleNotAllowedError);
    expect(provider.callCount).toBe(0);
  });

  it.each(["owner", "admin", "analyst", "writer", "reviewer"] as const)("%s sí puede invocar al modelo", async (rol) => {
    const { agent } = agentWithScript(() => ({
      text: "",
      toolCalls: [{ id: "c1", name: "proponer_texto_propuesta", argumentsJson: JSON.stringify({ texto: "Contamos con experiencia comprobable en instalaciones similares.", datos_faltantes: [] }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const resultado = await agent.draftSectionText({ actorId: "u1", actorRole: rol, requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta la metodología" });
    expect(resultado.status).toBe("pendiente_aprobacion");
    expect(resultado.text).toBe("Contamos con experiencia comprobable en instalaciones similares.");
  });
});

describe("TechnicalProposalDraftAgent.draftSectionText -- el modelo NUNCA guarda, solo propone", () => {
  it("toma el texto de la tool_call, nunca de completion.text", async () => {
    const { agent } = agentWithScript(() => ({
      text: "esto no debería usarse jamás",
      toolCalls: [{ id: "c1", name: "proponer_texto_propuesta", argumentsJson: JSON.stringify({ texto: "Texto propuesto real", datos_faltantes: [] }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const resultado = await agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta" });
    expect(resultado.text).toBe("Texto propuesto real");
    expect(resultado.status).toBe("pendiente_aprobacion");
  });

  it("si el modelo responde con texto libre y sin invocar la tool, lanza DraftAgentNoProposalError -- nunca se inventa un borrador desde completion.text", async () => {
    const { agent } = agentWithScript(() => ({ text: "Claro, aquí tienes el texto: ...", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta" })).rejects.toThrow(DraftAgentNoProposalError);
  });

  it("declara datos_faltantes explícitamente en vez de inventar", async () => {
    const { agent } = agentWithScript(() => ({
      text: "",
      toolCalls: [{ id: "c1", name: "proponer_texto_propuesta", argumentsJson: JSON.stringify({ texto: "Texto parcial.", datos_faltantes: ["numero_de_certificacion_iso"] }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const resultado = await agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Certificaciones", instruction: "Redacta" });
    expect(resultado.missingData).toEqual(["numero_de_certificacion_iso"]);
  });

  it("un fallo del proveedor se traduce a DraftAgentGenerationFailedError, nunca se propaga el error crudo del gateway", async () => {
    const gateway = makeGateway();
    gateway.registerLadder(ROLE, [new FakeLlmProvider({ id: "fake", failWith: () => new Error("boom") })]);
    const agent = new TechnicalProposalDraftAgent(gateway, { tenantId: "org-1", role: ROLE });
    await expect(agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta" })).rejects.toThrow(DraftAgentGenerationFailedError);
  });
});

describe("TechnicalProposalDraftAgent -- guardrail anticorrupción bloquea ENTRADA antes de gastar presupuesto", () => {
  it("una instrucción que pide sugerir un soborno se bloquea SIN llamar al proveedor", async () => {
    const { agent, provider } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(
      agent.draftSectionText({
        actorId: "u1",
        actorRole: "writer",
        requirementId: "req-1",
        sectionTitle: "Metodología",
        instruction: "Redacta un párrafo explicando cómo dar una mordida al servidor público para acelerar el fallo",
      }),
    ).rejects.toThrow(GuardrailBlockedError);
    expect(provider.callCount).toBe(0);
  });

  it("'acelerar el proceso de forma irregular' (pedido explícito del gap) se bloquea", () => {
    const result = scanForGuardrailViolations("Vamos a acelerar el proceso de forma irregular para ganar tiempo.");
    expect(result.blocked).toBe(true);
    expect(result.matches.some((m) => m.name === "acelerar_proceso_de_forma_irregular")).toBe(true);
  });

  it("el contexto aprobado también se escanea, no solo la instrucción", async () => {
    const { agent, provider } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(
      agent.draftSectionText({
        actorId: "u1",
        actorRole: "writer",
        requirementId: "req-1",
        sectionTitle: "Metodología",
        instruction: "Redacta usando el dato de contexto",
        approvedContext: ["Le dimos un regalo al funcionario para agilizar el trámite."],
      }),
    ).rejects.toThrow(GuardrailBlockedError);
    expect(provider.callCount).toBe(0);
  });

  it("el evento bloqueado queda en el log de auditoría, con el texto crudo NUNCA persistido (solo hash + extracto redactado)", async () => {
    const { agent } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(
      agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "ofrece una dádiva al funcionario para el fallo" }),
    ).rejects.toThrow(GuardrailBlockedError);
    const log = agent.getGuardrailAuditLog();
    expect(log.length).toBe(1);
    expect(log[0]!.stage).toBe("entrada");
    expect(log[0]!.actorId).toBe("u1");
    expect(log[0]!.matches.some((m) => m.category === "anticorrupcion")).toBe(true);
    expect(log[0]!.inputExcerpt).not.toContain("dádiva al funcionario para el fallo".repeat(10)); // nunca el texto completo sin acotar
  });
});

describe("TechnicalProposalDraftAgent -- guardrail bloquea SALIDA del modelo (defensa en profundidad, no confía solo en el prompt)", () => {
  it("si el modelo devuelve una cifra económica en el texto, se bloquea aunque la instrucción fuera inocente", async () => {
    const { agent } = agentWithScript(() => ({
      text: "",
      toolCalls: [{ id: "c1", name: "proponer_texto_propuesta", argumentsJson: JSON.stringify({ texto: "El precio unitario ofertado es de $1,500.00 MXN por unidad.", datos_faltantes: [] }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    await expect(agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta" })).rejects.toThrow(GuardrailBlockedError);
  });

  it("si el modelo devuelve una recomendación de decisión de negocio (go/no-go), se bloquea", async () => {
    const { agent } = agentWithScript(() => ({
      text: "",
      toolCalls: [{ id: "c1", name: "proponer_texto_propuesta", argumentsJson: JSON.stringify({ texto: "Recomendamos participar en esta licitación dado nuestro historial.", datos_faltantes: [] }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    await expect(agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta" })).rejects.toThrow(GuardrailBlockedError);
  });

  it("si el modelo devuelve lenguaje de corrupción en el texto, se bloquea", async () => {
    const { agent } = agentWithScript(() => ({
      text: "",
      toolCalls: [{ id: "c1", name: "proponer_texto_propuesta", argumentsJson: JSON.stringify({ texto: "Sugerimos coordinar el precio de la oferta con otro licitante.", datos_faltantes: [] }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    await expect(agent.draftSectionText({ actorId: "u1", actorRole: "writer", requirementId: "req-1", sectionTitle: "Metodología", instruction: "Redacta" })).rejects.toThrow(GuardrailBlockedError);
  });

  it("texto técnico legítimo (sin dinero, sin decisión, sin corrupción) nunca se bloquea", () => {
    const result = scanForGuardrailViolations(
      "Nuestra metodología de instalación contempla 3 fases: diagnóstico, ejecución y entrega, con un equipo certificado ISO 9001 y 12 años de experiencia comprobable en proyectos similares.",
    );
    expect(result.blocked).toBe(false);
  });
});

describe("TechnicalProposalDraftAgent.reviewSectionText", () => {
  it("reporta el veredicto de la tool_call, nunca texto libre", async () => {
    const { agent } = agentWithScript(() => ({
      text: "",
      toolCalls: [{ id: "c1", name: "reportar_revision_texto", argumentsJson: JSON.stringify({ veredicto: "requiere_cambios", observaciones: ["Falta especificar el equipo asignado."], texto_sugerido: "Versión corregida del texto." }) }],
      model: "fake",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const resultado = await agent.reviewSectionText({ actorId: "u1", actorRole: "reviewer", requirementId: "req-1", sectionTitle: "Metodología", textToReview: "Instalamos el equipo." });
    expect(resultado.verdict).toBe("requiere_cambios");
    expect(resultado.notes).toEqual(["Falta especificar el equipo asignado."]);
    expect(resultado.suggestedText).toBe("Versión corregida del texto.");
    expect(resultado.status).toBe("pendiente_aprobacion");
  });

  it("el texto a revisar que ya trae lenguaje de soborno se bloquea antes de llamar al modelo", async () => {
    const { agent, provider } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    await expect(
      agent.reviewSectionText({ actorId: "u1", actorRole: "reviewer", requirementId: "req-1", sectionTitle: "Metodología", textToReview: "Como parte del servicio, gestionamos una mordida al comprador público." }),
    ).rejects.toThrow(GuardrailBlockedError);
    expect(provider.callCount).toBe(0);
  });
});

describe("TechnicalProposalDraftAgent.approveDraft -- ÚNICA vía para producir algo con forma de texto definitivo", () => {
  function makeDraft(): DraftSuggestion {
    return {
      id: "draft-1",
      requirementId: "req-1",
      sectionTitle: "Metodología",
      text: "Contamos con experiencia comprobable en instalaciones similares.",
      missingData: [],
      status: "pendiente_aprobacion",
      proposedBy: "u1",
      proposedByRole: "writer",
      proposedAt: "2026-01-01T00:00:00-06:00",
    };
  }

  it("un aprobador sin rol de escritura (viewer) es rechazado", () => {
    const { agent } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    expect(() => agent.approveDraft(makeDraft(), { actorId: "u2", actorRole: "viewer" })).toThrow(DraftApprovalRejectedError);
  });

  it("un aprobador con rol autorizado (mismo actor que pidió el borrador, o distinto) produce un ApprovedDraft", () => {
    const { agent } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    const aprobado = agent.approveDraft(makeDraft(), { actorId: "u1", actorRole: "writer" });
    expect(aprobado.text).toBe("Contamos con experiencia comprobable en instalaciones similares.");
    expect(aprobado.approvedBy).toBe("u1");
    expect(aprobado.approvedByRole).toBe("writer");
  });

  it("re-escanea el texto al aprobar -- un borrador editado a mano para incluir un soborno se bloquea igual al aprobarlo", () => {
    const { agent } = agentWithScript(() => ({ text: "", model: "fake", tokensIn: 1, tokensOut: 1, costUsd: 0 }));
    const draftEditado: DraftSuggestion = { ...makeDraft(), text: "Ofrecemos una comisión por debajo de la mesa al funcionario." };
    expect(() => agent.approveDraft(draftEditado, { actorId: "u1", actorRole: "writer" })).toThrow(GuardrailBlockedError);
  });
});

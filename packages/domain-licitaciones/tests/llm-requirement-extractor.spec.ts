// Fase 2 pieza 3 -- LlmRequirementExtractor. Nunca toca la red real: usa
// `FakeLlmProvider` de @atiende/agent-core (mismo fixture que usan los
// propios tests de agent-core) registrado en un `LlmGateway` real -- prueba
// la integración real del gateway compartido, no un mock a medias.
import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import type { LlmCompletionRequest, LlmCompletionResult } from "@atiende/agent-core";
import { LlmRequirementExtractor } from "../src/llm-requirement-extractor.ts";
import { resetRequirementCounters } from "../src/requirement-matrix.ts";
import type { TenderDocumentText } from "../src/requirement-matrix.ts";

const ROLE = "licitaciones:requirement_extractor";

beforeEach(() => {
  resetRequirementCounters();
});

function gatewayWithScript(script: (request: LlmCompletionRequest) => LlmCompletionResult): LlmGateway {
  const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 } });
  gateway.registerLadder(ROLE, [new FakeLlmProvider({ id: "fake", script })]);
  return gateway;
}

const DOC: TenderDocumentText = {
  documentId: "bases",
  documentLabel: "Bases de la convocatoria",
  publishedAt: "2026-01-01T00:00:00-06:00",
  pages: [{ page: 5, text: "El licitante deberá presentar una manifestación bajo protesta de decir verdad de no encontrarse en los supuestos del artículo 50 de la LAASSP." }],
};

describe("LlmRequirementExtractor -- cada requisito es una tool_call estructurada, nunca texto libre parseado a mano", () => {
  it("convierte una tool_call 'registrar_requisito' válida en un RequirementItem con extractedBy:'llm' y confianza <1", async () => {
    const gateway = gatewayWithScript(() => ({
      text: "",
      toolCalls: [
        {
          id: "call_1",
          name: "registrar_requisito",
          argumentsJson: JSON.stringify({
            text: "El licitante deberá presentar una manifestación bajo protesta de decir verdad.",
            obligatoriedad: "obligatorio",
            type: "legal",
            deadlineIso: null,
            requiredEvidence: ["manifestacion_art_50"],
            topicKey: "manifestacion_art_50_60",
          }),
        },
      ],
      model: "fake/model",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0,
    }));

    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    const items = await extractor.extract(DOC);

    expect(items.length).toBe(1);
    expect(items[0]!.extractedBy).toBe("llm");
    expect(items[0]!.confidence).toBeLessThan(1);
    expect(items[0]!.source).toEqual({ documentId: "bases", documentLabel: "Bases de la convocatoria", page: 5, clause: undefined });
    expect(items[0]!.requiredEvidence).toEqual(["manifestacion_art_50"]);
  });

  // Hallazgo de auditoría (rubro 10, performance): esta llamada corre dentro de la
  // transacción por-request de `POST .../requirements/extract` -- sin límite, un
  // proveedor colgado sostiene la conexión de Postgres indefinidamente. Prueba real
  // de que la mitigación (AbortSignal.timeout) está efectivamente cableada -- no solo
  // presente en el tipo -- inspeccionando el request que de verdad recibe el provider.
  it("acota cada llamada por página con un AbortSignal real, nunca una llamada sin límite", async () => {
    let signalRecibido: AbortSignal | undefined;
    const gateway = gatewayWithScript((request) => {
      signalRecibido = request.signal;
      return { text: "", model: "fake/model", tokensIn: 5, tokensOut: 5, costUsd: 0 };
    });
    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    await extractor.extract(DOC);
    expect(signalRecibido).toBeInstanceOf(AbortSignal);
    expect(signalRecibido!.aborted).toBe(false);
  });

  it('una página sin requisitos (el modelo no llama a ninguna herramienta) produce cero RequirementItem, nunca uno inventado', async () => {
    const gateway = gatewayWithScript(() => ({ text: "Esta página es solo el índice, sin requisitos.", model: "fake/model", tokensIn: 5, tokensOut: 5, costUsd: 0 }));
    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    const items = await extractor.extract(DOC);
    expect(items).toEqual([]);
  });

  it("un RequirementItem con deadline INVÁLIDO (offset fuera de rango) se RECHAZA antes de persistirse -- reusa assertExplicitOffset ya portado en Fase 1, no una guardia nueva", async () => {
    const gateway = gatewayWithScript(() => ({
      text: "",
      toolCalls: [
        {
          id: "call_1",
          name: "registrar_requisito",
          argumentsJson: JSON.stringify({
            text: "La entrega será a más tardar el 99 de nuncatember del 2026.",
            obligatoriedad: "obligatorio",
            type: "administrativo",
            deadlineIso: "2026-12-15T18:00:00+99:00", // offset numéricamente imposible (EX-EXP-04/EX-EXP-13, ya portado)
            requiredEvidence: [],
          }),
        },
      ],
      model: "fake/model",
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0,
    }));

    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    const items = await extractor.extract(DOC);
    // El ítem entero se descarta -- nunca se persiste con una fecha inválida
    // ni se coacciona el deadline a null en silencio.
    expect(items).toEqual([]);
  });

  it("una tool_call con obligatoriedad/type fuera del enum permitido se descarta, nunca lanza", async () => {
    const gateway = gatewayWithScript(() => ({
      text: "",
      toolCalls: [{ id: "call_1", name: "registrar_requisito", argumentsJson: JSON.stringify({ text: "x", obligatoriedad: "quizas", type: "legal", deadlineIso: null, requiredEvidence: [] }) }],
      model: "fake/model",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    await expect(extractor.extract(DOC)).resolves.toEqual([]);
  });

  it("un argumentsJson malformado (JSON inválido) se descarta esa tool_call sin tumbar el resto de la extracción", async () => {
    const gateway = gatewayWithScript(() => ({
      text: "",
      toolCalls: [
        { id: "call_1", name: "registrar_requisito", argumentsJson: "{not json" },
        { id: "call_2", name: "registrar_requisito", argumentsJson: JSON.stringify({ text: "Requisito válido.", obligatoriedad: "obligatorio", type: "administrativo", deadlineIso: null, requiredEvidence: [] }) },
      ],
      model: "fake/model",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    const items = await extractor.extract(DOC);
    expect(items.length).toBe(1);
    expect(items[0]!.text).toBe("Requisito válido.");
  });

  it("ignora páginas de texto vacío -- nunca llama al proveedor para una página en blanco", async () => {
    let calls = 0;
    const gateway = gatewayWithScript(() => {
      calls += 1;
      return { text: "", model: "fake/model", tokensIn: 1, tokensOut: 1, costUsd: 0 };
    });
    const docConPaginaVacia: TenderDocumentText = { ...DOC, pages: [{ page: 1, text: "   " }, DOC.pages[0]!] };
    const extractor = new LlmRequirementExtractor(gateway, { tenantId: "org-1", role: ROLE });
    await extractor.extract(docConPaginaVacia);
    expect(calls).toBe(1); // solo la página con texto real.
  });
});

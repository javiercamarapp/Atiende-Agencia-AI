// Fase 2 pieza 3 -- RequirementMatrix. `licitaciones.requirement_item` en
// Fase 1 solo se LEE (comentario explícito en 001_licitaciones_schema.sql:
// "la extracción real vía LLM/reglas... no se porta en esta fase") --
// `RuleBasedExtractor` es el primer escritor real de esos datos.
import { beforeEach, describe, expect, it } from "vitest";
import {
  RequirementMatrixBuilder,
  RuleBasedExtractor,
  deriveSectionKeysFromRequirementMatrix,
  detectConflicts,
  extractDeadline,
  resetRequirementCounters,
} from "../src/requirement-matrix.ts";
import type { RequirementItem, TenderDocumentText } from "../src/requirement-matrix.ts";

beforeEach(() => {
  resetRequirementCounters();
});

function doc(documentId: string, text: string, publishedAt = "2026-01-01T00:00:00-06:00"): TenderDocumentText {
  return { documentId, documentLabel: documentId, publishedAt, pages: [{ page: 1, text }] };
}

describe("RuleBasedExtractor -- clasificación léxica", () => {
  it("clasifica un requisito con lenguaje imperativo como obligatorio", () => {
    const items = new RuleBasedExtractor().extract(doc("bases", "El licitante deberá presentar su acta constitutiva original."));
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.obligatoriedad).toBe("obligatorio");
    expect(items[0]!.extractedBy).toBe("rule");
  });

  it("clasifica un requisito con 'podrá presentar' como opcional", () => {
    const items = new RuleBasedExtractor().extract(doc("bases", "El licitante podrá presentar de manera opcional una carta de recomendación adicional."));
    expect(items.some((i) => i.obligatoriedad === "opcional")).toBe(true);
  });

  it("nunca inventa una fecha límite cuando el texto no trae una fecha inequívoca", () => {
    const { deadline } = extractDeadline("el licitante deberá presentar su propuesta en tiempo y forma");
    expect(deadline).toBeNull();
  });

  it("extrae una fecha límite explícita con nombre de mes y hora, fijada a America/Mexico_City (-06:00)", () => {
    const { deadline } = extractDeadline("la entrega de proposiciones será a más tardar el 15 de diciembre del 2026 a las 18:00 horas");
    expect(deadline).toBe("2026-12-15T18:00:00-06:00");
  });

  it("regresión: 'iva' exige límite de palabra -- 'acta constitutiva'/'administrativa' NUNCA se clasifican como económico solo por contener el sufijo '-iva'", () => {
    const items = new RuleBasedExtractor().extract(doc("bases", "El licitante deberá presentar acta constitutiva original."));
    expect(items[0]!.type).toBe("legal");
  });

  it("clasifica tipo económico/legal/técnico/anexo por palabra clave", () => {
    const items = new RuleBasedExtractor().extract(
      doc(
        "bases",
        "El licitante deberá presentar cotización de tarifa económica. Es obligatorio presentar la opinión de cumplimiento 32-D vigente. El licitante deberá acreditar experiencia técnica mínima de 3 años. Es obligatorio presentar el anexo 4 firmado.",
      ),
    );
    expect(items.map((i) => i.type)).toEqual(expect.arrayContaining(["economico", "legal", "tecnico", "anexo"]));
  });
});

describe("RequirementMatrixBuilder.build -- conflictos de plazo entre documentos", () => {
  it("dos plazos DISTINTOS para el mismo tema (bases vs. aclaración) generan un Conflict escalado y AMBOS ítems quedan 'bloqueado'", async () => {
    const bases = doc("bases", "La entrega de proposiciones será a más tardar el 15 de diciembre del 2026 a las 18:00 horas.");
    const aclaracion = doc("aclaracion-1", "Se aclara que la entrega de proposiciones será a más tardar el 20 de diciembre del 2026 a las 18:00 horas.");

    const result = await new RequirementMatrixBuilder([new RuleBasedExtractor()]).build([bases, aclaracion]);

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]!.kind).toBe("deadline_mismatch");
    expect(result.conflicts[0]!.status).toBe("escalado");
    const deadlineItems = result.items.filter((i) => i.topicKey === "plazo_entrega_proposiciones");
    expect(deadlineItems.length).toBe(2);
    expect(deadlineItems.every((i) => i.status === "bloqueado")).toBe(true);
  });

  it("deriveSectionKeysFromRequirementMatrix EXCLUYE los ítems bloqueados -- nunca redacta citando un requisito en disputa", async () => {
    const bases = doc("bases", "La entrega de proposiciones será a más tardar el 15 de diciembre del 2026 a las 18:00 horas. El licitante deberá presentar acta constitutiva original.");
    const aclaracion = doc("aclaracion-1", "Se aclara que la entrega de proposiciones será a más tardar el 20 de diciembre del 2026 a las 18:00 horas.");

    const result = await new RequirementMatrixBuilder([new RuleBasedExtractor()]).build([bases, aclaracion]);
    const sectionKeys = deriveSectionKeysFromRequirementMatrix(result.items);

    // El acta constitutiva (tipo "legal", no bloqueada) SÍ produce sección;
    // el plazo en disputa (tipo "administrativo", bloqueado) NUNCA la produce.
    expect(sectionKeys).toContain("legal");
    const blockedTypes = result.items.filter((i) => i.status === "bloqueado").map((i) => i.type);
    for (const t of blockedTypes) {
      // Si por coincidencia ningún otro ítem no-bloqueado cubre ese type,
      // deriveSectionKeys no debe incluir su sectionKey solo por el bloqueado.
      const anyUnblockedOfSameType = result.items.some((i) => i.type === t && i.status !== "bloqueado");
      if (!anyUnblockedOfSameType) {
        const sectionKeyByType: Record<string, string> = { tecnico: "tecnica", economico: "economica", legal: "legal", administrativo: "administrativa", anexo: "anexos" };
        expect(sectionKeys).not.toContain(sectionKeyByType[t]);
      }
    }
  });

  it("dos documentos con la MISMA fecha para el mismo tema no generan conflicto", async () => {
    const bases = doc("bases", "La entrega de proposiciones será a más tardar el 15 de diciembre del 2026 a las 18:00 horas.");
    const aclaracion = doc("aclaracion-1", "Se confirma que la entrega de proposiciones será a más tardar el 15 de diciembre del 2026 a las 18:00 horas.");
    const result = await new RequirementMatrixBuilder([new RuleBasedExtractor()]).build([bases, aclaracion]);
    expect(result.conflicts).toEqual([]);
  });
});

describe("detectConflicts -- obligatoriedad contradictoria", () => {
  it("dos ítems del mismo topicKey con obligatoriedad distinta generan un Conflict", () => {
    const base: Omit<RequirementItem, "id" | "obligatoriedad"> = {
      text: "x",
      source: { documentId: "d1", documentLabel: "d1", page: 1 },
      type: "legal",
      responsibleRole: "legal",
      deadline: null,
      requiredEvidence: [],
      status: "pendiente",
      extractedBy: "rule",
      topicKey: "garantia_cumplimiento",
    };
    const items: RequirementItem[] = [
      { ...base, id: "a", obligatoriedad: "obligatorio" },
      { ...base, id: "b", obligatoriedad: "opcional" },
    ];
    const conflicts = detectConflicts(items);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]!.kind).toBe("obligatoriedad_mismatch");
  });
});

import { describe, expect, it } from "vitest";
import { buildInconformidadContent, computeInconformidadDeadline, INCONFORMIDAD_DISCLAIMER, LAASSP_ART_95_INCONFORMIDAD_BUSINESS_DAYS, LAASSP_ART_95_INCONFORMIDAD_TRATADOS_BUSINESS_DAYS } from "../src/inconformidad.ts";

describe("inconformidad.ts -- redactor de inconformidades, puramente basado en plantillas/reglas (REQ-053)", () => {
  it("computeInconformidadDeadline: 6 días hábiles por defecto, 10 bajo tratados", () => {
    const normal = computeInconformidadDeadline("2026-01-05", false);
    expect(normal.businessDays).toBe(LAASSP_ART_95_INCONFORMIDAD_BUSINESS_DAYS);
    const tratados = computeInconformidadDeadline("2026-01-05", true);
    expect(tratados.businessDays).toBe(LAASSP_ART_95_INCONFORMIDAD_TRATADOS_BUSINESS_DAYS);
    expect(tratados.dueDate > normal.dueDate).toBe(true);
  });

  it("buildInconformidadContent cita Art. 49 y Art. 95 LAASSP con jurisdicción y fecha DOF", () => {
    const content = buildInconformidadContent({
      falloNotifiedOn: "2026-01-05",
      bajoTratados: false,
      hechos: ["El fallo desechó nuestra propuesta por un requisito no obligatorio."],
      agravios: ["El acto viola el principio de máxima concurrencia."],
      pruebas: ["Copia del fallo publicado."],
    });
    expect(content.fundamentos).toHaveLength(2);
    expect(content.fundamentos.map((f) => f.articulo)).toEqual(["Art. 49", "Art. 95"]);
    for (const f of content.fundamentos) {
      expect(f.ley).toBe("LAASSP nueva");
      expect(f.jurisdiccion).toBe("Federal");
      expect(f.fechaDof).toBe("2025-04-16");
    }
  });

  it("guardrail anti-frivolidad determinista: sin pruebas -> viabilidad baja", () => {
    const content = buildInconformidadContent({ falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h"], agravios: ["a1", "a2"], pruebas: [] });
    expect(content.viability).toBe("baja");
    expect(content.viabilityRecommendation).toMatch(/No se registró ninguna prueba/);
  });

  it("guardrail anti-frivolidad: menos pruebas que agravios -> viabilidad media", () => {
    const content = buildInconformidadContent({ falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h"], agravios: ["a1", "a2"], pruebas: ["p1"] });
    expect(content.viability).toBe("media");
  });

  it("guardrail anti-frivolidad: al menos una prueba por agravio -> viabilidad alta", () => {
    const content = buildInconformidadContent({ falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h"], agravios: ["a1", "a2"], pruebas: ["p1", "p2"] });
    expect(content.viability).toBe("alta");
  });

  it("NUNCA bloquea la generación -- incluso con viabilidad baja, el contenido se produce completo", () => {
    const content = buildInconformidadContent({ falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h"], agravios: ["a"], pruebas: [] });
    expect(content.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(content.plazo.dueDate).toBeTruthy();
  });

  it("el hash del contenido es determinista y reproducible para el mismo input", () => {
    const input = { falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h1", "h2"], agravios: ["a1"], pruebas: ["p1"] } as const;
    const a = buildInconformidadContent(input);
    const b = buildInconformidadContent(input);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("el hash cambia si cambia cualquier insumo del contenido", () => {
    const base = buildInconformidadContent({ falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h1"], agravios: ["a1"], pruebas: ["p1"] });
    const changed = buildInconformidadContent({ falloNotifiedOn: "2026-01-05", bajoTratados: false, hechos: ["h1 distinto"], agravios: ["a1"], pruebas: ["p1"] });
    expect(base.contentHash).not.toBe(changed.contentHash);
  });

  it("el disclaimer deja explícito que es un borrador que requiere revisión de abogado y nunca se presenta desde el sistema", () => {
    expect(INCONFORMIDAD_DISCLAIMER).toMatch(/BORRADOR/);
    expect(INCONFORMIDAD_DISCLAIMER).toMatch(/NO se presenta ante ninguna autoridad/);
  });
});

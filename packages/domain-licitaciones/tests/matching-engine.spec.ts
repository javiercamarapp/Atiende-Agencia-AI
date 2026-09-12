// Pruebas de dominio, puras (sin IO) -- mismos casos que el motor origen
// (licitaciones/packages/sources/src/matching/matching-engine.ts) verificaba:
// criterio ausente no penaliza, exclusión dura fuerza score 0, "no_evaluable"
// nunca se redondea a "cumple", pesos se redistribuyen correctamente.
import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, MatchingEngine, buildMatchInputsSnapshot, computeMatchInputsHash, normalizeText, normalizedIncludes, toOrganizationMatchingProfile } from "../src/matching-engine.ts";
import type { MatchingProfileRecord, TenderRecord } from "../src/types.ts";

function tender(overrides: Partial<TenderRecord> = {}): TenderRecord {
  return {
    id: "tender-1",
    organizationId: "org-1",
    title: "Servicio de mantenimiento de flotilla vehicular",
    submissionDeadline: "2026-12-01T18:00:00-06:00",
    updatedAt: "2026-01-01T00:00:00Z",
    source: "manual",
    externalId: "LA-00-000/2026",
    contractingBody: "Secretaría de Movilidad",
    cpvCodes: ["50111100"],
    budgetAmount: 500_000,
    currency: "MXN",
    state: "Jalisco",
    procedureTypeRaw: "Licitación pública nacional",
    status: "discovered",
    ...overrides,
  };
}

function profileRecord(overrides: Partial<MatchingProfileRecord> = {}): MatchingProfileRecord {
  return {
    organizationId: "org-1",
    keywords: [],
    excludedKeywords: [],
    classifierCodes: [],
    entities: [],
    states: [],
    budgetMin: null,
    budgetMax: null,
    updatedBy: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("normalizeText/normalizedIncludes -- utilidades deterministas de texto", () => {
  it("quita acentos, minúsculas, colapsa espacios", () => {
    expect(normalizeText("Íñigo   Sánchez!!")).toBe("inigo sanchez");
  });

  it("normalizedIncludes compara sin acentos ni mayúsculas", () => {
    expect(normalizedIncludes("Mantenimiento de Flotilla", "flotilla")).toBe(true);
    expect(normalizedIncludes("Mantenimiento de Flotilla", "camión")).toBe(false);
  });
});

describe("MatchingEngine.score -- perfil sin ningún criterio configurado", () => {
  it("score 0 con explicación explícita, eligibility no_evaluable (nunca 'cumple' por defecto)", () => {
    const result = new MatchingEngine().score(tender(), toOrganizationMatchingProfile(null, "org-1"));
    expect(result.score).toBe(0);
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]!.explanation).toMatch(/no define ningún criterio/);
    expect(result.eligibility.status).toBe("no_evaluable");
    expect(result.eligibility.criteria).toHaveLength(0);
  });
});

describe("MatchingEngine.score -- un criterio sin configurar no participa ni penaliza (pesos se redistribuyen)", () => {
  it("solo 'keywords' configurado -> el 100% del peso recae en keywords, no en 30/100", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ keywords: ["flotilla"] }), "org-1");
    const result = new MatchingEngine().score(tender(), profile);
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]!.criterion).toBe("keywords");
    expect(result.criteria[0]!.maxScore).toBe(100); // normalizado al 100%, no al peso nominal (30) del criterio.
    expect(result.score).toBe(100); // única palabra clave configurada, coincide -> score pleno.
  });

  it("dos organizaciones con perfiles distintos pero AMBAS con match perfecto en sus criterios configurados obtienen 100, sin importar cuántos criterios configuraron", () => {
    const soloKeywords = toOrganizationMatchingProfile(profileRecord({ keywords: ["flotilla"] }), "org-1");
    const keywordsYEntidad = toOrganizationMatchingProfile(profileRecord({ keywords: ["flotilla"], entities: ["Secretaría de Movilidad"] }), "org-1");
    const t = tender();
    expect(new MatchingEngine().score(t, soloKeywords).score).toBe(100);
    expect(new MatchingEngine().score(t, keywordsYEntidad).score).toBe(100);
  });

  it("pesos por defecto expuestos tal cual el origen (classifiers:35, keywords:30, budget:15, entities:10, states:10)", () => {
    expect(DEFAULT_WEIGHTS).toEqual({ classifiers: 35, keywords: 30, budget: 15, entities: 10, states: 10 });
  });

  it("con classifiers+keywords configurados, el score de cada criterio se escala a peso/totalWeight*100 (35/65 y 30/65)", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ classifierCodes: ["99999999"], keywords: ["flotilla"] }), "org-1");
    const result = new MatchingEngine().score(tender(), profile); // clasificador NO coincide, keyword SÍ.
    const classifiers = result.criteria.find((c) => c.criterion === "classifiers")!;
    const keywords = result.criteria.find((c) => c.criterion === "keywords")!;
    // El motor redondea a 2 decimales (round2) -- se compara con esa misma precisión.
    expect(classifiers.maxScore).toBeCloseTo((35 / 65) * 100, 2);
    expect(keywords.maxScore).toBeCloseTo((30 / 65) * 100, 2);
    expect(classifiers.score).toBe(0); // no coincide.
    expect(keywords.score).toBeCloseTo((30 / 65) * 100, 2); // coincide pleno.
    expect(result.score).toBeCloseTo((30 / 65) * 100, 2);
  });
});

describe("MatchingEngine.score -- criterio 'entities' con dato ausente en la convocatoria", () => {
  it("contractingBody ausente -> score neutro 0.5 (mismo tratamiento que budget/states ausentes), nunca 0", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ entities: ["Secretaría de Movilidad"] }), "org-1");
    const result = new MatchingEngine().score(tender({ contractingBody: undefined }), profile);
    const entities = result.criteria.find((c) => c.criterion === "entities")!;
    expect(entities.score).toBeCloseTo(50, 2); // 0.5/1 normalizado a maxScore 100.
    expect(entities.explanation).toMatch(/no especifica entidad convocante/);
  });
});

describe("MatchingEngine.score -- clasificador por PREFIJO JERÁRQUICO", () => {
  it("un prefijo del perfil que es prefijo del código de la convocatoria (o viceversa) cuenta como match", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ classifierCodes: ["5011"] }), "org-1");
    const result = new MatchingEngine().score(tender({ cpvCodes: ["50111100"] }), profile);
    const classifiers = result.criteria.find((c) => c.criterion === "classifiers")!;
    expect(classifiers.score).toBeGreaterThan(0);
  });

  it("convocatoria sin ningún cpvCode -> criterio classifiers en 0, explícitamente 'no evaluable' en la explicación", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ classifierCodes: ["5011"] }), "org-1");
    const result = new MatchingEngine().score(tender({ cpvCodes: [] }), profile);
    const classifiers = result.criteria.find((c) => c.criterion === "classifiers")!;
    expect(classifiers.score).toBe(0);
    expect(classifiers.explanation).toMatch(/no evaluable/);
  });
});

describe("MatchingEngine.score -- exclusión dura por palabra clave excluida", () => {
  it("anula el match a score 0 SIN IMPORTAR el resto de criterios, aunque todos los demás coincidan perfecto", () => {
    const profile = toOrganizationMatchingProfile(
      profileRecord({ keywords: ["flotilla"], classifierCodes: ["5011"], entities: ["Secretaría de Movilidad"], states: ["Jalisco"], excludedKeywords: ["mantenimiento"] }),
      "org-1",
    );
    const result = new MatchingEngine().score(tender(), profile);
    expect(result.score).toBe(0);
    expect(result.criteria.some((c) => c.score === -100)).toBe(true);
  });
});

describe("MatchingEngine.score -- eligibility (elegibilidad) SEPARADA de score (relevancia)", () => {
  it("presupuesto ausente en la convocatoria -> 'no_evaluable', NUNCA 'cumple' por omisión", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ budgetMin: 100, budgetMax: 1_000_000 }), "org-1");
    const result = new MatchingEngine().score(tender({ budgetAmount: null }), profile);
    const budgetCriterion = result.eligibility.criteria.find((c) => c.requirement === "budget")!;
    expect(budgetCriterion.status).toBe("no_evaluable");
    expect(result.eligibility.status).toBe("no_evaluable");
  });

  it("presupuesto dentro del rango -> 'cumple'; fuera de rango -> 'no_cumple' (con prioridad sobre no_evaluable)", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ budgetMin: 100, budgetMax: 1_000, states: ["Jalisco"] }), "org-1");
    const dentro = new MatchingEngine().score(tender({ budgetAmount: 500, state: null }), profile);
    // budget cumple, states no_evaluable (convocatoria sin estado) -> agregado no_evaluable (nunca se "redondea" a cumple).
    expect(dentro.eligibility.criteria.find((c) => c.requirement === "budget")!.status).toBe("cumple");
    expect(dentro.eligibility.status).toBe("no_evaluable");

    const fuera = new MatchingEngine().score(tender({ budgetAmount: 999_999, state: "Jalisco" }), profile);
    expect(fuera.eligibility.criteria.find((c) => c.requirement === "budget")!.status).toBe("no_cumple");
    expect(fuera.eligibility.status).toBe("no_cumple"); // no_cumple tiene prioridad sobre cualquier otro estado.
  });

  it("estado no configurado en el perfil de cobertura -> 'no_cumple'; estado ausente en la convocatoria -> 'no_evaluable'", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ states: ["Jalisco", "Nuevo León"] }), "org-1");
    const fueraDeCobertura = new MatchingEngine().score(tender({ state: "Yucatán" }), profile);
    expect(fueraDeCobertura.eligibility.criteria.find((c) => c.requirement === "states")!.status).toBe("no_cumple");

    const sinEstado = new MatchingEngine().score(tender({ state: null }), profile);
    expect(sinEstado.eligibility.criteria.find((c) => c.requirement === "states")!.status).toBe("no_evaluable");
  });

  it("sin NINGÚN criterio de elegibilidad configurado -> agregado 'no_evaluable' (nunca 'cumple' por defecto)", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ keywords: ["flotilla"] }), "org-1"); // solo relevancia, cero elegibilidad.
    const result = new MatchingEngine().score(tender(), profile);
    expect(result.eligibility.criteria).toHaveLength(0);
    expect(result.eligibility.status).toBe("no_evaluable");
  });

  it("un score alto NUNCA implica eligibility 'cumple' -- son valores independientes", () => {
    const profile = toOrganizationMatchingProfile(profileRecord({ keywords: ["flotilla"], budgetMin: 100, budgetMax: 1000 }), "org-1");
    const result = new MatchingEngine().score(tender({ budgetAmount: 999_999 }), profile); // keyword coincide (score alto), presupuesto fuera de rango.
    expect(result.score).toBeGreaterThan(0);
    expect(result.eligibility.status).toBe("no_cumple");
  });
});

describe("computeMatchInputsHash -- determinista y sensible a cambios", () => {
  it("mismos insumos -> mismo hash", () => {
    const t = tender();
    const p = profileRecord();
    const hash1 = computeMatchInputsHash(buildMatchInputsSnapshot(t, p));
    const hash2 = computeMatchInputsHash(buildMatchInputsSnapshot(t, p));
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("un cambio en el presupuesto de la convocatoria cambia el hash", () => {
    const p = profileRecord();
    const hashA = computeMatchInputsHash(buildMatchInputsSnapshot(tender({ budgetAmount: 500_000 }), p));
    const hashB = computeMatchInputsHash(buildMatchInputsSnapshot(tender({ budgetAmount: 600_000 }), p));
    expect(hashA).not.toBe(hashB);
  });

  it("perfil null (organización sin configurar) produce un hash distinto de uno con perfil configurado", () => {
    const t = tender();
    const hashSinPerfil = computeMatchInputsHash(buildMatchInputsSnapshot(t, null));
    const hashConPerfil = computeMatchInputsHash(buildMatchInputsSnapshot(t, profileRecord({ keywords: ["flotilla"] })));
    expect(hashSinPerfil).not.toBe(hashConPerfil);
  });
});

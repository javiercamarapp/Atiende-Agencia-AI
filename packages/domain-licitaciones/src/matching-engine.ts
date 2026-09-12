// MatchingEngine — Fase 3 §4: port ~literal de
// licitaciones/packages/sources/src/matching/{matching-engine,types}.ts del
// repo origen (leídos completos para este puerto). Función pura, sin IO, sin
// LLM: `score(record, profile)` es determinista y testeable con fixtures,
// igual que `domain-rentas/src/finanzas/conciliacion.ts`.
//
// Adaptaciones deliberadas frente al origen (ninguna cambia el
// comportamiento observable de las reglas duras que este motor debe
// preservar, solo el vocabulario de campos):
//  - El origen matchea contra `record.classifiers: Classifier[]` (con scheme
//    CUCoP/UNSPSC/CPV); domain-licitaciones no portó ese tipo compuesto (ver
//    diseño §3) y usa `cpvCodes: string[]` -- la regla de coincidencia por
//    PREFIJO JERÁRQUICO se conserva idéntica, solo el shape del dato cambia.
//  - El origen usa `record.contractingEntity: string` (obligatorio);
//    domain-licitaciones lo modela como `contractingBody: string | null`
//    (una convocatoria capturada a mano puede no tener ese dato todavía) --
//    se trata como "ausente" (mismo tratamiento que el origen ya le daba a
//    `state`, que SÍ era opcional en el origen).
//  - `tenderKey` (`source:externalId`, usado en el origen para deduplicar
//    entre conectores de un mismo pool multi-organización) no aplica aquí:
//    Fase 3 §2 excluye explícitamente esa arquitectura (licitaciones sigue
//    siendo estrictamente por-organización) -- `MatchResult` identifica la
//    convocatoria por `tenderId` (el uuid real de `licitaciones.tender`).
import type { MatchingProfileRecord, TenderRecord } from "./types.ts";
import { sha256Hex } from "./types.ts";

// ---------------------------------------------------------------------------
// Utilidades de normalización de texto -- port literal de
// licitaciones/packages/sources/src/util/text.ts (deterministas y puras, sin
// dependencias externas, para que el matching sea reproducible).
// ---------------------------------------------------------------------------

/** Quita acentos/diacríticos conservando la letra base (á -> a, ñ -> n). */
function stripAccents(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ñ/g, "n")
    .replace(/Ñ/g, "N");
}

/** Normaliza texto para comparación difusa: minúsculas, sin acentos, sin puntuación, espacios colapsados. */
export function normalizeText(input: string): string {
  return stripAccents(input.toLowerCase())
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `true` si `needle` normalizado aparece como subcadena de `haystack` normalizado. */
export function normalizedIncludes(haystack: string, needle: string): boolean {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!n) return false;
  return h.includes(n);
}

// ---------------------------------------------------------------------------
// Tipos -- port literal de matching/types.ts del origen.
// ---------------------------------------------------------------------------

export interface BudgetRange {
  min?: number;
  max?: number;
}

/**
 * Perfil de una organización contra el que se evalúan sus convocatorias.
 * Todos los campos son opcionales: un criterio sin configurar simplemente no
 * participa en el score (nunca penaliza). Se construye a partir de
 * `MatchingProfileRecord` (persistencia) vía `toOrganizationMatchingProfile`.
 */
export interface OrganizationMatchingProfile {
  organizationId: string;
  classifierCodes?: string[];
  keywords?: string[];
  excludedKeywords?: string[];
  /** Entidades convocantes preferentes (coincidencia normalizada, subcadena). */
  entities?: string[];
  budgetRange?: BudgetRange;
  /** Estados (entidades federativas) donde la organización opera. */
  states?: string[];
}

/** Convierte el registro persistido (arreglos siempre presentes, posiblemente vacíos) al perfil que consume el motor (arreglos vacíos = criterio no configurado). */
export function toOrganizationMatchingProfile(record: MatchingProfileRecord | null, organizationId: string): OrganizationMatchingProfile {
  if (!record) return { organizationId };
  return {
    organizationId,
    classifierCodes: record.classifierCodes.length > 0 ? [...record.classifierCodes] : undefined,
    keywords: record.keywords.length > 0 ? [...record.keywords] : undefined,
    excludedKeywords: record.excludedKeywords.length > 0 ? [...record.excludedKeywords] : undefined,
    entities: record.entities.length > 0 ? [...record.entities] : undefined,
    states: record.states.length > 0 ? [...record.states] : undefined,
    budgetRange: record.budgetMin !== null || record.budgetMax !== null ? { min: record.budgetMin ?? undefined, max: record.budgetMax ?? undefined } : undefined,
  };
}

export interface MatchCriterionResult {
  criterion: "classifiers" | "keywords" | "budget" | "entities" | "states";
  score: number;
  maxScore: number;
  explanation: string;
}

/**
 * Estado de cumplimiento de UN requisito duro de elegibilidad -- distinto de
 * `MatchCriterionResult`/`score` (que mide relevancia/afinidad temática).
 * "no_evaluable" es el estado OBLIGATORIO cuando falta el dato necesario para
 * decidir -- nunca se infiere "cumple" ni "no_cumple" por ausencia de dato.
 */
export type EligibilityStatus = "cumple" | "no_cumple" | "no_evaluable";

export interface EligibilityCriterionResult {
  requirement: "budget" | "states" | "excludedKeywords";
  status: EligibilityStatus;
  explanation: string;
}

export interface EligibilityResult {
  /**
   * "no_cumple" si CUALQUIERA no cumple (prioridad); si no, "no_evaluable"
   * si CUALQUIERA no es evaluable (incluye el caso sin ningún criterio
   * configurado: nunca se asume "cumple" por defecto); "cumple" solo si
   * todos los criterios configurados cumplen.
   */
  status: EligibilityStatus;
  criteria: EligibilityCriterionResult[];
}

/**
 * `score`/`criteria` miden RELEVANCIA (afinidad temática/léxica, 0-100).
 * `eligibility` mide CUMPLIMIENTO DE REQUISITOS DUROS como un valor
 * INDEPENDIENTE. Un consumidor NUNCA debe inferir elegibilidad a partir de
 * `score` -- debe leer `eligibility` explícitamente.
 */
export interface MatchResult {
  tenderId: string;
  score: number;
  criteria: MatchCriterionResult[];
  eligibility: EligibilityResult;
}

/**
 * Punto de extensión para enriquecer la explicación con LLM en una fase
 * posterior (fuera de alcance de Fase 3, ver diseño §4: "se porta como tipo
 * pero no se implementa"). El score en sí SIEMPRE debe seguir siendo
 * determinista -- el LLM solo puede narrar, nunca recalcular.
 */
export interface MatchExplanationEnricher {
  enrich(result: MatchResult, record: TenderRecord): Promise<string>;
}

export interface MatchWeights {
  classifiers: number;
  keywords: number;
  budget: number;
  entities: number;
  states: number;
}

export const DEFAULT_WEIGHTS: MatchWeights = {
  classifiers: 35,
  keywords: 30,
  budget: 15,
  entities: 10,
  states: 10,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Motor de matching determinista: perfil de organización -> score 0-100 con
 * explicación por criterio. Solo participan en el score los criterios que el
 * perfil define; los pesos de los criterios ausentes se redistribuyen
 * proporcionalmente entre los presentes, para no penalizar a una
 * organización que aún no configuró todos los criterios (permite lanzar
 * Fase 3 con perfiles incompletos sin que el score colapse a 0).
 */
export class MatchingEngine {
  private readonly weights: MatchWeights;

  constructor(weights: Partial<MatchWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  score(record: TenderRecord, profile: OrganizationMatchingProfile): MatchResult {
    const eligibility = this.evaluateEligibility(record, profile);
    const applicable: Array<{ criterion: MatchCriterionResult["criterion"]; weight: number; compute: () => MatchCriterionResult }> = [];

    if (profile.classifierCodes && profile.classifierCodes.length > 0) {
      applicable.push({ criterion: "classifiers", weight: this.weights.classifiers, compute: () => this.scoreClassifiers(record, profile) });
    }
    if (profile.keywords && profile.keywords.length > 0) {
      applicable.push({ criterion: "keywords", weight: this.weights.keywords, compute: () => this.scoreKeywords(record, profile) });
    }
    if (profile.budgetRange && (profile.budgetRange.min !== undefined || profile.budgetRange.max !== undefined)) {
      applicable.push({ criterion: "budget", weight: this.weights.budget, compute: () => this.scoreBudget(record, profile) });
    }
    if (profile.entities && profile.entities.length > 0) {
      applicable.push({ criterion: "entities", weight: this.weights.entities, compute: () => this.scoreEntities(record, profile) });
    }
    if (profile.states && profile.states.length > 0) {
      applicable.push({ criterion: "states", weight: this.weights.states, compute: () => this.scoreStates(record, profile) });
    }

    if (applicable.length === 0) {
      return {
        tenderId: record.id,
        score: 0,
        criteria: [{ criterion: "keywords", score: 0, maxScore: 0, explanation: "El perfil de la organización no define ningún criterio de matching." }],
        eligibility,
      };
    }

    const totalWeight = applicable.reduce((sum, a) => sum + a.weight, 0);
    const criteria: MatchCriterionResult[] = [];
    let totalScore = 0;

    for (const { weight, compute } of applicable) {
      const normalizedWeight = (weight / totalWeight) * 100;
      const raw = compute();
      const scaledScore = raw.maxScore === 0 ? 0 : (raw.score / raw.maxScore) * normalizedWeight;
      criteria.push({ ...raw, maxScore: normalizedWeight, score: round2(scaledScore) });
      totalScore += scaledScore;
    }

    // Exclusión dura: palabras clave excluidas anulan el match sin importar el resto.
    if (profile.excludedKeywords?.some((kw) => normalizedIncludes(record.title, kw))) {
      criteria.push({ criterion: "keywords", score: -100, maxScore: 0, explanation: "El título contiene una palabra clave excluida por la organización." });
      return { tenderId: record.id, score: 0, criteria, eligibility };
    }

    return { tenderId: record.id, score: round2(clamp(totalScore, 0, 100)), criteria, eligibility };
  }

  /**
   * Evalúa elegibilidad: requisitos duros configurados por el perfil --
   * presupuesto, cobertura geográfica y exclusiones -- como un valor
   * INDEPENDIENTE de la relevancia/score léxico. Dato ausente en la
   * convocatoria SIEMPRE produce "no_evaluable" para ese criterio, nunca
   * "cumple" ni "no_cumple" inventados.
   */
  private evaluateEligibility(record: TenderRecord, profile: OrganizationMatchingProfile): EligibilityResult {
    const criteria: EligibilityCriterionResult[] = [];
    const budgetAmount = record.budgetAmount ?? undefined;
    const currency = record.currency ?? "MXN";
    const state = record.state ?? undefined;

    if (profile.budgetRange && (profile.budgetRange.min !== undefined || profile.budgetRange.max !== undefined)) {
      if (budgetAmount === undefined || budgetAmount === null) {
        criteria.push({
          requirement: "budget",
          status: "no_evaluable",
          explanation: "La convocatoria no publica presupuesto/monto estimado; no es posible determinar si cumple el rango configurado por la organización (dato ausente nunca se marca elegible por defecto).",
        });
      } else {
        const { min, max } = profile.budgetRange;
        const within = (min === undefined || budgetAmount >= min) && (max === undefined || budgetAmount <= max);
        criteria.push({
          requirement: "budget",
          status: within ? "cumple" : "no_cumple",
          explanation: within
            ? `Presupuesto ${budgetAmount} ${currency} dentro del rango configurado [${min ?? "-∞"}, ${max ?? "∞"}].`
            : `Presupuesto ${budgetAmount} ${currency} fuera del rango configurado [${min ?? "-∞"}, ${max ?? "∞"}].`,
        });
      }
    }

    if (profile.states && profile.states.length > 0) {
      if (!state) {
        criteria.push({ requirement: "states", status: "no_evaluable", explanation: "La convocatoria no especifica entidad federativa; no es posible determinar si cae dentro de la cobertura geográfica configurada." });
      } else {
        const matched = profile.states.some((s) => normalizeText(s) === normalizeText(state));
        criteria.push({
          requirement: "states",
          status: matched ? "cumple" : "no_cumple",
          explanation: matched ? `El estado "${state}" está dentro de la cobertura geográfica configurada.` : `El estado "${state}" no está dentro de la cobertura geográfica configurada (${profile.states.join(", ")}).`,
        });
      }
    }

    if (profile.excludedKeywords && profile.excludedKeywords.length > 0) {
      const hit = profile.excludedKeywords.find((kw) => normalizedIncludes(record.title, kw));
      criteria.push({
        requirement: "excludedKeywords",
        status: hit ? "no_cumple" : "cumple",
        explanation: hit ? `El título contiene la palabra clave excluida "${hit}" configurada por la organización.` : "El título no contiene ninguna palabra clave excluida por la organización.",
      });
    }

    return { status: aggregateEligibility(criteria), criteria };
  }

  private scoreClassifiers(record: TenderRecord, profile: OrganizationMatchingProfile): MatchCriterionResult {
    const wanted = profile.classifierCodes ?? [];
    const codes = record.cpvCodes ?? [];
    if (codes.length === 0) {
      return { criterion: "classifiers", score: 0, maxScore: 1, explanation: "La convocatoria no trae clasificador (CPV); no evaluable." };
    }
    // Coincidencia por PREFIJO JERÁRQUICO (mismo criterio que el origen):
    // "43" (perfil) empareja con "43211500" (convocatoria) y viceversa.
    const matches = codes.filter((c) => wanted.some((w) => c.startsWith(w) || w.startsWith(c)));
    if (matches.length > 0) {
      return { criterion: "classifiers", score: 1, maxScore: 1, explanation: `Clasificador ${matches.join(", ")} coincide con el perfil (${wanted.join(", ")}).` };
    }
    return { criterion: "classifiers", score: 0, maxScore: 1, explanation: `Ningún clasificador (${codes.join(", ")}) coincide con el perfil (${wanted.join(", ")}).` };
  }

  private scoreKeywords(record: TenderRecord, profile: OrganizationMatchingProfile): MatchCriterionResult {
    const keywords = profile.keywords ?? [];
    const haystack = `${record.title} ${record.procedureTypeRaw ?? ""}`;
    const matched = keywords.filter((kw) => normalizedIncludes(haystack, kw));
    return {
      criterion: "keywords",
      score: matched.length,
      maxScore: keywords.length,
      explanation: matched.length > 0 ? `Coincidieron ${matched.length}/${keywords.length} palabras clave: ${matched.join(", ")}.` : `Ninguna de las ${keywords.length} palabras clave del perfil aparece en el título.`,
    };
  }

  private scoreBudget(record: TenderRecord, profile: OrganizationMatchingProfile): MatchCriterionResult {
    const range = profile.budgetRange!;
    const amount = record.budgetAmount ?? undefined;
    if (amount === undefined || amount === null) {
      return { criterion: "budget", score: 0.5, maxScore: 1, explanation: "Presupuesto no disponible en la convocatoria; se asigna score neutro." };
    }
    const withinMin = range.min === undefined || amount >= range.min;
    const withinMax = range.max === undefined || amount <= range.max;
    if (withinMin && withinMax) {
      return { criterion: "budget", score: 1, maxScore: 1, explanation: `Presupuesto ${amount} ${record.currency ?? "MXN"} dentro del rango configurado.` };
    }
    return { criterion: "budget", score: 0, maxScore: 1, explanation: `Presupuesto ${amount} ${record.currency ?? "MXN"} fuera del rango configurado [${range.min ?? "-∞"}, ${range.max ?? "∞"}].` };
  }

  private scoreEntities(record: TenderRecord, profile: OrganizationMatchingProfile): MatchCriterionResult {
    const entities = profile.entities ?? [];
    const contractingBody = record.contractingBody ?? undefined;
    if (!contractingBody) {
      return { criterion: "entities", score: 0, maxScore: 1, explanation: "La convocatoria no especifica entidad convocante; no evaluable." };
    }
    const matched = entities.find((e) => normalizeText(contractingBody).includes(normalizeText(e)));
    return {
      criterion: "entities",
      score: matched ? 1 : 0,
      maxScore: 1,
      explanation: matched ? `La entidad convocante "${contractingBody}" coincide con "${matched}" del perfil.` : `La entidad convocante "${contractingBody}" no está en la lista de interés del perfil.`,
    };
  }

  private scoreStates(record: TenderRecord, profile: OrganizationMatchingProfile): MatchCriterionResult {
    const states = profile.states ?? [];
    const state = record.state ?? undefined;
    if (!state) {
      return { criterion: "states", score: 0.5, maxScore: 1, explanation: "La convocatoria no especifica entidad federativa; score neutro." };
    }
    const matched = states.some((s) => normalizeText(s) === normalizeText(state));
    return {
      criterion: "states",
      score: matched ? 1 : 0,
      maxScore: 1,
      explanation: matched ? `El estado "${state}" está en la lista de cobertura del perfil.` : `El estado "${state}" no está en la lista de cobertura del perfil (${states.join(", ")}).`,
    };
  }
}

/**
 * Agrega el resultado de todos los criterios de elegibilidad configurados:
 * "no_cumple" tiene prioridad; si ninguno incumple pero al menos uno es
 * "no_evaluable", el agregado es "no_evaluable" (nunca se "redondea" a
 * "cumple" con datos incompletos); "cumple" solo si TODOS cumplen. Sin
 * ningún criterio configurado, el agregado es "no_evaluable" (nunca "cumple"
 * por defecto ante la ausencia total de configuración).
 */
function aggregateEligibility(criteria: EligibilityCriterionResult[]): EligibilityStatus {
  if (criteria.length === 0) return "no_evaluable";
  if (criteria.some((c) => c.status === "no_cumple")) return "no_cumple";
  if (criteria.some((c) => c.status === "no_evaluable")) return "no_evaluable";
  return "cumple";
}

// ---------------------------------------------------------------------------
// Sellado de insumos de la decisión Go/No-Go (§7 del diseño). Deliberadamente
// NO reutiliza `sealed-inputs.ts::computeInputsHash`: ese módulo está atado
// por diseño a la forma FIJA de `ExpedienteInputs` (tenderVersionHash +
// companyProfileHash + companyDocuments + rates + templates), un contexto
// acotado distinto (aprobar el EXPEDIENTE completo, con su propio símbolo
// privado de sellado vía WeakSet) que no tiene ningún significado para "qué
// datos vio quien decidió go/no-go". En vez de forzar los campos de matching
// dentro de ese molde ajeno, este hash usa la MISMA técnica de base
// (`sha256Hex` sobre una serialización canónica, de types.ts) para el mismo
// objetivo de evidencia -- un registro tamper-evident de los insumos EXACTOS
// (convocatoria + perfil) que produjeron el `MatchResult` sellado, sin la
// ceremonia de sellado por símbolo (innecesaria aquí: el hash nunca se
// recibe del cliente, siempre se recalcula server-side en el momento de
// decidir -- ver goNoGo.ts).
// ---------------------------------------------------------------------------

export interface MatchInputsSnapshot {
  readonly tenderId: string;
  readonly tenderUpdatedAt: string;
  readonly tenderFields: {
    readonly source: string | undefined;
    readonly externalId: string | null | undefined;
    readonly contractingBody: string | null | undefined;
    readonly cpvCodes: readonly string[] | undefined;
    readonly budgetAmount: number | null | undefined;
    readonly currency: string | undefined;
    readonly state: string | null | undefined;
    readonly procedureTypeRaw: string | null | undefined;
  };
  /** `null` si la organización aún no configuró ningún perfil de matching. */
  readonly profile: MatchingProfileRecord | null;
}

export function buildMatchInputsSnapshot(tender: TenderRecord, profile: MatchingProfileRecord | null): MatchInputsSnapshot {
  return {
    tenderId: tender.id,
    tenderUpdatedAt: tender.updatedAt,
    tenderFields: {
      source: tender.source,
      externalId: tender.externalId,
      contractingBody: tender.contractingBody,
      cpvCodes: tender.cpvCodes,
      budgetAmount: tender.budgetAmount,
      currency: tender.currency,
      state: tender.state,
      procedureTypeRaw: tender.procedureTypeRaw,
    },
    profile,
  };
}

/** Hash canónico de un `MatchInputsSnapshot` -- único insumo soportado para el `matchInputsHash` que persiste `licitaciones.go_no_go_decision`. */
export function computeMatchInputsHash(snapshot: MatchInputsSnapshot): string {
  return sha256Hex(snapshot);
}

// RequirementMatrix — Fase 2 pieza 3. Port ~literal de
// licitaciones/packages/expediente/src/requirement-matrix.ts: a partir del
// texto de las bases (y sus anexos/aclaraciones) por página, produce
// `RequirementItem[]` con fuente, obligatoriedad, tipo, responsable, fecha
// límite (America/Mexico_City), evidencia requerida y estado. Cuando dos
// documentos se contradicen (p. ej. dos plazos distintos para el mismo
// tema), se emite un `Conflict` explícito y escalado -- nunca se elige un
// valor en silencio.
//
// Hueco real que esta pieza cierra (ver diseño Fase 2 §1): Fase 1 dejó
// `licitaciones.requirement_item` como SOLO LECTURA -- el comentario de
// cabecera de 001_licitaciones_schema.sql dice literalmente "la extracción
// real vía LLM/reglas... no se porta en esta fase". `RuleBasedExtractor` es
// el primer escritor real de esa tabla.
import { MEXICO_CITY_TZ } from "./types.ts";

export type Obligatoriedad = "obligatorio" | "opcional" | "condicional";

export type RequirementType = "tecnico" | "economico" | "legal" | "administrativo" | "anexo";

export type RequirementStatus = "pendiente" | "en_progreso" | "cumplido" | "bloqueado" | "no_evaluable";

export interface RequirementSource {
  readonly documentId: string;
  readonly documentLabel: string;
  readonly page: number;
  readonly clause?: string;
}

/**
 * Clave de tema usada solo para detección de conflictos entre documentos
 * (p. ej. "plazo_entrega_proposiciones"). No forma parte del contrato
 * público mínimo del ítem, pero se conserva para trazabilidad de por qué se
 * generó un `Conflict`.
 */
export type TopicKey = string;

export interface RequirementItem {
  readonly id: string;
  readonly text: string;
  readonly source: RequirementSource;
  readonly obligatoriedad: Obligatoriedad;
  readonly type: RequirementType;
  /** Rol responsable de cumplir el requisito (p. ej. "legal", "finanzas", "licitador"). */
  readonly responsibleRole: string;
  /** ISO 8601 con offset explícito de America/Mexico_City, o `null` si las bases no fijan fecha para este ítem. */
  readonly deadline: string | null;
  readonly requiredEvidence: readonly string[];
  readonly status: RequirementStatus;
  readonly extractedBy: "rule" | "llm";
  readonly confidence?: number;
  readonly topicKey?: TopicKey;
}

export type ConflictKind = "deadline_mismatch" | "obligatoriedad_mismatch" | "duplicate_ambiguous";

export interface Conflict {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly topicKey: TopicKey;
  readonly description: string;
  readonly items: readonly RequirementItem[];
  readonly status: "abierto" | "escalado";
}

export interface TenderPageText {
  readonly page: number;
  readonly text: string;
}

export interface TenderDocumentText {
  readonly documentId: string;
  readonly documentLabel: string;
  /** Momento en que este documento (versión) se publicó/capturó -- usado solo para trazabilidad; un conflicto NUNCA se resuelve por antigüedad. */
  readonly publishedAt: string;
  readonly pages: readonly TenderPageText[];
}

/** Cualquier extractor determinista o basado en LLM implementa esta interfaz. */
export interface RequirementExtractor {
  readonly name: string;
  readonly extractedBy: "rule" | "llm";
  extract(doc: TenderDocumentText): RequirementItem[] | Promise<RequirementItem[]>;
}

let itemCounter = 0;
export function nextRequirementId(): string {
  itemCounter += 1;
  return `req-${itemCounter}`;
}

let conflictCounter = 0;
function nextConflictId(): string {
  conflictCounter += 1;
  return `conflict-${conflictCounter}`;
}

/**
 * Extractor determinista basado en reglas/patrones. Cubre los patrones más
 * comunes de bases de licitación mexicanas: obligatoriedad léxica, tipo por
 * palabra clave, plazos con fecha explícita, y anexos.
 *
 * Este extractor es intencionalmente conservador: ante ambigüedad, clasifica
 * como `condicional`/sin fecha antes que inventar un valor.
 */
export class RuleBasedExtractor implements RequirementExtractor {
  readonly name = "rule-based-v1";
  readonly extractedBy = "rule" as const;

  extract(doc: TenderDocumentText): RequirementItem[] {
    const items: RequirementItem[] = [];
    for (const page of doc.pages) {
      const sentences = splitSentences(page.text);
      for (const sentence of sentences) {
        const item = this.classifySentence(sentence, doc, page.page);
        if (item) items.push(item);
      }
    }
    return items;
  }

  private classifySentence(sentence: string, doc: TenderDocumentText, page: number): RequirementItem | null {
    const lower = sentence.toLowerCase();
    if (!looksLikeRequirement(lower)) return null;

    const obligatoriedad = classifyObligatoriedad(lower);
    const type = classifyType(lower);
    const responsibleRole = classifyResponsibleRole(type);
    const { deadline, topicKey: deadlineTopic, ambiguousDate } = extractDeadline(lower);
    const requiredEvidence = extractRequiredEvidence(lower, type);
    const topicKey = deadlineTopic ?? classifyTopicKey(lower, type);

    return {
      id: nextRequirementId(),
      text: sentence.trim(),
      source: { documentId: doc.documentId, documentLabel: doc.documentLabel, page, clause: extractClause(sentence) },
      obligatoriedad,
      type,
      responsibleRole,
      deadline,
      requiredEvidence,
      status: "pendiente",
      extractedBy: "rule",
      // Una fecha numérica "DD/MM/AAAA" con día Y mes ambos ≤12 es
      // genuinamente ambigua (podría leerse como MM/DD por error de
      // copiado) -- baja confianza en vez de asumir DD/MM con la misma
      // certeza que una fecha inequívoca (día > 12).
      confidence: ambiguousDate ? 0.5 : 0.7,
      topicKey,
    };
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.;\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
}

const REQUIREMENT_MARKERS = [
  "deberá",
  "deberán",
  "debe presentar",
  "es obligatorio",
  "obligatorio presentar",
  "se requiere",
  "requisito",
  "anexo obligatorio",
  "bajo protesta de decir verdad",
  "carta de",
  "escrito en el que manifieste",
  "fianza de",
  "garantía de",
  "podrá presentar",
  "opcionalmente",
  // Anuncios de plazo: no siempre usan léxico de obligatoriedad, pero fijan
  // una fecha crítica del procedimiento que la matriz debe capturar igual.
  "a más tardar",
  "entrega de proposiciones",
  "presentación de proposiciones",
  "acto de presentación",
  "junta de aclaraciones",
  "fecha límite",
];

function looksLikeRequirement(lower: string): boolean {
  return REQUIREMENT_MARKERS.some((marker) => lower.includes(marker));
}

function classifyObligatoriedad(lower: string): Obligatoriedad {
  if (lower.includes("podrá presentar") || lower.includes("opcionalmente") || lower.includes("de manera opcional")) {
    return "opcional";
  }
  if (lower.includes("en caso de") || lower.includes("cuando aplique") || lower.includes("si el licitante")) {
    return "condicional";
  }
  if (
    lower.includes("deberá") ||
    lower.includes("deberán") ||
    lower.includes("es obligatorio") ||
    lower.includes("obligatorio presentar") ||
    lower.includes("anexo obligatorio")
  ) {
    return "obligatorio";
  }
  return "condicional";
}

export function classifyType(lower: string): RequirementType {
  // Fase 2 (corrección sobre el port literal, ver requirement-matrix.spec.ts):
  // el origen usaba `iva` SIN límites de palabra para detectar el impuesto
  // "IVA" -- como substring, "iva" también aparece dentro de cualquier
  // adjetivo español terminado en "-iva"/"-ivo" (p. ej. "constitutiva",
  // "administrativa", "activa"), clasificando de forma incorrecta como
  // "economico" un requisito puramente legal/administrativo. `\biva\b` exige
  // que "iva" sea una palabra completa (el impuesto), nunca un sufijo.
  if (/(fianza|garantía|precio|tarifa|cotizaci[oó]n|\biva\b|presupuesto|econ[oó]mic)/.test(lower)) return "economico";
  if (/(escritura|poder notarial|acta constitutiva|rfc|opini[oó]n de cumplimiento|32-?d|repse|legal)/.test(lower)) {
    return "legal";
  }
  if (/(anexo)/.test(lower)) return "anexo";
  if (/(experiencia|capacidad t[eé]cnica|especificaci[oó]n t[eé]cnica|metodolog[ií]a|t[eé]cnic)/.test(lower)) {
    return "tecnico";
  }
  return "administrativo";
}

export function classifyResponsibleRole(type: RequirementType): string {
  switch (type) {
    case "economico":
      return "finanzas";
    case "legal":
      return "legal";
    case "tecnico":
      return "licitador";
    case "anexo":
      return "licitador";
    default:
      return "licitador";
  }
}

function classifyTopicKey(lower: string, type: RequirementType): TopicKey | undefined {
  if (lower.includes("fianza de cumplimiento") || lower.includes("garantía de cumplimiento")) {
    return "garantia_cumplimiento";
  }
  if (lower.includes("opinión de cumplimiento") || lower.includes("32-d")) return "opinion_cumplimiento_sat";
  if (lower.includes("acta constitutiva")) return "acta_constitutiva";
  if (type === "anexo" && lower.includes("anexo")) {
    const match = lower.match(/anexo\s+([a-z0-9]+)/);
    if (match) return `anexo_${match[1]}`;
  }
  return undefined;
}

const MESES: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

/**
 * Extrae una fecha límite explícita del texto y la fija a las 23:59:59 en
 * America/Mexico_City (offset fijo -06:00; México eliminó el horario de
 * verano nacional desde 2022, salvo franja fronteriza no aplicable a
 * licitaciones federales). Si el texto no trae una fecha inequívoca, regresa
 * `null` -- nunca se infiere una fecha por defecto.
 */
export function extractDeadline(lower: string): { deadline: string | null; topicKey?: TopicKey; ambiguousDate?: boolean } {
  // Patrón "a más tardar el DD de <mes> de/del AAAA" o "... a las HH:MM horas"
  // ("del" es tan común en español como "de" antes del año -- se aceptan ambos).
  const monthNameMatch = lower.match(/(\d{1,2}) de ([a-záéíóú]+) del? (\d{4})(?: a las (\d{1,2}):(\d{2}) horas)?/);
  if (monthNameMatch) {
    const day = Number(monthNameMatch[1]);
    const monthName = monthNameMatch[2];
    const year = Number(monthNameMatch[3]);
    const month = MESES[monthName as string];
    if (month) {
      const { hour, minute, second } = deadlineTimeOf(monthNameMatch[4], monthNameMatch[5]);
      const iso = buildMexicoCityIso(year, month, day, hour, minute, second);
      return { deadline: iso, topicKey: deadlineTopicKeyOf(lower) };
    }
  }

  // Patrón numérico "DD/MM/AAAA" o "DD-MM-AAAA": tan común como el formato
  // con nombre de mes en bases/actas reales.
  const numericMatch = lower.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?: a las (\d{1,2}):(\d{2}) horas)?/);
  if (numericMatch) {
    const day = Number(numericMatch[1]);
    const month = Number(numericMatch[2]);
    const year = Number(numericMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const { hour, minute, second } = deadlineTimeOf(numericMatch[4], numericMatch[5]);
      const iso = buildMexicoCityIso(year, month, day, hour, minute, second);
      // El patrón numérico SIEMPRE asume DD/MM (la convención correcta por
      // defecto en licitaciones mexicanas) sin marcar ambigüedad cuando día
      // Y mes son ambos ≤12 (p. ej. "05/09/2026" podría razonablemente ser
      // 5-sep o 9-may si el documento de origen usara la convención
      // estadounidense) -- no se cambia la interpretación por defecto (sigue
      // siendo DD/MM); solo se señala la ambigüedad para que
      // `classifySentence` baje `confidence` y un revisor humano lo
      // confirme. `day === month` no es ambigüedad real.
      const ambiguousDate = day <= 12 && day !== month;
      return { deadline: iso, topicKey: deadlineTopicKeyOf(lower), ambiguousDate };
    }
  }

  return { deadline: null };
}

/** Hora/minuto/segundo de un plazo: si el texto trae hora explícita se usa tal cual (segundo 0); si no, se fija a las 23:59:59 (fin del día), nunca inferida a medias. */
function deadlineTimeOf(hourGroup?: string, minuteGroup?: string): { hour: number; minute: number; second: number } {
  if (hourGroup) return { hour: Number(hourGroup), minute: Number(minuteGroup), second: 0 };
  return { hour: 23, minute: 59, second: 59 };
}

function deadlineTopicKeyOf(lower: string): TopicKey | undefined {
  if (lower.includes("entrega de proposiciones") || lower.includes("presentación de proposiciones") || lower.includes("acto de presentación")) {
    return "plazo_entrega_proposiciones";
  }
  if (lower.includes("junta de aclaraciones")) return "plazo_junta_aclaraciones";
  if (lower.includes("fallo")) return "plazo_fallo";
  return undefined;
}

/** Construye un ISO 8601 con el offset fijo -06:00 de America/Mexico_City. */
export function buildMexicoCityIso(year: number, month: number, day: number, hour: number, minute: number, second: number): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}-06:00`;
}

function extractClause(sentence: string): string | undefined {
  const match = sentence.match(/(cl[aá]usula|numeral|punto|anexo)\s+([a-z0-9.]+)/i);
  return match ? `${match[1]} ${match[2]}` : undefined;
}

function extractRequiredEvidence(lower: string, type: RequirementType): string[] {
  const evidence: string[] = [];
  if (lower.includes("fianza") || lower.includes("garantía")) evidence.push("póliza_de_fianza");
  if (lower.includes("opinión de cumplimiento") || lower.includes("32-d")) evidence.push("opinión_32d_sat");
  if (lower.includes("acta constitutiva")) evidence.push("acta_constitutiva");
  if (lower.includes("poder notarial")) evidence.push("poder_notarial");
  if (type === "anexo") {
    const match = lower.match(/anexo\s+([a-z0-9]+)/);
    if (match) evidence.push(`anexo_${match[1]}_firmado`);
  }
  if (evidence.length === 0 && type === "economico") evidence.push("cotización_o_tarifa_aprobada");
  return evidence;
}

export interface RequirementMatrixResult {
  readonly items: RequirementItem[];
  readonly conflicts: Conflict[];
}

/**
 * Ensambla la matriz combinando uno o más extractores sobre uno o más
 * documentos (bases + anexos + aclaraciones), y detecta conflictos entre
 * documentos para el mismo `topicKey` (p. ej. dos plazos distintos de
 * entrega). Los conflictos se marcan `escalado`: ningún ítem se descarta ni
 * se "gana" en silencio.
 */
export class RequirementMatrixBuilder {
  constructor(private readonly extractors: readonly RequirementExtractor[]) {}

  async build(docs: readonly TenderDocumentText[]): Promise<RequirementMatrixResult> {
    const items: RequirementItem[] = [];
    for (const doc of docs) {
      for (const extractor of this.extractors) {
        const extracted = await extractor.extract(doc);
        items.push(...extracted);
      }
    }
    const conflicts = detectConflicts(items);
    // Los ítems involucrados en un conflicto de plazo quedan explícitamente
    // "bloqueados" hasta que un humano lo resuelva y escale -- nunca se
    // asume ninguno de los dos plazos.
    const blockedIds = new Set(conflicts.flatMap((c) => c.items.map((i) => i.id)));
    const resolvedItems = items.map((item) => (blockedIds.has(item.id) && item.deadline !== null ? { ...item, status: "bloqueado" as RequirementStatus } : item));
    return { items: resolvedItems, conflicts };
  }
}

export function detectConflicts(items: readonly RequirementItem[]): Conflict[] {
  const byTopic = new Map<TopicKey, RequirementItem[]>();
  for (const item of items) {
    if (!item.topicKey) continue;
    const list = byTopic.get(item.topicKey) ?? [];
    list.push(item);
    byTopic.set(item.topicKey, list);
  }

  const conflicts: Conflict[] = [];
  for (const [topicKey, group] of byTopic) {
    if (group.length < 2) continue;

    const distinctDeadlines = new Set(group.filter((i) => i.deadline !== null).map((i) => i.deadline));
    if (distinctDeadlines.size > 1) {
      conflicts.push({
        id: nextConflictId(),
        kind: "deadline_mismatch",
        topicKey,
        description: `Se encontraron ${distinctDeadlines.size} fechas límite distintas para "${topicKey}" en documentos distintos. Requiere escalado humano; ninguna se aplica automáticamente.`,
        items: group,
        status: "escalado",
      });
      continue;
    }

    const distinctObligatoriedad = new Set(group.map((i) => i.obligatoriedad));
    if (distinctObligatoriedad.size > 1) {
      conflicts.push({
        id: nextConflictId(),
        kind: "obligatoriedad_mismatch",
        topicKey,
        description: `Obligatoriedad contradictoria para "${topicKey}" entre documentos (${Array.from(distinctObligatoriedad).join(", ")}).`,
        items: group,
        status: "escalado",
      });
    }
  }
  return conflicts;
}

/** Utilidad de solo pruebas: resetea contadores globales para IDs deterministas entre tests. */
export function resetRequirementCounters(): void {
  itemCounter = 0;
  conflictCounter = 0;
}

/**
 * Mapa fijo `RequirementType` -> sección de la propuesta técnica que ese
 * tipo de requisito debe cubrir. Fijo en código, nunca inferido por un LLM.
 */
export const SECTION_KEY_BY_REQUIREMENT_TYPE: Record<RequirementType, string> = {
  tecnico: "tecnica",
  economico: "economica",
  legal: "legal",
  administrativo: "administrativa",
  anexo: "anexos",
};

/**
 * Deriva, a partir de una matriz de requisitos YA CONSTRUIDA
 * (`RequirementMatrixBuilder.build`), el conjunto de `sectionKeys` que debe
 * redactar `TechnicalProposalBuilder`: una sección por cada `RequirementType`
 * presente entre los ítems, en orden determinista (alfabético).
 *
 * Los ítems `bloqueado` (conflicto de plazo/obligatoriedad sin resolver, ver
 * `detectConflicts`) se EXCLUYEN de este cálculo: redactar una sección
 * citando un requisito todavía en disputa entre documentos sería fabricar
 * certeza que no existe -- esa sección solo se propone una vez que un humano
 * resuelva el conflicto y la matriz se reconstruya sin ese bloqueo.
 */
export function deriveSectionKeysFromRequirementMatrix(items: readonly RequirementItem[]): string[] {
  const sectionKeys = new Set<string>();
  for (const item of items) {
    if (item.status === "bloqueado") continue;
    sectionKeys.add(SECTION_KEY_BY_REQUIREMENT_TYPE[item.type]);
  }
  return Array.from(sectionKeys).sort();
}

export { MEXICO_CITY_TZ };

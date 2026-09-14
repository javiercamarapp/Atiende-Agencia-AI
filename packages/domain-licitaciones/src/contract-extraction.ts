// contract-extraction.ts — Fase 6 pieza 2 (REQ-052): extracción determinista
// (SIN LLM) de campos estructurados de un contrato ya firmado, sobre texto
// YA EXTRAÍDO por página -- port ~literal de las reglas regex del repo
// original (`licitaciones/apps/api/src/lib/expediente/contract-extraction.ts`).
//
// LÍMITE DOCUMENTADO (honesto, no oculto -- ver instrucción de esta fase):
// este monorepo fusionado NO tiene, en NINGÚN vertical, un pipeline de
// texto-desde-PDF/OCR (ni siquiera para las bases de licitación mismas --
// ver `requirement-matrix.ts::TenderDocumentText`/
// `technicalProposal.ts::POST .../requirements/extract`, que YA reciben el
// texto pre-extraído en el cuerpo del request, `{pages:[{page,text}]}`,
// exactamente el mismo contrato que este módulo). El repo ORIGEN sí tenía un
// motor propio (`extractDocumentText`, pdfjs-dist) que distinguía PDF con
// capa de texto de un PDF escaneado y devolvía `requires_ocr` en ese
// segundo caso -- esa pieza específica NUNCA se portó a este monorepo (Fase
// 2 tampoco la portó para las bases) y sigue siendo trabajo pendiente
// genuino: convertir los BYTES de un PDF firmado (nativo o escaneado) en
// texto es responsabilidad de un paso externo al llamar a esta API (por
// ahora, el propio usuario/back-office copia el texto ya extraído, o un
// futuro pipeline compartido de texto-desde-PDF lo hace) -- este módulo, y
// la ruta HTTP que lo expone, jamás fingen ejecutar ese paso: fail-closed
// por diseño (nunca se inventa contenido a partir de bytes sin texto).
//
// Reglas deterministas (regex): cada campo detectado trae página
// (heurística exacta, no proporcional -- ver `pageForIndex`), cláusula (si
// se encuentra un marcador "CLÁUSULA N" antes de la coincidencia) y una
// confianza explícita -- NUNCA se inventa un campo que el texto no
// contiene. Todo lo que produce este extractor entra como `status =
// 'sugerido'` (ver `repository.ts::AddContractDocumentInput`); ninguna ruta
// de esta fase da un campo extraído por válido sin la confirmación
// explícita del usuario (`POST .../fields/:fieldId/confirm`).
export type ContractFieldKey =
  | "numero_contrato"
  | "monto_total"
  | "plazo_entrega"
  | "garantia_cumplimiento"
  | "pena_convencional"
  | "deductiva"
  | "forma_pago"
  | "administrador_contrato"
  | "cesion_cobro";

export const CONTRACT_FIELD_KEYS: readonly ContractFieldKey[] = [
  "numero_contrato",
  "monto_total",
  "plazo_entrega",
  "garantia_cumplimiento",
  "pena_convencional",
  "deductiva",
  "forma_pago",
  "administrador_contrato",
  "cesion_cobro",
];

export interface ExtractedContractField {
  readonly fieldKey: ContractFieldKey;
  /** Fragmento de texto crudo detectado (valor o cláusula completa, recortada a un tamaño razonable para lectura humana). */
  readonly value: string;
  readonly sourcePage: number | null;
  readonly sourceClause: string | null;
  /** 0-1: mayor cuando se capturó un valor específico (monto, fecha, nombre); menor cuando solo se detectó la mención del tema sin un valor aislable. */
  readonly confidence: number;
}

interface FieldRule {
  readonly fieldKey: ContractFieldKey;
  readonly pattern: RegExp;
  readonly highConfidence: number;
  readonly lowConfidence: number;
  readonly maxValueLength: number;
}

// Cada regla busca EL PRIMER acierto razonable en el documento -- un
// contrato real solo debería declarar un monto total, un plazo de entrega,
// etc. una vez en la cláusula correspondiente.
const FIELD_RULES: readonly FieldRule[] = [
  {
    fieldKey: "numero_contrato",
    pattern: /contrato\s+(?:n[uú]mero|n[uú]m\.?|no\.?)\s*[:-]?\s*([A-Za-z0-9][A-Za-z0-9/.-]{2,40})/i,
    highConfidence: 0.75,
    lowConfidence: 0.4,
    maxValueLength: 60,
  },
  {
    fieldKey: "monto_total",
    pattern: /monto\s+total[^\n\d$]{0,30}\$?\s?([\d][\d,]*(?:\.\d{2})?)\s*(?:\(([^)]{1,80})\))?\s*(?:m\.?n\.?|mxn|pesos)?/i,
    highConfidence: 0.8,
    lowConfidence: 0.45,
    maxValueLength: 120,
  },
  {
    fieldKey: "plazo_entrega",
    pattern: /plazo\s+de\s+entrega[^.]{0,200}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 220,
  },
  {
    fieldKey: "garantia_cumplimiento",
    pattern: /garant[ií]a\s+de\s+cumplimiento[^.]{0,220}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 240,
  },
  {
    fieldKey: "pena_convencional",
    pattern: /pena(?:s)?\s+convencional(?:es)?[^.]{0,220}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 240,
  },
  {
    fieldKey: "deductiva",
    pattern: /deductiva(?:s)?[^.]{0,220}\./i,
    highConfidence: 0.55,
    lowConfidence: 0.35,
    maxValueLength: 240,
  },
  {
    fieldKey: "forma_pago",
    pattern: /forma\s+de\s+pago[^.]{0,220}\./i,
    highConfidence: 0.55,
    lowConfidence: 0.35,
    maxValueLength: 240,
  },
  {
    fieldKey: "administrador_contrato",
    pattern: /administrador(?:a)?\s+del\s+contrato[^\n.]{0,150}/i,
    highConfidence: 0.6,
    lowConfidence: 0.35,
    maxValueLength: 180,
  },
  {
    fieldKey: "cesion_cobro",
    pattern: /cesi[oó]n\s+de\s+derechos\s+de\s+cobro[^.]{0,220}\./i,
    highConfidence: 0.6,
    lowConfidence: 0.4,
    maxValueLength: 240,
  },
];

const CLAUSE_MARKER = /cl[aá]usula\s+([a-z0-9]+)/i;

/** Busca hacia atrás desde `index` la última mención "CLÁUSULA N" -- `null` si no hay ninguna antes de esa posición. */
function findNearestClause(text: string, index: number): string | null {
  const before = text.slice(Math.max(0, index - 4000), index);
  let lastMatch: RegExpExecArray | null = null;
  const re = new RegExp(CLAUSE_MARKER, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(before)) !== null) {
    lastMatch = m;
  }
  return lastMatch ? `Cláusula ${lastMatch[1]!.toUpperCase()}` : null;
}

export interface ContractFieldPageText {
  readonly page: number;
  readonly text: string;
}

/** Concatena las páginas en un único string de trabajo, recordando en qué rango de offsets cae cada página real -- así `findNearestClause` puede seguir mirando hacia atrás a través de un límite de página sin perder la página REAL de cada coincidencia. */
function concatWithPageBoundaries(pages: readonly ContractFieldPageText[]): { text: string; boundaries: { page: number; start: number; end: number }[] } {
  let text = "";
  const boundaries: { page: number; start: number; end: number }[] = [];
  for (const p of pages) {
    const start = text.length;
    text += p.text;
    boundaries.push({ page: p.page, start, end: text.length });
    text += "\n";
  }
  return { text, boundaries };
}

/** Página REAL que contiene el offset `index` dentro del texto concatenado -- nunca una aproximación proporcional. */
function pageForIndex(index: number, boundaries: readonly { page: number; start: number; end: number }[]): number | null {
  if (boundaries.length === 0) return null;
  for (const b of boundaries) {
    if (index >= b.start && index <= b.end) return b.page;
  }
  return boundaries[boundaries.length - 1]!.page;
}

export function extractContractFields(pages: readonly ContractFieldPageText[]): ExtractedContractField[] {
  const results: ExtractedContractField[] = [];
  if (pages.length === 0) return results;
  const { text, boundaries } = concatWithPageBoundaries(pages);

  for (const rule of FIELD_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    const capturedValue = match[1]?.trim();
    const rawValue = (capturedValue && capturedValue.length > 0 ? capturedValue : match[0]).trim();
    const value = rawValue.length > rule.maxValueLength ? `${rawValue.slice(0, rule.maxValueLength)}…` : rawValue;
    const confidence = capturedValue && capturedValue.length > 0 && capturedValue.length <= 40 ? rule.highConfidence : rule.lowConfidence;

    results.push({
      fieldKey: rule.fieldKey,
      value,
      sourcePage: pageForIndex(match.index, boundaries),
      sourceClause: findNearestClause(text, match.index),
      confidence,
    });
  }
  return results;
}

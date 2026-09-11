// IntegrityChecklist — Flujo 1, port literal de
// licitaciones/packages/expediente/src/integrity-checklist.ts (ver diseño
// Fase 1 §0 fila 7/§3.1/§4.1). Cubre las 7 dimensiones exigidas: formatos,
// límites (tamaño/páginas/anexos por "botón" de carga del portal), firmas
// requeridas, anexos obligatorios, vigencias de documentos, cálculos
// económicos y consistencia cruzada entre documentos. Nunca marca una firma
// como realizada: solo indica "requiere firma del usuario".
//
// Adaptación deliberada de Fase 1: el origen tipa `requiredAnnexes` como
// `RequirementItem[]` (motor completo de extracción de requisitos vía LLM,
// `requirement-matrix.ts`, explícitamente NO portado en esta fase — Flujo 1
// solo *lee* requisitos ya existentes). Aquí se tipa contra `RequiredAnnexItem`
// (id/text/topicKey), el subconjunto real que esta clase usa — la lógica de
// `checkAnexosObligatorios` es idéntica byte a byte a la del origen.
import type { EconomicProposalResult } from "./economic-proposal.ts";
import { isPast } from "./types.ts";
import type { CompanyDocumentRecord, RequiredAnnexItem } from "./types.ts";

export type ChecklistDimension = "formatos" | "limites" | "firmas" | "anexos_obligatorios" | "vigencias" | "calculos_economicos" | "consistencia_cruzada";

export type ChecklistResultStatus = "verde" | "ambar" | "rojo";

export interface ChecklistItemResult {
  readonly dimension: ChecklistDimension;
  readonly status: ChecklistResultStatus;
  readonly detail: string;
  readonly evidence: string[];
}

export interface ChecklistReport {
  readonly items: ChecklistItemResult[];
  readonly overallStatus: ChecklistResultStatus;
}

export interface FileArtifact {
  readonly filename: string;
  readonly extension: string;
  readonly sizeBytes: number;
  readonly pages?: number;
}

export interface FormatLimitsConfig {
  readonly allowedExtensions: string[];
  readonly maxFileSizeBytes: number;
  readonly maxPagesPerFile?: number;
  /** Número máximo de anexos/archivos que el portal oficial acepta subir (límite de "botones" de carga). */
  readonly maxUploadSlots: number;
}

export interface SignatureRequirement {
  readonly role: string;
  /** El usuario ya marcó (fuera del sistema) que este documento fue firmado por su cuenta; el sistema nunca produce esta marca por sí mismo. */
  readonly userConfirmedSigned: boolean;
}

export interface IntegrityChecklistInput {
  readonly files: readonly FileArtifact[];
  readonly formatLimits: FormatLimitsConfig;
  readonly requiredSignatures: readonly SignatureRequirement[];
  readonly requiredAnnexes: readonly RequiredAnnexItem[]; // requirement_kind='anexo' && obligatoriedad='obligatorio' && invalidated_at is null
  readonly presentAnnexRefs: readonly string[]; // topicKey o requirementId de anexos efectivamente presentes
  // Nota de adaptación de Fase 1: se tipa contra `CompanyDocumentRecord`
  // (types.ts, el subconjunto que expone LicitacionesRepository) en vez del
  // `CompanyDocument` completo de company-data.ts -- esta dimensión solo
  // necesita id/label/expiresAt, que ambos tipos comparten.
  readonly documentsToValidate: readonly { document: CompanyDocumentRecord; asOfIso: string }[];
  readonly economicResult: EconomicProposalResult | null;
  /** Totales a comparar entre "documentos" del expediente (carta vs. anexo económico, etc.) para consistencia cruzada. */
  readonly crossDocumentTotals: readonly { documentLabel: string; total: string }[];
}

function overallFrom(items: ChecklistItemResult[]): ChecklistResultStatus {
  if (items.some((i) => i.status === "rojo")) return "rojo";
  if (items.some((i) => i.status === "ambar")) return "ambar";
  return "verde";
}

export class IntegrityChecklist {
  run(input: IntegrityChecklistInput): ChecklistReport {
    const items: ChecklistItemResult[] = [
      this.checkFormatos(input),
      this.checkLimites(input),
      this.checkFirmas(input),
      this.checkAnexosObligatorios(input),
      this.checkVigencias(input),
      this.checkCalculosEconomicos(input),
      this.checkConsistenciaCruzada(input),
    ];
    return { items, overallStatus: overallFrom(items) };
  }

  private checkFormatos(input: IntegrityChecklistInput): ChecklistItemResult {
    const invalid = input.files.filter((f) => !input.formatLimits.allowedExtensions.includes(f.extension.toLowerCase()));
    if (invalid.length > 0) {
      return {
        dimension: "formatos",
        status: "rojo",
        detail: `${invalid.length} archivo(s) con extensión no permitida: ${invalid.map((f) => f.filename).join(", ")}.`,
        evidence: invalid.map((f) => f.filename),
      };
    }
    return { dimension: "formatos", status: "verde", detail: "Todos los archivos usan extensiones permitidas.", evidence: input.files.map((f) => f.filename) };
  }

  private checkLimites(input: IntegrityChecklistInput): ChecklistItemResult {
    const { maxFileSizeBytes, maxPagesPerFile, maxUploadSlots } = input.formatLimits;
    const problems: string[] = [];
    for (const f of input.files) {
      if (f.sizeBytes > maxFileSizeBytes) problems.push(`${f.filename} excede tamaño máximo (${f.sizeBytes} > ${maxFileSizeBytes} bytes)`);
      if (maxPagesPerFile !== undefined && f.pages !== undefined && f.pages > maxPagesPerFile) {
        problems.push(`${f.filename} excede páginas máximas (${f.pages} > ${maxPagesPerFile})`);
      }
    }
    if (input.files.length > maxUploadSlots) {
      problems.push(`${input.files.length} archivos exceden los ${maxUploadSlots} espacios de carga del portal.`);
    }
    if (problems.length > 0) {
      return { dimension: "limites", status: "rojo", detail: problems.join(" | "), evidence: problems };
    }
    return { dimension: "limites", status: "verde", detail: "Todos los archivos dentro de los límites configurados.", evidence: [] };
  }

  private checkFirmas(input: IntegrityChecklistInput): ChecklistItemResult {
    const pending = input.requiredSignatures.filter((s) => !s.userConfirmedSigned);
    if (pending.length > 0) {
      return {
        dimension: "firmas",
        status: "rojo",
        detail: `Requiere firma del usuario para: ${pending.map((s) => s.role).join(", ")}. El sistema nunca firma ni simula firma.`,
        evidence: pending.map((s) => `pendiente_firma_usuario:${s.role}`),
      };
    }
    return {
      dimension: "firmas",
      status: "verde",
      detail: "Todas las firmas requeridas fueron confirmadas como realizadas por el usuario (fuera del sistema).",
      evidence: input.requiredSignatures.map((s) => `confirmado_por_usuario:${s.role}`),
    };
  }

  private checkAnexosObligatorios(input: IntegrityChecklistInput): ChecklistItemResult {
    const missing = input.requiredAnnexes.filter((req) => !input.presentAnnexRefs.includes(req.topicKey ?? req.id));
    if (missing.length > 0) {
      return {
        dimension: "anexos_obligatorios",
        status: "rojo",
        detail: `Faltan ${missing.length} anexo(s) obligatorio(s): ${missing.map((m) => m.text).join(" | ")}`,
        evidence: missing.map((m) => m.id),
      };
    }
    return { dimension: "anexos_obligatorios", status: "verde", detail: "Todos los anexos obligatorios están presentes.", evidence: input.requiredAnnexes.map((r) => r.id) };
  }

  private checkVigencias(input: IntegrityChecklistInput): ChecklistItemResult {
    const expired = input.documentsToValidate.filter(({ document, asOfIso }) => document.expiresAt !== null && isPast(document.expiresAt, asOfIso));
    if (expired.length > 0) {
      return {
        dimension: "vigencias",
        status: "rojo",
        detail: `${expired.length} documento(s) vencido(s) a la fecha del acto: ${expired.map((e) => e.document.label).join(", ")}.`,
        evidence: expired.map((e) => e.document.id),
      };
    }
    return { dimension: "vigencias", status: "verde", detail: "Todos los documentos vigentes a la fecha del acto.", evidence: input.documentsToValidate.map((d) => d.document.id) };
  }

  private checkCalculosEconomicos(input: IntegrityChecklistInput): ChecklistItemResult {
    if (input.economicResult === null) {
      return { dimension: "calculos_economicos", status: "rojo", detail: "No hay propuesta económica calculada (sin datos o con conceptos bloqueados).", evidence: [] };
    }
    if (input.economicResult.blockedLineItems.length > 0) {
      return {
        dimension: "calculos_economicos",
        status: "rojo",
        detail: `${input.economicResult.blockedLineItems.length} concepto(s) económico(s) bloqueado(s): ${input.economicResult.blockedLineItems.map((b) => b.concept).join(", ")}.`,
        evidence: input.economicResult.blockedLineItems.map((b) => b.concept),
      };
    }
    if (input.economicResult.totals === null) {
      return { dimension: "calculos_economicos", status: "rojo", detail: "Totales económicos no disponibles.", evidence: [] };
    }
    return {
      dimension: "calculos_economicos",
      status: "verde",
      detail: `Total calculado: $${input.economicResult.totals.total} ${input.economicResult.totals.currency}.`,
      evidence: input.economicResult.lineItems.map((li) => li.concept),
    };
  }

  /**
   * Con menos de 2 entradas reales en `crossDocumentTotals`, esta dimensión
   * queda en "ambar" (nunca "verde", y "ambar" !== "verde" sigue bloqueando
   * "ready" — correcto). NUNCA se debe "resolver" ese ámbar duplicando
   * artificialmente la misma cifra en una segunda entrada solo para forzar
   * "verde": eso fabricaría una consistencia que no existe realmente.
   */
  private checkConsistenciaCruzada(input: IntegrityChecklistInput): ChecklistItemResult {
    if (input.crossDocumentTotals.length < 2) {
      return { dimension: "consistencia_cruzada", status: "ambar", detail: "No hay suficientes documentos para verificar consistencia cruzada.", evidence: [] };
    }
    const distinctTotals = new Set(input.crossDocumentTotals.map((d) => d.total));
    if (distinctTotals.size > 1) {
      return {
        dimension: "consistencia_cruzada",
        status: "rojo",
        detail: `Totales inconsistentes entre documentos: ${input.crossDocumentTotals.map((d) => `${d.documentLabel}=$${d.total}`).join(", ")}.`,
        evidence: input.crossDocumentTotals.map((d) => d.documentLabel),
      };
    }
    return { dimension: "consistencia_cruzada", status: "verde", detail: "Mismo total en todos los documentos del expediente.", evidence: input.crossDocumentTotals.map((d) => d.documentLabel) };
  }
}

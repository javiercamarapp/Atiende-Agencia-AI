// PackageAssembler — Flujo 3, port literal de
// licitaciones/packages/expediente/src/package-assembler.ts (ver diseño Fase 1
// §1.3/§4.3, 425 líneas en origen). Genera un `PackageManifest` (índice de
// documentos exigidos, hashes, versiones, checklist snapshot, evidencia de
// aprobación, faltantes) y lo exporta a un ZIP real (jszip). Estado `draft`
// (marca "BORRADOR" en nombre de archivo y manifiesto) o `ready` SOLO si el
// checklist está completo, las aprobaciones vigentes cubren todo el
// expediente y no hay bloqueos — NUNCA `ready` por defecto ni declarado desde
// afuera (A13/A14 del origen). El manifiesto siempre incluye el aviso de que
// la presentación y firma las realiza el usuario.
import JSZip from "jszip";
import type { ChecklistReport } from "./integrity-checklist.ts";
import type { Approval } from "./approval-workflow.ts";
import { isoNow, sha256Bytes } from "./types.ts";
import { requireValidHashedInputs } from "./sealed-inputs.ts";
import type { HashedInputs } from "./sealed-inputs.ts";

export const USER_RESPONSIBILITY_NOTICE = "La presentación y firma las realiza el usuario; el sistema no envía ofertas.";

export type PackageStatus = "draft" | "ready";

export interface PackageDocumentInput {
  readonly documentId: string;
  readonly label: string;
  readonly required: boolean;
  /** `undefined`/`null` = documento no presente en el expediente todavía. */
  readonly content?: Uint8Array | string;
  readonly filename: string;
  readonly version?: number;
}

export interface PackageManifestDocumentEntry {
  readonly documentId: string;
  readonly label: string;
  readonly required: boolean;
  readonly present: boolean;
  /** sha256 hex de los BYTES REALES del archivo — coincide con `sha256sum` sobre el archivo extraído del ZIP. `null` si el documento no está presente. */
  readonly sha256: string | null;
  readonly version: number | null;
  /** Nombre de entrada SANEADO con el que este documento aparece dentro del ZIP (sin el prefijo `BORRADOR_`). Nunca el `filename` crudo del llamador. */
  readonly filename: string;
}

export interface PackageManifest {
  readonly expedienteId: string;
  readonly status: PackageStatus;
  readonly generatedAt: string;
  readonly documents: PackageManifestDocumentEntry[];
  readonly checklist: ChecklistReport;
  readonly approvals: Approval[];
  readonly missing: string[];
  /** Motivos explícitos por los que el paquete quedó en "draft" (vacío si "ready"). */
  readonly draftReasons: string[];
  readonly notice: string;
  readonly watermark: string | null;
  readonly notApplicableRequirements: { requirementId: string; reason: string }[];
  /** Id de correlación de negocio del request que ensambló este paquete, para trazabilidad legible dentro del propio ZIP. */
  readonly correlationId?: string | null;
}

export interface AssembleInput {
  readonly expedienteId: string;
  readonly documents: PackageDocumentInput[];
  readonly checklist: ChecklistReport;
  readonly approvals: Approval[];
  readonly correlationId?: string | null;
  /**
   * `HashedInputs` sellado con el hash ACTUAL de los insumos cubiertos por el
   * alcance "expediente" (tarifas, documentos, datos de empresa, versión de
   * bases). Debe venir de `sealInputs`/`computeInputsHash` — `buildManifest`
   * lo verifica con `requireValidHashedInputs` antes de usarlo (fail-closed
   * ante un hash calculado a mano o insumos mutados después de sellarse).
   */
  readonly currentInputsHash: HashedInputs;
  readonly notApplicableRequirements?: { requirementId: string; reason: string }[];
}

// Deliberadamente NO existe un campo `isFullyApproved: boolean` en
// `AssembleInput` — "¿está aprobado?" se DERIVA exclusivamente de `approvals`
// dentro de `buildManifest`, nunca se declara desde afuera.

export interface AssembleResult {
  readonly manifest: PackageManifest;
  readonly zip: Uint8Array;
  readonly suggestedFileName: string;
}

/** Longitud máxima de un nombre de entrada de ZIP saneado: acota nombres de usuario arbitrariamente largos. */
const MAX_ENTRY_FILENAME_LENGTH = 200;

/** Elimina caracteres de control (incluyendo NUL, 0x00-0x1F y 0x7F) de `name` — nunca válidos en un nombre de entrada de ZIP. */
function stripControlChars(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * Sanea un `filename` de ENTRADA antes de usarlo como nombre de entrada
 * dentro del ZIP (defensa anti Zip Slip): descarta cualquier componente de
 * ruta, elimina caracteres de control y `".."` residual, reemplaza `:`, y
 * cae a un `fallback` determinista si el resultado queda vacío. Fail-safe,
 * nunca lanza.
 */
function sanitizeEntryFilename(rawFilename: string, fallback: string): string {
  const lastSlash = Math.max(rawFilename.lastIndexOf("/"), rawFilename.lastIndexOf("\\"));
  let name = lastSlash >= 0 ? rawFilename.slice(lastSlash + 1) : rawFilename;

  name = stripControlChars(name).split("..").join("");
  name = name.replace(/:/g, "_");
  name = name.trim();

  if (name.length === 0 || name === ".") {
    name = fallback;
  }

  if (name.length > MAX_ENTRY_FILENAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const hasShortExtension = dot > 0 && name.length - dot <= 20;
    if (hasShortExtension) {
      const ext = name.slice(dot);
      name = name.slice(0, MAX_ENTRY_FILENAME_LENGTH - ext.length) + ext;
    } else {
      name = name.slice(0, MAX_ENTRY_FILENAME_LENGTH);
    }
  }

  return name;
}

/**
 * Calcula, en el mismo orden que `documents`, un nombre de entrada de ZIP
 * saneado y sin colisiones para cada documento. Las colisiones se resuelven
 * con un sufijo DETERMINISTA derivado del propio `documentId` — nunca
 * aleatorio, para que el mismo `AssembleInput` produzca siempre el mismo ZIP
 * byte a byte.
 */
function buildSafeEntryFilenames(documents: PackageDocumentInput[]): string[] {
  const used = new Set<string>();
  const result: string[] = [];

  for (const doc of documents) {
    const fallback = `${sanitizeEntryFilename(doc.documentId, "documento") || "documento"}.bin`;
    const base = sanitizeEntryFilename(doc.filename, fallback);

    let candidate = base;
    if (used.has(candidate)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      const idSuffix = sanitizeEntryFilename(doc.documentId, "doc");
      candidate = `${stem}__${idSuffix}${ext}`;
      let n = 2;
      while (used.has(candidate)) {
        candidate = `${stem}__${idSuffix}_${n}${ext}`;
        n++;
      }
    }

    used.add(candidate);
    result.push(candidate);
  }

  return result;
}

export class PackageAssembler {
  /** Construye el manifiesto sin generar el ZIP; útil para pruebas/inspección. */
  buildManifest(input: AssembleInput): PackageManifest {
    const { hash: currentInputsHash } = requireValidHashedInputs(input.currentInputsHash, "AssembleInput.currentInputsHash (buildManifest())");
    const missing: string[] = [];
    const safeFilenames = buildSafeEntryFilenames(input.documents);
    const documents: PackageManifestDocumentEntry[] = input.documents.map((doc, i) => {
      const present = doc.content !== undefined && doc.content !== null;
      if (doc.required && !present) missing.push(doc.documentId);
      return {
        documentId: doc.documentId,
        label: doc.label,
        required: doc.required,
        present,
        sha256: present ? sha256Bytes(doc.content as Uint8Array | string) : null,
        version: doc.version ?? null,
        filename: safeFilenames[i]!,
      };
    });

    const checklistOk = input.checklist.overallStatus === "verde";
    const noMissing = missing.length === 0;
    // "aprobado" se DERIVA aquí, nunca se acepta como booleano declarado por
    // el llamador — debe existir una aprobación cuyo `scope` sea EXACTAMENTE
    // "expediente" (una aprobación de "documento"/"sección" nunca basta) Y
    // cuyo `scopeRef` sea EXACTAMENTE "expediente" (defensa en profundidad
    // independiente), Y cuyo `inputsHash` coincida con el hash ACTUAL de los
    // insumos que el llamador acaba de recalcular.
    const hashValidExpedienteApproval = input.approvals.find((a) => a.scope === "expediente" && a.scopeRef === "expediente" && a.status === "vigente" && a.inputsHash === currentInputsHash);
    const approvedOk = hashValidExpedienteApproval !== undefined;

    // Regla dura: "ready" únicamente cuando las tres condiciones se cumplen
    // simultáneamente. Cualquier combinación de pendientes deja el paquete en
    // "draft".
    const status: PackageStatus = checklistOk && noMissing && approvedOk ? "ready" : "draft";

    const draftReasons: string[] = [];
    if (status === "draft") {
      if (!checklistOk) draftReasons.push(`checklist_no_verde:${input.checklist.overallStatus}`);
      if (!noMissing) draftReasons.push(`documentos_faltantes:${missing.join(",")}`);
      if (!approvedOk) {
        const vigentesExpediente = input.approvals.filter((a) => a.scope === "expediente" && a.scopeRef === "expediente" && a.status === "vigente");
        if (vigentesExpediente.length === 0) {
          draftReasons.push("sin_aprobacion_vigente_de_alcance_expediente");
        } else {
          draftReasons.push(`aprobacion_vigente_con_hash_insumos_divergente:aprobado=${vigentesExpediente.map((a) => a.inputsHash).join("|")}:actual=${currentInputsHash}`);
        }
      }
    }

    return {
      expedienteId: input.expedienteId,
      status,
      generatedAt: isoNow(),
      documents,
      checklist: input.checklist,
      approvals: input.approvals,
      missing,
      draftReasons,
      notice: USER_RESPONSIBILITY_NOTICE,
      watermark: status === "draft" ? "BORRADOR" : null,
      notApplicableRequirements: input.notApplicableRequirements ?? [],
      correlationId: input.correlationId ?? null,
    };
  }

  async assemble(input: AssembleInput): Promise<AssembleResult> {
    const manifest = this.buildManifest(input);
    const prefix = manifest.status === "draft" ? "BORRADOR_" : "";

    const zip = new JSZip();
    zip.file(`${prefix}manifiesto.json`, JSON.stringify(manifest, null, 2));
    zip.file(`${prefix}checklist.json`, JSON.stringify(manifest.checklist, null, 2));
    zip.file("AVISO.txt", USER_RESPONSIBILITY_NOTICE);

    if (manifest.status === "draft") {
      zip.file(
        "BORRADOR.txt",
        [
          "BORRADOR — este expediente NO está listo para presentar.",
          `Documentos faltantes: ${manifest.missing.length > 0 ? manifest.missing.join(", ") : "ninguno"}.`,
          `Checklist: ${manifest.checklist.overallStatus}.`,
          `Motivo(s) explícito(s): ${manifest.draftReasons.length > 0 ? manifest.draftReasons.join(" | ") : "ver checklist/missing arriba"}.`,
        ].join("\n"),
      );
    }

    for (let i = 0; i < input.documents.length; i++) {
      const doc = input.documents[i]!;
      if (doc.content === undefined || doc.content === null) continue;
      zip.file(`${prefix}${manifest.documents[i]!.filename}`, doc.content);
    }

    const zipBuffer = await zip.generateAsync({ type: "uint8array" });
    const suggestedFileName = `${prefix}expediente_${input.expedienteId}.zip`;

    return { manifest, zip: zipBuffer, suggestedFileName };
  }
}

export interface ManifestVerificationMismatch {
  readonly documentId: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
}

export interface ManifestVerificationResult {
  readonly ok: boolean;
  /** Documentos cuyo sha256 del manifiesto NO coincide con el sha256 real de los bytes extraídos del ZIP. */
  readonly mismatches: ManifestVerificationMismatch[];
  /** Documentos que el manifiesto marca `present: true` pero cuya entrada no existe en el ZIP. */
  readonly missingFromZip: string[];
}

/**
 * Verifica de forma INDEPENDIENTE que el `sha256` de cada documento `present`
 * en el manifiesto de un ZIP producido por `assemble()` coincide con el
 * sha256 REAL de los bytes de la entrada extraída. No lanza ante una
 * discrepancia: fail-visible, no fail-closed.
 */
export async function verifyManifest(zip: Uint8Array): Promise<ManifestVerificationResult> {
  const loaded = await JSZip.loadAsync(zip);
  const manifestFile = loaded.file("manifiesto.json") ?? loaded.file("BORRADOR_manifiesto.json");
  if (!manifestFile) {
    throw new Error("verifyManifest: el ZIP no contiene manifiesto.json ni BORRADOR_manifiesto.json.");
  }
  const manifest = JSON.parse(await manifestFile.async("string")) as PackageManifest;
  const prefix = manifest.status === "draft" ? "BORRADOR_" : "";

  const mismatches: ManifestVerificationMismatch[] = [];
  const missingFromZip: string[] = [];

  for (const doc of manifest.documents) {
    if (!doc.present || doc.sha256 === null) continue;
    const entry = loaded.file(`${prefix}${doc.filename}`);
    if (!entry) {
      missingFromZip.push(doc.documentId);
      continue;
    }
    const bytes = await entry.async("uint8array");
    const actualSha256 = sha256Bytes(bytes);
    if (actualSha256 !== doc.sha256) {
      mismatches.push({ documentId: doc.documentId, expectedSha256: doc.sha256, actualSha256 });
    }
  }

  return { ok: mismatches.length === 0 && missingFromZip.length === 0, mismatches, missingFromZip };
}

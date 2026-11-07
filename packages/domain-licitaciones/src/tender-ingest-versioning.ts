// Vigilante de cambios de la ingesta automatica (paridad3 L-P3-08). Funcion PURA: dado el ultimo snapshot versionado de una
// convocatoria y lo que acaba de publicar la fuente, decide si hay que registrar una version y de que tipo. Sin IO: la usan
// el repositorio en memoria y el de Postgres (que la ejecuta bajo la sesion de sistema con funciones definer).
//
// Reglas (REQ-017/151/152/154/155):
//   - El snapshot nuevo hereda los REQUISITOS de la ultima version: la ingesta automatica no toca `requirement_item`, asi que
//     nunca fabrica un "requisito eliminado" por no haberlos leido.
//   - Mismo hash que la ultima version -> `none` (reprocesar es idempotente, no escribe nada).
//   - Sin version previa -> `baseline` (primera captura: se guarda la linea base sin avisar; avisar de "nuevo" es el aviso de
//     descubrimiento, no el de cambio de bases).
//   - Con version previa y un cambio REAL de campo de bases (plazo, monto, entidad, CPV, documentos...) -> `changed`: version +
//     cascada de invalidacion de aprobaciones + aviso. Un "cambio" que solo es que por primera vez aparecen los documentos en
//     una convocatoria ya versionada antes de que existiera el mapeo -> `baseline` silenciosa (no es un cambio de la fuente).
import { TenderVersionRegistry, canonicalDocumentLine, computeTenderSnapshotHash } from "./tender-version-registry.ts";
import type { PersistedTenderVersion, TenderFieldSnapshot, TenderVersionDiff, TenderVersionSnapshot } from "./tender-version-registry.ts";
import type { TenderSourceDocument } from "./connectors/types.ts";
import type { TenderRecord } from "./types.ts";

export interface IngestVersionCascade {
  readonly scope: "expediente" | "seccion";
  readonly scopeRef: string;
  readonly reason: string;
}

export interface IngestVersionPlan {
  readonly action: "none" | "baseline" | "changed";
  readonly nextVersion: number;
  readonly hash: string;
  readonly snapshot: TenderVersionSnapshot;
  readonly diff: TenderVersionDiff;
  readonly changedFieldNames: readonly string[];
  readonly affectedSectionKeys: readonly string[];
  /** Motivo de la notificacion de cambio de convocatoria (mismo formato que `recordTenderVersion`). */
  readonly reason: string;
  readonly cascade: readonly IngestVersionCascade[];
}

type TenderVersionable = Pick<TenderRecord, "title" | "submissionDeadline" | "contractingBody" | "cpvCodes" | "budgetAmount" | "currency" | "state" | "procedureTypeRaw">;

export function planIngestTenderVersion(previous: PersistedTenderVersion | null, tender: TenderVersionable, documents: readonly TenderSourceDocument[] | undefined): IngestVersionPlan {
  const documentLines = [...(documents ?? [])].map(canonicalDocumentLine).sort();
  const fields: TenderFieldSnapshot = {
    title: tender.title,
    submissionDeadline: tender.submissionDeadline,
    contractingBody: tender.contractingBody ?? null,
    cpvCodes: tender.cpvCodes ?? [],
    budgetAmount: tender.budgetAmount ?? null,
    currency: tender.currency ?? "MXN",
    state: tender.state ?? null,
    procedureTypeRaw: tender.procedureTypeRaw ?? null,
    ...(documentLines.length > 0 ? { documents: documentLines } : {}),
  };
  const snapshot: TenderVersionSnapshot = { fields, requirements: previous?.snapshot.requirements ?? [] };
  const hash = computeTenderSnapshotHash(snapshot);
  const nextVersion = (previous?.version ?? 0) + 1;

  if (previous && previous.hash === hash) {
    return { action: "none", nextVersion: previous.version, hash, snapshot, diff: TenderVersionRegistry.diff(previous.snapshot, snapshot), changedFieldNames: [], affectedSectionKeys: [], reason: "", cascade: [] };
  }

  // Convocatoria ya versionada ANTES de que existiera el mapeo de documentos: que aparezcan por primera vez no es un cambio de la fuente.
  const previousFields = previous?.snapshot.fields;
  const documentosRecienVisibles = previousFields !== undefined && previousFields.documents === undefined && fields.documents !== undefined;
  const comparable = previous && documentosRecienVisibles ? { ...previous.snapshot, fields: { ...previous.snapshot.fields, documents: fields.documents } } : (previous?.snapshot ?? null);
  const diff = TenderVersionRegistry.diff(comparable, snapshot);

  if (!previous || !diff.hasChanges) {
    return { action: "baseline", nextVersion, hash, snapshot, diff, changedFieldNames: [], affectedSectionKeys: [], reason: previous ? `convocatoria_actualizada:v${nextVersion}` : "convocatoria_nueva", cascade: [] };
  }

  return {
    action: "changed",
    nextVersion,
    hash,
    snapshot,
    diff,
    changedFieldNames: diff.changedFieldNames,
    affectedSectionKeys: diff.affectedSectionKeys,
    reason: `convocatoria_actualizada:v${nextVersion}`,
    cascade: [{ scope: "expediente", scopeRef: "expediente", reason: `tender_version_changed:v${nextVersion}:${diff.changedFieldNames.join(",")}` }],
  };
}

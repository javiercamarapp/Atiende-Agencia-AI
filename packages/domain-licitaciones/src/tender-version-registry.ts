// TenderVersionRegistry — Fase 5 pieza 2: historial de versiones de
// CONVOCATORIA (REQ-017/041/151..155), hermano de
// `proposal-version-registry.ts` (Fase 2 pieza 2, historial de versiones de
// INSUMOS DE PROPUESTA) -- mismo patrón/estilo deliberadamente: una clase
// `create*`/`latest`/`all` más una función de comparación estática que
// clasifica QUÉ cambió, no solo QUE algo cambió.
//
// Alcance (ver diseño de la tarea): mientras ProposalVersionRegistry
// versiona los INSUMOS que consume un expediente (hash de bases + documentos
// + tarifas + plantillas), este módulo versiona la CONVOCATORIA misma --
// los campos de "bases" capturados en `licitaciones.tender`
// (título/fecha límite/entidad convocante/CPV/presupuesto/moneda/entidad
// federativa/tipo de procedimiento) y el conjunto de `requirement_item`
// vigente (equivalente a "requisitos de bases y actas de junta", REQ-017/
// REQ-041). Nunca hace diff de TEXTO PLANO de un documento -- compara
// SIEMPRE registros estructurados campo por campo (REQ-017: "no diff de
// texto plano").
//
// Clasificación de cada campo/requisito (REQ-017, enum EXACTO del origen):
// "sin_cambio" | "modificado" | "nuevo" | "eliminado". Se aplica tanto a
// campos singulares de la convocatoria (p. ej. `submissionDeadline` pasa de
// null a un valor -> "nuevo"; de un valor a null -> "eliminado") como a cada
// requisito, identificado por una CLAVE NATURAL estable entre versiones
// (`requirementKind` + `clause` si existe, si no `requirementKind` + `text`)
// -- nunca por el `id` de fila, que `replaceRequirementItems` regenera en
// cada extracción (mismo criterio que ProposalVersionRegistry: comparar por
// identidad de NEGOCIO, no por PK de storage).
import { sha256Hex } from "./types.ts";
import { SECTION_KEY_BY_REQUIREMENT_TYPE } from "./requirement-matrix.ts";
import type { RequirementItemRecord } from "./repository.ts";

export type TenderDiffStatus = "sin_cambio" | "modificado" | "nuevo" | "eliminado";

/** Campos de "bases" versionados -- subconjunto de `TenderRecord` que un alta/actualización manual (o, en el futuro, un conector real) puede mutar (ver `TenderUpsertInput`). */
export interface TenderFieldSnapshot {
  readonly title: string;
  readonly submissionDeadline: string | null;
  readonly contractingBody: string | null;
  readonly cpvCodes: readonly string[];
  readonly budgetAmount: number | null;
  readonly currency: string;
  readonly state: string | null;
  readonly procedureTypeRaw: string | null;
}

const TENDER_FIELD_NAMES = ["title", "submissionDeadline", "contractingBody", "cpvCodes", "budgetAmount", "currency", "state", "procedureTypeRaw"] as const;
export type TenderFieldName = (typeof TENDER_FIELD_NAMES)[number];

/** Subconjunto de `RequirementItemRecord` que participa en el diff -- excluye metadatos de proceso (`id`, `extractedBy`, `status`, `confidence`, `documentId`) que no describen el CONTENIDO de la bases/acta, solo cómo se extrajo. */
export interface RequirementSnapshot {
  readonly key: string;
  readonly requirementKind: RequirementItemRecord["requirementKind"];
  readonly text: string;
  readonly obligatoriedad: RequirementItemRecord["obligatoriedad"];
  readonly topicKey: string | null;
  readonly requiredEvidence: readonly string[];
  readonly deadline: string | null;
}

export interface TenderVersionSnapshot {
  readonly fields: TenderFieldSnapshot;
  readonly requirements: readonly RequirementSnapshot[];
}

export interface TenderFieldChange {
  readonly field: TenderFieldName;
  readonly status: TenderDiffStatus;
  readonly previous: unknown;
  readonly current: unknown;
}

export interface TenderRequirementChange {
  readonly key: string;
  readonly status: TenderDiffStatus;
  readonly requirementKind: RequirementItemRecord["requirementKind"] | null;
  readonly previous: RequirementSnapshot | null;
  readonly current: RequirementSnapshot | null;
}

export interface TenderVersionDiff {
  readonly fields: readonly TenderFieldChange[];
  readonly requirements: readonly TenderRequirementChange[];
  /** Nombres de campo con `status !== "sin_cambio"`, orden alfabético -- insumo directo para un motivo legible de `recordChange` (mismo patrón que `ProposalVersionRegistry.diff`). */
  readonly changedFieldNames: readonly TenderFieldName[];
  /** `sectionKey` (ver `SECTION_KEY_BY_REQUIREMENT_TYPE`) de cada requisito con `status !== "sin_cambio"`, orden alfabético y sin duplicados -- las secciones de propuesta técnica que dependen de un requisito modificado/nuevo/eliminado (REQ-155: "las secciones de propuesta técnica que dependían de él se marcan para revisión"). */
  readonly affectedSectionKeys: readonly string[];
  /** `true` si hubo AL MENOS un cambio (de campo o de requisito) -- atajo para decidir si esta versión amerita cascada de invalidación/notificación. */
  readonly hasChanges: boolean;
}

export interface TenderVersion {
  readonly version: number;
  readonly hash: string;
  readonly snapshot: TenderVersionSnapshot;
  readonly diff: TenderVersionDiff;
  readonly createdAt: string;
}

/** Forma persistida (`licitaciones.tender_version`) -- análoga a `PersistedProposalVersion`. */
export interface PersistedTenderVersion {
  readonly version: number;
  readonly hash: string;
  readonly snapshot: TenderVersionSnapshot;
  readonly diff: TenderVersionDiff;
  readonly createdAt: string;
}

/** Clave natural de un requisito, estable entre corridas de extracción (ver cabecera del módulo). */
export function requirementNaturalKey(item: Pick<RequirementItemRecord, "requirementKind" | "clause" | "text">): string {
  return item.clause ? `${item.requirementKind}:clause:${item.clause}` : `${item.requirementKind}:text:${item.text}`;
}

export function toRequirementSnapshot(item: RequirementItemRecord): RequirementSnapshot {
  return {
    key: requirementNaturalKey(item),
    requirementKind: item.requirementKind,
    text: item.text,
    obligatoriedad: item.obligatoriedad,
    topicKey: item.topicKey,
    requiredEvidence: [...item.requiredEvidence].sort(),
    deadline: item.deadline,
  };
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0) || value === "";
}

function normalizeForCompare(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  return JSON.stringify(value);
}

function classifyFieldChange(previous: unknown, current: unknown): TenderDiffStatus {
  const prevEmpty = isEmptyValue(previous);
  const currEmpty = isEmptyValue(current);
  if (prevEmpty && currEmpty) return "sin_cambio";
  if (prevEmpty && !currEmpty) return "nuevo";
  if (!prevEmpty && currEmpty) return "eliminado";
  return normalizeForCompare(previous) === normalizeForCompare(current) ? "sin_cambio" : "modificado";
}

function diffFields(previous: TenderFieldSnapshot | null, current: TenderFieldSnapshot): TenderFieldChange[] {
  return TENDER_FIELD_NAMES.map((field) => {
    const previousValue = previous ? previous[field] : null;
    const currentValue = current[field];
    return { field, status: classifyFieldChange(previousValue, currentValue), previous: previousValue, current: currentValue };
  });
}

function diffRequirements(previous: readonly RequirementSnapshot[], current: readonly RequirementSnapshot[]): TenderRequirementChange[] {
  const previousByKey = new Map(previous.map((r) => [r.key, r] as const));
  const currentByKey = new Map(current.map((r) => [r.key, r] as const));
  const changes: TenderRequirementChange[] = [];

  for (const [key, currentItem] of currentByKey) {
    const previousItem = previousByKey.get(key) ?? null;
    if (!previousItem) {
      changes.push({ key, status: "nuevo", requirementKind: currentItem.requirementKind, previous: null, current: currentItem });
      continue;
    }
    const same =
      previousItem.obligatoriedad === currentItem.obligatoriedad &&
      previousItem.topicKey === currentItem.topicKey &&
      previousItem.deadline === currentItem.deadline &&
      normalizeForCompare(previousItem.requiredEvidence) === normalizeForCompare(currentItem.requiredEvidence) &&
      previousItem.text === currentItem.text;
    changes.push({ key, status: same ? "sin_cambio" : "modificado", requirementKind: currentItem.requirementKind, previous: previousItem, current: currentItem });
  }
  for (const [key, previousItem] of previousByKey) {
    if (!currentByKey.has(key)) {
      changes.push({ key, status: "eliminado", requirementKind: previousItem.requirementKind, previous: previousItem, current: null });
    }
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

/** Hash canónico de un snapshot completo -- determina si una nueva versión merece persistirse (REQ-152/154: reingestar la misma versión no crea ruido ni efectos duplicados). */
export function computeTenderSnapshotHash(snapshot: TenderVersionSnapshot): string {
  return sha256Hex({
    fields: snapshot.fields,
    requirements: [...snapshot.requirements].sort((a, b) => a.key.localeCompare(b.key)),
  });
}

export class TenderVersionRegistry {
  private readonly versions: TenderVersion[] = [];

  /** Registra una nueva versión, calculando su diff contra la anterior (o contra "nada" si es la primera -- ver `diff`). */
  createVersion(snapshot: TenderVersionSnapshot): TenderVersion {
    const previous = this.latest();
    const version: TenderVersion = {
      version: this.versions.length + 1,
      hash: computeTenderSnapshotHash(snapshot),
      snapshot,
      diff: TenderVersionRegistry.diff(previous?.snapshot ?? null, snapshot),
      createdAt: new Date().toISOString(),
    };
    this.versions.push(version);
    return version;
  }

  getVersion(version: number): TenderVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  latest(): TenderVersion | undefined {
    return this.versions[this.versions.length - 1];
  }

  all(): TenderVersion[] {
    return [...this.versions];
  }

  /**
   * Compara dos snapshots estructurados (nunca texto plano, REQ-017) y
   * clasifica cada campo/requisito como sin_cambio/modificado/nuevo/
   * eliminado. `previous === null` (primera versión conocida) clasifica todo
   * campo/requisito presente como "nuevo" -- una convocatoria recién
   * capturada es, por definición, enteramente nueva.
   */
  static diff(previous: TenderVersionSnapshot | null, current: TenderVersionSnapshot): TenderVersionDiff {
    const fields = diffFields(previous?.fields ?? null, current.fields);
    const requirements = diffRequirements(previous?.requirements ?? [], current.requirements);
    const changedFieldNames = fields.filter((f) => f.status !== "sin_cambio").map((f) => f.field).sort();
    const affectedSectionKeys = [...new Set(requirements.filter((r) => r.status !== "sin_cambio" && r.requirementKind).map((r) => SECTION_KEY_BY_REQUIREMENT_TYPE[r.requirementKind!]))].sort();
    return {
      fields,
      requirements,
      changedFieldNames,
      affectedSectionKeys,
      hasChanges: changedFieldNames.length > 0 || requirements.some((r) => r.status !== "sin_cambio"),
    };
  }
}

// ProposalVersionRegistry — Fase 2 pieza 2: historial de versiones de
// insumos, para que la invalidación granular (Pieza 1, AE-02/AE-11) pueda
// explicar QUÉ insumo cambió, no solo QUE algo cambió. Subconjunto de
// licitaciones/packages/expediente/src/proposal-version.ts: `sealInputs`/
// `computeInputsHash`/`HashedInputs`/`InputsHash`/`ExpedienteInputs` YA viven
// en `sealed-inputs.ts` (portados en Fase 1) -- este módulo SOLO añade la
// clase de historial (`ProposalVersionRegistry`) y su función de comparación
// (`changedInputsSince`), que en el origen era "código muerto, 0
// referencias" hasta conectarse aquí a un flujo real (ver diseño §3).
//
// A diferencia del origen (un `ProposalVersionRegistry` en memoria, de vida
// tan larga como el proceso worker), aquí cada propuesta vive en Postgres:
// `PostgresLicitacionesRepository.syncExpedienteApprovalWithCurrentHash`
// persiste una fila nueva en `licitaciones.proposal_version` únicamente
// cuando el hash combinado CAMBIA respecto de la última versión registrada
// (nunca en cada lectura) -- ver migración 005_proposal_version_registry.sql.
import { sha256Hex } from "./types.ts";
import { sealInputs, type ExpedienteInputs, type HashedInputs } from "./sealed-inputs.ts";

export interface ProposalInputRecord {
  /** p. ej. "tender_version", "company_profile", "company_document:doc-32d", "rate:consultoria_hora". */
  readonly key: string;
  readonly hash: string;
}

export interface ProposalVersion {
  readonly version: number;
  /** `HashedInputs` sellado (EX-EXP-17): pásese tal cual a `ApprovalWorkflow.approve()`, nunca extraiga `.hash` "a mano" para reconstruir un `string`. */
  readonly hash: HashedInputs;
  readonly createdAt: string;
  readonly inputs: readonly ProposalInputRecord[];
}

/**
 * Forma de una versión tal como vive persistida (`licitaciones.proposal_version`):
 * a diferencia de `ProposalVersion` (que exige un `HashedInputs` SELLADO, es
 * decir, el `ExpedienteInputs` original completo + su hash), Postgres solo
 * guarda el hash combinado y el desglose `{key, hash}` por insumo (nunca los
 * `ExpedienteInputs` completos: sería redundante con lo que ya vive en
 * `licitaciones.tender`/`company_document`/`approved_rate`, y ablonaría la
 * fila). `ProposalVersionRegistry.diff` está diseñado para trabajar
 * directamente con este desglose -- no hace falta "re-sellar" nada para
 * comparar qué insumo cambió.
 */
export interface PersistedProposalVersion {
  readonly version: number;
  readonly hash: string;
  readonly inputs: readonly ProposalInputRecord[];
  readonly createdAt: string;
}

interface InputComponent {
  readonly key: string;
  readonly raw: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`ExpedienteInputs.${field} es obligatorio y debe ser una cadena no vacía: recibido ${JSON.stringify(value)}.`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`ExpedienteInputs.${field} es obligatorio y debe ser un arreglo (puede estar vacío, pero no omitirse): recibido ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * Descompone `inputs` en sus componentes individuales con clave estable --
 * réplica EXACTA de la descomposición interna de
 * `sealed-inputs.ts::computeInputsHash` (mismo orden canónico), necesaria
 * aquí para poder comparar insumo por insumo en vez de solo el hash
 * combinado. Ambos módulos deben permanecer sincronizados: si
 * `sealed-inputs.ts` cambia qué entra al hash, este módulo debe cambiar
 * igual (cubierto por `proposal-version-registry.spec.ts`, ver tests).
 */
function buildInputComponents(inputs: ExpedienteInputs): InputComponent[] {
  if (inputs === null || typeof inputs !== "object") {
    throw new Error("ExpedienteInputs debe ser un objeto con las 5 categorías obligatorias.");
  }
  const tenderVersionHash = requireString(inputs.tenderVersionHash, "tenderVersionHash");
  const companyProfileHash = requireString(inputs.companyProfileHash, "companyProfileHash");
  const companyDocuments = requireArray(inputs.companyDocuments, "companyDocuments") as ExpedienteInputs["companyDocuments"];
  const rates = requireArray(inputs.rates, "rates") as ExpedienteInputs["rates"];
  const templates = requireArray(inputs.templates, "templates") as ExpedienteInputs["templates"];

  const components: InputComponent[] = [];
  components.push({ key: "tender_version", raw: tenderVersionHash });
  components.push({ key: "company_profile", raw: companyProfileHash });

  for (const doc of [...companyDocuments].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    components.push({
      key: `company_document:${requireString(doc.documentId, "companyDocuments[].documentId")}`,
      raw: { hash: requireString(doc.hash, "companyDocuments[].hash"), vigenteHasta: doc.vigenteHasta ?? null },
    });
  }
  for (const rate of [...rates].sort((a, b) => a.concept.localeCompare(b.concept))) {
    components.push({ key: `rate:${requireString(rate.concept, "rates[].concept")}`, raw: { hash: requireString(rate.hash, "rates[].hash") } });
  }
  for (const tpl of [...templates].sort((a, b) => a.templateId.localeCompare(b.templateId))) {
    components.push({ key: `template:${requireString(tpl.templateId, "templates[].templateId")}`, raw: { hash: requireString(tpl.hash, "templates[].hash") } });
  }

  return components.sort((a, b) => a.key.localeCompare(b.key));
}

function buildInputRecords(inputs: ExpedienteInputs): ProposalInputRecord[] {
  return buildInputComponents(inputs).map(({ key, raw }) => ({ key, hash: sha256Hex(raw) }));
}

export class ProposalVersionRegistry {
  private readonly versions: ProposalVersion[] = [];

  /** Registra una nueva versión: hashea cada insumo individual y sella el conjunto completo con `sealInputs` (Fase 1). */
  createVersion(inputs: ExpedienteInputs): ProposalVersion {
    const version: ProposalVersion = {
      version: this.versions.length + 1,
      hash: sealInputs(inputs),
      createdAt: new Date().toISOString(),
      inputs: buildInputRecords(inputs),
    };
    this.versions.push(version);
    return version;
  }

  getVersion(version: number): ProposalVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  latest(): ProposalVersion | undefined {
    return this.versions[this.versions.length - 1];
  }

  all(): ProposalVersion[] {
    return [...this.versions];
  }

  /**
   * Compara los insumos ACTUALES contra una versión registrada y devuelve
   * las claves de los insumos que cambiaron desde entonces, incluyendo
   * insumos que existían antes y ya no están presentes (p. ej. un documento
   * retirado). A diferencia de comparar solo el hash combinado (que dice SI
   * algo cambió), esta función dice QUÉ cambió -- útil para que apps/api
   * explique al usuario por qué se invalidó una aprobación (ver diseño §3.2:
   * `syncExpedienteApprovalWithCurrentHash` consume esto para producir
   * `reason: "insumo_cambiado:rate:consultoria_hora"` en vez de un mensaje
   * opaco).
   */
  changedInputsSince(version: ProposalVersion, currentInputs: ExpedienteInputs): string[] {
    return ProposalVersionRegistry.diff(version.inputs, currentInputs);
  }

  /**
   * Misma comparación que `changedInputsSince`, pero sin requerir una
   * instancia con historial en memoria -- recibe directamente los
   * `ProposalInputRecord[]` de la última versión persistida (p. ej. leídos
   * de `licitaciones.proposal_version.inputs`). Es la forma que usa
   * `PostgresLicitacionesRepository`, que nunca mantiene un
   * `ProposalVersionRegistry` en memoria entre requests.
   */
  static diff(recordedInputs: readonly ProposalInputRecord[], currentInputs: ExpedienteInputs): string[] {
    const currentComponents = buildInputComponents(currentInputs);
    const currentKeys = new Set(currentComponents.map((c) => c.key));
    const changed = new Set<string>();

    for (const component of currentComponents) {
      const recorded = recordedInputs.find((i) => i.key === component.key);
      if (!recorded || recorded.hash !== sha256Hex(component.raw)) changed.add(component.key);
    }
    for (const recorded of recordedInputs) {
      if (!currentKeys.has(recorded.key)) changed.add(recorded.key);
    }
    return [...changed].sort();
  }

  /** Recalcula el hash de un insumo dado y compara contra el registrado en `version` -- permite detectar si cambió desde entonces. */
  static inputChanged(version: ProposalVersion, key: string, currentValue: unknown): boolean {
    const recorded = version.inputs.find((i) => i.key === key);
    if (!recorded) return true; // insumo nuevo, no existía en esa versión: se considera cambio.
    return recorded.hash !== sha256Hex(currentValue);
  }
}

/** Expuesto para que el adaptador de repositorio pueda descomponer `ExpedienteInputs` sin duplicar esta lógica. */
export function buildProposalInputRecords(inputs: ExpedienteInputs): ProposalInputRecord[] {
  return buildInputRecords(inputs);
}

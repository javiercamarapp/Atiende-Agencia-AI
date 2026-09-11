// Subconjunto de licitaciones/packages/expediente/src/proposal-version.ts
// (ver diseño Fase 1 §3.1): solo `sealInputs`/`computeInputsHash`/
// `requireValidHashedInputs`/`HashedInputs`/`InvalidInputsHashError`/
// `ExpedienteInputs` — SIN `ProposalVersionRegistry` completo (historial de
// versiones, fuera de fase). Necesario para que "ready" en Flujo 3 no pueda
// mentir (EX-EXP-17 del origen): `PackageAssembler.buildManifest` exige un
// `HashedInputs` sellado por este módulo, nunca un `string` calculado a mano.
import { sha256Hex } from "./types.ts";

/**
 * Símbolo PRIVADO del módulo (nunca exportado): única forma de que un objeto
 * cuente como "sellado" por `sealInputs`/`computeInputsHash`. Ningún código
 * externo puede añadir esta clave como propiedad PROPIA de un objeto nuevo.
 */
const SEALED_MARKER: unique symbol = Symbol("licitaciones:HashedInputs");

/**
 * Registra, por IDENTIDAD de objeto (nunca por estructura ni por herencia),
 * únicamente las instancias que `sealInputs` construyó y devolvió — bloquea
 * el caso `Object.create(selladoAjeno)` que solo heredaría el símbolo.
 */
const sealedInstances = new WeakSet<object>();

declare const INPUTS_HASH_BRAND: unique symbol;

/** Hash de insumos de alcance "expediente", producido EXCLUSIVAMENTE por `computeInputsHash(inputs)`. */
export type InputsHash = string & { readonly [INPUTS_HASH_BRAND]: true };

/** Envoltorio sellado de un hash de insumos ya verificado: conserva tanto el `ExpedienteInputs` de origen como su `InputsHash`. */
export interface HashedInputs {
  readonly inputs: ExpedienteInputs;
  readonly hash: InputsHash;
}

/** Lanzado cuando `buildManifest()`/`approveExpediente` reciben algo que no es un `HashedInputs` sellado producido por `sealInputs`/`computeInputsHash` de este módulo. */
export class InvalidInputsHashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInputsHashError";
  }
}

interface SealedHashedInputs extends HashedInputs {
  readonly [SEALED_MARKER]: true;
}

function isSealedHashedInputs(value: unknown): value is SealedHashedInputs {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.hasOwn(value, SEALED_MARKER) &&
    (value as Record<symbol, unknown>)[SEALED_MARKER] === true &&
    Object.hasOwn(value, "inputs") &&
    Object.hasOwn(value, "hash") &&
    sealedInstances.has(value)
  );
}

/** Sella `inputs` en un `HashedInputs` verificable: calcula su `InputsHash` canónico y adjunta el símbolo privado que `requireValidHashedInputs` exige. */
export function sealInputs(inputs: ExpedienteInputs): HashedInputs {
  const hash = computeInputsHash(inputs);
  const sealed: SealedHashedInputs = {
    inputs,
    hash,
    [SEALED_MARKER]: true,
  };
  sealedInstances.add(sealed);
  return sealed;
}

/**
 * Verifica que `value` sea un `HashedInputs` legítimo antes de usarlo para
 * decidir una aprobación/ensamblaje. Fail-closed: cualquier discrepancia
 * lanza `InvalidInputsHashError`, nunca deja pasar un valor dudoso.
 */
export function requireValidHashedInputs(value: unknown, label: string): HashedInputs {
  if (typeof value === "string") {
    throw new InvalidInputsHashError(
      `${label}: se recibió un hash de insumos como STRING PLANO ("${value}"). Esto está deprecado por inseguro: cualquier string suelto —incluso uno "correcto" calculado por fuera— podía aprobar/ensamblar un expediente sin relación real con sus insumos. Use computeInputsHash(inputs) + sealInputs(inputs) y pase ese HashedInputs aquí.`,
    );
  }
  if (!isSealedHashedInputs(value)) {
    throw new InvalidInputsHashError(`${label}: se esperaba un HashedInputs producido por sealInputs()/computeInputsHash() de este módulo; se recibió un objeto sin el sello interno.`);
  }
  const recomputed = computeInputsHash(value.inputs);
  if (recomputed !== value.hash) {
    throw new InvalidInputsHashError(
      `${label}: los ExpedienteInputs sellados fueron MUTADOS después de sellarse — el hash recalculado ("${recomputed}") ya no coincide con el hash registrado ("${value.hash}").`,
    );
  }
  return { inputs: value.inputs, hash: value.hash };
}

/** Documento de empresa efectivamente usado para redactar el expediente, con su vigencia. */
export interface ExpedienteInputCompanyDocument {
  readonly documentId: string;
  readonly hash: string;
  /** ISO 8601 con offset explícito, o `null` si el documento no tiene vigencia definida. */
  readonly vigenteHasta: string | null;
}

/** Tarifa efectivamente usada en la propuesta económica. */
export interface ExpedienteInputRate {
  readonly concept: string;
  readonly hash: string;
}

/** Plantilla usada para redactar carta/anexos. */
export interface ExpedienteInputTemplate {
  readonly templateId: string;
  readonly hash: string;
}

/**
 * Conjunto CERRADO y OBLIGATORIO de insumos de alcance "expediente": versión
 * de bases, documentos de empresa usados (con vigencia), tarifas usadas,
 * datos de perfil usados y plantillas. Es el ÚNICO tipo que `computeInputsHash`
 * acepta — TypeScript exige que las cinco categorías estén presentes (los
 * arreglos pueden estar vacíos si genuinamente no aplican, pero el campo no
 * puede omitirse).
 */
export interface ExpedienteInputs {
  /** Hash de la versión de bases/convocatoria vigente al construir la propuesta. */
  readonly tenderVersionHash: string;
  /** Hash de los datos de perfil de empresa (razón social, RFC, firmantes, etc.) usados. */
  readonly companyProfileHash: string;
  readonly companyDocuments: ExpedienteInputCompanyDocument[];
  readonly rates: ExpedienteInputRate[];
  readonly templates: ExpedienteInputTemplate[];
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

interface InputComponent {
  readonly key: string;
  readonly raw: unknown;
}

function buildInputComponents(inputs: ExpedienteInputs): InputComponent[] {
  if (inputs === null || typeof inputs !== "object") {
    throw new Error("ExpedienteInputs debe ser un objeto con las 5 categorías obligatorias.");
  }
  const tenderVersionHash = requireString(inputs.tenderVersionHash, "tenderVersionHash");
  const companyProfileHash = requireString(inputs.companyProfileHash, "companyProfileHash");
  const companyDocuments = requireArray(inputs.companyDocuments, "companyDocuments") as ExpedienteInputCompanyDocument[];
  const rates = requireArray(inputs.rates, "rates") as ExpedienteInputRate[];
  const templates = requireArray(inputs.templates, "templates") as ExpedienteInputTemplate[];

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

function buildInputRecords(inputs: ExpedienteInputs): { key: string; hash: string }[] {
  return buildInputComponents(inputs).map(({ key, raw }) => ({ key, hash: sha256Hex(raw) }));
}

/** Hash canónico de TODOS los insumos de alcance "expediente". Única función soportada para producir el `currentInputsHash` que consume `PackageAssembler`. */
export function computeInputsHash(inputs: ExpedienteInputs): InputsHash {
  return sha256Hex(buildInputRecords(inputs)) as InputsHash;
}

// Fase 9 licitaciones — tipos MÍNIMOS de un release/record OCDS (Open
// Contracting Data Standard), recortados a los campos que
// `map-ocds-release.ts` necesita leer para producir un
// `TenderSourceIngestCandidate` (ver `../types.ts`). NO es un puerto del
// esquema OCDS completo (cientos de campos) -- deliberadamente laxo
// (`unknown`/opcional en casi todo) porque las DOS fuentes reales verificadas
// en esta fase (Nuevo León, ver `nl-ocds-connector.ts`) publican releases con
// forma irregular respecto del esquema oficial (ver comentario de
// `map-ocds-release.ts` sobre `classification` sin `scheme`/`id` -- solo
// `description`, con el código real viviendo en `additionalClassifications`)
// -- un tipo estricto habría rechazado datos reales observados en producción.

export interface OcdsAmount {
  readonly amount?: number | null;
  readonly currency?: string | null;
}

export interface OcdsPeriod {
  readonly startDate?: string | null;
  readonly endDate?: string | null;
}

export interface OcdsOrganizationReference {
  readonly id?: string | null;
  readonly name?: string | null;
}

/**
 * Clasificador de un `tender.items[]`. El esquema OCDS oficial declara
 * `{scheme, id, description, uri}`, pero la API real de Nuevo León (ver
 * evidencia en `nl-ocds-connector.ts`) publica `classification` SOLO con
 * `description` (texto libre, sin `id`/`scheme`) y mete el código real
 * (numérico, tipo partida CUCoP) en `additionalClassifications[].id` -- por
 * eso ambos se tipan aquí y `map-ocds-release.ts` lee de los dos.
 */
export interface OcdsClassification {
  readonly scheme?: string | null;
  readonly id?: string | number | null;
  readonly description?: string | null;
}

export interface OcdsItem {
  readonly id?: string | number | null;
  readonly description?: string | null;
  readonly classification?: OcdsClassification | null;
  readonly additionalClassifications?: readonly OcdsClassification[] | null;
}

export interface OcdsTender {
  readonly id?: string | number | null;
  readonly title?: string | null;
  readonly status?: string | null;
  readonly statusDetails?: string | null;
  readonly procuringEntity?: OcdsOrganizationReference | null;
  readonly procurementMethod?: string | null;
  readonly procurementMethodDetails?: string | null;
  readonly value?: OcdsAmount | null;
  readonly items?: readonly OcdsItem[] | null;
  readonly tenderPeriod?: OcdsPeriod | null;
}

/** Un release OCDS individual (evento incremental) -- forma que devuelve `/api/releases` de Nuevo León. */
export interface OcdsRelease {
  readonly ocid?: string | null;
  readonly id?: string | null;
  readonly date?: string | null;
  readonly tag?: readonly string[] | null;
  readonly buyer?: OcdsOrganizationReference | null;
  readonly tender?: OcdsTender | null;
  /** Presente únicamente en un "record" (paquete de tipo `record_package`) -- el estado YA COMPILADO de ese ocid, preferido sobre reconstruirlo a mano a partir de releases sueltos cuando existe (ver `map-ocds-release.ts`). */
  readonly compiledRelease?: OcdsRelease | null;
}

/** `release_package` OCDS estándar: `{releases: OcdsRelease[]}` en su forma más simple (sin envolver por publicación). */
export interface OcdsReleasePackage {
  readonly releases?: readonly OcdsRelease[] | null;
}

/** `record_package` OCDS estándar: `{records: [{ocid, compiledRelease, releases}]}`. */
export interface OcdsRecord {
  readonly ocid?: string | null;
  readonly compiledRelease?: OcdsRelease | null;
  readonly releases?: readonly OcdsRelease[] | null;
}

export interface OcdsRecordPackage {
  readonly records?: readonly OcdsRecord[] | null;
}

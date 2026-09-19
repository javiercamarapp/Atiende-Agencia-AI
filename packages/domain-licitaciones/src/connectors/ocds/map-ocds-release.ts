// Fase 9 licitaciones — parser OCDS PURO y genérico: de un release/record OCDS
// (ver `types.ts`) a `TenderSourceIngestCandidate` (`../types.ts`). Sin IO,
// determinista, reutilizado por CUALQUIER conector que hable OCDS (hoy:
// `nl-ocds-connector.ts`, verificado contra la API real de Nuevo León,
// `https://api-ocds.nl.gob.mx/api/releases` -- ver evidencia real en ese
// archivo y en `connector-registry.ts`). `cdmx-ocds-connector.ts` NO usa este
// parser -- ver su comentario de cabecera para la desviación deliberada
// (CDMX Tianguis Digital no expone un endpoint OCDS estable/respetuoso de
// automatizar, verificado con peticiones reales antes de escribir código; su
// fuente real accesible es un CSV plano, no OCDS).
import type { TenderSourceIngestCandidate } from "../types.ts";
import type { OcdsClassification, OcdsRecord, OcdsRelease, OcdsTender } from "./types.ts";

export interface MapOcdsReleaseResultOk {
  readonly candidate: TenderSourceIngestCandidate;
}
export interface MapOcdsReleaseResultDropped {
  readonly droppedReason: string;
}
export type MapOcdsReleaseResult = MapOcdsReleaseResultOk | MapOcdsReleaseResultDropped;

export function isDroppedResult(result: MapOcdsReleaseResult): result is MapOcdsReleaseResultDropped {
  return "droppedReason" in result;
}

/**
 * Resuelve el "estado actual conocido" de un release/record OCDS:
 *  - `record.compiledRelease` si existe (record package -- ya es el estado
 *    compilado por la fuente, preferido sobre reconstruirlo).
 *  - si no, `release.compiledRelease` (algunas fuentes lo anidan igual dentro
 *    de un release suelto).
 *  - si no, el propio `release`/`record` tal cual -- caso de un release
 *    package sin compilar (como Nuevo León, ver `nl-ocds-connector.ts`), donde
 *    el LLAMADOR ya resolvió "el release más reciente por ocid" antes de
 *    invocar este mapeador (deduplicación de historial, ver ese archivo) --
 *    este módulo nunca decide "cuál release es el más reciente", solo mapea
 *    UNO ya resuelto.
 */
function resolveEffective(input: OcdsRelease | OcdsRecord): OcdsRelease {
  const asRecord = input as OcdsRecord;
  if (asRecord.compiledRelease) return asRecord.compiledRelease;
  const asRelease = input as OcdsRelease;
  if (asRelease.compiledRelease) return asRelease.compiledRelease;
  return asRelease;
}

function toStringId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * Vigencia (REQ del brief): un tender se considera VIGENTE (candidato a
 * ingesta) cuando su `tender.status` es `"active"` (declarado por la propia
 * fuente) Y/O su `tender.tenderPeriod.endDate` está en el futuro respecto de
 * `now`. Unión deliberada, no intersección -- evidencia real contra Nuevo
 * León (ver `nl-ocds-connector.ts`): de 615 releases reales con
 * `status: "active"` verificados en esta fase, NINGUNO traía
 * `tenderPeriod` -- exigir AMBOS habría descartado el 100% de las
 * convocatorias activas reales de esta fuente. Un `tenderPeriod.endDate`
 * futuro con `status` distinto de `"active"` (fuente inconsistente) también
 * cuenta como vigente -- el plazo real observado pesa más que una etiqueta de
 * estado que la fuente pudo no haber actualizado todavía.
 */
export function isVigenteTender(tender: OcdsTender | null | undefined, now: Date): boolean {
  if (!tender) return false;
  if (tender.status === "active") return true;
  const endDate = tender.tenderPeriod?.endDate;
  if (!endDate) return false;
  const parsed = new Date(endDate);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() > now.getTime();
}

function isIsoWithOffset(value: string): boolean {
  // Exige offset explícito (`Z` o `+HH:MM`/`-HH:MM`) -- nunca se asume una zona no declarada por la fuente (ver instrucciones del proyecto: "ISO 8601 con offset explícito").
  return /T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

/**
 * Recolecta códigos de clasificación de `tender.items[]` -- de
 * `classification.id` (esquema OCDS estándar) Y de
 * `additionalClassifications[].id` (donde Nuevo León pone el código real
 * partida/CUCoP-like, ver `types.ts`). Decisión CPV/CUCOP (ver README de la
 * vertical para el detalle completo): `TenderSourceIngestCandidate.cpvCodes`
 * es `string[]` PLANO, sin campo `scheme` (`connectors/types.ts` no lo
 * modela) -- se conserva el código TAL CUAL lo publica la fuente (sin
 * reetiquetar/normalizar CPV vs CUCoP vs UNSPSC), porque
 * `matching-engine.ts::scoreClassifiers` ya compara por PREFIJO JERÁRQUICO
 * numérico contra `profile.classifierCodes`, agnóstico del esquema -- tanto
 * CUCoP/UNSPSC (numéricos, jerárquicos, el caso real de Nuevo León) como CPV
 * europeo (también numérico) funcionan con esa regla sin normalización
 * adicional; forzar un prefijo de esquema (p. ej. `"CUCoP:43211500"`) habría
 * roto esa comparación por prefijo para cualquier organización que configure
 * su perfil con el código desnudo (el caso normal). `classification.description`
 * (texto libre, sin código) se descarta -- no es un clasificador utilizable
 * por `scoreClassifiers`.
 */
function collectClassifierCodes(tender: OcdsTender): string[] {
  const codes = new Set<string>();
  for (const item of tender.items ?? []) {
    const direct = toStringId(item?.classification?.id ?? null);
    if (direct) codes.add(direct);
    for (const extra of item?.additionalClassifications ?? []) {
      const id = toStringId(extra?.id ?? null);
      if (id) codes.add(id);
    }
  }
  return [...codes];
}

export interface MapOcdsReleaseOptions {
  /** `TenderRecord.state` fijo de la instancia del conector (una federación/entidad OCDS no declara su propia entidad federativa dentro del release -- se conoce estructuralmente por CUÁL fuente se está consultando, mismo criterio que `compras-mx-historico.ts::publishingEntity`). `null` si la fuente no tiene un estado fijo conocido (p. ej. cobertura nacional). */
  readonly fixedState: string | null;
}

/**
 * Mapea UN release/record OCDS YA RESUELTO (ver `resolveEffective`) a
 * `TenderSourceIngestCandidate`, o a un motivo de descarte (SR-16/17/21 del
 * origen: nunca desaparece en silencio). El LLAMADOR decide si invocar esto
 * (p. ej. filtrando primero por `isVigenteTender`) -- esta función no filtra
 * vigencia, solo mapea forma.
 */
export function mapOcdsReleaseToCandidate(input: OcdsRelease | OcdsRecord, options: MapOcdsReleaseOptions): MapOcdsReleaseResult {
  const effective = resolveEffective(input);
  const ocid = toStringId(effective.ocid ?? (input as OcdsRecord).ocid ?? null);
  if (!ocid) return { droppedReason: "Release/record sin ocid -- no hay clave natural de dedupe (OCID es obligatorio en OCDS)." };

  const tender = effective.tender;
  const title = tender?.title?.trim();
  if (!title) return { droppedReason: `ocid ${ocid}: sin tender.title -- no se fabrica un título.` };

  let submissionDeadline: string | null = null;
  const endDate = tender?.tenderPeriod?.endDate;
  if (endDate) {
    if (!isIsoWithOffset(endDate)) {
      return { droppedReason: `ocid ${ocid}: tender.tenderPeriod.endDate ("${endDate}") no trae offset de zona explícito -- se descarta en vez de asumir uno no declarado por la fuente.` };
    }
    submissionDeadline = endDate;
  }

  const contractingBody = effective.buyer?.name?.trim() || tender?.procuringEntity?.name?.trim() || null;
  const cpvCodes = tender ? collectClassifierCodes(tender) : [];
  const budgetAmount = typeof tender?.value?.amount === "number" && Number.isFinite(tender.value.amount) ? tender.value.amount : null;
  const currency = tender?.value?.currency?.trim() || "MXN";
  const procedureTypeRaw = tender?.procurementMethodDetails?.trim() || tender?.procurementMethod?.trim() || null;

  const candidate: TenderSourceIngestCandidate = {
    externalId: ocid,
    title,
    submissionDeadline,
    contractingBody,
    cpvCodes,
    budgetAmount,
    currency,
    state: options.fixedState,
    procedureTypeRaw,
  };
  return { candidate };
}

/** Reexportado para que los conectores/tests puedan inspeccionar un clasificador crudo sin duplicar el tipo. */
export type { OcdsClassification };

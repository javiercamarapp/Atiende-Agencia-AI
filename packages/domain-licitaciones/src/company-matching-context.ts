// Contexto de empresa para la ELEGIBILIDAD del matching (REQ-142): restricciones + procedencia, leidos del repositorio.
// Base sin migrar: el repositorio devuelve [] y el contexto queda vacio, asi que el motor se comporta exactamente como antes.
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { CompanyMatchingContext } from "./matching-engine.ts";
import { ProvenanceIndex } from "./company-profile.ts";
import type { LicitacionesRepository } from "./repository.ts";
import type { TenderRecord } from "./types.ts";

/** Medianoche-Ciudad de Mexico: offset fijo -06:00 (mismo criterio que `dates.ts`). */
const MEXICO_CITY_OFFSET_MS = 6 * 60 * 60 * 1000;

/** Fecha del acto "YYYY-MM-DD": el dia de la fecha limite de la convocatoria (hora de Mexico); sin fecha limite, el dia de negocio de hoy. */
export function matchingAsOfDate(tender: Pick<TenderRecord, "submissionDeadline">, hoy: string = hoyFechaNegocio()): string {
  if (!tender.submissionDeadline) return hoy;
  const ms = new Date(tender.submissionDeadline).getTime();
  return Number.isNaN(ms) ? hoy : new Date(ms - MEXICO_CITY_OFFSET_MS).toISOString().slice(0, 10);
}

/** Restricciones y procedencia de la organizacion, listas para `MatchingEngine.score(..., contexto)`. `null` si no hay restricciones capturadas. */
export async function loadCompanyMatchingContext(repo: LicitacionesRepository, organizationId: string, tender: Pick<TenderRecord, "submissionDeadline">): Promise<CompanyMatchingContext | null> {
  const restrictions = await repo.listCompanyRestrictions(organizationId);
  if (restrictions.length === 0) return null;
  const provenance = new ProvenanceIndex(await repo.listFieldProvenance(organizationId));
  return { restrictions, provenance, asOfDate: matchingAsOfDate(tender) };
}

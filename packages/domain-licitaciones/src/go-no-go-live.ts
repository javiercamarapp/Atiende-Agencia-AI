// Snapshot VIVO del matching que sustenta una decision go/no-go. Compartido por la ruta
// REST (`goNoGo.ts`) y por la decision por boton de WhatsApp (L-05): ninguna de las dos
// acepta un score que el solicitante proponga -- siempre se recalcula contra el perfil
// de matching y la convocatoria vigentes.
import { MatchingEngine, buildMatchInputsSnapshot, computeMatchInputsHash, toOrganizationMatchingProfile } from "./matching-engine.ts";
import type { EligibilityStatus } from "./matching-engine.ts";
import { loadCompanyMatchingContext } from "./company-matching-context.ts";
import type { LicitacionesRepository } from "./repository.ts";
import type { TenderRecord } from "./types.ts";

export interface LiveGoNoGoMatchSnapshot {
  readonly matchScore: number;
  readonly matchEligibilityStatus: EligibilityStatus;
  readonly matchInputsHash: string;
}

const engine = new MatchingEngine();

export async function computeLiveGoNoGoMatch(repo: LicitacionesRepository, organizationId: string, tender: TenderRecord): Promise<LiveGoNoGoMatchSnapshot> {
  const profileRecord = await repo.findMatchingProfile(organizationId);
  const profile = toOrganizationMatchingProfile(profileRecord, organizationId);
  // REQ-142: las restricciones vigentes de la empresa (con procedencia) entran a la elegibilidad. Sin restricciones capturadas: null.
  const company = (await loadCompanyMatchingContext(repo, organizationId, tender)) ?? undefined;
  const matchResult = engine.score(tender, profile, company);
  return {
    matchScore: matchResult.score,
    matchEligibilityStatus: matchResult.eligibility.status,
    matchInputsHash: computeMatchInputsHash(buildMatchInputsSnapshot(tender, profileRecord, company)),
  };
}

// Cliente web de la propuesta técnica (Fase 12 pieza acotada) — cierra el
// hallazgo ALTA de auditoría: "technicalProposal.ts expone
// POST .../proposal/technical/generate y PUT .../requirement-mappings/:topicKey
// (DECISION_ROLES) -- ninguno tiene cliente ni página", continuación natural
// del flujo central tras RequisitosConvocatoria.tsx (que ya sube el PDF y
// muestra los requisitos extraídos).
//
//  - GET .../proposal (`licitacionesProposalRoutes`, proposalEconomic.ts):
//    lazy-crea el `ProposalRecord` de esta convocatoria si todavía no existe
//    -- prerrequisito real de `proposal/technical/generate`
//    (`technicalProposal.ts::repo.findProposal` devuelve 404 explícito, "Genere
//    primero la propuesta...", si nadie llamó esto antes). Esta pieza SOLO
//    necesita el GET (lazy-create) como prerrequisito -- la propuesta
//    ECONÓMICA (`POST .../proposal/economic/generate`) sigue fuera de
//    alcance, ver README de este vertical.
//  - POST .../proposal/technical/generate (WRITE_ROLES en el servidor):
//    corre `TechnicalProposalBuilder` sobre los requisitos ya extraídos +
//    datos de empresa aprobados + el mapeo configurado, persiste las
//    secciones técnicas y devuelve un resumen (nunca el contenido completo
//    de cada sección -- eso vive en `licitaciones.proposal_section`, fuera
//    de alcance de esta pieza mostrarlo aquí, ver README).
//  - PUT .../requirement-mappings/:topicKey (DECISION_ROLES en el servidor):
//    configura de qué dato de empresa se redacta un requisito de cierto
//    tema. Sin GET equivalente en el backend (no existe todavía un
//    `GET .../requirement-mappings`) -- este cliente solo transporta el
//    upsert; la pantalla que lo consume no puede precargar el valor
//    guardado previamente, solo confirmar el que el usuario acaba de
//    enviar (ver comentario de cabecera de PropuestaTecnica.tsx).
import { fetchJson, postJson, putJson } from "./admin-client.ts";

/** Espejo de `technicalProposal.ts::licitacionesTechnicalProposalRoutes` -- resumen de UNA sección amplia (agrupa varias `ProposalSection` finas por `SECTION_KEY_BY_REQUIREMENT_TYPE`); el contenido redactado completo no viaja aquí, solo su identidad. */
export interface TechnicalSectionSummary {
  readonly sectionKey: string;
  readonly label: string;
}

/** Espejo de `extractNotApplicableRequirements` (domain-licitaciones/technical-proposal.ts) -- un requisito opcional o condicional evaluado explícitamente como no aplicable, con la razón visible (nunca desaparece en silencio). */
export interface NotApplicableRequirement {
  readonly requirementId: string;
  readonly reason: string;
}

export interface GenerateTechnicalProposalResult {
  readonly sections: readonly TechnicalSectionSummary[];
  readonly blockers: number;
  readonly notApplicableRequirements: readonly NotApplicableRequirement[];
  readonly correlationId: string | null;
}

/**
 * `POST .../proposal/technical/generate` -- WRITE_ROLES en el servidor (ver
 * `technicalProposal.ts`); esta función no valida rol, solo transporta. Exige
 * `idempotency-key` (mismo criterio que `extractRequirements`): se genera una
 * nueva por cada intento para que un doble clic/reintento de red nunca corra
 * la generación (y su persistencia de secciones) dos veces.
 *
 * `conditionEvaluations` declara, por `requirementId`, si un requisito
 * `obligatoriedad === "condicional"` aplica al caso concreto (`true`), no
 * aplica (`false`), o se omite (fail-closed, tratado como "no evaluable" --
 * ver `evaluateObligatorioLike` en `technical-proposal.ts`). Un requisito
 * `obligatorio` u `opcional` ignora este mapa por completo.
 */
export async function generateTechnicalProposal(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  conditionEvaluations: Readonly<Record<string, boolean>> = {},
  idempotencyKey: string = crypto.randomUUID(),
): Promise<GenerateTechnicalProposalResult> {
  return postJson<GenerateTechnicalProposalResult>(
    fetchImpl,
    `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/proposal/technical/generate`,
    token,
    { conditionEvaluations },
    { "idempotency-key": idempotencyKey },
  );
}

/** Forma persistida (`ProposalRecord`, `proposalEconomic.ts::serializeProposal`) -- solo los campos que esta pieza necesita: confirmar que existe (prerrequisito de `generateTechnicalProposal`) y, si ya se generó antes, leer `generationReport.technical` (qué documentos de empresa se usaron / qué requisitos se marcaron no aplica en la ÚLTIMA generación exitosa). */
export interface ProposalRecord {
  readonly id: string;
  readonly tenderId: string;
  readonly title: string;
  readonly generationReport: {
    readonly technical?: {
      readonly usedCompanyDocumentIds?: readonly string[];
      readonly notApplicableRequirements?: readonly NotApplicableRequirement[];
    };
  } | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

/** `GET .../proposal` -- lazy-crea el `ProposalRecord` si no existe todavía (ver `proposalEconomic.ts::licitacionesProposalRoutes`, ruta compartida entre el flujo económico y este). Sin rol restringido en el servidor (cualquier miembro autenticado de la property puede disparar la creación lazy) -- se llama siempre antes de ofrecer el botón de generar, nunca antes se asume que ya existe. */
export async function fetchOrCreateProposal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ProposalRecord> {
  return fetchJson<ProposalRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/proposal`, token);
}

export type RequirementFulfillmentMappingKind = "capability" | "experience" | "document" | "signer";

/** Espejo de `RequirementFulfillmentMappingRecord` (domain-licitaciones/repository.ts) -- lo que devuelve el PUT tras guardar. */
export interface RequirementFulfillmentMappingRecord {
  readonly id: string;
  readonly topicKey: string;
  readonly kind: RequirementFulfillmentMappingKind;
  readonly refKey: string;
  readonly statementTemplate: string;
}

export interface RequirementFulfillmentMappingInput {
  readonly kind: RequirementFulfillmentMappingKind;
  readonly refKey: string;
  readonly statementTemplate: string;
}

/**
 * `PUT .../requirement-mappings/:topicKey` -- DECISION_ROLES en el servidor
 * (`assertVerticalRole(c, DECISION_ROLES)`, más estricto que WRITE_ROLES: qué
 * dato de empresa redacta un requisito es una decisión editorial/de riesgo,
 * nunca redacción libre, ver cabecera de `technicalProposal.ts`). Esta
 * función no valida rol, solo transporta -- el enforcement real es siempre
 * server-side.
 */
export async function upsertRequirementMapping(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  topicKey: string,
  input: RequirementFulfillmentMappingInput,
): Promise<RequirementFulfillmentMappingRecord> {
  return putJson<RequirementFulfillmentMappingRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/requirement-mappings/${encodeURIComponent(topicKey)}`, token, input);
}

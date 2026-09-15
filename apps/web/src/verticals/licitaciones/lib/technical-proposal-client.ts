// Cliente web de la propuesta técnica + económica (Fase 12/13, piezas
// acotadas) — cierra el hallazgo ALTA de auditoría: "technicalProposal.ts
// expone POST .../proposal/technical/generate y
// PUT .../requirement-mappings/:topicKey (DECISION_ROLES) -- ninguno tiene
// cliente ni página", continuación natural del flujo central tras
// RequisitosConvocatoria.tsx (que ya sube el PDF y muestra los requisitos
// extraídos).
//
//  - GET .../proposal (`licitacionesProposalRoutes`, proposalEconomic.ts):
//    lazy-crea el `ProposalRecord` de esta convocatoria si todavía no existe
//    -- prerrequisito real de `proposal/technical/generate`
//    (`technicalProposal.ts::repo.findProposal` devuelve 404 explícito, "Genere
//    primero la propuesta...", si nadie llamó esto antes) y de
//    `proposal/economic/generate` (mismo lazy-create, ver abajo). Un único
//    GET sirve a ambos flujos -- no se duplica.
//  - POST .../proposal/technical/generate (WRITE_ROLES en el servidor):
//    corre `TechnicalProposalBuilder` sobre los requisitos ya extraídos +
//    datos de empresa aprobados + el mapeo configurado, persiste las
//    secciones técnicas y devuelve un resumen (nunca el contenido completo
//    de cada sección -- eso vive en `licitaciones.proposal_section`, fuera
//    de alcance de esta pieza mostrarlo aquí, ver README).
//  - POST .../proposal/economic/generate (Fase 13, WRITE_ROLES en el
//    servidor, `proposalEconomic.ts`): corre `EconomicProposalBuilder` sobre
//    una lista de `{concept, quantity}` que el staff captura a mano contra
//    las tarifas APROBADAS y vigentes a la fecha del acto
//    (`resolveExpedienteAsOfIso`). Regla dura del dominio (REQ-LIC-006/A8):
//    un solo concepto sin tarifa aprobada/vigente bloquea el TOTAL COMPLETO
//    -- `totals` viaja `null` y `blockedLineItems` lista el detalle, nunca un
//    total parcial silencioso. Exige `idempotency-key` (mismo criterio que
//    `generateTechnicalProposal`): un reintento manual siempre genera una key
//    nueva para que un doble clic nunca corra el cálculo dos veces.
//  - PUT .../requirement-mappings/:topicKey (DECISION_ROLES en el servidor):
//    configura de qué dato de empresa se redacta un requisito de cierto
//    tema. Sin GET equivalente en el backend (no existe todavía un
//    `GET .../requirement-mappings`) -- este cliente solo transporta el
//    upsert; la pantalla que lo consume no puede precargar el valor
//    guardado previamente, solo confirmar el que el usuario acaba de
//    enviar (ver comentario de cabecera de PropuestaTecnica.tsx).
//
// Fuera de esta pieza (Fase 13), a propósito: checklist/aprobaciones, el ZIP
// de cierre y todo lo post-adjudicación -- alcance de rondas futuras, ver
// README de este vertical.
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

/** Espejo de `EconomicTotals` (domain-licitaciones/economic-proposal.ts) -- `null` cuando CUALQUIER concepto solicitado queda bloqueado (REQ-LIC-006/A8: nunca un total parcial silencioso). Los montos ya viajan como `DecimalString` en el borde HTTP, nunca como bigint/centavos. */
export interface EconomicTotals {
  readonly currency: "MXN";
  readonly subtotal: string;
  readonly ivaRate: number;
  readonly iva: string;
  readonly total: string;
  readonly totalInWords: string;
}

/** Forma persistida (`ProposalRecord`, `proposalEconomic.ts::serializeProposal`) -- solo los campos que esta pieza necesita: confirmar que existe (prerrequisito de `generateTechnicalProposal`/`generateEconomicProposal`) y, si ya se generó antes, leer `generationReport.technical`/`generationReport.economic` (qué se usó/bloqueó en la ÚLTIMA generación exitosa de cada flujo). */
export interface ProposalRecord {
  readonly id: string;
  readonly tenderId: string;
  readonly title: string;
  readonly ivaRate: number;
  readonly economicTotals: EconomicTotals | null;
  readonly generationReport: {
    readonly technical?: {
      readonly usedCompanyDocumentIds?: readonly string[];
      readonly notApplicableRequirements?: readonly NotApplicableRequirement[];
    };
    readonly economic?: {
      readonly usedRateConcepts?: readonly string[];
      readonly blockedLineItems?: readonly EconomicLineItemBlocked[];
      readonly totals?: EconomicTotals | null;
    };
  } | null;
  readonly correlationId: string | null;
  readonly createdAt: string;
}

export interface EconomicLineItemInput {
  readonly concept: string;
  readonly quantity: number;
}

/** Espejo de `EconomicLineItemResolved` serializado en el borde HTTP (`proposalEconomic.ts::serializeLineItem`) -- `unitPrice`/`subtotal` ya vienen como `DecimalString`, la conversión desde centavos (bigint) es un detalle interno del dominio que nunca cruza HTTP. */
export interface EconomicLineItemResolved {
  readonly concept: string;
  readonly quantity: number;
  readonly unitPrice: string;
  readonly subtotal: string;
  readonly sourceRef: { readonly kind: string; readonly refId: string; readonly capturedAt: string | null };
}

/** Espejo de `EconomicLineItemBlocked` (domain-licitaciones/economic-proposal.ts) -- un concepto SIN tarifa aprobada y vigente a la fecha del acto ("missing": nunca se capturó tarifa para ese concepto; "blocked": existe pero no aprobada/vencida). */
export interface EconomicLineItemBlocked {
  readonly concept: string;
  readonly status: "missing" | "blocked";
  readonly detail: string;
}

export interface GenerateEconomicProposalResult {
  readonly proposal: ProposalRecord;
  readonly economic: {
    readonly lineItems: readonly EconomicLineItemResolved[];
    readonly blockedLineItems: readonly EconomicLineItemBlocked[];
    readonly totals: EconomicTotals | null;
  };
}

/** `GET .../proposal` -- lazy-crea el `ProposalRecord` si no existe todavía (ver `proposalEconomic.ts::licitacionesProposalRoutes`, ruta compartida entre el flujo económico y este). Sin rol restringido en el servidor (cualquier miembro autenticado de la property puede disparar la creación lazy) -- se llama siempre antes de ofrecer el botón de generar, nunca antes se asume que ya existe. */
export async function fetchOrCreateProposal(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, tenderId: string): Promise<ProposalRecord> {
  return fetchJson<ProposalRecord>(fetchImpl, `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/proposal`, token);
}

/**
 * `POST .../proposal/economic/generate` (Fase 13) -- WRITE_ROLES en el
 * servidor (ver `proposalEconomic.ts`); esta función no valida rol, solo
 * transporta. Exige `idempotency-key` (mismo criterio que
 * `generateTechnicalProposal`): se genera una nueva por cada intento para que
 * un doble clic/reintento de red nunca corra el cálculo económico (y su
 * persistencia) dos veces.
 *
 * `lineItems` es la lista de conceptos + cantidad que el staff captura a
 * mano -- cada concepto se resuelve contra las tarifas APROBADAS y vigentes
 * a la fecha del acto (`resolveExpedienteAsOfIso`); un concepto sin tarifa
 * resoluble bloquea el total COMPLETO (`economic.totals === null`), nunca un
 * total parcial silencioso (REQ-LIC-006/A8).
 */
export async function generateEconomicProposal(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  tenderId: string,
  lineItems: readonly EconomicLineItemInput[],
  idempotencyKey: string = crypto.randomUUID(),
): Promise<GenerateEconomicProposalResult> {
  return postJson<GenerateEconomicProposalResult>(
    fetchImpl,
    `${apiBaseUrl}/licitaciones/${propertyId}/tenders/${tenderId}/proposal/economic/generate`,
    token,
    { lineItems },
    { "idempotency-key": idempotencyKey },
  );
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

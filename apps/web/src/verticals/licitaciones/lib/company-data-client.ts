// Lógica de datos de "datos de empresa" (Fase 16) — llama a
// `GET/POST/PATCH .../company/{documents,rates,capabilities,experience,signers}`
// (companyData.ts). Es la ÚNICA fuente real de la que
// `CompanyDataService` (domain-licitaciones/src/company-data.ts) resuelve
// documentos/tarifas/capacidades/experiencia/firmantes para las propuestas
// técnica y económica -- sin esta pantalla, un requisito ausente quedaba
// "PENDIENTE" para siempre, sin ningún camino real de captura.
import { fetchJson, patchJson, postJson } from "./admin-client.ts";

export type CompanyDataApprovalStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";

/**
 * Autoria de un dato (migracion 036). Ausente en una base sin migrar (el servidor no la trae): la pantalla lo muestra sin
 * "propuso/aprobo" y NO deshabilita nada (el servidor decide). Los nombres salen del mapa `people` de cada listado.
 */
export interface CompanyDataAuthorship {
  readonly proposedBy?: string | null;
  readonly approvedBy?: string | null;
  readonly approvedAt?: string | null;
  readonly proposedByName?: string | null;
  readonly approvedByName?: string | null;
}

export interface CompanyDocument extends CompanyDataAuthorship {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface ApprovedRate extends CompanyDataAuthorship {
  readonly id: string;
  readonly concept: string;
  readonly unitPrice: string;
  readonly currency: "MXN";
  readonly approvalStatus: CompanyDataApprovalStatus;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface CompanyCapability extends CompanyDataAuthorship {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly evidenceDocId: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface CompanyExperienceItem extends CompanyDataAuthorship {
  readonly id: string;
  readonly description: string;
  readonly evidenceDocId: string;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface CompanySigner extends CompanyDataAuthorship {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly authorized: boolean;
  /** Ausente en una base sin migrar: ahi un firmante existente cuenta como aprobado. */
  readonly approvalStatus?: CompanyDataApprovalStatus;
}

type WithPeople<K extends string, T> = { readonly [P in K]: readonly T[] } & { readonly people?: Readonly<Record<string, string>> };

/** Agrega `proposedByName`/`approvedByName` a cada registro con el mapa `people` del listado (mejor esfuerzo). */
function withNames<T extends CompanyDataAuthorship>(items: readonly T[], people: Readonly<Record<string, string>> | undefined): readonly T[] {
  if (!people) return items;
  return items.map((item) => ({ ...item, proposedByName: item.proposedBy ? (people[item.proposedBy] ?? null) : null, approvedByName: item.approvedBy ? (people[item.approvedBy] ?? null) : null }));
}

function base(apiBaseUrl: string, propertyId: string, resource: string): string {
  return `${apiBaseUrl}/licitaciones/${propertyId}/company/${resource}`;
}

// ---- Documentos ----

export async function fetchCompanyDocuments(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyDocument[]> {
  const body = await fetchJson<WithPeople<"documents", CompanyDocument>>(fetchImpl, base(apiBaseUrl, propertyId, "documents"), token);
  return withNames(body.documents, body.people);
}

export async function createCompanyDocument(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { type: string; label: string; expiresAt: string | null }): Promise<CompanyDocument> {
  return postJson<CompanyDocument>(fetchImpl, base(apiBaseUrl, propertyId, "documents"), token, input);
}

export async function updateCompanyDocument(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  documentId: string,
  input: { label?: string; expiresAt?: string | null },
): Promise<CompanyDocument> {
  return patchJson<CompanyDocument>(fetchImpl, `${base(apiBaseUrl, propertyId, "documents")}/${documentId}`, token, input);
}

// ---- Tarifas aprobadas ----

export async function fetchApprovedRates(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ApprovedRate[]> {
  const body = await fetchJson<WithPeople<"rates", ApprovedRate>>(fetchImpl, base(apiBaseUrl, propertyId, "rates"), token);
  return withNames(body.rates, body.people);
}

export async function createApprovedRate(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { concept: string; unitPrice: string; validFrom?: string; validUntil?: string | null },
): Promise<ApprovedRate> {
  return postJson<ApprovedRate>(fetchImpl, base(apiBaseUrl, propertyId, "rates"), token, input);
}

export async function updateApprovedRate(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  rateId: string,
  input: { unitPrice?: string; validFrom?: string; validUntil?: string | null },
): Promise<ApprovedRate> {
  return patchJson<ApprovedRate>(fetchImpl, `${base(apiBaseUrl, propertyId, "rates")}/${rateId}`, token, input);
}

// ---- Capacidades ----

export async function fetchCompanyCapabilities(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyCapability[]> {
  const body = await fetchJson<WithPeople<"capabilities", CompanyCapability>>(fetchImpl, base(apiBaseUrl, propertyId, "capabilities"), token);
  return withNames(body.capabilities, body.people);
}

export async function createCompanyCapability(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { name: string; description: string; evidenceDocId?: string | null },
): Promise<CompanyCapability> {
  return postJson<CompanyCapability>(fetchImpl, base(apiBaseUrl, propertyId, "capabilities"), token, input);
}

export async function updateCompanyCapability(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  capabilityId: string,
  input: { description?: string; evidenceDocId?: string | null },
): Promise<CompanyCapability> {
  return patchJson<CompanyCapability>(fetchImpl, `${base(apiBaseUrl, propertyId, "capabilities")}/${capabilityId}`, token, input);
}

// ---- Experiencia ----

export async function fetchCompanyExperience(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyExperienceItem[]> {
  const body = await fetchJson<WithPeople<"experience", CompanyExperienceItem>>(fetchImpl, base(apiBaseUrl, propertyId, "experience"), token);
  return withNames(body.experience, body.people);
}

export async function createCompanyExperience(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { description: string; evidenceDocId: string }): Promise<CompanyExperienceItem> {
  return postJson<CompanyExperienceItem>(fetchImpl, base(apiBaseUrl, propertyId, "experience"), token, input);
}

export async function updateCompanyExperience(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  experienceId: string,
  input: { description?: string; evidenceDocId?: string },
): Promise<CompanyExperienceItem> {
  return patchJson<CompanyExperienceItem>(fetchImpl, `${base(apiBaseUrl, propertyId, "experience")}/${experienceId}`, token, input);
}

// ---- Firmantes autorizados ----

export async function fetchCompanySigners(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanySigner[]> {
  const body = await fetchJson<WithPeople<"signers", CompanySigner>>(fetchImpl, base(apiBaseUrl, propertyId, "signers"), token);
  return withNames(body.signers, body.people);
}

export async function createCompanySigner(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: { name: string; role: string; authorized?: boolean }): Promise<CompanySigner> {
  return postJson<CompanySigner>(fetchImpl, base(apiBaseUrl, propertyId, "signers"), token, input);
}

export async function updateCompanySigner(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  signerId: string,
  input: { name?: string; authorized?: boolean },
): Promise<CompanySigner> {
  return patchJson<CompanySigner>(fetchImpl, `${base(apiBaseUrl, propertyId, "signers")}/${signerId}`, token, input);
}

// ---- Decision: aprobar / rechazar (migracion 036) ----

export type CompanyItemKind = "rate" | "document" | "capability" | "experience" | "signer";

const DECISION_RESOURCE: Readonly<Record<CompanyItemKind, string>> = { rate: "rates", document: "documents", capability: "capabilities", experience: "experience", signer: "signers" };

/**
 * `POST .../company/<recurso>/:id/approve|reject`. Las tarifas exigen el token de step-up (`company_rate_approval`) en
 * `x-step-up-token`; el resto no. El servidor decide el rol, el autor distinto del aprobador y el 404/409.
 */
export async function decideCompanyItem(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly kind: CompanyItemKind; readonly id: string; readonly decision: "aprobado" | "rechazado"; readonly stepUpToken?: string | null },
): Promise<void> {
  const action = input.decision === "aprobado" ? "approve" : "reject";
  await postJson<unknown>(fetchImpl, `${base(apiBaseUrl, propertyId, DECISION_RESOURCE[input.kind])}/${encodeURIComponent(input.id)}/${action}`, token, {}, input.stepUpToken ? { "x-step-up-token": input.stepUpToken } : {});
}

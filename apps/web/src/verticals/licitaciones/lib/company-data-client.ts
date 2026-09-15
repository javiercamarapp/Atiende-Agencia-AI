// Lógica de datos de "datos de empresa" (Fase 16) — llama a
// `GET/POST/PATCH .../company/{documents,rates,capabilities,experience,signers}`
// (companyData.ts). Es la ÚNICA fuente real de la que
// `CompanyDataService` (domain-licitaciones/src/company-data.ts) resuelve
// documentos/tarifas/capacidades/experiencia/firmantes para las propuestas
// técnica y económica -- sin esta pantalla, un requisito ausente quedaba
// "PENDIENTE" para siempre, sin ningún camino real de captura.
import { fetchJson, patchJson, postJson } from "./admin-client.ts";

export type CompanyDataApprovalStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";

export interface CompanyDocument {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly expiresAt: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface ApprovedRate {
  readonly id: string;
  readonly concept: string;
  readonly unitPrice: string;
  readonly currency: "MXN";
  readonly approvalStatus: CompanyDataApprovalStatus;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

export interface CompanyCapability {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly evidenceDocId: string | null;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface CompanyExperienceItem {
  readonly id: string;
  readonly description: string;
  readonly evidenceDocId: string;
  readonly approvalStatus: CompanyDataApprovalStatus;
}

export interface CompanySigner {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly authorized: boolean;
}

function base(apiBaseUrl: string, propertyId: string, resource: string): string {
  return `${apiBaseUrl}/licitaciones/${propertyId}/company/${resource}`;
}

// ---- Documentos ----

export async function fetchCompanyDocuments(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyDocument[]> {
  const body = await fetchJson<{ documents: readonly CompanyDocument[] }>(fetchImpl, base(apiBaseUrl, propertyId, "documents"), token);
  return body.documents;
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
  input: { label?: string; expiresAt?: string | null; approvalStatus?: CompanyDataApprovalStatus },
): Promise<CompanyDocument> {
  return patchJson<CompanyDocument>(fetchImpl, `${base(apiBaseUrl, propertyId, "documents")}/${documentId}`, token, input);
}

// ---- Tarifas aprobadas ----

export async function fetchApprovedRates(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ApprovedRate[]> {
  const body = await fetchJson<{ rates: readonly ApprovedRate[] }>(fetchImpl, base(apiBaseUrl, propertyId, "rates"), token);
  return body.rates;
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
  input: { unitPrice?: string; validFrom?: string; validUntil?: string | null; approvalStatus?: CompanyDataApprovalStatus },
): Promise<ApprovedRate> {
  return patchJson<ApprovedRate>(fetchImpl, `${base(apiBaseUrl, propertyId, "rates")}/${rateId}`, token, input);
}

// ---- Capacidades ----

export async function fetchCompanyCapabilities(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyCapability[]> {
  const body = await fetchJson<{ capabilities: readonly CompanyCapability[] }>(fetchImpl, base(apiBaseUrl, propertyId, "capabilities"), token);
  return body.capabilities;
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
  input: { description?: string; evidenceDocId?: string | null; approvalStatus?: CompanyDataApprovalStatus },
): Promise<CompanyCapability> {
  return patchJson<CompanyCapability>(fetchImpl, `${base(apiBaseUrl, propertyId, "capabilities")}/${capabilityId}`, token, input);
}

// ---- Experiencia ----

export async function fetchCompanyExperience(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanyExperienceItem[]> {
  const body = await fetchJson<{ experience: readonly CompanyExperienceItem[] }>(fetchImpl, base(apiBaseUrl, propertyId, "experience"), token);
  return body.experience;
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
  input: { description?: string; evidenceDocId?: string; approvalStatus?: CompanyDataApprovalStatus },
): Promise<CompanyExperienceItem> {
  return patchJson<CompanyExperienceItem>(fetchImpl, `${base(apiBaseUrl, propertyId, "experience")}/${experienceId}`, token, input);
}

// ---- Firmantes autorizados ----

export async function fetchCompanySigners(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly CompanySigner[]> {
  const body = await fetchJson<{ signers: readonly CompanySigner[] }>(fetchImpl, base(apiBaseUrl, propertyId, "signers"), token);
  return body.signers;
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

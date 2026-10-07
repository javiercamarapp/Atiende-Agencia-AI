// AE-08 / REQ-162: hash REAL del perfil de empresa que alimenta `ExpedienteInputs.companyProfileHash`.
// Antes era una constante ("licitaciones:fase1:company-profile-fijo"): cambiar un firmante, una capacidad, la experiencia
// o un documento DESPUES de aprobar el expediente no invalidaba nada. Ahora cubre TODO lo que la propuesta pudo usar
// (documentos, capacidades, experiencia y firmantes) y el estado de aprobacion de cada uno.
//
// Contenido de cada elemento = sus campos de negocio + `approvalStatus` (nunca ids ni fechas de captura ni autoria:
// borrar y recrear un dato identico no cambia el hash). Orden CANONICO: cada lista se ordena por su serializacion
// estable, asi reordenar sin cambiar contenido no cambia el hash. Los firmantes sin `approvalStatus` (base sin migrar)
// cuentan como "aprobado", igual que los respalda la migracion 036, para que migrar no cambie el hash por si solo.
import { sha256Hex, stableStringify } from "./types.ts";
import type { CompanyCapabilityRecord, CompanyDocumentRecord, CompanyExperienceItemRecord, CompanySignerRecord } from "./types.ts";
import type { CompanyLocationRecord, CompanyProductServiceRecord, CompanyProfileRecord, CompanyRestrictionRecord, CompanyStakeholderRecord } from "./company-profile.ts";

export interface CompanyProfileSnapshot {
  readonly documents: readonly Pick<CompanyDocumentRecord, "type" | "label" | "expiresAt" | "approvalStatus">[];
  readonly capabilities: readonly Pick<CompanyCapabilityRecord, "name" | "description" | "evidenceDocId" | "approvalStatus">[];
  readonly experience: readonly Pick<CompanyExperienceItemRecord, "description" | "evidenceDocId" | "approvalStatus">[];
  readonly signers: readonly (Pick<CompanySignerRecord, "name" | "role" | "authorized" | "validFrom" | "validUntil" | "identityDocId" | "actionLimits"> & { readonly approvalStatus?: CompanySignerRecord["approvalStatus"] })[];
  // Perfil completo (migracion 040). Opcionales: solo entran al hash si traen datos, para que migrar (tablas vacias) o una
  // base sin migrar produzcan EXACTAMENTE el mismo hash que antes y no invaliden expedientes ya aprobados.
  readonly profile?: Pick<CompanyProfileRecord, "legalName" | "taxId" | "tradeName" | "sector" | "foundedYear" | "employeeCount" | "annualSalesCents" | "website" | "approvalStatus"> | null;
  readonly productsServices?: readonly Pick<CompanyProductServiceRecord, "kind" | "name" | "description" | "classifierCode" | "approvalStatus">[];
  readonly locations?: readonly Pick<CompanyLocationRecord, "kind" | "name" | "state" | "municipality" | "address" | "approvalStatus">[];
  readonly restrictions?: readonly Pick<CompanyRestrictionRecord, "kind" | "description" | "validFrom" | "validUntil" | "approvalStatus">[];
  readonly stakeholders?: readonly Pick<CompanyStakeholderRecord, "kind" | "fullName" | "rfc" | "participationPct" | "approvalStatus">[];
}

function canonicalList(items: readonly unknown[]): string[] {
  return items.map((i) => stableStringify(i)).sort();
}

export function computeCompanyProfileHash(profile: CompanyProfileSnapshot): string {
  // Solo los datos que de verdad existen: la vigencia/identidad/limites del firmante y las listas nuevas no aparecen si estan vacias.
  const optionalLists: Record<string, unknown> = {};
  if (profile.profile) optionalLists.profile = stableStringify(profile.profile);
  for (const [key, list] of [
    ["productsServices", profile.productsServices],
    ["locations", profile.locations],
    ["restrictions", profile.restrictions],
    ["stakeholders", profile.stakeholders],
  ] as const) {
    if (list && list.length > 0) optionalLists[key] = canonicalList(list);
  }
  return sha256Hex({
    v: 1,
    documents: canonicalList(profile.documents.map((d) => ({ type: d.type, label: d.label, expiresAt: d.expiresAt, approvalStatus: d.approvalStatus }))),
    capabilities: canonicalList(profile.capabilities.map((c) => ({ name: c.name, description: c.description, evidenceDocId: c.evidenceDocId, approvalStatus: c.approvalStatus }))),
    experience: canonicalList(profile.experience.map((e) => ({ description: e.description, evidenceDocId: e.evidenceDocId, approvalStatus: e.approvalStatus }))),
    signers: canonicalList(
      profile.signers.map((s) => ({
        name: s.name,
        role: s.role,
        authorized: s.authorized,
        approvalStatus: s.approvalStatus ?? "aprobado",
        ...(s.validFrom ? { validFrom: s.validFrom } : {}),
        ...(s.validUntil ? { validUntil: s.validUntil } : {}),
        ...(s.identityDocId ? { identityDocId: s.identityDocId } : {}),
        ...(s.actionLimits ? { actionLimits: s.actionLimits } : {}),
      })),
    ),
    ...optionalLists,
  });
}

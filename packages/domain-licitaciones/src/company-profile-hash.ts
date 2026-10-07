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

export interface CompanyProfileSnapshot {
  readonly documents: readonly Pick<CompanyDocumentRecord, "type" | "label" | "expiresAt" | "approvalStatus">[];
  readonly capabilities: readonly Pick<CompanyCapabilityRecord, "name" | "description" | "evidenceDocId" | "approvalStatus">[];
  readonly experience: readonly Pick<CompanyExperienceItemRecord, "description" | "evidenceDocId" | "approvalStatus">[];
  readonly signers: readonly (Pick<CompanySignerRecord, "name" | "role" | "authorized"> & { readonly approvalStatus?: CompanySignerRecord["approvalStatus"] })[];
}

function canonicalList(items: readonly unknown[]): string[] {
  return items.map((i) => stableStringify(i)).sort();
}

export function computeCompanyProfileHash(profile: CompanyProfileSnapshot): string {
  return sha256Hex({
    v: 1,
    documents: canonicalList(profile.documents.map((d) => ({ type: d.type, label: d.label, expiresAt: d.expiresAt, approvalStatus: d.approvalStatus }))),
    capabilities: canonicalList(profile.capabilities.map((c) => ({ name: c.name, description: c.description, evidenceDocId: c.evidenceDocId, approvalStatus: c.approvalStatus }))),
    experience: canonicalList(profile.experience.map((e) => ({ description: e.description, evidenceDocId: e.evidenceDocId, approvalStatus: e.approvalStatus }))),
    signers: canonicalList(profile.signers.map((s) => ({ name: s.name, role: s.role, authorized: s.authorized, approvalStatus: s.approvalStatus ?? "aprobado" }))),
  });
}

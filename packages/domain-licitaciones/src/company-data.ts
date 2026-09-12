// CompanyDataResolver — port de licitaciones/packages/expediente/src/company-data.ts
// (ver diseño Fase 1 §3.1). Reglas duras preservadas literal: dato ausente ->
// `missing` explícito (nunca se infiere ni se usa un valor por defecto);
// documento vencido a la fecha del acto (no a "hoy") -> bloqueo; tarifa no
// aprobada o vencida -> bloqueo. Ningún método puede devolver un valor
// inventado.
//
// Fase 1 (§3.1) portó la interfaz completa pero dejó `getCapabilities`/
// `getExperience`/`getSigners` como stub ([]) hasta que se portara
// TechnicalProposalBuilder. Fase 2 ya lo portó y SÍ los consume
// (resolveCapability/resolveExperience/resolveAuthorizedSigner) -- Fase 4 los
// implementó de verdad, respaldados por `licitaciones.company_capability`/
// `company_experience`/`company_signer` (migración 009) vía
// `PostgresLicitacionesRepository.listCompanyCapabilities/listCompanyExperience/
// listCompanySigners`.
import { assertExplicitOffset, isPast } from "./types.ts";

export type ApprovalStatus = "aprobado" | "pendiente_aprobacion" | "rechazado";

export interface CompanyCapability {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly description: string;
  readonly evidenceDocId?: string;
  readonly approvalStatus: ApprovalStatus;
}

export interface CompanyExperienceRecord {
  readonly id: string;
  readonly companyId: string;
  readonly description: string;
  readonly evidenceDocId: string;
  readonly approvalStatus: ApprovalStatus;
}

export interface CompanyDocument {
  readonly id: string;
  readonly companyId: string;
  readonly type: string;
  readonly label: string;
  readonly issuedAt: string;
  /** `null` = sin vigencia definida (documento indefinido); NO significa "siempre vigente" para tipos que la ley exige con vigencia. */
  readonly expiresAt: string | null;
  readonly approvalStatus: ApprovalStatus;
}

export interface CompanySigner {
  readonly id: string;
  readonly companyId: string;
  readonly name: string;
  readonly role: string;
  readonly authorized: boolean;
}

export interface ApprovedRate {
  readonly id: string;
  readonly companyId: string;
  readonly concept: string;
  readonly unit: string;
  /** Precio unitario como cadena decimal, p. ej. "1234.56". */
  readonly unitPrice: string;
  readonly currency: "MXN";
  readonly approvalStatus: ApprovalStatus;
  readonly validFrom: string;
  readonly validUntil: string | null;
}

/** Interfaz de persistencia de datos de empresa — `PostgresLicitacionesRepository` la implementa contra `licitaciones.company_document`/`licitaciones.approved_rate`. */
export interface CompanyDataResolver {
  getCapabilities(companyId: string): CompanyCapability[];
  getExperience(companyId: string): CompanyExperienceRecord[];
  getDocuments(companyId: string): CompanyDocument[];
  getSigners(companyId: string): CompanySigner[];
  getApprovedRates(companyId: string): ApprovedRate[];
}

export class InMemoryCompanyDataResolver implements CompanyDataResolver {
  constructor(
    private readonly data: {
      documents?: CompanyDocument[];
      rates?: ApprovedRate[];
      // Fase 4: TechnicalProposalBuilder ya está portado y SÍ llama
      // resolveCapability/resolveExperience/resolveAuthorizedSigner -- el stub fijo
      // de Fase 1 §3.1 (siempre `[]`) degradaba en silencio esos requisitos a
      // "missing" en producción. Se filtran por companyId igual que documents/rates.
      capabilities?: CompanyCapability[];
      experience?: CompanyExperienceRecord[];
      signers?: CompanySigner[];
    },
  ) {}

  getCapabilities(companyId: string): CompanyCapability[] {
    return (this.data.capabilities ?? []).filter((c) => c.companyId === companyId);
  }
  getExperience(companyId: string): CompanyExperienceRecord[] {
    return (this.data.experience ?? []).filter((e) => e.companyId === companyId);
  }
  getSigners(companyId: string): CompanySigner[] {
    return (this.data.signers ?? []).filter((s) => s.companyId === companyId);
  }
  getDocuments(companyId: string): CompanyDocument[] {
    return (this.data.documents ?? []).filter((d) => d.companyId === companyId);
  }
  getApprovedRates(companyId: string): ApprovedRate[] {
    return (this.data.rates ?? []).filter((r) => r.companyId === companyId);
  }
}

export type BlockingReasonCode =
  | "dato_ausente"
  | "documento_vencido"
  | "documento_no_aprobado"
  | "tarifa_no_aprobada"
  | "tarifa_vencida"
  | "tarifa_aun_no_vigente"
  | "firmante_no_autorizado"
  | "capacidad_no_aprobada"
  | "experiencia_no_aprobada"
  | "evidencia_no_verificable";

export interface FieldResolutionOk<T> {
  readonly status: "ok";
  readonly field: string;
  readonly value: T;
  readonly sourceRef: { docId: string; capturedAt: string };
}

export interface FieldResolutionMissing {
  readonly status: "missing";
  readonly field: string;
}

export interface FieldResolutionBlocked {
  readonly status: "blocked";
  readonly field: string;
  readonly reason: BlockingReasonCode;
  readonly detail: string;
}

export type FieldResolution<T> = FieldResolutionOk<T> | FieldResolutionMissing | FieldResolutionBlocked;

export function isResolved<T>(r: FieldResolution<T>): r is FieldResolutionOk<T> {
  return r.status === "ok";
}

/**
 * Aplica las reglas duras sobre un `CompanyDataResolver`. `asOfIso` es la
 * fecha del acto relevante (fecha límite de entrega de proposiciones,
 * derivada SIEMPRE por `resolveExpedienteAsOfIso`) contra la que se evalúa
 * vigencia — nunca "hoy" salvo que el llamador pase "hoy" explícitamente.
 */
export class CompanyDataService {
  constructor(private readonly resolver: CompanyDataResolver) {}

  resolveDocumentByType(companyId: string, type: string, asOfIso: string): FieldResolution<CompanyDocument> {
    assertExplicitOffset(asOfIso, `asOfIso al resolver documento "${type}"`);
    const field = `documento:${type}`;
    const doc = this.resolver.getDocuments(companyId).find((d) => d.type === type);
    if (!doc) return { status: "missing", field };
    if (doc.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "documento_no_aprobado", detail: `Documento "${type}" en estado "${doc.approvalStatus}", no "aprobado".` };
    }
    if (doc.expiresAt !== null && isPast(doc.expiresAt, asOfIso)) {
      return { status: "blocked", field, reason: "documento_vencido", detail: `Documento "${type}" venció el ${doc.expiresAt}, antes de la fecha del acto (${asOfIso}).` };
    }
    return { status: "ok", field, value: doc, sourceRef: { docId: doc.id, capturedAt: doc.issuedAt } };
  }

  resolveApprovedRate(companyId: string, concept: string, asOfIso: string): FieldResolution<ApprovedRate> {
    assertExplicitOffset(asOfIso, `asOfIso al resolver tarifa "${concept}"`);
    const field = `tarifa:${concept}`;
    const rate = this.resolver.getApprovedRates(companyId).find((r) => r.concept === concept);
    if (!rate) return { status: "missing", field };
    if ((rate.currency as string) !== "MXN") {
      throw new Error(`Tarifa "${concept}" tiene moneda "${rate.currency}", se esperaba "MXN". Verifique el adaptador de datos.`);
    }
    if (rate.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "tarifa_no_aprobada", detail: `Tarifa "${concept}" en estado "${rate.approvalStatus}", no "aprobado".` };
    }
    assertExplicitOffset(rate.validFrom, `tarifa "${concept}".validFrom`);
    if (new Date(rate.validFrom).getTime() > new Date(asOfIso).getTime()) {
      return { status: "blocked", field, reason: "tarifa_aun_no_vigente", detail: `Tarifa "${concept}" vigente desde ${rate.validFrom}, posterior a la fecha del acto (${asOfIso}).` };
    }
    if (rate.validUntil !== null && isPast(rate.validUntil, asOfIso)) {
      return { status: "blocked", field, reason: "tarifa_vencida", detail: `Tarifa "${concept}" venció el ${rate.validUntil}, antes de la fecha del acto (${asOfIso}).` };
    }
    return { status: "ok", field, value: rate, sourceRef: { docId: rate.id, capturedAt: rate.validFrom } };
  }

  resolveCapability(companyId: string, name: string): FieldResolution<CompanyCapability> {
    const field = `capacidad:${name}`;
    const capability = this.resolver.getCapabilities(companyId).find((c) => c.name === name);
    if (!capability) return { status: "missing", field };
    if (capability.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "capacidad_no_aprobada", detail: `Capacidad "${name}" en estado "${capability.approvalStatus}".` };
    }
    return { status: "ok", field, value: capability, sourceRef: { docId: capability.evidenceDocId ?? capability.id, capturedAt: capability.id } };
  }

  resolveExperience(companyId: string, experienceId: string): FieldResolution<CompanyExperienceRecord> {
    const field = `experiencia:${experienceId}`;
    const record = this.resolver.getExperience(companyId).find((e) => e.id === experienceId);
    if (!record) return { status: "missing", field };
    if (record.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "experiencia_no_aprobada", detail: `Experiencia "${experienceId}" en estado "${record.approvalStatus}".` };
    }
    const evidenceDocId = typeof record.evidenceDocId === "string" ? record.evidenceDocId.trim() : "";
    if (evidenceDocId === "") {
      return {
        status: "blocked",
        field,
        reason: "evidencia_no_verificable",
        detail: `Experiencia "${experienceId}" no tiene un evidenceDocId real; no puede darse por probada sin evidencia documental.`,
      };
    }
    const evidenceDoc = this.resolver.getDocuments(companyId).find((d) => d.id === evidenceDocId);
    if (!evidenceDoc) {
      return {
        status: "blocked",
        field,
        reason: "evidencia_no_verificable",
        detail: `Experiencia "${experienceId}" referencia evidenceDocId "${evidenceDocId}", que no corresponde a ningún documento existente en la bóveda documental de la empresa.`,
      };
    }
    return { status: "ok", field, value: record, sourceRef: { docId: evidenceDocId, capturedAt: record.id } };
  }

  resolveAuthorizedSigner(companyId: string, role: string): FieldResolution<CompanySigner> {
    const field = `firmante:${role}`;
    const signer = this.resolver.getSigners(companyId).find((s) => s.role === role);
    if (!signer) return { status: "missing", field };
    if (!signer.authorized) {
      return { status: "blocked", field, reason: "firmante_no_autorizado", detail: `Firmante "${signer.name}" no está autorizado para el rol "${role}".` };
    }
    return { status: "ok", field, value: signer, sourceRef: { docId: signer.id, capturedAt: signer.id } };
  }
}

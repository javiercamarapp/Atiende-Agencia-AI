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
import { PROVENANCE_REQUIRED_ENTITIES, ProvenanceIndex } from "./company-profile.ts";
import type {
  CompanyLocationRecord,
  CompanyProductServiceRecord,
  CompanyProfileRecord,
  CompanyRestrictionRecord,
  CompanyStakeholderRecord,
  ProfileApprovalStatus,
  ProvenanceEntity,
} from "./company-profile.ts";

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
  /** Ausente = comportamiento anterior (solo `authorized`). Presente y distinto de "aprobado" bloquea. */
  readonly approvalStatus?: ApprovalStatus;
  /** Vigencia del poder (migracion 040). `undefined`/`null` = sin vigencia capturada (comportamiento anterior: no se evalua). Fechas con offset explicito. */
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  /** Documento de identidad o poder (evidencia en `company_document`). */
  readonly identityDocId?: string | null;
  /** Limites de actuacion del poder, como texto. */
  readonly actionLimits?: string | null;
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
  // Perfil completo (migracion 040). Opcionales: un resolvedor anterior (o una base sin migrar) no las implementa y el
  // servicio responde "missing" -- nunca un valor inventado.
  getProfile?(companyId: string): CompanyProfileRecord | null;
  getProductsServices?(companyId: string): readonly CompanyProductServiceRecord[];
  getLocations?(companyId: string): readonly CompanyLocationRecord[];
  getRestrictions?(companyId: string): readonly CompanyRestrictionRecord[];
  getStakeholders?(companyId: string): readonly CompanyStakeholderRecord[];
  /** Procedencia por campo (REQ-142). Sin ella, el dato de las entidades que la exigen queda bloqueado. */
  getProvenance?(companyId: string): ProvenanceIndex;
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
      profile?: CompanyProfileRecord | null;
      productsServices?: CompanyProductServiceRecord[];
      locations?: CompanyLocationRecord[];
      restrictions?: CompanyRestrictionRecord[];
      stakeholders?: CompanyStakeholderRecord[];
      provenance?: ProvenanceIndex;
    },
  ) {}

  getProfile(_companyId: string): CompanyProfileRecord | null {
    return this.data.profile ?? null;
  }
  getProductsServices(_companyId: string): readonly CompanyProductServiceRecord[] {
    return this.data.productsServices ?? [];
  }
  getLocations(_companyId: string): readonly CompanyLocationRecord[] {
    return this.data.locations ?? [];
  }
  getRestrictions(_companyId: string): readonly CompanyRestrictionRecord[] {
    return this.data.restrictions ?? [];
  }
  getStakeholders(_companyId: string): readonly CompanyStakeholderRecord[] {
    return this.data.stakeholders ?? [];
  }
  getProvenance(_companyId: string): ProvenanceIndex {
    return this.data.provenance ?? new ProvenanceIndex();
  }

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
  | "firmante_no_aprobado"
  | "capacidad_no_aprobada"
  | "experiencia_no_aprobada"
  | "evidencia_no_verificable"
  | "firmante_poder_no_vigente"
  | "firmante_poder_vencido"
  | "procedencia_ausente"
  | "dato_no_aprobado";

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

  /**
   * Firmante vigente para `role`. Con varios firmantes por cargo (migracion 040 quita el unico por cargo) se elige el
   * primero que cumple TODO: aprobado, autorizado y con el poder vigente a `asOfIso` (la fecha del acto, misma regla que las
   * tarifas; nunca "hoy" salvo que el llamador lo pase). Sin ninguno vigente el requisito queda bloqueado o pendiente con
   * el motivo mas especifico; nunca se rellena con un firmante cuyo poder no cubre la fecha.
   * Sin `asOfIso` o sin vigencia capturada en el firmante se conserva el comportamiento anterior (no se evalua la vigencia).
   */
  resolveAuthorizedSigner(companyId: string, role: string, asOfIso?: string): FieldResolution<CompanySigner> {
    const field = `firmante:${role}`;
    if (asOfIso !== undefined) assertExplicitOffset(asOfIso, `asOfIso al resolver firmante "${role}"`);
    const candidates = this.resolver.getSigners(companyId).filter((s) => s.role === role);
    if (candidates.length === 0) return { status: "missing", field };

    const verdicts = candidates.map((signer) => ({ signer, blocked: this.signerBlock(signer, role, asOfIso, field) }));
    const ok = verdicts.find((v) => v.blocked === null);
    if (ok) return { status: "ok", field, value: ok.signer, sourceRef: { docId: ok.signer.id, capturedAt: ok.signer.id } };
    // Ninguno sirve: el motivo mas especifico gana (poder vencido o aun no vigente informa mas que "no aprobado").
    const prioridad: BlockingReasonCode[] = ["firmante_poder_vencido", "firmante_poder_no_vigente", "firmante_no_aprobado", "firmante_no_autorizado"];
    const peor = [...verdicts].sort((a, b) => prioridad.indexOf(a.blocked!.reason) - prioridad.indexOf(b.blocked!.reason))[0]!;
    return peor.blocked!;
  }

  private signerBlock(signer: CompanySigner, role: string, asOfIso: string | undefined, field: string): FieldResolutionBlocked | null {
    if (signer.approvalStatus !== undefined && signer.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "firmante_no_aprobado", detail: `Firmante "${signer.name}" en estado "${signer.approvalStatus}", no "aprobado".` };
    }
    if (!signer.authorized) {
      return { status: "blocked", field, reason: "firmante_no_autorizado", detail: `Firmante "${signer.name}" no está autorizado para el rol "${role}".` };
    }
    if (asOfIso !== undefined) {
      if (signer.validFrom) {
        assertExplicitOffset(signer.validFrom, `firmante "${signer.name}".validFrom`);
        if (new Date(signer.validFrom).getTime() > new Date(asOfIso).getTime()) {
          return { status: "blocked", field, reason: "firmante_poder_no_vigente", detail: `El poder de "${signer.name}" rige desde ${signer.validFrom}, posterior a la fecha del acto (${asOfIso}).` };
        }
      }
      if (signer.validUntil) {
        assertExplicitOffset(signer.validUntil, `firmante "${signer.name}".validUntil`);
        if (isPast(signer.validUntil, asOfIso)) {
          return { status: "blocked", field, reason: "firmante_poder_vencido", detail: `El poder de "${signer.name}" venció el ${signer.validUntil}, antes de la fecha del acto (${asOfIso}).` };
        }
      }
    }
    return null;
  }

  // ---- Perfil completo (migracion 040) y procedencia (REQ-142) ----

  /**
   * Un dato de una entidad que exige procedencia (`PROVENANCE_REQUIRED_ENTITIES`) y no la tiene queda BLOQUEADO con su
   * motivo, aunque este aprobado: una fila insertada fuera de la API (por SQL) nunca tiene procedencia y no cuenta.
   */
  private gateItem(entity: ProvenanceEntity, field: string, companyId: string, item: { id: string; approvalStatus: ProfileApprovalStatus }, label: string): FieldResolutionBlocked | null {
    if (PROVENANCE_REQUIRED_ENTITIES.includes(entity) && !(this.resolver.getProvenance?.(companyId) ?? new ProvenanceIndex()).has(entity, item.id)) {
      return { status: "blocked", field, reason: "procedencia_ausente", detail: `${label} no tiene procedencia registrada (quién lo capturó y cuándo); un dato sin procedencia no se usa.` };
    }
    if (item.approvalStatus !== "aprobado") {
      return { status: "blocked", field, reason: "dato_no_aprobado", detail: `${label} en estado "${item.approvalStatus}", no "aprobado".` };
    }
    return null;
  }

  resolveProfile(companyId: string): FieldResolution<CompanyProfileRecord> {
    const field = "perfil:general";
    const profile = this.resolver.getProfile?.(companyId) ?? null;
    if (!profile) return { status: "missing", field };
    const blocked = this.gateItem("profile", field, companyId, profile, "El perfil general de la empresa");
    if (blocked) return blocked;
    return { status: "ok", field, value: profile, sourceRef: { docId: profile.id, capturedAt: this.resolver.getProvenance?.(companyId).get("profile", profile.id)?.capturedAt ?? "" } };
  }

  /** Lista completa o nada: si algun elemento (no rechazado) esta sin procedencia o sin aprobar, la lista entera queda bloqueada (no se oculta un socio o una restriccion). */
  private resolveList<T extends { id: string; approvalStatus: ProfileApprovalStatus }>(
    companyId: string,
    entity: ProvenanceEntity,
    field: string,
    label: string,
    items: readonly T[],
  ): FieldResolution<readonly T[]> {
    const vivos = items.filter((i) => i.approvalStatus !== "rechazado");
    if (vivos.length === 0) return { status: "missing", field };
    for (const item of vivos) {
      const blocked = this.gateItem(entity, field, companyId, item, label);
      if (blocked) return blocked;
    }
    return { status: "ok", field, value: vivos, sourceRef: { docId: vivos[0]!.id, capturedAt: this.resolver.getProvenance?.(companyId).get(entity, vivos[0]!.id)?.capturedAt ?? "" } };
  }

  resolveStakeholders(companyId: string): FieldResolution<readonly CompanyStakeholderRecord[]> {
    return this.resolveList(companyId, "stakeholder", "perfil:socios", "Un socio o representante", this.resolver.getStakeholders?.(companyId) ?? []);
  }
  resolveRestrictions(companyId: string): FieldResolution<readonly CompanyRestrictionRecord[]> {
    return this.resolveList(companyId, "restriction", "perfil:restricciones", "Una restricción", this.resolver.getRestrictions?.(companyId) ?? []);
  }
  resolveLocations(companyId: string): FieldResolution<readonly CompanyLocationRecord[]> {
    return this.resolveList(companyId, "location", "perfil:ubicaciones", "Una ubicación", this.resolver.getLocations?.(companyId) ?? []);
  }
  resolveProductsServices(companyId: string): FieldResolution<readonly CompanyProductServiceRecord[]> {
    return this.resolveList(companyId, "product", "perfil:productos_servicios", "Un producto o servicio", this.resolver.getProductsServices?.(companyId) ?? []);
  }
}

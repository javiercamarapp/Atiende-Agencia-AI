// Adaptador en memoria de privacidad (tests de rutas/servicio). Reproduce las reglas del modelo
// SQL que importan al codigo TS: transiciones ARCO, plazos, prorroga unica, doble control del
// acceso excepcional, retencion legal, reglas de consentimiento y cierre de incidentes. NO
// reproduce RLS/GRANT/triggers: eso lo cubre scripts/verify-hoteles-privacidad-arco contra
// Postgres real. Las rutas aplican el rol fino antes de llamar aqui.
import { randomUUID } from "node:crypto";
import type { InMemoryIdentityRepository } from "../identity/in-memory-repository.ts";
import { addDaysYmd } from "../identity/service.ts";
import { PrivacyAccessDeniedError, PrivacyConflictError, PrivacyDoubleControlError, PrivacyInvalidInputError, PrivacyUnavailableError } from "./errors.ts";
import type { IncidentActionInput } from "./parse.ts";
import type { PrivacyRepository } from "./repository.ts";
import { ARCO_EXECUTION_DAYS, ARCO_RESPONSE_DAYS, BLOCK_WINDOW_DAYS_DEFAULT, LEGAL_HOLD_REVIEW_DAYS, computeArcoExecutionDue, computeArcoResponseDue } from "./rules.ts";
import {
  CONSENT_WRITTEN_METHODS,
  type ArcoRequestRecord,
  type ArcoStatus,
  type ArcoTargetStatus,
  type BlockedAccessRequestRecord,
  type BlockedAccessStatus,
  type ConsentRecord,
  type IncidentStatus,
  type LegalHoldRecord,
  type LegalHoldStatus,
  type NewArcoRequestInput,
  type NewConsentInput,
  type NewIncidentInput,
  type NewLegalHoldInput,
  type NewPrivacyNoticeInput,
  type PrivacyEventRecord,
  type PrivacyEventSubject,
  type PrivacyIncidentRecord,
  type PrivacyListResult,
  type PrivacyNoticeRecord,
  type PrivacySettingsRecord,
} from "./types.ts";

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x));
}

export class InMemoryPrivacyRepository implements PrivacyRepository {
  private readonly notices = new Map<string, PrivacyNoticeRecord>();
  private readonly consents = new Map<string, ConsentRecord>();
  private readonly arcos = new Map<string, ArcoRequestRecord>();
  private readonly incidents = new Map<string, PrivacyIncidentRecord>();
  private readonly holds = new Map<string, LegalHoldRecord>();
  private readonly accesses = new Map<string, BlockedAccessRequestRecord>();
  private readonly events: PrivacyEventRecord[] = [];
  private blockWindowDays = BLOCK_WINDOW_DAYS_DEFAULT;
  private windowUpdate: { by: string; at: string } | null = null;
  private tick = 0;
  /** Simula una base sin la migracion 032 (lecturas vacias, escrituras 503). */
  unavailable = false;

  /** `identity`: boveda en memoria con la que se coordinan bloqueo, retencion legal y acceso excepcional. */
  constructor(private readonly identity?: InMemoryIdentityRepository) {}

  private now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }
  private assertAvailable(operation: string): void {
    if (this.unavailable) throw new PrivacyUnavailableError(operation);
  }
  private log(propertyId: string, subjectType: PrivacyEventSubject, subjectId: string | null, actorUserId: string | null, action: string, note: string | null): void {
    this.events.push({ id: randomUUID(), propertyId, subjectType, subjectId, actorUserId, action, note, createdAt: this.now() });
  }
  private static list<T>(unavailable: boolean, items: T[]): PrivacyListResult<T> {
    return unavailable ? { available: false, items: [] } : { available: true, items };
  }

  async getSettings(): Promise<{ available: boolean; settings: PrivacySettingsRecord }> {
    return {
      available: !this.unavailable,
      settings: { blockWindowDays: this.blockWindowDays, isDefault: this.windowUpdate === null, updatedBy: this.windowUpdate?.by ?? null, updatedAt: this.windowUpdate?.at ?? null },
    };
  }
  async setBlockWindow(propertyId: string, days: number, actorUserId: string): Promise<void> {
    this.assertAvailable("settings-set");
    if (!Number.isInteger(days) || days < 3 || days > 30) throw new PrivacyInvalidInputError("la ventana de bloqueo debe estar entre 3 y 30 dias");
    this.log(propertyId, "configuracion", propertyId, actorUserId, "ventana_bloqueo", `de ${this.blockWindowDays} a ${days} dias`);
    this.blockWindowDays = days;
    this.windowUpdate = { by: actorUserId, at: this.now() };
    this.identity?.setBlockWindowDays(days);
  }

  async publishNotice(propertyId: string, input: NewPrivacyNoticeInput, actorUserId: string): Promise<string> {
    this.assertAvailable("notice-publish");
    if ([...this.notices.values()].some((n) => n.propertyId === propertyId && n.version === input.version)) throw new PrivacyConflictError("Ya existe un registro con ese folio, version o una solicitud abierta para el mismo objeto.");
    for (const n of this.notices.values()) if (n.propertyId === propertyId && n.isCurrent) this.notices.set(n.id, { ...n, isCurrent: false });
    const id = randomUUID();
    this.notices.set(id, {
      id, propertyId, version: input.version, simplifiedText: input.simplifiedText, integralUrl: input.integralUrl, mandatoryPurposes: input.mandatoryPurposes,
      optionalPurposes: input.optionalPurposes, contentSha256: input.contentSha256, isCurrent: true, publishedBy: actorUserId, publishedAt: this.now(),
    });
    this.log(propertyId, "aviso", id, actorUserId, "aviso_publicado", `version ${input.version}`);
    return id;
  }
  async listNotices(propertyId: string, filters: { limit: number }): Promise<PrivacyListResult<PrivacyNoticeRecord>> {
    return InMemoryPrivacyRepository.list(this.unavailable, [...this.notices.values()].filter((n) => n.propertyId === propertyId).sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1)).slice(0, filters.limit));
  }
  async findNotice(propertyId: string, noticeId: string): Promise<PrivacyNoticeRecord | null> {
    const n = this.notices.get(noticeId);
    return !this.unavailable && n && n.propertyId === propertyId ? n : null;
  }

  async recordConsent(propertyId: string, input: NewConsentInput, actorUserId: string): Promise<ConsentRecord> {
    this.assertAvailable("consent-record");
    const notice = this.notices.get(input.noticeId);
    if (!notice || notice.propertyId !== propertyId) throw new PrivacyInvalidInputError("el aviso no pertenece a la property");
    if (!same(input.acceptedMandatory, notice.mandatoryPurposes)) throw new PrivacyInvalidInputError("se deben aceptar exactamente las finalidades obligatorias del aviso");
    if (!input.acceptedOptional.every((p) => notice.optionalPurposes.includes(p))) throw new PrivacyInvalidInputError("hay finalidades opcionales que no estan en el aviso");
    if (input.sensitiveData && !CONSENT_WRITTEN_METHODS.includes(input.evidenceMethod)) throw new PrivacyInvalidInputError("Los datos no cumplen las restricciones del modelo (catalogo, longitud o coherencia de estado).");
    const rec: ConsentRecord = {
      id: input.id, propertyId, guestId: input.guestId, vaultId: input.vaultId, noticeId: notice.id, noticeVersion: notice.version, acceptedMandatory: input.acceptedMandatory,
      acceptedOptional: input.acceptedOptional, channel: input.channel, evidenceMethod: input.evidenceMethod, sensitiveData: input.sensitiveData, consentedAt: this.now(),
      capturedBy: actorUserId, revokedAt: null, revokedBy: null, revokeReason: null,
    };
    this.consents.set(rec.id, rec);
    return rec;
  }
  async listConsents(propertyId: string, filters: { guestId?: string; vaultId?: string; limit: number }): Promise<PrivacyListResult<ConsentRecord>> {
    return InMemoryPrivacyRepository.list(
      this.unavailable,
      [...this.consents.values()]
        .filter((c) => c.propertyId === propertyId && (!filters.guestId || c.guestId === filters.guestId) && (!filters.vaultId || c.vaultId === filters.vaultId))
        .sort((a, b) => (a.consentedAt < b.consentedAt ? 1 : -1))
        .slice(0, filters.limit),
    );
  }
  async revokeConsent(consentId: string, reason: string, actorUserId: string): Promise<void> {
    this.assertAvailable("consent-revoke");
    const c = this.consents.get(consentId);
    if (!c) throw new PrivacyAccessDeniedError("consent-revoke");
    if (c.revokedAt !== null) throw new PrivacyConflictError("el consentimiento ya fue revocado");
    this.consents.set(consentId, { ...c, revokedAt: this.now(), revokedBy: actorUserId, revokeReason: reason });
    this.log(c.propertyId, "consentimiento", consentId, actorUserId, "consentimiento_revocado", reason);
  }

  async openArco(propertyId: string, input: NewArcoRequestInput, actorUserId: string): Promise<string> {
    this.assertAvailable("arco-open");
    const id = randomUUID();
    const folio = `ARCO-${input.receivedOn.replace(/-/g, "")}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    this.arcos.set(id, {
      id, propertyId, folio, rightType: input.rightType, guestId: input.guestId, vaultId: input.vaultId, requesterName: input.requesterName, requesterContact: input.requesterContact,
      channel: input.channel, description: input.description, receivedOn: input.receivedOn, responseDueOn: computeArcoResponseDue(input.receivedOn), executionDueOn: null, status: "recibida",
      decidedOn: null, decisionNote: null, extensionPhase: null, extensionReason: null, extendedAt: null, extendedBy: null, executedAt: null, createdBy: actorUserId, createdAt: this.now(),
    });
    this.log(propertyId, "arco", id, actorUserId, "solicitud_recibida", `${folio} (${input.rightType})`);
    return id;
  }
  async listArco(propertyId: string, filters: { status?: ArcoStatus; limit: number }): Promise<PrivacyListResult<ArcoRequestRecord>> {
    return InMemoryPrivacyRepository.list(
      this.unavailable,
      [...this.arcos.values()].filter((a) => a.propertyId === propertyId && (!filters.status || a.status === filters.status)).sort((a, b) => (a.responseDueOn < b.responseDueOn ? -1 : 1)).slice(0, filters.limit),
    );
  }
  async findArco(propertyId: string, requestId: string): Promise<ArcoRequestRecord | null> {
    const a = this.arcos.get(requestId);
    return !this.unavailable && a && a.propertyId === propertyId ? a : null;
  }
  async advanceArco(requestId: string, to: ArcoTargetStatus, note: string, today: string, actorUserId: string): Promise<ArcoTargetStatus> {
    this.assertAvailable("arco-advance");
    const a = this.arcos.get(requestId);
    if (!a) throw new PrivacyAccessDeniedError("arco-advance");
    const ok = (a.status === "recibida" && ["en_revision", "procedente", "improcedente"].includes(to)) || (a.status === "en_revision" && ["procedente", "improcedente"].includes(to)) || (a.status === "procedente" && to === "ejecutada");
    if (!ok) throw new PrivacyConflictError(`no se puede pasar de ${a.status} a ${to}`);
    let next: ArcoRequestRecord = { ...a, status: to, decisionNote: note };
    let blocked = 0;
    if (to === "procedente") {
      next = { ...next, decidedOn: today, executionDueOn: computeArcoExecutionDue(today) };
      if (a.rightType === "cancelacion" && this.identity) {
        if (a.vaultId) blocked = this.identity.blockIdentityForArco(a.vaultId, actorUserId, `ARCO cancelacion ${a.folio}`) ? 1 : 0;
        else if (a.guestId) blocked = this.identity.blockGuestIdentities(a.guestId, actorUserId, `ARCO cancelacion ${a.folio}`);
      }
    } else if (to === "improcedente") next = { ...next, decidedOn: today };
    else if (to === "ejecutada") next = { ...next, executedAt: this.now() };
    this.arcos.set(requestId, next);
    this.log(a.propertyId, "arco", requestId, actorUserId, `arco_${to}`, blocked > 0 ? `${note} [identidades bloqueadas: ${blocked}]` : note);
    return to;
  }
  async extendArco(requestId: string, reason: string, actorUserId: string): Promise<void> {
    this.assertAvailable("arco-extend");
    const a = this.arcos.get(requestId);
    if (!a) throw new PrivacyAccessDeniedError("arco-extend");
    if (a.status === "improcedente" || a.status === "ejecutada") throw new PrivacyConflictError("la solicitud ya esta resuelta");
    if (a.extendedAt !== null) throw new PrivacyConflictError("la prorroga solo se puede usar una vez");
    const at = this.now();
    this.arcos.set(
      requestId,
      a.status === "procedente"
        ? { ...a, executionDueOn: addDaysYmd(a.executionDueOn!, ARCO_EXECUTION_DAYS), extensionPhase: "ejecucion", extensionReason: reason, extendedAt: at, extendedBy: actorUserId }
        : { ...a, responseDueOn: addDaysYmd(a.responseDueOn, ARCO_RESPONSE_DAYS), extensionPhase: "respuesta", extensionReason: reason, extendedAt: at, extendedBy: actorUserId },
    );
    this.log(a.propertyId, "arco", requestId, actorUserId, "arco_prorroga", reason);
  }

  async reportIncident(propertyId: string, input: NewIncidentInput, actorUserId: string): Promise<string> {
    this.assertAvailable("incident-report");
    const id = randomUUID();
    const folio = `INC-${input.detectedAt.slice(0, 10).replace(/-/g, "")}-${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    this.incidents.set(id, {
      id, propertyId, folio, incidentType: input.incidentType, severity: input.severity, title: input.title, description: input.description, detectedAt: input.detectedAt,
      affectedCount: input.affectedCount, significantRisk: input.significantRisk, status: "detectada", containedAt: null, notifiedAt: null, notifiedBy: null, notificationChannel: null,
      notificationRef: null, noNotificationReason: null, closedAt: null, closedBy: null, closingNote: null, reportedBy: actorUserId, createdAt: this.now(),
    });
    this.log(propertyId, "incidente", id, actorUserId, "incidente_reportado", folio);
    return id;
  }
  async listIncidents(propertyId: string, filters: { status?: IncidentStatus; limit: number }): Promise<PrivacyListResult<PrivacyIncidentRecord>> {
    return InMemoryPrivacyRepository.list(
      this.unavailable,
      [...this.incidents.values()].filter((i) => i.propertyId === propertyId && (!filters.status || i.status === filters.status)).sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1)).slice(0, filters.limit),
    );
  }
  async findIncident(propertyId: string, incidentId: string): Promise<PrivacyIncidentRecord | null> {
    const i = this.incidents.get(incidentId);
    return !this.unavailable && i && i.propertyId === propertyId ? i : null;
  }
  async updateIncident(incidentId: string, action: IncidentActionInput, actorUserId: string): Promise<IncidentStatus> {
    this.assertAvailable("incident-update");
    const i = this.incidents.get(incidentId);
    if (!i) throw new PrivacyAccessDeniedError("incident-update");
    if (i.status === "cerrada") throw new PrivacyConflictError("el incidente ya esta cerrado");
    const at = this.now();
    if (action.action === "contener") {
      if (i.status !== "detectada") throw new PrivacyConflictError("solo un incidente detectado se puede marcar como contenido");
      this.incidents.set(incidentId, { ...i, status: "contenida", containedAt: at });
      this.log(i.propertyId, "incidente", incidentId, actorUserId, "incidente_contenido", action.note);
      return "contenida";
    }
    if (action.action === "registrar_notificacion") {
      if (i.notifiedAt !== null) throw new PrivacyConflictError("la notificacion al titular ya fue registrada");
      this.incidents.set(incidentId, { ...i, notifiedAt: at, notifiedBy: actorUserId, notificationChannel: action.channel, notificationRef: action.ref });
      this.log(i.propertyId, "incidente", incidentId, actorUserId, "titular_notificado", `canal ${action.channel}`);
      return i.status;
    }
    if (i.significantRisk && i.notifiedAt === null && (action.ref ?? "").length < 10) {
      throw new PrivacyConflictError("con riesgo significativo registra la notificacion al titular o el motivo de no notificar (10 a 300 caracteres)");
    }
    this.incidents.set(incidentId, {
      ...i, status: "cerrada", closedAt: at, closedBy: actorUserId, closingNote: action.note, noNotificationReason: i.significantRisk && i.notifiedAt === null ? action.ref : null,
    });
    this.log(i.propertyId, "incidente", incidentId, actorUserId, "incidente_cerrado", action.note);
    return "cerrada";
  }

  async placeLegalHold(input: NewLegalHoldInput, actorUserId: string): Promise<string> {
    this.assertAvailable("hold-place");
    const propertyId = this.identity?.getById(input.vaultId)?.propertyId;
    if (!propertyId) throw new PrivacyAccessDeniedError("hold-place");
    const id = randomUUID();
    this.holds.set(id, {
      id, propertyId, vaultId: input.vaultId, incidentId: input.incidentId, folio: input.folio, reason: input.reason, authorizationRef: input.authorizationRef, status: "activa", placedBy: actorUserId,
      placedAt: this.now(), reviewDueOn: addDaysYmd("2026-01-01", LEGAL_HOLD_REVIEW_DAYS), releasedBy: null, releasedAt: null, releaseNote: null,
    });
    this.identity?.setLegalHold(input.vaultId, true);
    this.log(propertyId, "retencion_legal", id, actorUserId, "retencion_aplicada", `folio ${input.folio}`);
    return id;
  }
  async listLegalHolds(propertyId: string, filters: { vaultId?: string; status?: LegalHoldStatus; limit: number }): Promise<PrivacyListResult<LegalHoldRecord>> {
    return InMemoryPrivacyRepository.list(
      this.unavailable,
      [...this.holds.values()].filter((h) => h.propertyId === propertyId && (!filters.vaultId || h.vaultId === filters.vaultId) && (!filters.status || h.status === filters.status)).sort((a, b) => (a.placedAt < b.placedAt ? 1 : -1)).slice(0, filters.limit),
    );
  }
  async findLegalHold(propertyId: string, holdId: string): Promise<LegalHoldRecord | null> {
    const h = this.holds.get(holdId);
    return !this.unavailable && h && h.propertyId === propertyId ? h : null;
  }
  async releaseLegalHold(holdId: string, note: string, actorUserId: string): Promise<void> {
    this.assertAvailable("hold-release");
    const h = this.holds.get(holdId);
    if (!h) throw new PrivacyAccessDeniedError("hold-release");
    if (h.status !== "activa") throw new PrivacyConflictError("la retencion ya fue liberada");
    this.holds.set(holdId, { ...h, status: "liberada", releasedBy: actorUserId, releasedAt: this.now(), releaseNote: note });
    if (![...this.holds.values()].some((x) => x.vaultId === h.vaultId && x.status === "activa")) this.identity?.setLegalHold(h.vaultId, false);
    this.log(h.propertyId, "retencion_legal", holdId, actorUserId, "retencion_liberada", note);
  }

  async blockIdentity(vaultId: string, reason: string, actorUserId: string): Promise<void> {
    this.assertAvailable("identity-block");
    if (!this.identity) throw new PrivacyUnavailableError("identity-block");
    await this.identity.blockIdentity(vaultId, reason, actorUserId);
  }

  async requestBlockedAccess(vaultId: string, reason: string, actorUserId: string): Promise<string> {
    this.assertAvailable("blocked-access-request");
    const rec = this.identity?.getById(vaultId);
    if (!rec) throw new PrivacyAccessDeniedError("blocked-access-request");
    if (rec.status !== "bloqueada") throw new PrivacyConflictError("solo las identidades bloqueadas usan acceso excepcional");
    if ([...this.accesses.values()].some((a) => a.vaultId === vaultId && (a.status === "pendiente" || a.status === "aprobada"))) throw new PrivacyConflictError("Ya existe un registro con ese folio, version o una solicitud abierta para el mismo objeto.");
    const id = randomUUID();
    this.accesses.set(id, {
      id, propertyId: rec.propertyId, vaultId, requestedBy: actorUserId, reason, status: "pendiente", decidedBy: null, decidedAt: null, decisionNote: null, expiresAt: null, usedAt: null, createdAt: this.now(),
    });
    this.log(rec.propertyId, "acceso_excepcional", id, actorUserId, "acceso_excepcional_solicitado", reason);
    return id;
  }
  async decideBlockedAccess(requestId: string, approve: boolean, note: string | null, actorUserId: string): Promise<"aprobada" | "rechazada"> {
    this.assertAvailable("blocked-access-decide");
    const a = this.accesses.get(requestId);
    if (!a) throw new PrivacyAccessDeniedError("blocked-access-decide");
    if (a.status !== "pendiente") throw new PrivacyConflictError("la solicitud ya fue resuelta");
    if (a.requestedBy === actorUserId) throw new PrivacyDoubleControlError();
    const status: BlockedAccessStatus = approve ? "aprobada" : "rechazada";
    this.accesses.set(requestId, { ...a, status, decidedBy: actorUserId, decidedAt: this.now(), decisionNote: note, expiresAt: approve ? "2026-01-01T02:00:00.000Z" : null });
    if (approve) this.identity?.grantBlockedAccess(requestId, a.vaultId, a.requestedBy);
    this.log(a.propertyId, "acceso_excepcional", requestId, actorUserId, approve ? "acceso_excepcional_aprobado" : "acceso_excepcional_rechazado", note);
    return approve ? "aprobada" : "rechazada";
  }
  async listBlockedAccess(propertyId: string, filters: { status?: BlockedAccessStatus; limit: number }): Promise<PrivacyListResult<BlockedAccessRequestRecord>> {
    return InMemoryPrivacyRepository.list(
      this.unavailable,
      [...this.accesses.values()].filter((a) => a.propertyId === propertyId && (!filters.status || a.status === filters.status)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, filters.limit),
    );
  }
  async findBlockedAccess(propertyId: string, requestId: string): Promise<BlockedAccessRequestRecord | null> {
    const a = this.accesses.get(requestId);
    return !this.unavailable && a && a.propertyId === propertyId ? a : null;
  }

  async listEvents(propertyId: string, filters: { subjectType?: PrivacyEventSubject; subjectId?: string; limit: number }): Promise<PrivacyListResult<PrivacyEventRecord>> {
    return InMemoryPrivacyRepository.list(
      this.unavailable,
      this.events.filter((e) => e.propertyId === propertyId && (!filters.subjectType || e.subjectType === filters.subjectType) && (!filters.subjectId || e.subjectId === filters.subjectId)).slice().reverse().slice(0, filters.limit),
    );
  }
}

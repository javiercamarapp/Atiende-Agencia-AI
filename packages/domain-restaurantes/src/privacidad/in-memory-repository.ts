// Adaptador en memoria de `PrivacidadRepository` para pruebas. Reproduce las reglas que la base real
// impone (idempotencia por (org, telefono, derecho), confirmacion con plazos 20 + 35 dias,
// expiracion a las 24 h, transiciones de estado, evidencia unica del aviso, consentimiento de
// grabacion) y permite simular la base SIN migrar con `migrada = false`.
import { randomUUID } from "node:crypto";
import { PRIVACY_CONFIG_POR_DEFECTO } from "./aviso.ts";
import type { PrivacyConfig, PrivacyConfigEntrada } from "./aviso.ts";
import {
  DATA_RIGHT_OPEN_STATUSES,
  DATA_RIGHTS_CONFIRMATION_WINDOW_HOURS,
  DATA_RIGHTS_EXECUTION_DAYS,
  DATA_RIGHTS_RESPONSE_DAYS,
} from "./data-rights.ts";
import type {
  ConfirmDataRightsOutcome,
  DataRightStaffTargetStatus,
  DataRightStatus,
  DataRightType,
  DataRightsChannel,
  DataRightsEventRow,
  DataRightsPaginacion,
  DataRightsRequestRow,
  DataRightsRequestsFiltro,
  DataRightsRequestsPage,
  RegisterDataRightsOutcome,
  UpdateDataRightsStatusResult,
} from "./data-rights.ts";
import type { PrivacidadRepository, PurgeOutcome, RecordingConsent, SetRecordingConsentResult, UpdatePrivacyConfigResult } from "./repository.ts";

interface RequestMem extends DataRightsRequestRow {
  readonly organizationId: string;
  readonly createdAtMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_FOR_DEDUPE: readonly DataRightStatus[] = ["pendiente_confirmacion", ...DATA_RIGHT_OPEN_STATUSES];

export class InMemoryPrivacidadRepository implements PrivacidadRepository {
  /** `false` simula una base sin la migracion 030. */
  migrada = true;
  /** Rol del actor staff simulado en los metodos de staff. */
  rolStaff: "owner" | "admin" | "staff" = "owner";
  reloj: () => number = () => Date.now();
  readonly requests: RequestMem[] = [];
  readonly events: (DataRightsEventRow & { organizationId: string })[] = [];
  readonly notices = new Set<string>();
  readonly configs = new Map<string, PrivacyConfig>();
  readonly consents = new Map<string, RecordingConsent>();

  async getPrivacyConfig(organizationId: string): Promise<PrivacyConfig> {
    if (!this.migrada) return PRIVACY_CONFIG_POR_DEFECTO;
    return this.configs.get(organizationId) ?? PRIVACY_CONFIG_POR_DEFECTO;
  }

  async claimPrivacyNotice(organizationId: string, phoneHash: string, channel: DataRightsChannel, version: string): Promise<boolean | null> {
    if (!this.migrada) return null;
    const key = `${organizationId}|${phoneHash}|${channel}|${version}`;
    if (this.notices.has(key)) return false;
    this.notices.add(key);
    return true;
  }

  private event(req: RequestMem, actorKind: "titular" | "sistema" | "staff", event: string, from: string | null, to: string | null, note: string | null = null): void {
    this.events.push({
      id: randomUUID(),
      organizationId: req.organizationId,
      requestId: req.id,
      actorKind,
      actorUserId: null,
      event,
      fromStatus: from,
      toStatus: to,
      note,
      createdAt: new Date(this.reloj()).toISOString(),
    });
  }

  private replace(id: string, patch: Partial<DataRightsRequestRow>): RequestMem {
    const idx = this.requests.findIndex((r) => r.id === id);
    const next = { ...this.requests[idx]!, ...patch, updatedAt: new Date(this.reloj()).toISOString() } as RequestMem;
    this.requests[idx] = next;
    return next;
  }

  async registerDataRightsRequestAsSystem(input: { organizationId: string; customerPhone: string; rightType: DataRightType; channel: DataRightsChannel; detail: string | null }): Promise<RegisterDataRightsOutcome> {
    if (!this.migrada) return { available: false };
    const now = this.reloj();
    for (const r of this.requests) {
      if (r.organizationId === input.organizationId && r.customerPhone === input.customerPhone && r.status === "pendiente_confirmacion" && r.createdAtMs < now - DATA_RIGHTS_CONFIRMATION_WINDOW_HOURS * 3600_000) {
        const next = this.replace(r.id, { status: "expirada" });
        this.event(next, "sistema", "expirada", "pendiente_confirmacion", "expirada");
      }
    }
    const open = this.requests.find(
      (r) => r.organizationId === input.organizationId && r.customerPhone === input.customerPhone && r.rightType === input.rightType && OPEN_FOR_DEDUPE.includes(r.status),
    );
    if (open) return { available: true, id: open.id, status: open.status, alreadyOpen: true, responseDueAt: open.responseDueAt };
    const created: RequestMem = {
      id: randomUUID(),
      organizationId: input.organizationId,
      createdAtMs: now,
      customerPhone: input.customerPhone,
      rightType: input.rightType,
      channel: input.channel,
      identityBasis: input.channel === "voice" ? "llamada_identificador" : "whatsapp_numero",
      status: "pendiente_confirmacion",
      detail: input.detail ? input.detail.slice(0, 300) : null,
      requestedAt: new Date(now).toISOString(),
      confirmedAt: null,
      responseDueAt: null,
      executionDueAt: null,
      resolvedAt: null,
      resolutionNote: null,
      handledBy: null,
      updatedAt: new Date(now).toISOString(),
    };
    this.requests.push(created);
    this.event(created, "titular", "registrada", null, "pendiente_confirmacion");
    return { available: true, id: created.id, status: created.status, alreadyOpen: false, responseDueAt: null };
  }

  async resolveDataRightsConfirmationAsSystem(organizationId: string, customerPhone: string, confirm: boolean): Promise<ConfirmDataRightsOutcome> {
    if (!this.migrada) return { available: false };
    const now = this.reloj();
    const pending = [...this.requests]
      .reverse()
      .find((r) => r.organizationId === organizationId && r.customerPhone === customerPhone && r.status === "pendiente_confirmacion" && r.createdAtMs >= now - DATA_RIGHTS_CONFIRMATION_WINDOW_HOURS * 3600_000);
    if (!pending) return { available: true, found: false };
    const next = confirm
      ? this.replace(pending.id, {
          status: "recibida",
          confirmedAt: new Date(now).toISOString(),
          responseDueAt: new Date(now + DATA_RIGHTS_RESPONSE_DAYS * DAY_MS).toISOString(),
          executionDueAt: new Date(now + (DATA_RIGHTS_RESPONSE_DAYS + DATA_RIGHTS_EXECUTION_DAYS) * DAY_MS).toISOString(),
        })
      : this.replace(pending.id, { status: "cancelada_titular" });
    this.event(next, "titular", confirm ? "confirmada" : "cancelada_por_titular", "pendiente_confirmacion", next.status);
    return { available: true, found: true, id: next.id, rightType: next.rightType, status: next.status, responseDueAt: next.responseDueAt, executionDueAt: next.executionDueAt };
  }

  async setVoiceRecordingConsent(_organizationId: string, conversationId: string, consent: RecordingConsent): Promise<SetRecordingConsentResult> {
    if (!this.migrada) return { outcome: "unavailable" };
    const current = this.consents.get(conversationId);
    if (current === "negado") return { outcome: "set", consent: "negado" };
    this.consents.set(conversationId, consent);
    return { outcome: "set", consent };
  }

  purgeResult: PurgeOutcome = { disponible: true, conversationsCleared: 0, voiceTurnsDeleted: 0, voiceCallsAnonymized: 0 };
  async purgeExpiredPrivacyData(_limit: number): Promise<PurgeOutcome> {
    if (!this.migrada) return { disponible: false, conversationsCleared: 0, voiceTurnsDeleted: 0, voiceCallsAnonymized: 0 };
    return this.purgeResult;
  }

  async listDataRightsRequests(organizationId: string, filtro: DataRightsRequestsFiltro, paginacion: DataRightsPaginacion): Promise<DataRightsRequestsPage> {
    if (!this.migrada) return { disponible: false, items: [], total: 0, nextOffset: null };
    const limit = Math.min(200, Math.max(1, paginacion.limit ?? 50));
    const offset = Math.max(0, paginacion.offset ?? 0);
    const all = this.requests
      .filter((r) => r.organizationId === organizationId && (!filtro.status || r.status === filtro.status) && (!filtro.rightType || r.rightType === filtro.rightType))
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
    const items = all.slice(offset, offset + limit).map(({ organizationId: _o, createdAtMs: _c, ...row }) => row);
    return { disponible: true, items, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null };
  }

  async listDataRightsEvents(organizationId: string, requestId: string): Promise<readonly DataRightsEventRow[] | null> {
    if (!this.migrada) return null;
    return this.events.filter((e) => e.organizationId === organizationId && e.requestId === requestId).map(({ organizationId: _o, ...e }) => e);
  }

  async updateDataRightsRequestStatus(organizationId: string, requestId: string, status: DataRightStaffTargetStatus, note: string | null): Promise<UpdateDataRightsStatusResult> {
    if (!this.migrada) return { outcome: "unavailable" };
    if (this.rolStaff === "staff") return { outcome: "forbidden" };
    if (status === "rechazada" && (!note || note.trim() === "")) return { outcome: "invalid_input" };
    const req = this.requests.find((r) => r.id === requestId && r.organizationId === organizationId);
    if (!req) return { outcome: "not_found" };
    const from = req.status;
    const ok =
      (from === "recibida" && ["en_proceso", "bloqueada", "resuelta", "rechazada"].includes(status)) ||
      (from === "en_proceso" && ["bloqueada", "resuelta", "rechazada"].includes(status)) ||
      (from === "bloqueada" && ["resuelta", "rechazada"].includes(status));
    if (!ok || (status === "bloqueada" && req.rightType !== "cancelacion")) return { outcome: "invalid_transition" };
    const terminal = status === "resuelta" || status === "rechazada";
    const next = this.replace(req.id, {
      status,
      resolutionNote: terminal ? (note ?? "").slice(0, 1000) : req.resolutionNote,
      resolvedAt: terminal ? new Date(this.reloj()).toISOString() : req.resolvedAt,
    });
    this.event(next, "staff", "cambio_estado", from, status, note);
    return { outcome: "updated", id: next.id, status };
  }

  async updatePrivacyConfig(organizationId: string, config: PrivacyConfigEntrada): Promise<UpdatePrivacyConfigResult> {
    if (!this.migrada) return { outcome: "unavailable" };
    if (this.rolStaff === "staff") return { outcome: "forbidden" };
    this.configs.set(organizationId, { ...config, configurada: true });
    return { outcome: "updated" };
  }
}

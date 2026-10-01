// Adaptador en memoria de la boveda de identidad (tests de rutas/servicio). Reproduce las
// reglas del modelo SQL que importan al codigo TS: doble control, purga irreversible,
// una solicitud pendiente por identidad, guardas de property, reportado que no retrocede.
// NO reproduce RLS/GRANT: eso lo cubre scripts/verify-hoteles-boveda-identidad contra
// Postgres real. Las rutas aplican el rol fino antes de llamar aqui.
import { randomUUID } from "node:crypto";
import {
  IdentityAccessDeniedError,
  IdentityBlockedError,
  IdentityConflictError,
  IdentityDoubleControlError,
  IdentityInvalidInputError,
  IdentityPurgedError,
  IdentityRequestResolvedError,
  IdentityUnavailableError,
} from "./errors.ts";
import type { IdentityRepository } from "./repository.ts";
import { addDaysYmd } from "./service.ts";
import type {
  IdentityAccessAction,
  IdentityAccessLogRecord,
  IdentityListResult,
  IdentityPurgeRequestRecord,
  IdentityPurgeStatus,
  IdentityRetentionSweepResult,
  IdentityStatus,
  IdentityVaultRecord,
  MigratoryRegistrationRecord,
  MigratoryStatus,
  NewIdentityVaultInput,
  RevealedEnvelope,
} from "./types.ts";

interface VaultEntry extends IdentityVaultRecord {
  payloadEnc: string | null;
}

export class InMemoryIdentityRepository implements IdentityRepository {
  private readonly vault = new Map<string, VaultEntry>();
  private readonly log: IdentityAccessLogRecord[] = [];
  private readonly purges = new Map<string, IdentityPurgeRequestRecord>();
  private readonly registrations = new Map<string, MigratoryRegistrationRecord>();
  private readonly guests = new Map<string, string>(); // guestId -> propertyId
  private readonly reservations = new Map<string, { propertyId: string; checkIn: string; checkOut: string }>();
  private tick = 0;
  /** Simula una base sin la migracion 031 (lecturas vacias, escrituras 503). */
  unavailable = false;
  // Estado del bloqueo (migracion 032). El tiempo del adaptador en memoria es de NEGOCIO (YYYY-MM-DD).
  private windowDays = 7;
  private businessDate = "2026-01-01";
  private readonly heldVaults = new Set<string>();
  private readonly blockedAccess = new Map<string, { vaultId: string; requester: string }>();

  /** Para tests: ventana de bloqueo de la property (3-30). */
  setBlockWindowDays(days: number): void {
    this.windowDays = days;
  }
  /** Para tests: fecha de negocio con la que se sellan los bloqueos hechos fuera del barrido (aprobar una purga). */
  setBusinessDate(ymd: string): void {
    this.businessDate = ymd;
  }
  /** Para tests: simula una retencion legal activa sobre la identidad (la purga no la toca). */
  setLegalHold(vaultId: string, active: boolean): void {
    if (active) this.heldVaults.add(vaultId);
    else this.heldVaults.delete(vaultId);
  }
  /** Para tests: simula una aprobacion vigente de acceso excepcional (doble control resuelto). */
  grantBlockedAccess(requestId: string, vaultId: string, requesterUserId: string): void {
    this.blockedAccess.set(requestId, { vaultId, requester: requesterUserId });
  }

  seedGuest(propertyId: string, guestId: string): void {
    this.guests.set(guestId, propertyId);
  }
  seedReservation(propertyId: string, reservationId: string, checkIn: string, checkOut: string): void {
    this.reservations.set(reservationId, { propertyId, checkIn, checkOut });
  }
  /** Para asserts de tests: el sobre guardado (null tras purgar). */
  storedEnvelope(vaultId: string): string | null {
    return this.vault.get(vaultId)?.payloadEnc ?? null;
  }
  /** Para tests: fuerza una retencion ya vencida. */
  setRetention(vaultId: string, retentionUntil: string): void {
    const e = this.vault.get(vaultId);
    if (e) this.vault.set(vaultId, { ...e, retentionUntil });
  }

  private now(): string {
    this.tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString();
  }
  private assertAvailable(operation: string): void {
    if (this.unavailable) {
      throw new IdentityUnavailableError("migracion_pendiente", operation);
    }
  }
  private record(propertyId: string, vaultId: string, actorUserId: string | null, action: IdentityAccessAction, reason: string | null): void {
    this.log.push({ id: randomUUID(), propertyId, vaultId, actorUserId, action, reason, createdAt: this.now() });
  }
  private strip(e: VaultEntry): IdentityVaultRecord {
    const { payloadEnc: _omit, ...rest } = e;
    void _omit;
    return rest;
  }

  async captureIdentity(input: NewIdentityVaultInput): Promise<IdentityVaultRecord> {
    this.assertAvailable("capture");
    if (this.guests.get(input.guestId) !== input.propertyId) throw new IdentityInvalidInputError("el huesped no pertenece a la property");
    if (input.reservationId && this.reservations.get(input.reservationId)?.propertyId !== input.propertyId) throw new IdentityInvalidInputError("la reserva no pertenece a la property");
    if (!/^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$/.test(input.payloadEnc)) throw new IdentityInvalidInputError("Los datos no cumplen las restricciones del modelo (formato del sobre cifrado).");
    const entry: VaultEntry = {
      id: input.id, propertyId: input.propertyId, guestId: input.guestId, reservationId: input.reservationId, documentType: input.documentType,
      nationality: input.nationality, documentLast4: input.documentLast4, keyVersion: input.keyVersion, status: "activo",
      retentionUntil: input.retentionUntil, verifiedAt: null, verifiedBy: null, capturedBy: input.actorUserId, createdAt: this.now(), purgedAt: null,
      blockedAt: null, blockedUntil: null, blockWindowDays: null, blockReason: null, blockedBy: null,
      payloadEnc: input.payloadEnc,
    };
    this.vault.set(entry.id, entry);
    this.record(entry.propertyId, entry.id, input.actorUserId, "captura", null);
    return this.strip(entry);
  }

  async listIdentities(propertyId: string, filters: { guestId?: string; status?: IdentityStatus; limit: number }): Promise<IdentityListResult<IdentityVaultRecord>> {
    if (this.unavailable) return { available: false, items: [] };
    const items = [...this.vault.values()]
      .filter((e) => e.propertyId === propertyId && (!filters.guestId || e.guestId === filters.guestId) && (!filters.status || e.status === filters.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, filters.limit)
      .map((e) => this.strip(e));
    return { available: true, items };
  }

  async findIdentity(propertyId: string, vaultId: string): Promise<IdentityVaultRecord | null> {
    if (this.unavailable) return null;
    const e = this.vault.get(vaultId);
    return e && e.propertyId === propertyId ? this.strip(e) : null;
  }

  async verifyIdentity(vaultId: string, actorUserId: string): Promise<void> {
    this.assertAvailable("verify");
    const e = this.vault.get(vaultId);
    if (!e) throw new IdentityAccessDeniedError("verify");
    if (e.status === "bloqueada") throw new IdentityBlockedError();
    if (e.status !== "activo") throw new IdentityPurgedError();
    this.vault.set(vaultId, { ...e, verifiedAt: this.now(), verifiedBy: actorUserId });
    this.record(e.propertyId, vaultId, actorUserId, "verificacion", null);
  }

  async revealIdentity(vaultId: string, reason: string, actorUserId: string): Promise<RevealedEnvelope> {
    this.assertAvailable("reveal");
    const e = this.vault.get(vaultId);
    if (!e) throw new IdentityAccessDeniedError("reveal");
    const r = reason.trim();
    if (r.length < 10 || r.length > 300) throw new IdentityInvalidInputError("el motivo debe tener entre 10 y 300 caracteres");
    if (e.status === "bloqueada") throw new IdentityBlockedError();
    if (e.status !== "activo" || !e.payloadEnc) throw new IdentityPurgedError();
    this.record(e.propertyId, vaultId, actorUserId, "revelacion", r);
    return { envelope: e.payloadEnc, keyVersion: e.keyVersion };
  }

  async listAccessLog(propertyId: string, filters: { vaultId?: string; limit: number }): Promise<IdentityListResult<IdentityAccessLogRecord>> {
    if (this.unavailable) return { available: false, items: [] };
    const items = this.log.filter((l) => l.propertyId === propertyId && (!filters.vaultId || l.vaultId === filters.vaultId)).slice().reverse().slice(0, filters.limit);
    return { available: true, items };
  }

  async requestPurge(vaultId: string, reason: string, actorUserId: string): Promise<string> {
    this.assertAvailable("purge-request");
    const e = this.vault.get(vaultId);
    if (!e) throw new IdentityAccessDeniedError("purge-request");
    const r = reason.trim();
    if (r.length < 10 || r.length > 300) throw new IdentityInvalidInputError("el motivo debe tener entre 10 y 300 caracteres");
    if (e.status === "bloqueada") throw new IdentityBlockedError("La identidad ya esta bloqueada y se purgara al vencer su ventana.");
    if (e.status !== "activo") throw new IdentityPurgedError();
    if ([...this.purges.values()].some((p) => p.vaultId === vaultId && p.status === "pendiente")) {
      throw new IdentityConflictError("Ya existe una solicitud de purga pendiente para esta identidad.");
    }
    const id = randomUUID();
    this.purges.set(id, { id, propertyId: e.propertyId, vaultId, requestedBy: actorUserId, reason: r, status: "pendiente", decidedBy: null, decidedAt: null, decisionNote: null, createdAt: this.now() });
    this.record(e.propertyId, vaultId, actorUserId, "purga_solicitada", r);
    return id;
  }

  async listPurgeRequests(propertyId: string, filters: { status?: IdentityPurgeStatus; limit: number }): Promise<IdentityListResult<IdentityPurgeRequestRecord>> {
    if (this.unavailable) return { available: false, items: [] };
    const items = [...this.purges.values()]
      .filter((p) => p.propertyId === propertyId && (!filters.status || p.status === filters.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, filters.limit);
    return { available: true, items };
  }

  async findPurgeRequest(propertyId: string, requestId: string): Promise<IdentityPurgeRequestRecord | null> {
    if (this.unavailable) return null;
    const p = this.purges.get(requestId);
    return p && p.propertyId === propertyId ? p : null;
  }

  private blockEntry(e: VaultEntry, reason: NonNullable<IdentityVaultRecord["blockReason"]>, today: string, actorUserId: string | null, note: string | null): void {
    this.vault.set(e.id, {
      ...e, status: "bloqueada", blockedAt: this.now(), blockedUntil: addDaysYmd(today, this.windowDays), blockWindowDays: this.windowDays, blockReason: reason, blockedBy: actorUserId,
    });
    this.record(e.propertyId, e.id, actorUserId, "bloqueo", note ?? reason);
  }

  async decidePurge(requestId: string, approve: boolean, note: string | null, actorUserId: string): Promise<"ejecutada" | "rechazada" | "en_bloqueo"> {
    this.assertAvailable("purge-decide");
    const p = this.purges.get(requestId);
    if (!p) throw new IdentityAccessDeniedError("purge-decide");
    if (p.status !== "pendiente") throw new IdentityRequestResolvedError();
    if (p.requestedBy === actorUserId) throw new IdentityDoubleControlError();
    const decidedAt = this.now();
    if (approve) {
      // Desde 032 aprobar NO purga: bloquea y la purga ocurre al vencer la ventana.
      const e = this.vault.get(p.vaultId);
      if (e && e.status === "activo") this.blockEntry(e, "solicitud_purga", this.businessDate, actorUserId, note ?? p.reason);
      const result = e?.status === "purgado" ? "ejecutada" : "en_bloqueo";
      this.purges.set(requestId, { ...p, status: result, decidedBy: actorUserId, decidedAt, decisionNote: note });
      this.record(p.propertyId, p.vaultId, actorUserId, "purga_aprobada", note);
      return result;
    }
    this.purges.set(requestId, { ...p, status: "rechazada", decidedBy: actorUserId, decidedAt, decisionNote: note });
    this.record(p.propertyId, p.vaultId, actorUserId, "purga_rechazada", note);
    return "rechazada";
  }

  async purgeExpired(propertyId: string, today: string): Promise<number> {
    this.assertAvailable("purge-expired");
    let n = 0;
    for (const e of [...this.vault.values()]) {
      if (e.propertyId !== propertyId || e.status !== "bloqueada" || e.blockedUntil === null || e.blockedUntil > today || this.heldVaults.has(e.id)) continue;
      const at = this.now();
      this.vault.set(e.id, { ...e, payloadEnc: null, documentLast4: null, nationality: null, status: "purgado", purgedAt: at });
      for (const p of this.purges.values()) {
        if (p.vaultId === e.id && (p.status === "pendiente" || p.status === "en_bloqueo")) {
          this.purges.set(p.id, { ...p, status: "ejecutada", decidedAt: p.decidedAt ?? at, decisionNote: p.decisionNote ?? "purga al vencer la ventana de bloqueo" });
        }
      }
      this.record(propertyId, e.id, null, "purga_por_bloqueo_vencido", "ventana de bloqueo vencida");
      n += 1;
    }
    return n;
  }

  async sweepRetention(propertyId: string, today: string): Promise<IdentityRetentionSweepResult> {
    this.assertAvailable("sweep");
    let blocked = 0;
    for (const e of [...this.vault.values()]) {
      if (e.propertyId !== propertyId || e.status !== "activo" || !(e.retentionUntil < today)) continue;
      this.blockEntry(e, "retencion_vencida", today, null, "retencion vencida");
      blocked += 1;
    }
    const purged = await this.purgeExpired(propertyId, today);
    return { blocked, purged, viaBloqueo: true };
  }

  async revealBlockedIdentity(accessRequestId: string, actorUserId: string): Promise<RevealedEnvelope> {
    this.assertAvailable("reveal-blocked");
    const grant = this.blockedAccess.get(accessRequestId);
    if (!grant || grant.requester !== actorUserId) throw new IdentityAccessDeniedError("reveal-blocked");
    const e = this.vault.get(grant.vaultId);
    if (!e || e.status !== "bloqueada" || !e.payloadEnc) throw new IdentityPurgedError();
    this.blockedAccess.delete(accessRequestId); // un solo uso
    this.record(e.propertyId, e.id, actorUserId, "acceso_excepcional_revelacion", null);
    return { envelope: e.payloadEnc, keyVersion: e.keyVersion };
  }

  async createMigratoryRegistration(input: { propertyId: string; reservationId: string; guestId: string; vaultId: string | null; actorUserId: string }): Promise<MigratoryRegistrationRecord> {
    this.assertAvailable("migratory-create");
    const res = this.reservations.get(input.reservationId);
    if (!res || res.propertyId !== input.propertyId) throw new IdentityInvalidInputError("la reserva no pertenece a la property");
    if (this.guests.get(input.guestId) !== input.propertyId) throw new IdentityInvalidInputError("el huesped no pertenece a la property");
    let nationality: string | null = null;
    if (input.vaultId) {
      const v = this.vault.get(input.vaultId);
      if (!v || v.propertyId !== input.propertyId || v.guestId !== input.guestId) throw new IdentityInvalidInputError("la identidad no corresponde a la property/huesped");
      nationality = v.nationality;
    }
    if ([...this.registrations.values()].some((r) => r.reservationId === input.reservationId && r.guestId === input.guestId)) {
      throw new IdentityConflictError("Ya existe un registro migratorio para esta reserva y huesped.");
    }
    const rec: MigratoryRegistrationRecord = {
      id: randomUUID(), propertyId: input.propertyId, reservationId: input.reservationId, guestId: input.guestId, vaultId: input.vaultId,
      nationality, arrivalDate: res.checkIn, departureDate: res.checkOut, status: "pendiente", constanciaRef: null, reportedAt: null, reportedBy: null, createdAt: this.now(),
    };
    this.registrations.set(rec.id, rec);
    return rec;
  }

  async listMigratoryRegistrations(propertyId: string, filters: { status?: MigratoryStatus; limit: number }): Promise<IdentityListResult<MigratoryRegistrationRecord>> {
    if (this.unavailable) return { available: false, items: [] };
    const items = [...this.registrations.values()]
      .filter((r) => r.propertyId === propertyId && (!filters.status || r.status === filters.status))
      .sort((a, b) => (a.arrivalDate < b.arrivalDate ? 1 : -1))
      .slice(0, filters.limit);
    return { available: true, items };
  }

  async reportMigratoryRegistration(propertyId: string, registrationId: string, constanciaRef: string, actorUserId: string): Promise<MigratoryRegistrationRecord | null> {
    this.assertAvailable("migratory-report");
    const r = this.registrations.get(registrationId);
    if (!r || r.propertyId !== propertyId) return null;
    if (r.status === "reportado") throw new IdentityConflictError("El registro migratorio ya fue reportado y no se puede modificar.");
    const updated: MigratoryRegistrationRecord = { ...r, status: "reportado", constanciaRef, reportedAt: this.now(), reportedBy: actorUserId };
    this.registrations.set(registrationId, updated);
    return updated;
  }
}

// Implementacion en memoria de `StaffSecurityRepository` con la MISMA semantica que
// `migrations/0026_staff_totp_stepup_reset.sql` (lockout 5 intentos/15 min, anti-replay por
// paso, codigos de respaldo de un solo uso, tokens de un solo uso con vencimiento). Sirve
// para tests de rutas; NO sustituye la verificacion contra Postgres real
// (`scripts/verify-staff-2fa`), que es la que prueba RLS/GRANT/`auth.uid()`.
//
// `available: false` simula la base sin migrar: todos los metodos lanzan
// `StaffSecurityUnavailableError` (el mismo error que traduce la implementacion Postgres).
import type { TenantDbSession } from "@atiende/core-tenancy";
import type { InMemoryCoreRepository } from "./in-memory-core-repository.ts";
import {
  StaffSecurityUnavailableError,
  TotpAlreadyEnrolledError,
  TotpNoPendingEnrollmentError,
  TotpNotEnrolledError,
} from "./staff-security-repository.ts";
import type { GoogleIdentityRow, StaffSecurityRepository, StaffSessionRow, TotpSecretRow, TotpStatus } from "./staff-security-repository.ts";

interface TotpRow {
  secretCiphertext: string;
  confirmed: boolean;
  lastUsedStep: number | null;
  failedAttempts: number;
  lockedUntil: number | null;
}

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

export class InMemoryStaffSecurityRepository implements StaffSecurityRepository {
  available = true;
  /** `false` simula la base con 0026 pero SIN 038 (sin tabla de consumo del step-up). */
  stepUpConsumptionAvailable = true;
  private readonly consumedStepUps = new Map<string, number>(); // jti -> expira (ms)
  /** Reloj inyectable para tests de lockout/vencimiento. */
  now: () => number = () => Date.now();
  private readonly totp = new Map<string, TotpRow>();
  private readonly backup = new Map<string, Map<string, boolean>>(); // staff -> hash -> usado
  private readonly resetTokens = new Map<string, { staffId: string; expiresAt: number; used: boolean }>();
  private readonly verifyTokens = new Map<string, { staffId: string; expiresAt: number; used: boolean }>();

  private readonly sessions = new Map<string, { staffId: string; startedAt: number; issuedAt: number; expiresAt: number; userAgent: string | null }>();

  constructor(private readonly core: InMemoryCoreRepository) {}

  private guard(): void {
    if (!this.available) throw new StaffSecurityUnavailableError();
  }

  private lockedUntil(row: TotpRow | undefined): string | null {
    return row && row.lockedUntil !== null && row.lockedUntil > this.now() ? new Date(row.lockedUntil).toISOString() : null;
  }

  async consumeStepUpToken(
    _session: TenantDbSession | null,
    input: { readonly jti: string; readonly userId: string; readonly organizationId: string; readonly scope: string; readonly expiresAt: string },
  ): Promise<boolean> {
    this.guard();
    if (!this.stepUpConsumptionAvailable) throw new StaffSecurityUnavailableError();
    if (this.consumedStepUps.has(input.jti)) return false;
    this.consumedStepUps.set(input.jti, Date.parse(input.expiresAt));
    return true;
  }

  async purgeStepUpConsumptionForSystem(): Promise<number> {
    this.guard();
    if (!this.stepUpConsumptionAvailable) throw new StaffSecurityUnavailableError();
    let n = 0;
    for (const [jti, exp] of this.consumedStepUps) {
      if (exp < this.now() - 3_600_000) {
        this.consumedStepUps.delete(jti);
        n += 1;
      }
    }
    return n;
  }

  async getTotpStatus(staffId: string): Promise<TotpStatus> {
    this.guard();
    const row = this.totp.get(staffId);
    const codes = this.backup.get(staffId);
    return {
      enrolled: row?.confirmed === true,
      pending: row !== undefined && !row.confirmed,
      lockedUntil: this.lockedUntil(row),
      backupCodesRemaining: codes ? [...codes.values()].filter((used) => !used).length : 0,
    };
  }

  async getTotpSecret(staffId: string): Promise<TotpSecretRow | null> {
    this.guard();
    const row = this.totp.get(staffId);
    if (!row) return null;
    return { secretCiphertext: row.secretCiphertext, confirmed: row.confirmed, lastUsedStep: row.lastUsedStep, lockedUntil: this.lockedUntil(row) };
  }

  async beginTotpEnrollment(staffId: string, secretCiphertext: string): Promise<void> {
    this.guard();
    if (this.totp.get(staffId)?.confirmed) throw new TotpAlreadyEnrolledError();
    this.totp.set(staffId, { secretCiphertext, confirmed: false, lastUsedStep: null, failedAttempts: 0, lockedUntil: null });
  }

  async confirmTotpEnrollment(staffId: string, step: number, backupCodeHashes: readonly string[]): Promise<void> {
    this.guard();
    const row = this.totp.get(staffId);
    if (!row || row.confirmed) throw new TotpNoPendingEnrollmentError();
    row.confirmed = true;
    row.lastUsedStep = step;
    row.failedAttempts = 0;
    row.lockedUntil = null;
    this.backup.set(staffId, new Map(backupCodeHashes.map((h) => [h, false])));
  }

  async registerTotpSuccess(staffId: string, step: number): Promise<boolean> {
    this.guard();
    const row = this.totp.get(staffId);
    if (!row || this.lockedUntil(row) !== null) return false;
    if (row.lastUsedStep !== null && row.lastUsedStep >= step) return false;
    row.lastUsedStep = step;
    row.failedAttempts = 0;
    row.lockedUntil = null;
    return true;
  }

  async registerTotpFailure(staffId: string): Promise<string | null> {
    this.guard();
    const row = this.totp.get(staffId);
    if (!row) return null;
    const alreadyLocked = this.lockedUntil(row);
    const next = row.failedAttempts + 1;
    if (alreadyLocked === null && next >= MAX_FAILED) row.lockedUntil = this.now() + LOCK_MS;
    row.failedAttempts = next >= MAX_FAILED ? 0 : next;
    return this.lockedUntil(row);
  }

  async consumeBackupCode(staffId: string, codeHash: string): Promise<boolean> {
    this.guard();
    const row = this.totp.get(staffId);
    if (!row?.confirmed || this.lockedUntil(row) !== null) return false;
    const codes = this.backup.get(staffId);
    if (!codes || codes.get(codeHash) !== false) return false;
    codes.set(codeHash, true);
    return true;
  }

  async replaceBackupCodes(staffId: string, backupCodeHashes: readonly string[]): Promise<void> {
    this.guard();
    if (!this.totp.get(staffId)?.confirmed) throw new TotpNotEnrolledError();
    this.backup.set(staffId, new Map(backupCodeHashes.map((h) => [h, false])));
  }

  async disableTotp(staffId: string): Promise<void> {
    this.guard();
    this.totp.delete(staffId);
    this.backup.delete(staffId);
  }

  async changePassword(staffId: string, newPasswordHash: string): Promise<void> {
    this.guard();
    this.core.setPasswordAndRevokeSessions(staffId, newPasswordHash);
  }

  async createPasswordResetToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    this.guard();
    for (const t of this.resetTokens.values()) if (t.staffId === input.staffId) t.used = true;
    this.resetTokens.set(input.tokenHash, { staffId: input.staffId, expiresAt: new Date(input.expiresAt).getTime(), used: false });
  }

  async consumePasswordResetToken(tokenHash: string, newPasswordHash: string): Promise<string | null> {
    this.guard();
    const t = this.resetTokens.get(tokenHash);
    if (!t || t.used || t.expiresAt <= this.now()) return null;
    t.used = true;
    for (const other of this.resetTokens.values()) if (other.staffId === t.staffId) other.used = true;
    this.core.setPasswordAndRevokeSessions(t.staffId, newPasswordHash);
    this.core.markEmailVerified(t.staffId);
    return t.staffId;
  }

  async createEmailVerificationToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    this.guard();
    for (const t of this.verifyTokens.values()) if (t.staffId === input.staffId) t.used = true;
    this.verifyTokens.set(input.tokenHash, { staffId: input.staffId, expiresAt: new Date(input.expiresAt).getTime(), used: false });
  }

  async consumeEmailVerificationToken(tokenHash: string): Promise<string | null> {
    this.guard();
    const t = this.verifyTokens.get(tokenHash);
    if (!t || t.used || t.expiresAt <= this.now()) return null;
    t.used = true;
    this.core.markEmailVerified(t.staffId);
    return t.staffId;
  }

  async registerSession(input: { readonly staffId: string; readonly jti: string; readonly expiresAt: string; readonly userAgent: string | null; readonly replacesJti?: string | null }): Promise<void> {
    this.guard();
    const now = this.now();
    let startedAt = now;
    const replaced = input.replacesJti ? this.sessions.get(input.replacesJti) : undefined;
    // Rotacion: solo reemplaza una sesion de LA MISMA cuenta (misma regla que la funcion SQL).
    if (input.replacesJti && replaced && replaced.staffId === input.staffId) {
      startedAt = replaced.startedAt;
      this.sessions.delete(input.replacesJti);
    }
    for (const [id, row] of this.sessions) if (row.staffId === input.staffId && row.expiresAt <= now) this.sessions.delete(id);
    if (!this.sessions.has(input.jti)) {
      this.sessions.set(input.jti, { staffId: input.staffId, startedAt, issuedAt: now, expiresAt: new Date(input.expiresAt).getTime(), userAgent: input.userAgent ? input.userAgent.slice(0, 200) : null });
    }
    const mine = [...this.sessions.entries()].filter(([, r]) => r.staffId === input.staffId).sort((a, b) => b[1].issuedAt - a[1].issuedAt);
    for (const [id] of mine.slice(50)) this.sessions.delete(id);
  }

  async listSessions(staffId: string): Promise<StaffSessionRow[]> {
    this.guard();
    const now = this.now();
    const cutoff = (await this.core.findStaffById(staffId))?.sessionsRevokedAt;
    const cutoffMs = cutoff ? new Date(cutoff).getTime() : null;
    const out: StaffSessionRow[] = [];
    for (const [id, r] of this.sessions) {
      if (r.staffId !== staffId || r.expiresAt <= now) continue;
      if (cutoffMs !== null && r.issuedAt < cutoffMs) continue;
      if (await this.core.isRefreshTokenRevoked(id)) continue;
      out.push({ id, startedAt: new Date(r.startedAt).toISOString(), issuedAt: new Date(r.issuedAt).toISOString(), expiresAt: new Date(r.expiresAt).toISOString(), userAgent: r.userAgent });
    }
    return out.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  async revokeSession(staffId: string, sessionId: string): Promise<boolean> {
    this.guard();
    const row = this.sessions.get(sessionId);
    if (!row || row.staffId !== staffId) return false;
    this.sessions.delete(sessionId);
    await this.core.revokeRefreshToken({ jti: sessionId, userId: staffId, expiresAt: new Date(row.expiresAt).toISOString() });
    return true;
  }

  async revokeAllSessions(staffId: string): Promise<void> {
    this.guard();
    this.core.revokeSessionsAtSecond(staffId);
  }

  async listGoogleIdentities(staffId: string): Promise<GoogleIdentityRow[]> {
    this.guard();
    return this.core.listGoogleIdentitiesFor(staffId);
  }

  async unlinkGoogleIdentity(staffId: string, identityId: string): Promise<boolean> {
    this.guard();
    return this.core.unlinkGoogleIdentityFor(staffId, identityId);
  }
}

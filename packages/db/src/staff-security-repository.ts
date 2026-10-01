// Puerto de seguridad de la cuenta de staff: segundo factor TOTP (+ codigos de respaldo),
// cambio/reset de contrasena y verificacion de correo. SQL en
// `migrations/0026_staff_totp_stepup_reset.sql`.
//
// Contrato de transacciones (importante para la regla de compatibilidad con la base sin
// migrar): CADA metodo abre SU PROPIA transaccion (`engine.withAppSession`) y no hace nada
// mas despues de una posible falla de Postgres. Asi un SQLSTATE 42883/42P01/42703 (la
// migracion todavia no se aplico) se captura FUERA de la transaccion y se traduce a
// `StaffSecurityUnavailableError`, sin dejar una transaccion compartida abortada. Esto
// tambien es lo que hace que el conteo de intentos fallidos del segundo factor SOBREVIVA
// aunque la ruta responda 4xx justo despues (si compartiera la transaccion del request,
// el ROLLBACK borraria el intento y el lockout nunca se activaria).
//
// Sesion: los metodos "atados al usuario" abren la sesion COMO ese usuario
// (`auth.uid() = staffId`, exigido por las funciones SQL); los de reset/verificacion de
// correo son de solo-sistema (`userId: null`).
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { isMigrationPendingError } from "./sql-errors.ts";

export interface TotpStatus {
  /** Segundo factor confirmado y activo. */
  readonly enrolled: boolean;
  /** Alta iniciada, todavia sin confirmar. */
  readonly pending: boolean;
  /** ISO 8601 si la verificacion esta bloqueada por intentos fallidos. */
  readonly lockedUntil: string | null;
  readonly backupCodesRemaining: number;
}

export interface TotpSecretRow {
  readonly secretCiphertext: string;
  readonly confirmed: boolean;
  readonly lastUsedStep: number | null;
  readonly lockedUntil: string | null;
}

/** La migracion 0026 todavia no se aplico a esta base: las rutas responden "no disponible aun". */
export class StaffSecurityUnavailableError extends Error {
  constructor() {
    super("El segundo factor y la gestion de contrasena todavia no estan disponibles en esta base (migracion pendiente).");
    this.name = "StaffSecurityUnavailableError";
  }
}

export class TotpAlreadyEnrolledError extends Error {
  constructor() {
    super("Ya hay un segundo factor activo; desactivalo primero.");
    this.name = "TotpAlreadyEnrolledError";
  }
}

export class TotpNoPendingEnrollmentError extends Error {
  constructor() {
    super("No hay un alta de segundo factor pendiente de confirmar.");
    this.name = "TotpNoPendingEnrollmentError";
  }
}

export class TotpNotEnrolledError extends Error {
  constructor() {
    super("No hay un segundo factor activo.");
    this.name = "TotpNotEnrolledError";
  }
}

export interface StaffSecurityRepository {
  getTotpStatus(staffId: string): Promise<TotpStatus>;
  /** `null` si nunca inicio un alta. */
  getTotpSecret(staffId: string): Promise<TotpSecretRow | null>;
  beginTotpEnrollment(staffId: string, secretCiphertext: string): Promise<void>;
  confirmTotpEnrollment(staffId: string, step: number, backupCodeHashes: readonly string[]): Promise<void>;
  /** `false` si el paso ya se uso (replay) o esta bloqueado. */
  registerTotpSuccess(staffId: string, step: number): Promise<boolean>;
  /** Devuelve el instante de desbloqueo (ISO) si quedo bloqueado, si no `null`. */
  registerTotpFailure(staffId: string): Promise<string | null>;
  /** `false` si no existe, ya se uso o esta bloqueado. */
  consumeBackupCode(staffId: string, codeHash: string): Promise<boolean>;
  replaceBackupCodes(staffId: string, backupCodeHashes: readonly string[]): Promise<void>;
  disableTotp(staffId: string): Promise<void>;
  /** Fija el hash nuevo y corta todas las sesiones previas. La ruta verifica la contrasena actual ANTES. */
  changePassword(staffId: string, newPasswordHash: string): Promise<void>;
  createPasswordResetToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void>;
  /** Devuelve el id del staff, o `null` (inexistente/usado/vencido: nunca se distingue). */
  consumePasswordResetToken(tokenHash: string, newPasswordHash: string): Promise<string | null>;
  createEmailVerificationToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void>;
  consumeEmailVerificationToken(tokenHash: string): Promise<string | null>;
}

interface StatusRaw {
  enrolled: boolean;
  pending: boolean;
  locked_until: string | Date | null;
  backup_codes_remaining: number;
}
interface SecretRaw {
  secret_ciphertext: string;
  confirmed: boolean;
  last_used_step: string | number | null;
  locked_until: string | Date | null;
}

function iso(v: string | Date | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

export class PostgresStaffSecurityRepository implements StaffSecurityRepository {
  constructor(private readonly engine: TenancyEngine) {}

  /** Una transaccion por llamada; la migracion pendiente se traduce FUERA de ella. */
  private async run<T>(userId: string | null, fn: (db: TenantDbSession) => Promise<T>): Promise<T> {
    try {
      return await this.engine.withAppSession({ userId }, fn);
    } catch (err) {
      if (isMigrationPendingError(err)) throw new StaffSecurityUnavailableError();
      throw err;
    }
  }

  getTotpStatus(staffId: string): Promise<TotpStatus> {
    return this.run(staffId, async (db) => {
      const { rows } = await db.query<StatusRaw>(`select enrolled, pending, locked_until, backup_codes_remaining from core.totp_get_status($1);`, [staffId]);
      const r = rows[0];
      return {
        enrolled: r?.enrolled ?? false,
        pending: r?.pending ?? false,
        lockedUntil: iso(r?.locked_until ?? null),
        backupCodesRemaining: Number(r?.backup_codes_remaining ?? 0),
      };
    });
  }

  getTotpSecret(staffId: string): Promise<TotpSecretRow | null> {
    return this.run(staffId, async (db) => {
      const { rows } = await db.query<SecretRaw>(`select secret_ciphertext, confirmed, last_used_step, locked_until from core.totp_get_secret($1);`, [staffId]);
      const r = rows[0];
      if (!r) return null;
      return {
        secretCiphertext: r.secret_ciphertext,
        confirmed: r.confirmed,
        lastUsedStep: r.last_used_step === null ? null : Number(r.last_used_step),
        lockedUntil: iso(r.locked_until),
      };
    });
  }

  async beginTotpEnrollment(staffId: string, secretCiphertext: string): Promise<void> {
    try {
      await this.run(staffId, async (db) => {
        await db.query(`select core.totp_begin_enrollment($1, $2);`, [staffId, secretCiphertext]);
      });
    } catch (err) {
      if (isP0001(err)) throw new TotpAlreadyEnrolledError();
      throw err;
    }
  }

  async confirmTotpEnrollment(staffId: string, step: number, backupCodeHashes: readonly string[]): Promise<void> {
    try {
      await this.run(staffId, async (db) => {
        await db.query(`select core.totp_confirm_enrollment($1, $2, $3::text[]);`, [staffId, step, [...backupCodeHashes]]);
      });
    } catch (err) {
      if (isP0001(err)) throw new TotpNoPendingEnrollmentError();
      throw err;
    }
  }

  registerTotpSuccess(staffId: string, step: number): Promise<boolean> {
    return this.run(staffId, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(`select core.totp_register_success($1, $2) as ok;`, [staffId, step]);
      return rows[0]?.ok === true;
    });
  }

  registerTotpFailure(staffId: string): Promise<string | null> {
    return this.run(staffId, async (db) => {
      const { rows } = await db.query<{ locked: string | Date | null }>(`select core.totp_register_failure($1) as locked;`, [staffId]);
      return iso(rows[0]?.locked ?? null);
    });
  }

  consumeBackupCode(staffId: string, codeHash: string): Promise<boolean> {
    return this.run(staffId, async (db) => {
      const { rows } = await db.query<{ ok: boolean }>(`select core.totp_consume_backup_code($1, $2) as ok;`, [staffId, codeHash]);
      return rows[0]?.ok === true;
    });
  }

  async replaceBackupCodes(staffId: string, backupCodeHashes: readonly string[]): Promise<void> {
    try {
      await this.run(staffId, async (db) => {
        await db.query(`select core.totp_replace_backup_codes($1, $2::text[]);`, [staffId, [...backupCodeHashes]]);
      });
    } catch (err) {
      if (isP0001(err)) throw new TotpNotEnrolledError();
      throw err;
    }
  }

  async disableTotp(staffId: string): Promise<void> {
    await this.run(staffId, async (db) => {
      await db.query(`select core.totp_disable($1);`, [staffId]);
    });
  }

  async changePassword(staffId: string, newPasswordHash: string): Promise<void> {
    await this.run(staffId, async (db) => {
      await db.query(`select core.change_staff_password($1, $2);`, [staffId, newPasswordHash]);
    });
  }

  async createPasswordResetToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    await this.run(null, async (db) => {
      await db.query(`select core.create_password_reset_token($1, $2, $3);`, [input.staffId, input.tokenHash, input.expiresAt]);
    });
  }

  consumePasswordResetToken(tokenHash: string, newPasswordHash: string): Promise<string | null> {
    return this.run(null, async (db) => {
      const { rows } = await db.query<{ id: string | null }>(`select core.consume_password_reset_token($1, $2) as id;`, [tokenHash, newPasswordHash]);
      return rows[0]?.id ?? null;
    });
  }

  async createEmailVerificationToken(input: { readonly staffId: string; readonly tokenHash: string; readonly expiresAt: string }): Promise<void> {
    await this.run(null, async (db) => {
      await db.query(`select core.create_email_verification_token($1, $2, $3);`, [input.staffId, input.tokenHash, input.expiresAt]);
    });
  }

  consumeEmailVerificationToken(tokenHash: string): Promise<string | null> {
    return this.run(null, async (db) => {
      const { rows } = await db.query<{ id: string | null }>(`select core.consume_email_verification_token($1) as id;`, [tokenHash]);
      return rows[0]?.id ?? null;
    });
  }
}

function isP0001(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P0001";
}

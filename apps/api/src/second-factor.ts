// Verificacion del segundo factor (TOTP o codigo de respaldo) y guardia de step-up,
// compartidas por `routes/auth-2fa.ts` y por las rutas de negocio que protegen acciones
// sensibles (hoy: transiciones del contrato de licitaciones).
//
// Cada llamada al repositorio abre SU PROPIA transaccion (ver staff-security-repository.ts),
// por eso: (1) el contador de fallos sobrevive al 4xx que la ruta responde justo despues,
// (2) la migracion pendiente se traduce a `StaffSecurityUnavailableError` sin tocar la
// transaccion del request (`dbSession`).
import {
  decryptStaffTotpSecret,
  hashBackupCode,
  normalizeBackupCode,
  verifyContractStepUpToken,
  verifyStaffTotp,
} from "@atiende/core-auth";
import type { StepUpClaims, StepUpScope } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { StaffSecurityUnavailableError } from "@atiende/db";
import type { StaffSecurityRepository } from "@atiende/db";
import { Errors } from "./errors.ts";
import type { AppDeps } from "./deps.ts";

export type SecondFactorResult = "ok" | "invalid" | "locked" | "not_enrolled";

export interface SecondFactorInput {
  readonly code?: string;
  readonly backupCode?: string;
}

/** Repositorio de seguridad o 503: para rutas cuyo UNICO proposito es el 2FA. */
export function requireSecurityRepo(deps: AppDeps): StaffSecurityRepository {
  if (!deps.staffSecurityRepo) throw Errors.twoFactorUnavailable();
  return deps.staffSecurityRepo;
}

/** Traduce "migracion pendiente" a 503 honesto para rutas de 2FA. */
export async function orUnavailable<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StaffSecurityUnavailableError) throw Errors.twoFactorUnavailable();
    throw err;
  }
}

/**
 * Verifica un codigo TOTP o de respaldo de un 2FA YA confirmado. Cuenta el fallo en SQL
 * (5 consecutivos -> 15 min de bloqueo) y exige un paso TOTP estrictamente mayor al ultimo
 * usado (anti-replay atomico en `totp_register_success`).
 */
export async function checkSecondFactor(deps: AppDeps, userId: string, input: SecondFactorInput): Promise<SecondFactorResult> {
  const repo = requireSecurityRepo(deps);
  const secret = await repo.getTotpSecret(userId);
  if (!secret || !secret.confirmed) return "not_enrolled";
  if (secret.lockedUntil) return "locked";

  if (typeof input.backupCode === "string" && input.backupCode.length > 0) {
    const normalized = normalizeBackupCode(input.backupCode);
    if (normalized && (await repo.consumeBackupCode(userId, hashBackupCode(normalized)))) return "ok";
  } else if (typeof input.code === "string") {
    let plain: string | null = null;
    try {
      plain = decryptStaffTotpSecret(secret.secretCiphertext, deps.env.jwtSecret);
    } catch {
      plain = null; // clave rotada o fila corrupta: nunca valida, cuenta como fallo
    }
    const step = plain ? verifyStaffTotp(plain, input.code, Date.now()) : null;
    if (step !== null && (secret.lastUsedStep === null || step > secret.lastUsedStep) && (await repo.registerTotpSuccess(userId, step))) {
      return "ok";
    }
  }

  const lockedUntil = await repo.registerTotpFailure(userId);
  return lockedUntil ? "locked" : "invalid";
}

/** Lanza el ApiError que corresponde a un resultado distinto de "ok". */
export function throwForSecondFactor(result: Exclude<SecondFactorResult, "ok">, lockedUntilHint?: string): never {
  if (result === "not_enrolled") throw Errors.stepUpEnrollmentRequired();
  if (result === "locked") throw Errors.secondFactorLocked(lockedUntilHint ?? "unos minutos");
  throw Errors.secondFactorInvalid();
}

/**
 * Guardia de step-up para una accion sensible, de UN SOLO USO. Con 2FA disponible: el usuario debe tenerlo activo y presentar un token de
 * step-up vigente, atado a su usuario+organizacion+alcance, y el `jti` del token se CONSUME en la sesion de la accion (`input.db`: la
 * misma transaccion; si la accion falla y se revierte el token no se gasta). Reusar el token (o repetir una peticion capturada) da 403
 * `step_up_required` "vuelve a confirmar"; con dos peticiones concurrentes con el mismo token exactamente una pasa.
 *
 * Sin puerto de 2FA o con su migracion pendiente: en PRODUCCION (`env.production`) falla cerrado con 503; en desarrollo y pruebas no
 * exige nada (queda el control por rol que la ruta ya aplico). Con el puerto y 0026 pero SIN la migracion 038 (tabla de consumo) se
 * conserva el token sin estado de siempre (compatibilidad con la base sin migrar; el uso unico rige al aplicar 038).
 */
export async function requireStepUp(
  deps: AppDeps,
  input: {
    readonly userId: string;
    readonly organizationId: string;
    readonly scope: StepUpScope;
    readonly token: string | undefined;
    /** Sesion de la accion (misma transaccion que el trabajo que el token autoriza). */
    readonly db: TenantDbSession;
  },
): Promise<void> {
  const production = deps.env.production === true;
  const repo = deps.staffSecurityRepo;
  if (!repo) {
    if (production) throw Errors.twoFactorUnavailable();
    return;
  }
  let enrolled: boolean;
  try {
    enrolled = (await repo.getTotpStatus(input.userId)).enrolled;
  } catch (err) {
    if (err instanceof StaffSecurityUnavailableError) {
      if (production) throw Errors.twoFactorUnavailable();
      return;
    }
    throw err;
  }
  if (!enrolled) throw Errors.stepUpEnrollmentRequired();
  if (!input.token) throw Errors.stepUpRequired();
  let claims: StepUpClaims;
  try {
    claims = await verifyContractStepUpToken(input.token, deps.env.jwtSecret, { userId: input.userId, organizationId: input.organizationId, scope: input.scope });
  } catch {
    throw Errors.stepUpRequired("La confirmación de identidad expiró o no corresponde a esta acción. Vuelve a confirmar con tu código.");
  }
  let firstUse: boolean;
  try {
    firstUse = await repo.consumeStepUpToken(input.db, {
      jti: claims.jti ?? "",
      userId: input.userId,
      organizationId: input.organizationId,
      scope: input.scope,
      expiresAt: new Date((claims.exp ?? 0) * 1000).toISOString(),
    });
  } catch (err) {
    if (err instanceof StaffSecurityUnavailableError) return; // 038 pendiente: token sin estado (compatibilidad)
    throw err;
  }
  if (!firstUse) throw Errors.stepUpRequired("Esta confirmación ya se usó. Vuelve a confirmar con tu código para esta acción.");
}

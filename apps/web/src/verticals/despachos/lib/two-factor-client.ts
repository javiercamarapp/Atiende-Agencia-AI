// Cliente web del segundo factor (TOTP, L-01) para el panel de despachos (D-30): estado, alta/confirmacion, step-up,
// codigos de respaldo y desactivacion sobre `/auth/2fa/*` y `/auth/step-up` (apps/api/src/routes/auth-2fa.ts). Mismo
// contrato que licitaciones/lib/two-factor-client.ts, con el transporte (refresh de sesion) de despachos.
//
// COMPATIBILIDAD con la base sin migrar: `fetchTwoFactorStatus` NUNCA lanza (backend sin la migracion de 2FA o fallo de red
// => `available: false`): la UI no exige un codigo que nadie puede dar y las acciones siguen protegidas solo por el rol,
// exactamente como el servidor (`requireStepUp` no exige nada en ese caso).
import { fetchJson, postJson } from "./admin-client.ts";

export interface TwoFactorStatus {
  /** `false` = la base todavia no tiene la migracion de 2FA (o no se pudo consultar). */
  readonly available: boolean;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly lockedUntil: string | null;
  readonly backupCodesRemaining: number;
}

export const TWO_FACTOR_UNAVAILABLE: TwoFactorStatus = { available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 };

/** Alcance del step-up de despachos -- espejo de `StepUpScope` (core-auth). */
export type StepUpScopeDespachos = "despachos_sensitive";

/** Un codigo de 6 digitos (TOTP) o un codigo de respaldo (XXXXX-XXXXX). */
export type SecondFactorInput = { readonly code: string } | { readonly backupCode: string };

/** Interpreta lo que teclea el usuario: 6 digitos = TOTP; cualquier otra cosa = codigo de respaldo. */
export function secondFactorFromText(text: string): SecondFactorInput | null {
  const clean = text.trim();
  if (clean.length === 0) return null;
  return /^\d{6}$/u.test(clean.replace(/\s+/gu, "")) ? { code: clean.replace(/\s+/gu, "") } : { backupCode: clean };
}

export async function fetchTwoFactorStatus(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<TwoFactorStatus> {
  try {
    const s = await fetchJson<TwoFactorStatus>(fetchImpl, `${apiBaseUrl}/auth/2fa/status`, token);
    return { available: s.available === true, enabled: s.enabled === true, pending: s.pending === true, lockedUntil: s.lockedUntil ?? null, backupCodesRemaining: s.backupCodesRemaining ?? 0 };
  } catch {
    return TWO_FACTOR_UNAVAILABLE;
  }
}

export interface TwoFactorSetup {
  readonly secret: string;
  readonly otpauthUrl: string;
}

export function startTwoFactorSetup(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<TwoFactorSetup> {
  return postJson<TwoFactorSetup>(fetchImpl, `${apiBaseUrl}/auth/2fa/setup`, token, {});
}

/** Devuelve los codigos de respaldo (se muestran UNA vez). */
export async function confirmTwoFactorSetup(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, code: string): Promise<readonly string[]> {
  const res = await postJson<{ backupCodes: readonly string[] }>(fetchImpl, `${apiBaseUrl}/auth/2fa/confirm`, token, { code });
  return res.backupCodes;
}

export async function requestStepUpToken(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, factor: SecondFactorInput, scope: StepUpScopeDespachos = "despachos_sensitive"): Promise<string> {
  const res = await postJson<{ stepUpToken: string }>(fetchImpl, `${apiBaseUrl}/auth/step-up`, token, { scope, ...factor });
  return res.stepUpToken;
}

export async function regenerateBackupCodes(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, factor: SecondFactorInput): Promise<readonly string[]> {
  const res = await postJson<{ backupCodes: readonly string[] }>(fetchImpl, `${apiBaseUrl}/auth/2fa/backup-codes`, token, { ...factor });
  return res.backupCodes;
}

export async function disableTwoFactor(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, password: string, factor: SecondFactorInput): Promise<void> {
  await postJson<{ enabled: boolean }>(fetchImpl, `${apiBaseUrl}/auth/2fa/disable`, token, { password, ...factor });
}

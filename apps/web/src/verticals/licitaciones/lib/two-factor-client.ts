// Cliente web del segundo factor (L-01): estado, alta/confirmacion, step-up, codigos de
// respaldo y desactivacion (`/auth/2fa/*`, `/auth/step-up`, ver
// apps/api/src/routes/auth-2fa.ts) mas "cerrar mis otras sesiones" (`/auth/revoke-sessions`,
// ya existente). Mismo aislamiento que el resto de apps/web: no depende de
// `@atiende/domain-licitaciones`.
//
// COMPATIBILIDAD con la base sin migrar: `fetchTwoFactorStatus` NUNCA lanza por un backend
// sin la migracion (responde `available: false`) ni por un fallo de red: devuelve
// "no disponible" para que la UI NO exija un codigo que nadie puede dar (un fallo aqui jamas
// debe bloquear un flujo que hoy funciona).
import { defaultAuthCtx, fetchJson, postJson } from "./admin-client.ts";
import { withAuthRefresh, apiBaseUrlFromRequestUrl } from "../../../lib/authed-fetch.ts";

export interface TwoFactorStatus {
  /** `false` = la base todavia no tiene la migracion de 2FA (o no se pudo consultar). */
  readonly available: boolean;
  readonly enabled: boolean;
  readonly pending: boolean;
  readonly lockedUntil: string | null;
  readonly backupCodesRemaining: number;
}

export const TWO_FACTOR_UNAVAILABLE: TwoFactorStatus = { available: false, enabled: false, pending: false, lockedUntil: null, backupCodesRemaining: 0 };

/** Alcance del step-up -- espejo de `StepUpScope` (core-auth). */
export type StepUpScope = "contract_sensitive" | "expediente_approval" | "company_rate_approval";

/** Espejo de `CONTRACT_STEP_UP_TRANSITIONS` (domain-licitaciones/contract-lifecycle.ts): cosmetico, decide si pedir el codigo; el servidor SIEMPRE decide. */
export const CONTRACT_STEP_UP_TRANSITIONS: readonly string[] = ["rescindido", "penalizado", "en_inconformidad", "modificado", "pagado"];

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

export async function startTwoFactorSetup(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<TwoFactorSetup> {
  return postJson<TwoFactorSetup>(fetchImpl, `${apiBaseUrl}/auth/2fa/setup`, token, {});
}

/** Devuelve los codigos de respaldo (se muestran UNA vez). */
export async function confirmTwoFactorSetup(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, code: string): Promise<readonly string[]> {
  const res = await postJson<{ backupCodes: readonly string[] }>(fetchImpl, `${apiBaseUrl}/auth/2fa/confirm`, token, { code });
  return res.backupCodes;
}

export async function requestStepUpToken(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, scope: StepUpScope, factor: SecondFactorInput): Promise<string> {
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

/** Cierra todas las sesiones previas (los refresh tokens emitidos antes de ahora dejan de servir). */
export async function revokeOtherSessions(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<void> {
  const url = `${apiBaseUrl}/auth/revoke-sessions`;
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), defaultAuthCtx(), token, (t) =>
    fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" }),
  );
  if (!res.ok) throw new Error(`No se pudieron cerrar las sesiones (${res.status}).`);
}

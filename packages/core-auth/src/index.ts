export type { AccessTokenClaims, RefreshTokenClaims, SoporteClaim } from "./jwt.ts";
export {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  TokenInvalidError,
  TokenExpiredError,
  STEPUP_TTL_SECONDS,
  accessTokenHash,
  signStepUpToken,
  verifyStepUpToken,
} from "./jwt.ts";
export type { StepUpTokenClaims } from "./jwt.ts";

export {
  TOTP_DEFAULT_WINDOW,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  hotp,
  totpAt,
  totpStep,
  verifyTotp,
} from "./totp.ts";

export { ApiError, Errors } from "./errors.ts";

export type { GeneratedInviteToken } from "./invite-token.ts";
export { generateInviteToken, hashInviteToken } from "./invite-token.ts";

export type { CoreAuthEnv, CoreAuthVariables, CoreAuthHonoEnv } from "./types.ts";

export {
  requestId,
  authMiddleware,
  dbSession,
  requirePropertyMembership,
  assertVerticalRole,
  organizationSuspendedError,
} from "./middleware.ts";

export type { OAuthStateClaims, GoogleTokenResponse, GoogleIdTokenClaims } from "./google-oauth.ts";
export {
  generateCodeVerifier,
  computeCodeChallenge,
  generateNonce,
  signOAuthState,
  verifyOAuthState,
  exchangeAuthorizationCode,
  verifyGoogleIdToken,
  buildAuthorizationUrl,
  GoogleOAuthError,
} from "./google-oauth.ts";

export {
  BACKUP_CODE_COUNT,
  computeTotp,
  totpTimeStep,
  verifyStaffTotp,
  buildOtpAuthUrl,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  encryptStaffTotpSecret,
  decryptStaffTotpSecret,
} from "./staff-totp.ts";

export type { StepUpScope, StepUpClaims } from "./step-up.ts";
export { STEP_UP_TTL_SECONDS, signContractStepUpToken, verifyContractStepUpToken } from "./step-up.ts";

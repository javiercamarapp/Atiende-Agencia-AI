export type { AccessTokenClaims, RefreshTokenClaims } from "./jwt.ts";
export {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  TokenInvalidError,
  TokenExpiredError,
} from "./jwt.ts";

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
  TOTP_PERIOD_SECONDS,
  TOTP_DIGITS,
  TOTP_DEFAULT_WINDOW,
  BACKUP_CODE_COUNT,
  base32Encode,
  base32Decode,
  generateTotpSecret,
  computeTotp,
  totpTimeStep,
  verifyTotp,
  buildOtpAuthUrl,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  encryptTotpSecret,
  decryptTotpSecret,
} from "./totp.ts";

export type { StepUpScope, StepUpClaims } from "./step-up.ts";
export { STEP_UP_TTL_SECONDS, signStepUpToken, verifyStepUpToken } from "./step-up.ts";

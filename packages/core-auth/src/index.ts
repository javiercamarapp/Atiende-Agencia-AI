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

export type { RouteAreaConfig, RouteAreaMap } from "./route-area.ts";
export { createRouteAreaMap } from "./route-area.ts";

export {
  PLATFORM_ROLE_HIERARCHY,
  hasPlatformRole,
  hasAnyPlatformRole,
  canInviteStaff,
  hasFeature,
  requireFeature,
  FeatureNotAvailableError,
} from "./roles.ts";

export type { RateLimitResult, RateLimiter, TokenBucketRateLimiterOptions } from "./rate-limiter.ts";
export { InMemoryRateLimiter } from "./rate-limiter.ts";

export type { AuthzDecision, DenialReason, AuthzAuditEntry, AuditSink } from "./audit.ts";
export { InMemoryAuditSink } from "./audit.ts";

export type { DenialAuditCoalescer, DenialAuditCoalesceDecision } from "./denial-audit-coalescer.ts";
export { InMemoryDenialAuditCoalescer } from "./denial-audit-coalescer.ts";

export type { RequireAdminAccessOptions } from "./admin-middleware.ts";
export {
  ADMIN_ROUTE_PREFIX,
  isAdminRoute,
  requireOrganizationMembership,
  requireAdminAccess,
} from "./admin-middleware.ts";

export * from "./impersonation/index.ts";

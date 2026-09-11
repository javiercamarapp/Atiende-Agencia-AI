export {
  IMPERSONATION_COOKIE_NAME,
  IMPERSONATION_COOKIE_SECRET_ENV_HINT,
  IMPERSONATION_TTL_MS,
  signImpersonationSelection,
  verifyImpersonationSelection,
} from "./cookie.ts";
export type { ImpersonationSelection } from "./cookie.ts";

export { resolveImpersonatedOrganization } from "./resolve.ts";
export type {
  ResolveImpersonatedOrganizationInput,
  ResolvedImpersonation,
  SuperadminActor,
} from "./resolve.ts";

export {
  DEFAULT_IMPERSONATION_TIMEZONE,
  InMemoryImpersonationAuditStore,
  dayKey,
  recordImpersonation,
} from "./audit.ts";
export type {
  ImpersonationAuditEntry,
  ImpersonationAuditOutcome,
  ImpersonationAuditStore,
  ImpersonationReservation,
  RecordImpersonationOptions,
} from "./audit.ts";

export {
  ImpersonationError,
  ImpersonationSigningKeyMissingError,
  InvalidOrganizationIdError,
  NoOrganizationSelectedError,
} from "./errors.ts";

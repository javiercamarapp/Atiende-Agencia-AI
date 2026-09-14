// Barril de src/break-glass (Fase 10 -- acceso auditado "romper cristal" de un
// Superadmin de plataforma a los datos de un tenant específico de rentas). Mismo
// patrón que ../mensajeria/index.ts, ../limpieza/index.ts: solo reexporta lo público
// de esta subcarpeta. Ver ../../migrations/012_break_glass_audit.sql para el diseño
// completo (gap verificado contra core-authz/impersonation antes de construirse).
export {
  BREAK_GLASS_MIN_REASON_LENGTH,
  BREAK_GLASS_RESOURCE_TYPES,
  isBreakGlassResourceType,
} from "./tipos.ts";
export type {
  BreakGlassAccessInput,
  BreakGlassAuditEntry,
  BreakGlassResourceType,
  BreakGlassReservaResumen,
  NewBreakGlassAuditEntry,
  SuperadminActor,
} from "./tipos.ts";

export {
  BreakGlassAuditWriteFailedError,
  BreakGlassError,
  BreakGlassOrganizationRequiredError,
  BreakGlassReasonRequiredError,
} from "./errors.ts";

export { InMemoryBreakGlassAuditRepository } from "./audit-repository.ts";
export type { BreakGlassAuditRepository } from "./audit-repository.ts";

export { InMemoryBreakGlassRentasDataRepository } from "./data-repository.ts";
export type { BreakGlassRentasDataRepository } from "./data-repository.ts";

export { leerDatosTenantBreakGlass, leerReservasTenantBreakGlass, validarRazonBreakGlass } from "./acceso.ts";

export { PostgresBreakGlassAuditRepository } from "./postgres-audit-repository.ts";
export { PostgresBreakGlassRentasDataRepository } from "./postgres-data-repository.ts";

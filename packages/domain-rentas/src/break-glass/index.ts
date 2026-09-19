// Barril de src/break-glass (Fase 10 -- acceso auditado "romper cristal" de un
// Superadmin de plataforma a los datos de un tenant específico de rentas). Mismo
// patrón que ../mensajeria/index.ts, ../limpieza/index.ts: solo reexporta lo público
// de esta subcarpeta. Ver ../../migrations/012_break_glass_audit.sql para el diseño
// completo (gap verificado contra core-authz/impersonation antes de construirse).
export {
  BREAK_GLASS_LECTOR_LIMIT_DEFAULT,
  BREAK_GLASS_LECTOR_LIMIT_MAX,
  BREAK_GLASS_MAX_DURATION_MINUTES,
  BREAK_GLASS_MIN_DURATION_MINUTES,
  BREAK_GLASS_MIN_REASON_LENGTH,
  BREAK_GLASS_RESOURCE_TYPES,
  esSesionBreakGlassActiva,
  isBreakGlassResourceType,
} from "./tipos.ts";
export type {
  BreakGlassAccessInput,
  BreakGlassAuditEntry,
  BreakGlassFinanzasResumen,
  BreakGlassLectorPaginacion,
  BreakGlassLectorResultado,
  BreakGlassLimpiezaResumen,
  BreakGlassMensajeriaResumen,
  BreakGlassPayoutResumen,
  BreakGlassPricingResumen,
  BreakGlassResourceType,
  BreakGlassReservaResumen,
  BreakGlassSession,
  BreakGlassSyncIcalResumen,
  NewBreakGlassAuditEntry,
  NewBreakGlassSessionInput,
  SuperadminActor,
} from "./tipos.ts";

export {
  BreakGlassAuditWriteFailedError,
  BreakGlassDurationInvalidError,
  BreakGlassError,
  BreakGlassNoActiveSessionError,
  BreakGlassOrganizationRequiredError,
  BreakGlassReasonRequiredError,
  BreakGlassSessionNotFoundError,
} from "./errors.ts";

export { InMemoryBreakGlassAuditRepository } from "./audit-repository.ts";
export type { BreakGlassAuditRepository } from "./audit-repository.ts";

export { InMemoryBreakGlassRentasDataRepository } from "./data-repository.ts";
export type { BreakGlassRentasDataRepository } from "./data-repository.ts";

export { InMemoryBreakGlassSessionRepository } from "./sesion-repository.ts";
export type { BreakGlassSessionRepository } from "./sesion-repository.ts";

export {
  leerDatosTenantBreakGlass,
  leerFinanzasTenantBreakGlass,
  leerLimpiezaTenantBreakGlass,
  leerMensajeriaTenantBreakGlass,
  leerPayoutsTenantBreakGlass,
  leerPricingTenantBreakGlass,
  leerReservasTenantBreakGlass,
  leerSyncIcalTenantBreakGlass,
  validarRazonBreakGlass,
} from "./acceso.ts";
export {
  abrirAccesoBreakGlass,
  cerrarAccesoBreakGlass,
  listarAccesosBreakGlass,
  obtenerAccesoActivoBreakGlass,
  validarDuracionBreakGlass,
} from "./sesion.ts";

export { PostgresBreakGlassAuditRepository } from "./postgres-audit-repository.ts";
export { PostgresBreakGlassRentasDataRepository } from "./postgres-data-repository.ts";
export { PostgresBreakGlassSessionRepository } from "./postgres-sesion-repository.ts";

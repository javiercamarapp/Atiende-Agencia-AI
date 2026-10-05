export { hashPassword, verifyPassword } from "./password.ts";
export { isUndefinedFunctionError, isUndefinedTableError, isUndefinedColumnError, isMigrationPendingError, isNoUniqueOrExclusionConstraintError } from "./sql-errors.ts";
export type {
  CoreRepository,
  CoreStaffRepository,
  StaffUserRow,
  MembershipRow,
  OrgAdminStaffLookupRow,
  OrganizationMemberRow,
  OrganizationMemberWithRoleRow,
  StaffInviteRow,
  StaffInviteStatus,
  CreateStaffInviteInput,
  AcceptStaffInviteInput,
  AcceptStaffInviteResult,
  RevokeRefreshTokenInput,
  SuperadminOrganizationRow,
  NotificationRow,
  NotificationSeverity,
  ListNotificationsOptions,
  ProspectoRow,
  CreateProspectoInput,
  OrganizationBillingRow,
  UpsertOrganizationBillingInput,
  BillingWebhookEventMark,
  SuperadminOrganizationBillingRow,
  BillingWebhookEventSummaryRow,
  BillingWebhookLogResult,
  BillingWebhookLogReason,
  RecordBillingWebhookEventInput,
  BillingWebhookLogRow,
  BillingWebhookLogFilters,
  BillingWebhookLogPage,
} from "./core-repository.ts";
export {
  StaffInviteInvalidError,
  MembershipRoleUpdateError,
  MembershipRemovalError,
  MembershipRemovalUnavailableError,
  NotificationNotFoundError,
  ProspectoNotFoundError,
  OrganizationNotFoundError,
  OrganizationBillingAccessDeniedError,
} from "./core-repository.ts";
export { InMemoryCoreRepository } from "./in-memory-core-repository.ts";
export type { SeedOrganization, SeedMembership } from "./in-memory-core-repository.ts";
export { PostgresCoreRepository } from "./postgres-core-repository.ts";
export { InMemoryTenancyEngine } from "./in-memory-tenancy-engine.ts";
export type { SeedTenancyProperty, SeedTenancyMembership } from "./in-memory-tenancy-engine.ts";
export { openManagedPostgres, AbortedTransactionCommitError, DatabaseBusyError, admissionLimits } from "./managed-postgres-engine.ts";
export type { ManagedPostgresConfig, ManagedPostgresEngine } from "./managed-postgres-engine.ts";
export { runWithSavepointFallback } from "./savepoint-fallback.ts";
export * from "./notificaciones/index.ts";
export * from "./planes-topes.ts";
export type { SavepointFallbackOptions } from "./savepoint-fallback.ts";
export type {
  LlmUsageRepository,
  LlmUsageEventInput,
  LlmUsageSummaryRow,
  LlmUsageByOrganizationRow,
  LlmUsageByProviderModelRow,
  LlmPlatformBudgetRow,
  LlmMonthlyReservationTotals,
  LlmUsageByOrgRoleMonthRow,
  LlmOrgRoleLimitRow,
  LlmRoleTurnResult,
  LlmHourWindow,
} from "./llm-usage-repository.ts";
export {
  LlmMonthlyBudgetExceededError,
  LlmOrganizationNotFoundError,
  DEFAULT_LLM_ORG_MONTHLY_CAP_MICRO_USD,
  DEFAULT_LLM_ALERT_THRESHOLD_PCT,
  PostgresLlmUsageRepository,
  InMemoryLlmUsageRepository,
} from "./llm-usage-repository.ts";
export type { InMemoryLlmUsageOrganization } from "./llm-usage-repository.ts";
export type {
  SaludRepository,
  CronHeartbeatStatus,
  RecordCronHeartbeatInput,
  CronHeartbeatRow,
  OutboxQueueHealthRow,
  LicitacionesFuenteRunRow,
} from "./salud-repository.ts";
export { PostgresSaludRepository, InMemorySaludRepository } from "./salud-repository.ts";
export type {
  ResumenDiarioRepository,
  VentanaDia,
  CronHeartbeatSystemRow,
  OutboxDiarioRow,
  LicitacionesFuenteRunSystemRow,
  LlmPlatformBudgetSystemRow,
  LlmUsageTotalRow,
  LlmUsageTopOrganizacionRow,
  OrganizacionesStaffNuevosRow,
  ProspectosAgregadoRow,
  FacturacionAgregadoRow,
  GeneradoPor,
  DailyOpsSummaryRow,
  UpsertDailyOpsSummaryInput,
} from "./resumen-diario-repository.ts";
export { PostgresResumenDiarioRepository, InMemoryResumenDiarioRepository } from "./resumen-diario-repository.ts";
export type {
  SuperadminAccionesRepository,
  IntentTipo,
  IntentEstado,
  SuperadminActionIntentRow,
  AutomationActionLogRow,
  OutboxQueueName,
  OutboxDeadMessageRow,
  OutboxDeadMessageDetailRow,
  DesatascarOutboxResultRow,
  MarcarProspectoResultRow,
} from "./superadmin-acciones-repository.ts";
export { PostgresSuperadminAccionesRepository, InMemorySuperadminAccionesRepository } from "./superadmin-acciones-repository.ts";
export type {
  ImpersonationSessionRow,
  ImpersonationSessionWithActiveRow,
  ImpersonationAuditEntryRow,
  ImpersonationAuditEventType,
  ImpersonationAvailability,
  ImpersonationRepository,
} from "./impersonation-repository.ts";
export {
  ImpersonationError,
  ImpersonationForbiddenError,
  ImpersonationReasonInvalidError,
  ImpersonationNotFoundError,
  ImpersonationConflictError,
  PostgresImpersonationRepository,
  InMemoryImpersonationRepository,
} from "./impersonation-repository.ts";
export type {
  AuthzAuditAvailability,
  AuthzAuditDecision,
  AuthzAuditLogEntryInput,
  AuthzAuditLogRow,
  AuthzAuditRepository,
} from "./authz-audit-repository.ts";
export { PostgresAuthzAuditRepository, InMemoryAuthzAuditRepository } from "./authz-audit-repository.ts";

export type { StaffSecurityRepository, TotpStatus, TotpSecretRow, StaffSessionRow, GoogleIdentityRow } from "./staff-security-repository.ts";
export {
  PostgresStaffSecurityRepository,
  StaffSecurityUnavailableError,
  TotpAlreadyEnrolledError,
  TotpNoPendingEnrollmentError,
  TotpNotEnrolledError,
} from "./staff-security-repository.ts";
export { InMemoryStaffSecurityRepository } from "./in-memory-staff-security-repository.ts";
export type {
  BlockedSwitch,
  MfaAttemptResult,
  MfaFactorRow,
  MfaRepository,
  OrgActionEstado,
  OrgActionTipo,
  OrgAdminActionRow,
  OrgAdminRepository,
  PlatformSwitchRepository,
  PlatformSwitchRow,
  SecurityEventRow,
  SeguridadAvailability,
  SeguridadErrorCode,
  SwitchScope,
} from "./superadmin-seguridad-repository.ts";
export {
  InMemoryMfaRepository,
  InMemoryOrgAdminRepository,
  InMemoryPlatformSwitchRepository,
  PostgresMfaRepository,
  PostgresOrgAdminRepository,
  PostgresPlatformSwitchRepository,
  SuperadminSeguridadError,
} from "./superadmin-seguridad-repository.ts";
export type {
  AccionLimiteRow,
  CategoriaEventoCosto,
  CostReportRow,
  CostosAvailability,
  CostosPlanesRepository,
  FxRateRow,
  MetricaLimiteRow,
  PlanAssignmentEstado,
  PlanAssignmentRow,
  PlanLimitRow,
  PlanRow,
  RecordUsageCostEventInput,
  UnidadEventoCosto,
  UpsertPlanInput,
  UsageCostEventRow,
  VerticalCostos,
} from "./superadmin-costos-planes-repository.ts";
export {
  ACCIONES_LIMITE,
  InMemoryCostosPlanesRepository,
  METRICAS_LIMITE,
  PostgresCostosPlanesRepository,
  VERTICALES_COSTOS,
} from "./superadmin-costos-planes-repository.ts";
export type { ContratosRepository, ContratoVersionRow, InsumosFacturacionRow, TerminosContratoInput } from "./superadmin-contratos-repository.ts";
export { InMemoryContratosRepository, PostgresContratosRepository } from "./superadmin-contratos-repository.ts";
export type { BillingSnapshotRow, CfoOrgRow, CfoRepository } from "./superadmin-cfo-repository.ts";
export { InMemoryCfoRepository, PostgresCfoRepository } from "./superadmin-cfo-repository.ts";
export type { InfraCostRow, PylRepository } from "./superadmin-pyl-repository.ts";
export { InMemoryPylRepository, PostgresPylRepository } from "./superadmin-pyl-repository.ts";
export type { CfoAccessLogRow, CfoZoneRepository, CfoZoneRoleRow, ZonaCfoAccion, ZonaCfoRol } from "./superadmin-zona-cfo-repository.ts";
export { InMemoryCfoZoneRepository, PostgresCfoZoneRepository } from "./superadmin-zona-cfo-repository.ts";
export type {
  ConsolaAgenteActividadRow,
  ConsolaAlcanceRow,
  ConsolaConversacionesWaRow,
  ConsolaCostoDiarioRow,
  ConsolaCostoHistoricoRow,
  ConsolaOperacionRow,
  ConsolaOrganizacionRow,
  ConsolaRepository,
  ConsolaResueltasSinHumanoRow,
  FuenteConsola,
} from "./superadmin-consola-repository.ts";
export { InMemoryConsolaRepository, PostgresConsolaRepository } from "./superadmin-consola-repository.ts";
export type {
  FichaActividadDiariaRow,
  FichaConciliadosRow,
  FichaDocumentosExtraidosRow,
  FichaModeloRolRow,
  FichaVozVerticalRow,
  FichasAgenteRepository,
} from "./superadmin-fichas-agente-repository.ts";
export { InMemoryFichasAgenteRepository, PostgresFichasAgenteRepository } from "./superadmin-fichas-agente-repository.ts";
export type {
  AgentPanelRow,
  AgentRunRow,
  AgentRunRepository,
  DisparoCorrida,
  EstadoAgente,
  EstadoCorrida,
  FiltrosCorridas,
  FuenteAgentes,
  RegistrarCorridaInput,
} from "./superadmin-agentes-repository.ts";
export { InMemoryAgentRunRepository, PostgresAgentRunRepository } from "./superadmin-agentes-repository.ts";
export type {
  ArcoPage,
  ArcoQuery,
  ArcoRequestRow,
  ArcoStatusBucket,
  PlataformaPrivacidadErrorKind,
  PlataformaPrivacidadRepository,
  PrivacidadAvailability,
  PrivacyNoticeRow,
  PrivacyOverviewRow,
  PurgeHoldRow,
  PurgeRunResult,
  PurgeRunRow,
  PurgeStatus,
  PurgeTarget,
  RetentionPolicyRow,
  RetentionSource,
} from "./plataforma-privacidad-repository.ts";
export { InMemoryPlataformaPrivacidadRepository, PlataformaPrivacidadError, PostgresPlataformaPrivacidadRepository } from "./plataforma-privacidad-repository.ts";
export type {
  OrgFicha,
  OrgFichaRepository,
  OrgFichaValor,
  OrgMetricaRow,
  OrgOnboardingEstado,
  OrgOnboardingPaso,
  OrgOnboardingResumenRow,
} from "./superadmin-organizaciones-ficha-repository.ts";
export { InMemoryOrgFichaRepository, PostgresOrgFichaRepository } from "./superadmin-organizaciones-ficha-repository.ts";
export type {
  OrgPreflightHechos,
  OrgPreflightRepository,
  PreflightRestaurantesHechos,
  PreflightSucursalHechos,
  PreflightVoz,
} from "./superadmin-preflight-repository.ts";
export { InMemoryOrgPreflightRepository, PostgresOrgPreflightRepository } from "./superadmin-preflight-repository.ts";
export type {
  AceptacionSuperadmin,
  EquipoFuente,
  EquipoInvitacionCodigo,
  EquipoInvitacionPendiente,
  EquipoMiembro,
  EquipoSucursal,
  InvitacionEquipo,
  InvitarEquipoInput,
  OrgEquipo,
  OrgEquipoRepository,
} from "./superadmin-alta-equipo-repository.ts";
export {
  EquipoInvitacionError,
  EquipoNoDisponibleError,
  InMemoryOrgEquipoRepository,
  PostgresOrgEquipoRepository,
  enmascararCorreo,
  traducirErrorEquipo,
} from "./superadmin-alta-equipo-repository.ts";

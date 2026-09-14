// Barrel de @atiende/worker — mismo patrón de `exports: { ".": "./src/index.ts" }`
// que el resto de paquetes del monorepo (ver packages/domain-hoteles/package.json):
// ningún consumidor externo importa una ruta profunda de este paquete.
export { runNightAuditForProperty, runNightAuditSweep } from "./jobs/hoteles/night-audit.ts";
export type { RunNightAuditParams, NightAuditSweepOptions, NightAuditSweepResult } from "./jobs/hoteles/night-audit.ts";
export { runNoShowSweep } from "./jobs/hoteles/no-show.ts";
export type { NoShowSweepResult, RunNoShowSweepParams } from "./jobs/hoteles/no-show.ts";

// Fase 8 licitaciones — primer job real del vertical (ver
// jobs/licitaciones/README.md para el resto del contexto).
export { runDiscoverTendersForOrganization, runDiscoverTendersSweep, DEFAULT_DISCOVER_TENDERS_LIMIT } from "./jobs/licitaciones/discover-tenders.ts";
export type { DiscoverTendersSourceResult, DiscoverTendersSweepResult, RunDiscoverTendersOptions } from "./jobs/licitaciones/discover-tenders.ts";
export { runDeadlineReminderSweep } from "./jobs/licitaciones/deadline-reminders.ts";
export type { DeadlineReminderSweepResult, RunDeadlineRemindersOptions } from "./jobs/licitaciones/deadline-reminders.ts";

// Fase 10 licitaciones — despacho proactivo real (correo) de recordatorios de
// plazo/alertas de renovación/facturas vencidas (ver
// jobs/licitaciones/README.md).
export { runRenewalAlertSweep, runCollectionAlertSweep, runAlertNotificationSweep } from "./jobs/licitaciones/alert-notifications.ts";
export type {
  RenewalAlertSweepResult,
  RunRenewalAlertSweepOptions,
  CollectionAlertSweepResult,
  RunCollectionAlertSweepOptions,
  AlertNotificationSweepResult,
  RunAlertNotificationSweepOptions,
} from "./jobs/licitaciones/alert-notifications.ts";

// Hallazgo de auditoría (severidad ALTA) — primer job real del vertical
// despachos: despacho proactivo de recordatorios de cobranza (ver
// jobs/despachos/README.md).
export { runCobranzaReminderSweep } from "./jobs/despachos/cobranza-reminders.ts";
export type { CobranzaReminderSweepResult, CobranzaReminderPropertyResult, RunCobranzaReminderSweepOptions } from "./jobs/despachos/cobranza-reminders.ts";

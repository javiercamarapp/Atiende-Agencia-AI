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

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
// L-04 -- recordatorio de la fecha limite de envio de preguntas a la junta de aclaraciones.
export { runJuntaQuestionReminderSweep } from "./jobs/licitaciones/junta-question-reminders.ts";
export type { JuntaQuestionReminderSweepResult, RunJuntaQuestionRemindersOptions, WithSalaGuerraRepo } from "./jobs/licitaciones/junta-question-reminders.ts";

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
// despachos: ingesta mensual de la lista 69-B del SAT (D-04), con adaptador de fuente.
export { runEfos69bIngestion, FixtureEfos69bSource } from "./jobs/despachos/efos-69b-ingestion.ts";
export type { Efos69bSource, Efos69bIngestionResult } from "./jobs/despachos/efos-69b-ingestion.ts";
// D-28: adaptador HTTP de la fuente 69-B (descarga del CSV publico con tope de tamano y streaming).
export { HttpEfos69bSource, Efos69bDescargaError, EFOS_69B_URL_DEFECTO } from "./jobs/despachos/efos-69b-http-source.ts";
export type { HttpEfos69bSourceOpciones } from "./jobs/despachos/efos-69b-http-source.ts";
// despachos (D-26/D-27/D-28): barridos de sistema de los crons de estatus SAT, vencimientos y descarga 69-B.
export { runCfdiEstatusSatSweep } from "./jobs/despachos/cfdi-estatus-sat.ts";
export type { CfdiEstatusSatResultado, RunCfdiEstatusSatOpciones } from "./jobs/despachos/cfdi-estatus-sat.ts";
export { runVencimientosBarridoSistema } from "./jobs/despachos/vencimientos-barrido.ts";
export type { VencimientosBarridoResultado, RunVencimientosBarridoOpciones } from "./jobs/despachos/vencimientos-barrido.ts";
export { runEfos69bDescarga } from "./jobs/despachos/efos-69b-descarga.ts";
export type { Efos69bDescargaResultado } from "./jobs/despachos/efos-69b-descarga.ts";
export type { NotificacionCron, NotificarCron, UnidadCronSat, WithUnidadCronSat } from "./jobs/despachos/cron-comun.ts";
// paridad3 D-31 + D-P3-15: solicitudes de documentos al cliente, recordatorios y auto-check diario del cierre.
export { runPilotoCierreClienteSweep } from "./jobs/despachos/piloto-cierre-cliente.ts";
export type { PilotoCierreClienteResultado, RunPilotoCierreClienteOpciones, UnidadPiloto, WithUnidadPiloto } from "./jobs/despachos/piloto-cierre-cliente.ts";

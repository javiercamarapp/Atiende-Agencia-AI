// alert-notifications.ts — Fase 10, el gap real que cierra esta fase (ver
// auditoría que la originó): `tender_deadline_reminder` (Fase 8) + las
// facturas vencidas de cobranza (Fase 6) + `renewal_alert` (Fase 6) existían
// como REGISTROS que alguien debía consultar manualmente en el panel — nada
// los despachaba proactivamente al responsable de la organización.
//
// Verificado ANTES de construir esto (ver comentario de cabecera de
// `migrations/018_alert_notifications.sql`): licitaciones NO es una de las 3
// verticales con agente de WhatsApp (`@atiende/whatsapp-gateway` -- solo
// citas/hoteles/restaurantes), así que el dispatcher transversal de WhatsApp
// no aplica aquí. El canal real disponible es correo vía Resend, MISMO motor
// que citas (Fase 6 §3)/rentas (Fase 9) ya usan (`email-dispatch.ts`, puerto
// de este archivo) -- nunca se reinventa.
//
// Estas 3 funciones "core" son quien traduce cada REGISTRO YA CREADO por el
// motor de dominio correspondiente (scanUpcomingDeadlineReminders/
// scanRenewalAlerts/listOverdueContractInvoices) en UN correo real encolado
// por cada (alerta, destinatario) -- deliberadamente granular (un correo por
// evento, nunca un "digest" agregado): mismo criterio que
// `domain-rentas::reserva-email-notifications.ts`/
// `domain-restaurantes::order-notifications.ts`, donde cada evento de
// negocio real genera su propio mensaje transaccional. La deduplicación real
// vive en 2 capas independientes: (1) el motor de dominio nunca re-crea una
// alerta ya emitida (scanUpcomingDeadlineReminders/scanRenewalAlerts son
// idempotentes por diseño desde su Fase original); (2) el dedupe_key del
// outbox (`${tipo}:${alertaId}:${email}`) hace que reencolar el MISMO
// (alerta, destinatario) en una corrida posterior del barrido nunca duplique
// el envío -- necesario en particular para facturas vencidas, que
// `listOverdueContractInvoices` SIEMPRE re-lista mientras sigan sin pagarse
// (a diferencia de las otras dos, no hay una tabla de "alerta ya emitida"
// intermedia -- el propio outbox cumple ese rol).
//
// Todas las funciones "core" pueden lanzar (dejan ver el error real). Las
// variantes `try*` de abajo existían para uso best-effort, pero
// r4-fix-crons-transaccion-por-unidad (re-revisión, bloqueante #3) las retiró de
// `jobs/licitaciones/alert-notifications.ts`: tragaban un error SQL real dentro
// de la transacción por organización sin savepoint (COMMIT sobre sesión abortada
// = ROLLBACK silencioso, reportado como "ok"). El job real ahora llama SIEMPRE
// las variantes `*Core` de arriba, dejando que el catch por organización YA
// existente en el job las capture y las cuente como fallo real. `try*` se deja
// exportado (sin caller de producción) por si algún consumidor futuro necesita
// el criterio best-effort explícitamente, con esta advertencia.
import { correoAlertaRenovacion, correoFacturaVencida, correoRecordatorioPlazo } from "./emails/alert-templates.ts";
import type { LicitacionesRepository, OverdueContractInvoiceAlert, RenewalAlertRecord, TenderDeadlineReminderRecord } from "./repository.ts";

export interface AlertEmailEnqueueResult {
  /** Destinatarios (`owner`/`admin`) resueltos para la organización -- 0 si la organización todavía no tiene ningún staff con ese rol (nunca un error, simplemente no hay a quién avisar todavía). */
  readonly recipients: number;
  /** Correos efectivamente encolados = `alertas.length * recipients` (un correo por cada par alerta×destinatario). */
  readonly enqueued: number;
}

const NO_RECIPIENTS: AlertEmailEnqueueResult = { recipients: 0, enqueued: 0 };

export async function enqueueDeadlineReminderEmailsCore(repo: LicitacionesRepository, organizationId: string, reminders: readonly TenderDeadlineReminderRecord[]): Promise<AlertEmailEnqueueResult> {
  if (reminders.length === 0) return NO_RECIPIENTS;
  const recipients = await repo.listOrganizationNotificationRecipients(organizationId);
  if (recipients.length === 0) return { recipients: 0, enqueued: 0 };

  let enqueued = 0;
  for (const reminder of reminders) {
    const correo = correoRecordatorioPlazo({ tenderId: reminder.tenderId, submissionDeadline: reminder.submissionDeadline, daysRemaining: reminder.daysRemaining, message: reminder.message });
    for (const recipient of recipients) {
      await repo.enqueueMessagingOutbox(organizationId, "email", "tender.deadline_reminder", `deadline-reminder:${reminder.id}:${recipient.email}`, { to: recipient.email, subject: correo.asunto, html: correo.html, text: correo.texto });
      enqueued += 1;
    }
  }
  return { recipients: recipients.length, enqueued };
}

export async function enqueueRenewalAlertEmailsCore(repo: LicitacionesRepository, organizationId: string, alerts: readonly RenewalAlertRecord[]): Promise<AlertEmailEnqueueResult> {
  if (alerts.length === 0) return NO_RECIPIENTS;
  const recipients = await repo.listOrganizationNotificationRecipients(organizationId);
  if (recipients.length === 0) return { recipients: 0, enqueued: 0 };

  let enqueued = 0;
  for (const alert of alerts) {
    const correo = correoAlertaRenovacion({ tenderId: alert.tenderId, contractId: alert.contractId, predictedDate: alert.predictedDate, leadDays: alert.leadDays, confidence: alert.confidence });
    for (const recipient of recipients) {
      await repo.enqueueMessagingOutbox(organizationId, "email", "contract.renewal_alert", `renewal-alert:${alert.id}:${recipient.email}`, { to: recipient.email, subject: correo.asunto, html: correo.html, text: correo.texto });
      enqueued += 1;
    }
  }
  return { recipients: recipients.length, enqueued };
}

export async function enqueueOverdueInvoiceEmailsCore(repo: LicitacionesRepository, organizationId: string, invoices: readonly OverdueContractInvoiceAlert[]): Promise<AlertEmailEnqueueResult> {
  if (invoices.length === 0) return NO_RECIPIENTS;
  const recipients = await repo.listOrganizationNotificationRecipients(organizationId);
  if (recipients.length === 0) return { recipients: 0, enqueued: 0 };

  let enqueued = 0;
  for (const invoice of invoices) {
    const correo = correoFacturaVencida({ tenderId: invoice.tenderId, concepto: invoice.concepto, amount: invoice.amount, dueDate: invoice.dueDate, daysOverdue: invoice.daysOverdue });
    for (const recipient of recipients) {
      await repo.enqueueMessagingOutbox(organizationId, "email", "contract.invoice_overdue", `collection-alert:${invoice.invoiceId}:${recipient.email}`, { to: recipient.email, subject: correo.asunto, html: correo.html, text: correo.texto });
      enqueued += 1;
    }
  }
  return { recipients: recipients.length, enqueued };
}

/** Variante best-effort de `enqueueDeadlineReminderEmailsCore`. Ya NO la llama el barrido de `apps/worker` (ver comentario de cabecera del archivo, r4-fix-crons-transaccion-por-unidad) -- tragaba errores SQL reales dentro de la transacción por organización sin savepoint. Se conserva exportada sin caller de producción. */
export async function tryEnqueueDeadlineReminderEmails(repo: LicitacionesRepository, organizationId: string, reminders: readonly TenderDeadlineReminderRecord[]): Promise<AlertEmailEnqueueResult> {
  try {
    return await enqueueDeadlineReminderEmailsCore(repo, organizationId, reminders);
  } catch (err) {
    console.error("alert-notifications: best-effort deadline-reminder email enqueue failed:", err);
    return NO_RECIPIENTS;
  }
}

export async function tryEnqueueRenewalAlertEmails(repo: LicitacionesRepository, organizationId: string, alerts: readonly RenewalAlertRecord[]): Promise<AlertEmailEnqueueResult> {
  try {
    return await enqueueRenewalAlertEmailsCore(repo, organizationId, alerts);
  } catch (err) {
    console.error("alert-notifications: best-effort renewal-alert email enqueue failed:", err);
    return NO_RECIPIENTS;
  }
}

export async function tryEnqueueOverdueInvoiceEmails(repo: LicitacionesRepository, organizationId: string, invoices: readonly OverdueContractInvoiceAlert[]): Promise<AlertEmailEnqueueResult> {
  try {
    return await enqueueOverdueInvoiceEmailsCore(repo, organizationId, invoices);
  } catch (err) {
    console.error("alert-notifications: best-effort collection-alert email enqueue failed:", err);
    return NO_RECIPIENTS;
  }
}

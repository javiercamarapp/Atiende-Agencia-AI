// Correo real de escalamiento de vencimientos fiscales — cierra el gap de
// auditoría (severidad ALTA) de `POST .../vencimientos/:deadlineId/escalar`
// (apps/api/src/routes/verticals/despachos/vencimientos.ts), que hasta esta
// fase solo insertaba la fila de escalamiento en BD y marcaba el estado
// 'escalado' — nunca notificaba a nadie. Encola SIEMPRE vía
// `despachos.messaging_outbox` con `channel='email'`
// (`../email-dispatch.ts` hace el envío real por Resend) — nunca llama a la
// API de Resend directo desde aquí, mismo principio que
// `domain-citas::appointment-email-notifications.ts`/
// `domain-licitaciones::alert-notifications.ts` (leídos primero como
// plantilla).
//
// Destinatario: el escalamiento de un vencimiento fiscal es un aviso INTERNO
// al despacho contable dueño de la cuenta (nunca al contribuyente/cliente
// final) — se manda a TODO el staff owner/admin de la organización
// (`repo.listOrganizationNotificationRecipients`), mismo criterio que
// `domain-licitaciones::alert-notifications.ts`.
import { correoEscalamientoVencimiento } from "../emails/vencimiento-templates.ts";
import type { DespachosRepository } from "../repository.ts";
import type { FiscalDeadlineRecord } from "../types.ts";
import type { DecisionEscalamiento } from "./engine.ts";

export interface EscalationEmailEnqueueResult {
  /** Destinatarios (owner/admin) resueltos para la organización -- 0 si la
   * organización todavía no tiene ningún staff con ese rol (nunca un error,
   * simplemente no hay a quién avisar todavía). */
  readonly recipients: number;
  readonly enqueued: number;
}

const NO_RECIPIENTS: EscalationEmailEnqueueResult = { recipients: 0, enqueued: 0 };

/**
 * Encola un correo real por cada destinatario (owner/admin) de la
 * organización, avisando el escalamiento de `deadline`. Dedupe_key incluye el
 * nivel de escalamiento (`escalation:${deadlineId}:${level}:${email}`) --
 * mismo criterio que `appointment-email-notifications.ts::rescheduled`
 * (incluir el dato que distingue una repetición real de un simple reintento
 * de envío): un mismo vencimiento puede escalar varias veces a niveles
 * distintos (nivel_1 -> nivel_2 -> ... -> nivel_4), y cada nivel nuevo debe
 * poder mandar su propio aviso; reintentar el envío del MISMO nivel nunca
 * duplica.
 */
export async function enqueueEscalationEmailCore(repo: DespachosRepository, deadline: FiscalDeadlineRecord, decision: DecisionEscalamiento, tenantNombre: string, diasRestantes: number): Promise<EscalationEmailEnqueueResult> {
  const recipients = await repo.listOrganizationNotificationRecipients(deadline.organizationId);
  if (recipients.length === 0) return NO_RECIPIENTS;

  const correo = correoEscalamientoVencimiento({
    tenantNombre,
    tipo: deadline.tipo,
    periodo: deadline.periodo,
    fechaLimite: deadline.fechaLimite,
    diasRestantes,
    nivel: decision.level,
    notas: decision.notes,
  });

  let enqueued = 0;
  for (const recipient of recipients) {
    await repo.enqueueMessagingOutbox(deadline.organizationId, "email", "vencimiento.escalado", `escalation:${deadline.id}:${decision.level}:${recipient.email}`, {
      to: recipient.email,
      subject: correo.asunto,
      html: correo.html,
      text: correo.texto,
    });
    enqueued += 1;
  }
  return { recipients: recipients.length, enqueued };
}

/**
 * Envoltura best-effort — mismo principio que
 * `domain-citas::tryEnqueueAppointmentEmail`: el escalamiento YA se registró
 * con éxito en la base de datos (`repo.insertEscalation`/
 * `repo.updateDeadlineEstado`); que el correo falle por cualquier razón NUNCA
 * debe convertirse en un error para quien está escalando el vencimiento
 * (la revisión humana sigue siendo obligatoria y queda registrada de
 * cualquier forma).
 */
export async function tryEnqueueEscalationEmail(repo: DespachosRepository, deadline: FiscalDeadlineRecord, decision: DecisionEscalamiento, tenantNombre: string, diasRestantes: number): Promise<EscalationEmailEnqueueResult> {
  try {
    return await enqueueEscalationEmailCore(repo, deadline, decision, tenantNombre, diasRestantes);
  } catch (err) {
    console.error("vencimientos/email-notifications: best-effort escalation email enqueue failed:", err);
    return NO_RECIPIENTS;
  }
}

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
import type { CronSatRepository } from "../cron-sat/types.ts";
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
export async function enqueueEscalationEmailCore(
  repo: DespachosRepository,
  deadline: FiscalDeadlineRecord,
  decision: DecisionEscalamiento,
  tenantNombre: string,
  diasRestantes: number,
  opciones: { readonly habiles?: boolean } = {},
): Promise<EscalationEmailEnqueueResult> {
  const recipients = await repo.listOrganizationNotificationRecipients(deadline.organizationId);
  if (recipients.length === 0) return NO_RECIPIENTS;

  const correo = correoEscalamientoVencimiento({
    tenantNombre,
    tipo: deadline.tipo,
    periodo: deadline.periodo,
    fechaLimite: deadline.fechaLimite,
    diasRestantes,
    habiles: opciones.habiles === true,
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
 *
 * SAVEPOINT (auditoría a3, hallazgo confirmado #5/#2): el único caller real
 * (`apps/api/src/routes/verticals/despachos/vencimientos.ts::escalar`) llama a esta
 * función en la MISMA transacción de sesión de staff que ya hizo
 * `insertEscalation` + `updateDeadlineEstado`. Sin este SAVEPOINT, un error real de
 * Postgres dentro de `enqueueEscalationEmailCore`
 * (`despachos.enqueue_messaging_outbox`) deja la transacción COMPLETA abortada
 * (25P02) y el escalamiento ya "persistido" se pierde de todas formas, y el
 * `commit;` que sigue en `managed-postgres-engine.ts` lo detecta y lanza
 * `AbortedTransactionCommitError` (desde PR #158 esto es un 500 honesto, NUNCA un
 * rollback silencioso con 2xx). `repo.runWithRowSavepoint` aísla el intento y
 * relanza el mismo error para que este `catch` lo siga tragando, con la sesión ya
 * recuperada.
 */
export async function tryEnqueueEscalationEmail(
  repo: DespachosRepository,
  deadline: FiscalDeadlineRecord,
  decision: DecisionEscalamiento,
  tenantNombre: string,
  diasRestantes: number,
  opciones: { readonly habiles?: boolean } = {},
): Promise<EscalationEmailEnqueueResult> {
  try {
    return await repo.runWithRowSavepoint(() => enqueueEscalationEmailCore(repo, deadline, decision, tenantNombre, diasRestantes, opciones));
  } catch (err) {
    console.error("vencimientos/email-notifications: best-effort escalation email enqueue failed:", err);
    return NO_RECIPIENTS;
  }
}

/**
 * D-P3-33: correo de escalamiento desde el CRON de sistema (antes solo salía con el botón del panel). Mismo cuerpo que el del botón, a los
 * mismos destinatarios (staff owner/admin de la organización), por el mismo outbox: la lista de supresión de plataforma y los reintentos los
 * resuelve el despacho del outbox (el payload NO es transaccional, así que un correo suprimido no sale). Dedupe DIARIO: la clave incluye el
 * día (`escalation:<vencimiento>:<nivel>:<hoy>:<correo>`), de modo que un reintento del cron el mismo día jamás duplica. Best-effort: lo
 * llama el barrido después de registrar el escalamiento y un fallo aquí nunca lo revierte (cada llamada del repositorio corre en su propio
 * SAVEPOINT). Devuelve cuántos correos se encolaron.
 */
export async function encolarCorreoEscalamientoSistema(
  cron: CronSatRepository,
  v: { readonly id: string; readonly organizationId: string; readonly propertyId: string; readonly tipo: FiscalDeadlineRecord["tipo"]; readonly periodo: string; readonly fechaLimite: string },
  decision: DecisionEscalamiento,
  diasHabiles: number,
  hoy: string,
): Promise<number> {
  try {
    const destinatarios = await cron.listarDestinatariosAvisoSistema(v.organizationId);
    if (destinatarios.length === 0) return 0;
    const clienteNombre = await cron.nombreClienteSistema(v.propertyId);
    const correo = correoEscalamientoVencimiento({ tenantNombre: "tu despacho", clienteNombre, tipo: v.tipo, periodo: v.periodo, fechaLimite: v.fechaLimite, diasRestantes: diasHabiles, habiles: true, nivel: decision.level, notas: decision.notes });
    let encolados = 0;
    for (const d of destinatarios) {
      if (await cron.encolarCorreoSistema(v.organizationId, "vencimiento.escalado", `escalation:${v.id}:${decision.level}:${hoy}:${d.email}`, { to: d.email, subject: correo.asunto, html: correo.html, text: correo.texto })) encolados += 1;
    }
    return encolados;
  } catch (err) {
    console.error("vencimientos/email-notifications: best-effort cron escalation email enqueue failed:", err);
    return 0;
  }
}

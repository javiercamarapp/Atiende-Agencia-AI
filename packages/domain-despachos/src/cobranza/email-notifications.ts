// Correo real de recordatorio de cobranza — cierra el gap de auditoría
// (severidad ALTA) que el README/engine.ts de este módulo documentaban
// honestamente: "construirRecordatorioCobranza genera el contenido... pero no
// hay integración con un canal de envío real (messaging_outbox/
// whatsapp-gateway/email) en esta fase". Encola SIEMPRE vía
// `despachos.messaging_outbox` con `channel='email'` (`../email-dispatch.ts`
// hace el envío real por Resend) y SIEMPRE deja el rastro de auditoría en
// `despachos.collection_event` (`repo.insertCollectionEvent`) — mismo
// principio que `domain-citas::appointment-email-notifications.ts`/
// `domain-licitaciones::alert-notifications.ts` (leídos primero como
// plantilla): nunca se llama a la API de Resend directo desde aquí.
//
// Destinatario: a diferencia del escalamiento de vencimientos (aviso interno
// al despacho, ver `../vencimientos/email-notifications.ts`), un recordatorio
// de cobranza SÍ es un aviso a un tercero externo (el cliente que debe la
// factura) -- el contacto real vive en `receivable.clienteEmail`/
// `clienteNombre` (migración 005; el CFDI en sí nunca trajo un correo de
// contacto utilizable, solo `rfc_receptor`). Sin correo capturado, la etapa
// simplemente no se envía por email -- NO es un error (mismo criterio
// "honesto" que `appointment-email-notifications.ts`: "sin correo en archivo
// no es un error, muchos clientes solo dejan teléfono"), pero el evento de
// auditoría se registra igual con `canal:'email'` y se deja constancia para
// que un humano capture el contacto si hace falta.
import { construirCorreoCobranza } from "./email-templates.ts";
import { formatMontoCobranza } from "./templates.ts";
import type { CobranzaReminderStage } from "./templates.ts";
import type { DespachosRepository } from "../repository.ts";
import type { ReceivableReminderRow, ReceivableRecord } from "../types.ts";

export interface CollectionReminderEmailResult {
  readonly enqueued: boolean;
  readonly reason?: "no_email";
}

export interface FacturaCobranza {
  /** Identificador de negocio de la factura (folio fiscal del CFDI, ver
   * `InvoiceRecord.folioFiscal`) -- el mismo que ve el staff en el panel. */
  readonly facturaId: string;
  readonly monto: number;
}

/**
 * Genera y encola (si hay `clienteEmail` capturado) el correo real de una
 * etapa de cobranza para `receivable`, y SIEMPRE registra el evento de
 * auditoría correspondiente (`repo.insertCollectionEvent`) -- el registro de
 * auditoría no depende de que exista un correo real al que mandarlo, mismo
 * criterio que el resto de `collection_event` (auditoría de "qué etapa se
 * generó", separada de "se pudo enviar por este canal"). `diasVencido`:
 * calculado por el caller vía `diasVencidoCartera` (../cobranza/engine.ts),
 * nunca recalculado aquí.
 */
export async function enqueueCollectionReminderEmailCore(repo: DespachosRepository, receivable: ReceivableRecord, factura: FacturaCobranza, stage: CobranzaReminderStage, diasVencido: number): Promise<CollectionReminderEmailResult> {
  await repo.insertCollectionEvent({
    organizationId: receivable.organizationId,
    propertyId: receivable.propertyId,
    receivableId: receivable.id,
    etapa: stage,
    canal: "email",
    respuesta: null,
  });

  if (!receivable.clienteEmail) return { enqueued: false, reason: "no_email" };

  const vars = {
    nombreEmpresa: receivable.clienteNombre ?? "Cliente",
    monto: formatMontoCobranza(factura.monto),
    diasVencido: String(diasVencido),
    facturaId: factura.facturaId,
  };
  const correo = construirCorreoCobranza(stage, vars);

  // dedupe_key incluye la etapa (no solo el receivableId): la secuencia de
  // cobranza tiene 5 etapas reales para una misma cuenta por cobrar
  // (pre_vencimiento -> ... -> escalamiento) y cada una debe poder mandar su
  // propio correo -- mismo criterio que
  // `appointment-email-notifications.ts::modified` (incluir el dato que
  // distingue un evento real nuevo de un simple reintento).
  await repo.enqueueMessagingOutbox(receivable.organizationId, "email", `cobranza.${stage}`, `cobranza:${stage}:${receivable.id}`, {
    to: receivable.clienteEmail,
    subject: correo.asunto,
    html: correo.html,
    text: correo.texto,
  });
  return { enqueued: true };
}

/**
 * Envoltura best-effort — mismo principio que
 * `domain-citas::tryEnqueueAppointmentEmail`: un fallo al encolar/registrar un
 * recordatorio de UNA cuenta por cobrar nunca debe tumbar el barrido del
 * resto de la cartera (ver `@atiende/worker::runCobranzaReminderSweep`).
 */
export async function tryEnqueueCollectionReminderEmail(repo: DespachosRepository, receivable: ReceivableRecord, factura: FacturaCobranza, stage: CobranzaReminderStage, diasVencido: number): Promise<CollectionReminderEmailResult | null> {
  try {
    return await enqueueCollectionReminderEmailCore(repo, receivable, factura, stage, diasVencido);
  } catch (err) {
    console.error("cobranza/email-notifications: best-effort reminder enqueue failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Variantes de SOLO SISTEMA (`@atiende/worker::runCobranzaReminderSweep`,
// `withAppSession({ userId: null })`) -- hallazgo de auditoría (severidad
// ALTA, "flujos de sistema bloqueados en escritura", ver migración
// `009_despachos_sistema_cobranza_escritura.sql`): `repo.insertCollectionEvent`
// de arriba es código COMPARTIDO con el staff autenticado (`POST .../
// cuentas/:id/recordatorio`, camino manual, YA funciona hoy) -- sustituirlo
// directo habría roto ese camino. Estas 2 funciones son EXACTAMENTE
// `enqueueCollectionReminderEmailCore`/`tryEnqueueCollectionReminderEmail`
// de arriba, con `repo.systemRecordCollectionEvent` (exclusivo de sistema,
// idempotente) en vez de `repo.insertCollectionEvent`, y
// `ReceivableReminderRow` (la fila ya combinada con el invoice, ver
// `repo.systemListPendingReceivablesForReminders`) en vez de
// `ReceivableRecord` + `FacturaCobranza` por separado -- el motor de
// contenido/envío (`construirCorreoCobranza`/`repo.enqueueMessagingOutbox`,
// éste último YA funciona para ambos caminos desde
// `007_email_outbox_authenticated_grants.sql`) es el MISMO, nunca
// reimplementado.
// ---------------------------------------------------------------------------
export async function enqueueCollectionReminderEmailForSystemCore(
  repo: DespachosRepository,
  receivable: ReceivableReminderRow,
  stage: CobranzaReminderStage,
  diasVencido: number,
  eventDateIso: string,
): Promise<CollectionReminderEmailResult> {
  await repo.systemRecordCollectionEvent({
    organizationId: receivable.organizationId,
    propertyId: receivable.propertyId,
    receivableId: receivable.id,
    etapa: stage,
    canal: "email",
    respuesta: null,
    eventDate: eventDateIso,
  });

  if (!receivable.clienteEmail) return { enqueued: false, reason: "no_email" };

  const vars = {
    nombreEmpresa: receivable.clienteNombre ?? "Cliente",
    monto: formatMontoCobranza(receivable.facturaTotal),
    diasVencido: String(diasVencido),
    facturaId: receivable.facturaFolioFiscal,
  };
  const correo = construirCorreoCobranza(stage, vars);

  await repo.enqueueMessagingOutbox(receivable.organizationId, "email", `cobranza.${stage}`, `cobranza:${stage}:${receivable.id}`, {
    to: receivable.clienteEmail,
    subject: correo.asunto,
    html: correo.html,
    text: correo.texto,
  });
  return { enqueued: true };
}

/** Envoltura best-effort -- mismo criterio que `tryEnqueueCollectionReminderEmail`. */
export async function tryEnqueueCollectionReminderEmailForSystem(
  repo: DespachosRepository,
  receivable: ReceivableReminderRow,
  stage: CobranzaReminderStage,
  diasVencido: number,
  eventDateIso: string,
): Promise<CollectionReminderEmailResult | null> {
  try {
    return await enqueueCollectionReminderEmailForSystemCore(repo, receivable, stage, diasVencido, eventDateIso);
  } catch (err) {
    console.error("cobranza/email-notifications: best-effort system reminder enqueue failed:", err);
    return null;
  }
}

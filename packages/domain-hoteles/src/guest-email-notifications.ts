// Correo real de ciclo de vida de una reserva/folio/CFDI al huésped — mismo patrón
// que packages/domain-citas/src/appointment-email-notifications.ts. Encola SIEMPRE
// vía `hoteles.messaging_outbox` con `channel = 'email'` (email-dispatch.ts hace el
// envío real por Resend) — nunca llama a la API de Resend directo desde aquí.
//
// GAP QUE ESTA FASE CIERRA (hallazgo ALTA, verificado directamente contra el
// código): domain-hoteles NO tenía ninguna carpeta `emails/` ni ruta
// `email-dispatch` — a diferencia de citas/rentas/licitaciones/despachos, que ya
// tienen esta infraestructura completa. `enqueueMessagingOutbox` admite
// `channel='email'` desde 008_messaging_outbox.sql, pero su único uso real hasta
// esta fase era WhatsApp. Este archivo + emails/guest-templates.ts +
// email-dispatch.ts + la migración 014 cierran ese gap para los 3 eventos reales
// mínimos: reserva creada, folio cerrado (recibo), CFDI timbrado (aviso).
//
// Cada función se resuelve de forma AUTOSUFICIENTE a partir de solo `reservationId`
// (más un `extra` con el dato propio del evento que NO vive en la reserva misma:
// el folio cerrado o el CFDI recién timbrado) — mismo criterio que
// `enqueueAppointmentEmailCore` de citas: ningún caller (reservas.ts/folios.ts/
// cfdi.ts) necesita saber qué columnas hacen falta para armar el correo.
import {
  correoCfdiDisponible,
  correoFolioRecibo,
  correoReservaConfirmada,
  type CfdiCorreo,
  type Correo,
  type FolioCorreo,
  type ReservaCorreo,
} from "./emails/guest-templates.ts";
import { applyTaxes } from "./taxes.ts";
import type { HotelesRepository } from "./repository.ts";

export type GuestEmailEvent = "reservation.created" | "folio.closed" | "cfdi.issued";

export interface GuestEmailFolioExtra {
  /** Id real del folio cerrado — usado como dedupe_key (una reserva puede tener
   *  más de un folio, ej. split, y cada cierre real debe poder mandar su propio
   *  correo). */
  readonly folioId: string;
  readonly label: string;
  readonly closeReason: "saldo_cero" | "cuenta_por_cobrar";
  readonly totalCargos: number;
  readonly totalPagos: number;
  readonly saldo: number;
}

export interface GuestEmailCfdiExtra {
  readonly uuidFiscal: string;
  readonly total: number;
  readonly folioLabel: string;
}

export interface GuestEmailExtra {
  /** Solo relevante para "folio.closed". */
  readonly folio?: GuestEmailFolioExtra;
  /** Solo relevante para "cfdi.issued". */
  readonly cfdi?: GuestEmailCfdiExtra;
}

export interface GuestEmailResult {
  readonly enqueued: boolean;
  readonly reason?: "no_guest" | "no_email" | "reservation_not_found" | "property_not_found";
}

const formatMonto = (n: number): string => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

/** `checkInDate`/`checkOutDate` son fechas calendario puras (`YYYY-MM-DD`, sin
 *  componente de hora ni timezone propio — ver ReservationRecord.checkInDate) —
 *  se formatean SIEMPRE en UTC para que un huésped en cualquier zona horaria vea
 *  la misma fecha que reservó, nunca un día corrido por el timezone del host. */
const formatFecha = (dateStr: string): string =>
  new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${dateStr}T00:00:00Z`));

const MOTIVO_CIERRE_TEXTO: Record<"saldo_cero" | "cuenta_por_cobrar", string> = {
  saldo_cero: "Saldo en cero",
  cuenta_por_cobrar: "Cuenta por cobrar",
};

export async function enqueueGuestEmailCore(
  repo: HotelesRepository,
  propertyId: string,
  organizationId: string,
  event: GuestEmailEvent,
  reservationId: string,
  extra: GuestEmailExtra = {},
): Promise<GuestEmailResult> {
  const reservation = await repo.findReservation(propertyId, reservationId);
  if (!reservation) return { enqueued: false, reason: "reservation_not_found" };

  // Sin huésped ligado (walk-in sin capturar, o reserva de canal que no lo trae)
  // no es un error — es el mismo criterio que citas: no todo huésped deja correo
  // en archivo. ----
  if (!reservation.guestId) return { enqueued: false, reason: "no_guest" };
  const guest = await repo.findGuestById(propertyId, reservation.guestId);
  if (!guest?.email) return { enqueued: false, reason: "no_email" };

  const property = await repo.findPropertyById(propertyId);
  if (!property) return { enqueued: false, reason: "property_not_found" };

  let correo: Correo;
  let dedupeKey: string;

  switch (event) {
    case "reservation.created": {
      const roomType = await repo.findRoomTypeSummary(propertyId, reservation.roomTypeId);
      const taxConfig = await repo.loadTaxConfig(propertyId);
      // ReservationRecord.totalAmount es SIEMPRE el neto (ver su propio comentario
      // en types.ts) — el huésped necesita ver el total CON impuestos, recalculado
      // aquí con el mismo motor determinista que folios.ts/reservas.ts, nunca un
      // monto aproximado a mano.
      const { totalAmount } = applyTaxes(reservation.totalAmount, taxConfig);
      const base: ReservaCorreo = {
        huespedNombre: guest.fullName,
        hotelNombre: property.name,
        tipoHabitacionNombre: roomType?.name ?? "Habitación",
        checkInTexto: formatFecha(reservation.checkInDate),
        checkOutTexto: formatFecha(reservation.checkOutDate),
        totalConImpuestosTexto: formatMonto(totalAmount),
      };
      correo = correoReservaConfirmada(base);
      dedupeKey = `reservation-created:${reservationId}`;
      break;
    }
    case "folio.closed": {
      if (!extra.folio) throw new Error("guest-email-notifications: el evento 'folio.closed' requiere extra.folio.");
      const f = extra.folio;
      const base: FolioCorreo = {
        huespedNombre: guest.fullName,
        hotelNombre: property.name,
        folioEtiqueta: f.label,
        motivoCierreTexto: MOTIVO_CIERRE_TEXTO[f.closeReason],
        totalCargosTexto: formatMonto(f.totalCargos),
        totalPagosTexto: formatMonto(f.totalPagos),
        saldoTexto: formatMonto(f.saldo),
        esCuentaPorCobrar: f.closeReason === "cuenta_por_cobrar",
      };
      correo = correoFolioRecibo(base);
      // Por folioId (no por reservationId): una reserva puede tener más de un
      // folio real (split, ver folios.ts::split) — cada cierre real manda su
      // propio recibo.
      dedupeKey = `folio-closed:${f.folioId}`;
      break;
    }
    case "cfdi.issued": {
      if (!extra.cfdi) throw new Error("guest-email-notifications: el evento 'cfdi.issued' requiere extra.cfdi.");
      const cf = extra.cfdi;
      const base: CfdiCorreo = {
        huespedNombre: guest.fullName,
        hotelNombre: property.name,
        folioEtiqueta: cf.folioLabel,
        uuidFiscal: cf.uuidFiscal,
        totalTexto: formatMonto(cf.total),
      };
      correo = correoCfdiDisponible(base);
      // Por uuidFiscal: idempotente de verdad ante un reintento HTTP de la propia
      // ruta de timbrado (REQ-BO-002 ya garantiza un solo CFDI de tipo 'hospedaje'
      // por folio, pero el correo se ata al UUID real emitido, nunca al folioId,
      // para que un CFDI de 'pago' futuro con su propio UUID también pueda avisar
      // sin colisionar con el de 'hospedaje').
      dedupeKey = `cfdi-issued:${cf.uuidFiscal}`;
      break;
    }
    default:
      throw new Error(`guest-email-notifications: evento de correo desconocido: ${String(event)}`);
  }

  await repo.enqueueMessagingOutbox(propertyId, organizationId, "email", event, dedupeKey, {
    to: guest.email,
    subject: correo.asunto,
    html: correo.html,
    text: correo.texto,
  });

  return { enqueued: true };
}

/**
 * Envoltura best-effort — mismo principio que
 * citas::tryEnqueueAppointmentEmail: la reserva/el folio/el CFDI YA se
 * crearon/cerraron/timbraron con éxito; que no haya correo del huésped en
 * archivo, o que esto falle por cualquier otra razón, NUNCA debe convertirse en
 * un error para quien está creando la reserva, cerrando el folio o timbrando el
 * CFDI.
 *
 * SAVEPOINT (auditoría a3, hallazgo confirmado #5/#2): los tres callers reales
 * (`reservas.ts:289`, `folios.ts:576`, `cfdi.ts:322`) invocan esta función DENTRO
 * de la MISMA transacción que ya persistió la escritura de negocio (inserción de
 * la reserva, cierre del folio, o el propio `insertCfdiEmision` DESPUÉS de
 * timbrar en el PAC externo — el caso más delicado, mitigado porque el PAC es
 * idempotente por folio ante un reintento). `enqueueGuestEmailCore` termina en
 * `select hoteles.enqueue_messaging_outbox(...)` (postgres-repository.ts ~1399):
 * un error real de Postgres ahí (deadlock, timeout, `42501` si `auth.uid()` no
 * es miembro) sin este SAVEPOINT deja la transacción COMPLETA abortada (25P02) —
 * la reserva/folio/CFDI ya "persistido" antes se pierde con un `commit;` que
 * `managed-postgres-engine.ts` convierte en `ROLLBACK` silencioso
 * (`AbortedTransactionCommitError`). `repo.runWithRowSavepoint` (ya expuesto por
 * `HotelesRepository`, ver postgres-repository.ts ~1426) aísla solo este
 * intento y relanza el mismo error para que este `catch` lo siga tragando, con
 * la sesión ya recuperada para el `commit;` real que sigue.
 */
export async function tryEnqueueGuestEmail(
  repo: HotelesRepository,
  propertyId: string,
  organizationId: string,
  event: GuestEmailEvent,
  reservationId: string,
  extra: GuestEmailExtra = {},
): Promise<GuestEmailResult | null> {
  try {
    return await repo.runWithRowSavepoint(() => enqueueGuestEmailCore(repo, propertyId, organizationId, event, reservationId, extra));
  } catch (err) {
    console.error("guest-email-notifications: best-effort enqueue failed:", err);
    return null;
  }
}

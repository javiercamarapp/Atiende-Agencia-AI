// Rn-20 -- encolado best-effort del correo de invitacion de staff en el outbox de rentas.
//
// SAVEPOINT: la ruta corre en la sesion de STAFF del request, en la MISMA transaccion que ya persistio la
// invitacion (`createStaffInvite`). Sin SAVEPOINT, un error real de Postgres al encolar (deadlock/timeout
// transitorio, o 42501 del guard) dejaria la transaccion en 25P02 y el COMMIT final revertiria tambien la invitacion
// (AbortedTransactionCommitError -> 500), justo lo que un best-effort promete que nunca pasa. Mismo criterio que
// `tryEnqueueReservaEmail` (reserva-email-notifications.ts): nunca relanza, ni siquiera si el SAVEPOINT mismo falla.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { runWithSavepointFallback } from "@atiende/db";
import type { RentasRepository } from "./repository.ts";

export const STAFF_INVITE_EMAIL_SAVEPOINT_NAME = "sp_staff_invite_email_best_effort";

export async function tryEnqueueStaffInviteEmail(
  repo: RentasRepository,
  db: TenantDbSession,
  propertyId: string,
  organizationId: string,
  inviteId: string,
  email: string,
  correo: { readonly asunto: string; readonly html: string; readonly texto: string },
): Promise<boolean> {
  try {
    await runWithSavepointFallback<void>({
      session: db,
      savepointName: STAFF_INVITE_EMAIL_SAVEPOINT_NAME,
      primary: () =>
        repo.enqueueMessagingOutbox(propertyId, organizationId, "email", "staff.invite", `staff-invite:${inviteId}`, {
          to: email,
          subject: correo.asunto,
          html: correo.html,
          text: correo.texto,
        }),
      isRecoverable: () => true,
      fallback: (err) => {
        throw err;
      },
    });
    return true;
  } catch (err) {
    console.error("rentas/admin-staff: best-effort staff invite email enqueue failed:", err);
    return false;
  }
}

// Hallazgo de auditoría (severidad ALTA, "Alta de organización/staff imposible
// sin SQL") — cliente real de POST/GET/DELETE
// .../despachos/:propertyId/admin/staff/invitaciones (admin-staff.ts). Port
// EXACTO de apps/web/src/verticals/restaurantes/lib/staff-client.ts (leído
// primero como plantilla) sobre los 4 roles de despachos en vez de los de
// restaurantes, y sin `fetchRepartidores` (despachos no tiene un rol análogo).
import { deleteJson, fetchJson, postJson } from "./admin-client.ts";

/** Mismos 4 roles que `DESPACHOS_ROLES` de `@atiende/domain-despachos/src/roles.ts`
 * -- duplicado aquí a propósito, no importado: apps/web no depende de los paquetes
 * de dominio (mismo criterio ya documentado en declaraciones-client.ts). El
 * servidor (admin-staff.ts::isDespachosRole) es SIEMPRE la fuente real de verdad;
 * este tipo solo evita que el <select> de Staff.tsx mande un string arbitrario. */
export type StaffVerticalRole = "admin" | "contador" | "auditor" | "readonly";

export interface StaffInvite {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: StaffVerticalRole;
  readonly propertyIds: readonly string[] | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Solo la respuesta de CREAR trae `inviteToken` -- el servidor nunca lo vuelve a
 * exponer después (ver admin-staff.ts: "se devuelve UNA sola vez... solo el hash
 * persiste"). Quien invita copia/pega este token en el mensaje que le mande al
 * invitado (WhatsApp, correo manual, etc.) además del correo real que ya se encola
 * best-effort. */
export interface CreatedStaffInvite extends StaffInvite {
  readonly inviteToken: string;
}

export async function fetchStaffInvites(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly StaffInvite[]> {
  const body = await fetchJson<{ invitations: StaffInvite[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/admin/staff/invitaciones`, token);
  return body.invitations;
}

export async function createStaffInvite(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly email: string; readonly verticalRole: StaffVerticalRole },
): Promise<CreatedStaffInvite> {
  return postJson<CreatedStaffInvite>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/admin/staff/invitaciones`, token, input);
}

/** Idempotente en el servidor solo para el PRIMER llamado -- una invitación ya
 * aceptada/revocada responde 404 ("Invitación no encontrada, ya fue usada, o ya
 * estaba revocada", ver admin-staff.ts), que `deleteJson` propaga como error real. */
export async function revokeStaffInvite(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, inviteId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/admin/staff/invitaciones/${inviteId}`, token);
}

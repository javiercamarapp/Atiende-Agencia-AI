// Hallazgo de auditoría (severidad ALTA, "Alta de organización/staff imposible
// sin SQL") — cliente real de POST/GET/DELETE
// .../despachos/:propertyId/admin/staff/invitaciones (admin-staff.ts). Port
// EXACTO de apps/web/src/verticals/restaurantes/lib/staff-client.ts (leído
// primero como plantilla) sobre los 4 roles de despachos en vez de los de
// restaurantes, y sin `fetchRepartidores` (despachos no tiene un rol análogo).
import { deleteJson, fetchJson, patchJson, postJson } from "./admin-client.ts";

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

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): mismo hueco real que
// restaurantes tenía antes de esta pasada — todo lo de arriba solo fija el rol AL
// INVITAR, nunca después. `OrgMember` SÍ trae `verticalRole` (a diferencia de un
// selector que ya conoce el rol) — es el dato que la tabla nueva "Staff activo"
// necesita mostrar/editar.
export interface OrgMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly verticalRole: StaffVerticalRole;
  readonly propertyIds: readonly string[] | null;
}

export async function fetchOrgMembers(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly OrgMember[]> {
  const body = await fetchJson<{ miembros: OrgMember[] }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/admin/staff/miembros`, token);
  return body.miembros;
}

/** Cambia el rol de un staff YA ACEPTADO — `admin-staff.ts::PATCH miembroItemPath`
 * reaplica la MISMA jerarquía de `canInviteStaff` que ya bloquea `createStaffInvite`
 * de arriba (nunca tocar/ascender a alguien de más alcance que el propio, nunca
 * auto-cambio de rol) — un 400/403/404 real, nunca un éxito fingido. */
export async function updateStaffRole(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  userId: string,
  verticalRole: StaffVerticalRole,
): Promise<OrgMember> {
  return patchJson<OrgMember>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/admin/staff/miembros/${userId}`, token, { verticalRole });
}

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): verificado contra el
// código real que licitaciones tenía `admin-staff.ts` (POST/GET/DELETE
// invitaciones, y ahora GET/PATCH miembros) construido desde una fase anterior
// (severidad ALTA, "alta de organización/staff imposible sin SQL") pero NINGÚN
// panel lo llamaba todavía — a diferencia de restaurantes/despachos/citas, que ya
// tenían su Staff.tsx desde su propia Fase 14. Este archivo es el port EXACTO de
// restaurantes/lib/staff-client.ts (leído primero como plantilla) sobre
// `LICITACIONES_ROLES`/`isLicitacionesRole` en vez de las de restaurantes, sin la
// superficie de "repartidores" (licitaciones no tiene ese concepto).
import { deleteJson, fetchJson, patchJson, postJson } from "./admin-client.ts";

/** Mismos 6 roles que `LICITACIONES_ROLES` de
 * `@atiende/domain-licitaciones/src/roles.ts` -- duplicado aquí a propósito, no
 * importado: apps/web no depende de los paquetes de dominio (mismo criterio ya
 * documentado en restaurantes/lib/staff-client.ts). El servidor
 * (admin-staff.ts::isLicitacionesRole) es SIEMPRE la fuente real de verdad; este
 * tipo solo evita que el <select> de Staff.tsx mande un string arbitrario. */
export type StaffVerticalRole = "owner" | "admin" | "analyst" | "writer" | "reviewer" | "viewer";

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
 * invitado por si el correo real (encolado best-effort) no llega. */
export interface CreatedStaffInvite extends StaffInvite {
  readonly inviteToken: string;
}

export async function fetchStaffInvites(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly StaffInvite[]> {
  const body = await fetchJson<{ invitations: StaffInvite[] }>(fetchImpl, `${apiBaseUrl}/v1/licitaciones/${propertyId}/admin/staff/invitaciones`, token);
  return body.invitations;
}

export async function createStaffInvite(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly email: string; readonly verticalRole: StaffVerticalRole },
): Promise<CreatedStaffInvite> {
  return postJson<CreatedStaffInvite>(fetchImpl, `${apiBaseUrl}/v1/licitaciones/${propertyId}/admin/staff/invitaciones`, token, input);
}

/** Idempotente en el servidor solo para el PRIMER llamado -- una invitación ya
 * aceptada/revocada responde 404 ("Invitación no encontrada, ya fue usada, o ya
 * estaba revocada", ver admin-staff.ts). */
export async function revokeStaffInvite(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, inviteId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${apiBaseUrl}/v1/licitaciones/${propertyId}/admin/staff/invitaciones/${inviteId}`, token);
}

/** `OrgMember` SÍ trae `verticalRole` -- es el dato que la tabla "Staff activo"
 * necesita mostrar/editar. */
export interface OrgMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly verticalRole: StaffVerticalRole;
  readonly propertyIds: readonly string[] | null;
}

export async function fetchOrgMembers(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly OrgMember[]> {
  const body = await fetchJson<{ miembros: OrgMember[] }>(fetchImpl, `${apiBaseUrl}/v1/licitaciones/${propertyId}/admin/staff/miembros`, token);
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
  return patchJson<OrgMember>(fetchImpl, `${apiBaseUrl}/v1/licitaciones/${propertyId}/admin/staff/miembros/${userId}`, token, { verticalRole });
}

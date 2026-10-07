// H-P3-05 -- cliente de la gestion de equipo de hoteles (`apps/api/src/routes/verticals/hoteles/admin-staff.ts`): invitar, revocar,
// ver pendientes y ver al equipo activo (solo lectura). Mismo patron que verticals/rentas/lib/staff-client.ts. Los 8 roles son los de
// `HOTEL_ROLES` (packages/domain-hoteles/src/roles.ts), duplicados a proposito (apps/web no depende de los paquetes de dominio); el
// servidor (`isHotelRole`, `canInviteStaff`) es SIEMPRE la fuente real de verdad.
import { fetchJson, sendJson } from "./admin-client.ts";

export type StaffVerticalRole = "owner" | "gm" | "frontdesk" | "reservations" | "housekeeping" | "maintenance" | "fnb" | "accountant";

export const STAFF_ROLE_LABELS: Record<StaffVerticalRole, string> = {
  owner: "Propietario/a",
  gm: "Gerente general",
  frontdesk: "Recepción",
  reservations: "Reservaciones",
  housekeeping: "Housekeeping",
  maintenance: "Mantenimiento",
  fnb: "Alimentos y bebidas",
  accountant: "Contabilidad",
};

/** Orden del selector: del rol de menor alcance al de mayor. */
export const STAFF_ROLE_OPTIONS: readonly StaffVerticalRole[] = ["housekeeping", "maintenance", "fnb", "frontdesk", "reservations", "accountant", "gm", "owner"];

/** Roles que ven la pagina Equipo (espejo de STAFF_INVITE_ROLES del servidor). */
export const EQUIPO_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

export interface StaffInvite {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: StaffVerticalRole;
  readonly propertyIds: readonly string[] | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Solo la respuesta de CREAR trae `inviteToken`: el servidor nunca lo vuelve a exponer (solo persiste el hash). */
export interface CreatedStaffInvite extends StaffInvite {
  readonly inviteToken: string;
}

export interface OrgMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly verticalRole: StaffVerticalRole;
  readonly propertyIds: readonly string[] | null;
}

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/hoteles/${propertyId}/admin/staff`;

export async function fetchStaffInvites(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly StaffInvite[]> {
  const body = await fetchJson<{ invitations: StaffInvite[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/invitaciones`, token);
  return body.invitations;
}

export function createStaffInvite(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly email: string; readonly verticalRole: StaffVerticalRole },
): Promise<CreatedStaffInvite> {
  return sendJson<CreatedStaffInvite>(fetchImpl, `${base(apiBaseUrl, propertyId)}/invitaciones`, token, "POST", input);
}

export async function revokeStaffInvite(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, inviteId: string): Promise<void> {
  await sendJson<{ ok: true }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/invitaciones/${inviteId}`, token, "DELETE");
}

export async function fetchOrgMembers(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly OrgMember[]> {
  const body = await fetchJson<{ miembros: OrgMember[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/miembros`, token);
  return body.miembros;
}

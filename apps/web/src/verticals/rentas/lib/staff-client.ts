// Rn-20 -- cliente de la gestión de staff de rentas (`apps/api/src/routes/verticals/rentas/admin-staff.ts`): invitar,
// cambiar el rol y dar de baja. Mismo patrón que verticals/restaurantes/lib/staff-client.ts. Los 6 roles son los de
// `RENTAS_VERTICAL_ROLES` (packages/domain-rentas/src/roles.ts), duplicados a propósito (apps/web no depende de los
// paquetes de dominio); el servidor (`isRentasVerticalRole`, `canInviteStaff`) es SIEMPRE la fuente real de verdad.
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export type StaffVerticalRole = "admin_gestora" | "operador:acceso_total" | "operador:calendario_mensajeria" | "operador:solo_calendario" | "contador" | "limpieza";

export const STAFF_ROLE_LABELS: Record<StaffVerticalRole, string> = {
  admin_gestora: "Administrador/a de la gestora",
  "operador:acceso_total": "Operador/a (acceso total)",
  "operador:calendario_mensajeria": "Operador/a (calendario y mensajería)",
  "operador:solo_calendario": "Operador/a (solo calendario)",
  contador: "Contador/a",
  limpieza: "Limpieza",
};

/** Orden del selector: del rol de menor alcance al de mayor. */
export const STAFF_ROLE_OPTIONS: readonly StaffVerticalRole[] = ["limpieza", "contador", "operador:solo_calendario", "operador:calendario_mensajeria", "operador:acceso_total", "admin_gestora"];

export interface StaffInvite {
  readonly id: string;
  readonly email: string;
  readonly verticalRole: StaffVerticalRole;
  readonly propertyIds: readonly string[] | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/** Solo la respuesta de CREAR trae `inviteToken`: el servidor nunca lo vuelve a exponer (solo persiste el hash). Además se
 *  encola el correo real con el enlace de activación; el token queda por si quien invita prefiere compartirlo a mano. */
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

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/v1/rentas/${propertyId}/admin/staff`;

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
  await deleteJson<{ ok: true }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/invitaciones/${inviteId}`, token);
}

export async function fetchOrgMembers(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly OrgMember[]> {
  const body = await fetchJson<{ miembros: OrgMember[] }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/miembros`, token);
  return body.miembros;
}

export function updateStaffRole(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string, verticalRole: StaffVerticalRole): Promise<OrgMember> {
  return sendJson<OrgMember>(fetchImpl, `${base(apiBaseUrl, propertyId)}/miembros/${userId}`, token, "PATCH", { verticalRole });
}

export async function removeStaffMember(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, userId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${base(apiBaseUrl, propertyId)}/miembros/${userId}`, token);
}

// Fase 12 — hallazgo de auditoría (CRÍTICO/ALTO, "citas define 3 roles de
// plataforma pero no los aplica en NINGUNA capa"): cliente real de
// POST/GET/DELETE .../admin/staff/invitaciones (admin-staff.ts) — mismo patrón
// exacto que restaurantes/lib/staff-client.ts, sin la superficie de
// "repartidores" (citas no tiene ese concepto, ver domain-citas/src/roles.ts:
// solo owner/admin/staff).
import { deleteJson, fetchJson, postJson } from "./admin-client.ts";

/** Mismos 3 roles que `CITAS_ROLES` de `@atiende/domain-citas/src/roles.ts` --
 * duplicado aquí a propósito, no importado: apps/web no depende de los paquetes de
 * dominio (mismo criterio ya documentado en restaurantes/lib/staff-client.ts). El
 * servidor (admin-staff.ts::isCitasRole) es SIEMPRE la fuente real de verdad; este
 * tipo solo evita que el <select> de Staff.tsx mande un string arbitrario. */
export type StaffVerticalRole = "owner" | "admin" | "staff";

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
  const body = await fetchJson<{ invitations: StaffInvite[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/staff/invitaciones`, token);
  return body.invitations;
}

export async function createStaffInvite(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly email: string; readonly verticalRole: StaffVerticalRole },
): Promise<CreatedStaffInvite> {
  return postJson<CreatedStaffInvite>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/staff/invitaciones`, token, input);
}

/** Idempotente en el servidor solo para el PRIMER llamado -- una invitación ya
 * aceptada/revocada responde 404 ("Invitación no encontrada, ya fue usada, o ya
 * estaba revocada", ver admin-staff.ts). */
export async function revokeStaffInvite(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, inviteId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${apiBaseUrl}/v1/citas/properties/${propertyId}/admin/staff/invitaciones/${inviteId}`, token);
}

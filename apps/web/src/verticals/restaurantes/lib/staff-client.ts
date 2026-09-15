// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI: el panel de repartidor siempre estará vacío"): cliente real de
// `GET .../admin/staff/repartidores` (admin-staff.ts) — lista los miembros YA
// aceptados de la organización con `verticalRole === "repartidor"`, para poblar el
// selector de `PedidosPage` (ver `orders-client.ts::assignRepartidor`). Deliberadamente
// un archivo nuevo (no agregado a `orders-client.ts`): es un recurso distinto
// (staff/membership, no pedidos), mismo criterio de separación que ya usa el resto de
// este vertical (`orders-client.ts` vs. `dashboard-client.ts` vs. `catalog-client.ts`).
//
// Fase 14 — hallazgo de auditoría (severidad ALTA, "Invitaciones de staff (Fase 10)
// sin ninguna UI: imposible dar de alta staff o repartidores desde el producto"):
// admin-staff.ts ya exponía POST/GET/DELETE .../admin/staff/invitaciones desde Fase
// 10 (ver el comentario de cabecera de ese archivo para la decisión de diseño
// completa), pero ningún cliente de apps/web los llamaba todavía -- este archivo YA
// existía (fetchRepartidores, Fase 12) y es el lugar correcto para extenderlo (mismo
// recurso "staff", no uno nuevo): `createStaffInvite`/`fetchStaffInvites`/
// `revokeStaffInvite` son el CRUD real de invitaciones que StaffPage.tsx consume.
import { deleteJson, fetchJson, sendJson } from "./admin-client.ts";

export interface RepartidorMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly propertyIds: readonly string[] | null;
}

export async function fetchRepartidores(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RepartidorMember[]> {
  const body = await fetchJson<{ repartidores: RepartidorMember[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/repartidores`, token);
  return body.repartidores;
}

/** Mismos 4 roles que `RESTAURANTES_ROLES` de `@atiende/domain-restaurantes/src/roles.ts`
 * -- duplicado aquí a propósito, no importado: apps/web no depende de los paquetes de
 * dominio (ver el mismo criterio ya documentado en orders-client.ts para
 * order-lifecycle.ts). El servidor (admin-staff.ts::isRestaurantesRole) es SIEMPRE la
 * fuente real de verdad; este tipo solo evita que el <select> de StaffPage.tsx mande
 * un string arbitrario. */
export type StaffVerticalRole = "owner" | "admin" | "staff" | "repartidor";

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
 * exponer después (ver el comentario de `admin-staff.ts::app.post(collectionPath)`:
 * "se devuelve UNA sola vez... solo el hash persiste"). Quien invita copia/pega este
 * token en el mensaje que le mande al invitado (WhatsApp, correo manual, etc. -- sin
 * proveedor SMTP configurado en esta fase, mismo criterio "honesto" documentado ahí). */
export interface CreatedStaffInvite extends StaffInvite {
  readonly inviteToken: string;
}

export async function fetchStaffInvites(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly StaffInvite[]> {
  const body = await fetchJson<{ invitations: StaffInvite[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/invitaciones`, token);
  return body.invitations;
}

export async function createStaffInvite(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: { readonly email: string; readonly verticalRole: StaffVerticalRole },
): Promise<CreatedStaffInvite> {
  return sendJson<CreatedStaffInvite>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/invitaciones`, token, "POST", input);
}

/** Idempotente en el servidor solo para el PRIMER llamado -- una invitación ya
 * aceptada/revocada responde 404 ("Invitación no encontrada, ya fue usada, o ya
 * estaba revocada", ver admin-staff.ts), que `deleteJson` propaga como error real. */
export async function revokeStaffInvite(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, inviteId: string): Promise<void> {
  await deleteJson<{ ok: true }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/staff/invitaciones/${inviteId}`, token);
}

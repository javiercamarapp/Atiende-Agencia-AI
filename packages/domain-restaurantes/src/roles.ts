// Mapeo de `restaurant_staff.role` (origen) -> `platformRole` (core-tenancy) +
// `verticalRole` (opaco, string). Ver diseño Fase 1 §1.1 para la justificación
// completa del mapeo.
export type RestaurantesRole = "owner" | "admin" | "staff" | "repartidor";
export const RESTAURANTES_ROLES: readonly RestaurantesRole[] = ["owner", "admin", "staff", "repartidor"];

// platformRole = techo común que core-auth entiende SIN saber nada de restaurantes.
// Mapeo elegido para preservar el comportamiento de hoy: solo owner/admin/staff
// pasan can_manage_restaurant() (gestión de catálogo/branches/customers/promos, ver
// 20260904065000_tenant_role_matrix.sql en el origen); repartidor tiene acceso
// acotado a SU propio pedido/perfil, nunca gestión — platformRole="member" para los
// 4, la distinción fina la hace SIEMPRE assertVerticalRole() con RESTAURANTES_ROLES,
// nunca platformRole (mismo principio ya documentado en core-tenancy/session.ts).
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<RestaurantesRole, "owner" | "admin" | "member"> = {
  owner: "owner",
  admin: "admin",
  staff: "member",
  repartidor: "member",
};

/** == can_manage_restaurant() del origen: gestión de catálogo/sucursales/clientes. */
export const MANAGER_ROLES: readonly RestaurantesRole[] = ["owner", "admin", "staff"];

/**
 * Fase 8 — el único verticalRole autorizado en las rutas `.../repartidor/*` (ver
 * apps/api/.../restaurantes/repartidor-orders.ts). Deliberadamente disjunto de
 * MANAGER_ROLES: un repartidor nunca gana acceso de gestión, y MANAGER_ROLES nunca
 * gana el acceso acotado-a-lo-propio de un repartidor (son dos superficies HTTP
 * distintas, cada una con su propio `assertVerticalRole`) — mismo principio que ya
 * documenta el comentario de cabecera de este archivo.
 */
export const REPARTIDOR_ROLES: readonly RestaurantesRole[] = ["repartidor"];

/**
 * Fase 10 — quién puede invitar staff nuevo (ver diseño del gap en
 * `packages/db/migrations/0002_staff_invite_schema.sql` y
 * `apps/api/src/routes/verticals/restaurantes/admin-staff.ts`): solo owner/admin,
 * NUNCA "staff" ni "repartidor" — deliberadamente más angosto que MANAGER_ROLES
 * (que sí incluye "staff" para gestión de catálogo/sucursales/clientes, una
 * superficie distinta y de menor riesgo que crear una cuenta con acceso al
 * negocio). El techo real de a QUIÉN puede invitar cada uno (ej. admin no puede
 * invitar a otro owner) lo resuelve `@atiende/core-authz::canInviteStaff` sobre el
 * `platformRole` mapeado — esta lista es solo el primer filtro (quién llega
 * siquiera a la ruta), mismo patrón de dos capas que MANAGER_ROLES/REPARTIDOR_ROLES.
 */
export const STAFF_INVITE_ROLES: readonly RestaurantesRole[] = ["owner", "admin"];

export function isRestaurantesRole(value: string): value is RestaurantesRole {
  return (RESTAURANTES_ROLES as readonly string[]).includes(value);
}

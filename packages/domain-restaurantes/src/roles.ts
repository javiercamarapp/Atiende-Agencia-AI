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

export function isRestaurantesRole(value: string): value is RestaurantesRole {
  return (RESTAURANTES_ROLES as readonly string[]).includes(value);
}

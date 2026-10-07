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

// ---------------------------------------------------------------------------
// PL-23 -- matriz de permisos POR ACCION (fuente unica). Hasta aqui el panel solo distinguia "gestor" (MANAGER_ROLES) de
// "owner/admin" (STAFF_INVITE_ROLES): un `staff` (cajero/cocina) podia cambiar precios, crear promociones y editar la sucursal.
// El dueño de PM (P-v2-53, valor por omision) quiere que solo el dueño y sus administradores cambien precios, promociones y
// datos de sucursal, y que el cajero solo marque agotado (P-v2-31). Cada ruta admin de catalogo/promociones/sucursales pide
// una ACCION de esta tabla en vez de una lista suelta de roles; la UI lee la misma tabla para ocultar lo que el servidor
// rechazaria. No se inventan roles: cajero/cocina/gerente siguen siendo `staff`/`admin`.
//
// Fail-closed: una accion que no esta en la tabla se niega a todos los roles (`rolesParaAccion` devuelve []), igual que un rol
// que no es de restaurantes (`puedeEjecutar` devuelve false).
// ---------------------------------------------------------------------------

const DUENO_Y_ADMIN: readonly RestaurantesRole[] = ["owner", "admin"];

export const ACCIONES_RESTAURANTES = {
  /** Ver el menu (categorias, productos y su estado en la sucursal). */
  "catalogo.ver": MANAGER_ROLES,
  /** Crear/editar producto o categoria, cambiar precio (base o por sucursal) y marcas del catalogo. */
  "catalogo.precio": DUENO_Y_ADMIN,
  /** Marcar un producto agotado / disponible EN UNA SUCURSAL (sin tocar precio). */
  "catalogo.disponibilidad": MANAGER_ROLES,
  /** Ver las promociones (incluye los codigos activos). */
  "promociones.ver": DUENO_Y_ADMIN,
  /** Crear, editar, activar o desactivar promociones. */
  "promociones.editar": DUENO_Y_ADMIN,
  /** Ver los datos de las sucursales (horario, direccion, contacto). */
  "sucursal.ver": MANAGER_ROLES,
  /** Editar datos de la sucursal (direccion, telefono, coordenadas, slug, orden). */
  "sucursal.editar": DUENO_Y_ADMIN,
  /** Pedidos: aceptar, avanzar, cancelar, asignar repartidor. Sin cambio respecto a MANAGER_ROLES. */
  "pedidos.gestionar": MANAGER_ROLES,
} as const satisfies Record<string, readonly RestaurantesRole[]>;

export type AccionRestaurantes = keyof typeof ACCIONES_RESTAURANTES;

export const ACCIONES_RESTAURANTES_LISTA = Object.keys(ACCIONES_RESTAURANTES) as readonly AccionRestaurantes[];

/** Roles autorizados para la accion; `[]` (nadie) si la accion no esta en la matriz (fail-closed). */
export function rolesParaAccion(accion: string): readonly RestaurantesRole[] {
  return Object.prototype.hasOwnProperty.call(ACCIONES_RESTAURANTES, accion) ? ACCIONES_RESTAURANTES[accion as AccionRestaurantes] : [];
}

/** `true` solo si el rol es de restaurantes Y esta en la matriz para la accion. */
export function puedeEjecutar(rol: string | null | undefined, accion: string): boolean {
  return typeof rol === "string" && (rolesParaAccion(accion) as readonly string[]).includes(rol);
}

/** Permisos efectivos de un rol: una entrada booleana por cada accion de la matriz (lo que lee el panel). */
export function permisosEfectivos(rol: string | null | undefined): Record<AccionRestaurantes, boolean> {
  const out = {} as Record<AccionRestaurantes, boolean>;
  for (const accion of ACCIONES_RESTAURANTES_LISTA) out[accion] = puedeEjecutar(rol, accion);
  return out;
}

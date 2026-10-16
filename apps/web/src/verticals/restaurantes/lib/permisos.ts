// PL-23 -- permisos por accion del panel de restaurantes. Copia DELIBERADA de `ACCIONES_RESTAURANTES` de
// packages/domain-restaurantes/src/roles.ts (la web no importa el paquete de dominio, mismo criterio que STAFF_NAV_ROLES en
// RestaurantesShell.tsx): solo oculta o explica en la UI lo que el servidor rechazaria con 403 (assertAccion en la API y las
// policies de la migracion 065 son el enforcement real). apps/web/tests/restaurantes-permisos-paridad.spec.ts falla si esta tabla
// se desincroniza de la del dominio.
export type AccionRestaurantes =
  | "catalogo.ver"
  | "catalogo.precio"
  | "catalogo.disponibilidad"
  | "promociones.ver"
  | "promociones.editar"
  | "sucursal.ver"
  | "sucursal.editar"
  | "pedidos.gestionar"
  | "cfo.ver"
  | "cfo.capturar"
  | "cfo.importar_sr"
  | "cfo.exportar";

const DUENO_Y_ADMIN: readonly string[] = ["owner", "admin"];
const GESTORES: readonly string[] = ["owner", "admin", "staff"];

export const ROLES_POR_ACCION: Readonly<Record<AccionRestaurantes, readonly string[]>> = {
  "catalogo.ver": GESTORES,
  "catalogo.precio": DUENO_Y_ADMIN,
  "catalogo.disponibilidad": GESTORES,
  "promociones.ver": DUENO_Y_ADMIN,
  "promociones.editar": DUENO_Y_ADMIN,
  "sucursal.ver": GESTORES,
  "sucursal.editar": DUENO_Y_ADMIN,
  "pedidos.gestionar": GESTORES,
  "cfo.ver": DUENO_Y_ADMIN,
  "cfo.capturar": DUENO_Y_ADMIN,
  "cfo.importar_sr": DUENO_Y_ADMIN,
  "cfo.exportar": DUENO_Y_ADMIN,
};

/** `true` solo si el rol esta en la matriz para la accion (rol desconocido o ausente -> false). */
export function puedeEn(rol: string | null | undefined, accion: AccionRestaurantes): boolean {
  return typeof rol === "string" && ROLES_POR_ACCION[accion].includes(rol);
}

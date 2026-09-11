// Mapeo de `RolUsuario` + `ColaboradorNivel` (origen) -> `platformRole` (core-tenancy)
// + `verticalRole` (opaco, string). Ver diseño Fase 1 §2.2 para la justificación
// completa del mapeo — es una decisión de ESTE paquete, no algo que
// core-auth/core-tenancy ya resolvían (mismo patrón que domain-hoteles::HOTEL_ROLES).
//
// `superadmin`/`propietario` (owner externo, no-staff) quedan explícitamente fuera de
// fase — ver diseño §2.2 y §6: superadmin depende de
// feat/fusion-superadmin-impersonacion, propietario no encaja en `core.membership`
// (modelo N:M owner↔empresa_gestora).
export const RENTAS_VERTICAL_ROLES = [
  "admin_gestora",
  "operador:acceso_total",
  "operador:calendario_mensajeria",
  "operador:solo_calendario",
  "contador",
  "limpieza",
] as const;

export type RentasVerticalRole = (typeof RENTAS_VERTICAL_ROLES)[number];

export function isRentasVerticalRole(value: string): value is RentasVerticalRole {
  return (RENTAS_VERTICAL_ROLES as readonly string[]).includes(value);
}

// Espejo de app, a nivel de aplicación, de la misma regla `puedeEscribirCalendario`
// del origen — la autoridad final sigue siendo la RLS real (core.has_property_access +
// el chequeo fino de rol en la ruta): si este espejo se desincroniza, la peor
// consecuencia es un 403 de más, nunca un acceso de más.
export const ESCRITURA_CALENDARIO_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total", "operador:calendario_mensajeria"];

// Cancelar exige el nivel más alto (equivalente a H-018 del origen: "cancelar es una
// acción irreversible desde la perspectiva del huésped").
export const CANCELAR_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "operador:acceso_total"];

// Finanzas: solo admin_gestora escribe movimiento; contador es solo-lectura (mismo
// criterio que ROLES_ADMIN/ROLES_ADMIN_CONTADOR del origen).
export const FINANZAS_ESCRITURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora"];
export const FINANZAS_LECTURA_ROLES: readonly RentasVerticalRole[] = ["admin_gestora", "contador"];

/**
 * platformRole = techo común que core-auth entiende SIN saber nada de rentas. La
 * distinción fina la hace SIEMPRE `assertVerticalRole()` con RENTAS_VERTICAL_ROLES,
 * nunca `platformRole` — mismo principio que domain-hoteles::PLATFORM_ROLE_BY_VERTICAL_ROLE.
 */
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<RentasVerticalRole, "owner" | "admin" | "member" | "viewer"> = {
  admin_gestora: "owner",
  "operador:acceso_total": "member",
  "operador:calendario_mensajeria": "member",
  "operador:solo_calendario": "member",
  contador: "viewer",
  limpieza: "member",
};

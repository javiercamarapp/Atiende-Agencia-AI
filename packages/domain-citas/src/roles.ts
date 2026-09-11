// Mapeo de `tenant_staff.role` (origen) -> `platformRole` (core-tenancy) +
// `verticalRole` (opaco, string) — mismo patrón que domain-restaurantes/src/roles.ts.
// `tenant_staff.role` es plano en el origen: owner|admin|staff (3 valores) — igual de
// plano que restaurantes, NO como hoteles (8 roles finos). Ver diseño Fase 1 §4/§0.6.
export type CitasRole = "owner" | "admin" | "staff";
export const CITAS_ROLES: readonly CitasRole[] = ["owner", "admin", "staff"];

// platformRole = techo común que core-auth entiende SIN saber nada de citas. El
// origen no distingue permisos finos por acción (`is_tenant_staff()` no filtra por
// rol para ninguna operación de agenda) — a diferencia de hoteles,
// `assertVerticalRole()` NO se necesita para ninguno de los 3 flujos de esta fase,
// porque el origen mismo no restringe por rol quién cancela/reagenda/ve
// recordatorios desde el panel (ver diseño Fase 1 §4, documentado explícitamente
// para que quien construya no agregue una restricción que el origen no tiene).
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<CitasRole, "owner" | "admin" | "member"> = {
  owner: "owner",
  admin: "admin",
  staff: "member",
};

export function isCitasRole(value: string): value is CitasRole {
  return (CITAS_ROLES as readonly string[]).includes(value);
}

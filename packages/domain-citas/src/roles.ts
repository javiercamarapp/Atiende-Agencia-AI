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

/**
 * Hallazgo de auditoría (CRÍTICO/ALTO): los 3 roles de arriba y
 * `PLATFORM_ROLE_BY_VERTICAL_ROLE` se definieron en Fase 1 pero nunca se
 * consumieron en NINGUNA capa — ni un solo import fuera de este archivo (a
 * diferencia de domain-restaurantes/domain-hoteles/domain-rentas/domain-licitaciones/
 * domain-despachos, donde al menos el alta de staff los usa). No existía ninguna
 * ruta capaz de PRODUCIR una fila `core.membership` para citas (alta de
 * organización/staff quedaba fuera de las 11 fases construidas) — el modelo de 2
 * capas (platformRole+verticalRole) estaba en el papel, sin ningún flujo real que
 * lo alimentara.
 *
 * Mismo patrón EXACTO que `STAFF_INVITE_ROLES` de domain-restaurantes/src/roles.ts
 * (única vertical con esto ya construido, ver apps/api/src/routes/verticals/
 * restaurantes/admin-staff.ts): quién puede invitar staff nuevo. Solo owner/admin —
 * "staff" nunca puede dar de alta a otro miembro, aunque sí pueda operar el resto
 * del panel (roles.ts documenta arriba que el origen no distingue rol para
 * cancelar/reagendar/etc. — invitar acceso nuevo es una superficie de mayor riesgo,
 * deliberadamente más angosta). El techo real de a quién puede invitar cada uno
 * (ej. admin no puede invitar a otro owner) lo resuelve
 * `@atiende/core-authz::canInviteStaff` sobre el `platformRole` ya mapeado arriba —
 * esta lista es solo el primer filtro (quién llega siquiera a la ruta).
 */
export const STAFF_INVITE_ROLES: readonly CitasRole[] = ["owner", "admin"];

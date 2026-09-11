// Port literal de licitaciones/packages/db/src/roles.ts (OrgRole/WRITE_ROLES/
// DECISION_ROLES) — mismo patrón que domain-hoteles/src/roles.ts y
// domain-restaurantes/src/roles.ts (ver diseño Fase 1 §2.3). A diferencia de
// hoteles (8 roles operativos por área), licitaciones tiene un enum PLANO de
// 6 roles a nivel de organización completa — mismo criterio incluso más
// plano que restaurantes.
export const LICITACIONES_ROLES = ["owner", "admin", "analyst", "writer", "reviewer", "viewer"] as const;
export type LicitacionesRole = (typeof LICITACIONES_ROLES)[number];

export function isLicitacionesRole(value: string): value is LicitacionesRole {
  return (LICITACIONES_ROLES as readonly string[]).includes(value);
}

// Port literal de licitaciones/packages/db/src/roles.ts::WRITE_ROLES.
export const WRITE_ROLES: readonly LicitacionesRole[] = ["owner", "admin", "analyst", "writer", "reviewer"];

// Mirror de licitaciones/schema.sql (decision_roles, migración de roles de
// aprobación 0016+): aprobar el expediente completo (scope "expediente") y
// aprobar una tarifa son decisiones, no redacción — un subconjunto más
// estricto que WRITE_ROLES.
export const DECISION_ROLES: readonly LicitacionesRole[] = ["owner", "admin", "analyst"];

/**
 * platformRole = techo común que core-auth entiende sin saber nada de
 * licitaciones. owner->owner, admin->admin, analyst/writer/reviewer->member
 * (todos con capacidad de escritura fina, pero ninguno es dueño/segundo al
 * mando de la organización), viewer->viewer. La distinción fina la hace
 * SIEMPRE `assertVerticalRole()` con LICITACIONES_ROLES, nunca `platformRole`.
 */
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<LicitacionesRole, "owner" | "admin" | "member" | "viewer"> = {
  owner: "owner",
  admin: "admin",
  analyst: "member",
  writer: "member",
  reviewer: "member",
  viewer: "viewer",
};

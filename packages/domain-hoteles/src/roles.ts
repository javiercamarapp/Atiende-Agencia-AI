// Mapeo de `hotel_staff.role` (origen, 8 valores finos) -> `platformRole`
// (core-tenancy) + `verticalRole` (opaco, string). Ver diseño Fase 1 §2 para la
// justificación completa del mapeo — es una decisión de ESTE paquete, no algo que
// core-auth/core-tenancy ya resolvían (a diferencia de restaurantes, cuyo rol de
// origen es más plano).
export const HOTEL_ROLES = [
  "owner",
  "gm",
  "frontdesk",
  "reservations",
  "housekeeping",
  "maintenance",
  "fnb",
  "accountant",
] as const;

export type HotelRole = (typeof HOTEL_ROLES)[number];

export function isHotelRole(value: string): value is HotelRole {
  return (HOTEL_ROLES as readonly string[]).includes(value);
}

// Espejo de app, a nivel de aplicación, de las mismas reglas que hoy vive en la RLS
// real de `hoteles.can_access_money()` (ver migrations/001_hoteles_schema.sql) — la
// autoridad final SIGUE SIENDO la RLS: si este espejo se desincroniza, la peor
// consecuencia es un 403 de más, nunca un acceso de más.
export const MONEY_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations", "fnb", "accountant"];
export const ADMIN_ROLES: readonly HotelRole[] = ["owner", "gm"];

// Fase 3 (H02) — quién puede crear/leer una reserva y ejecutar transiciones genéricas
// del ciclo de vida (check-in/en_estancia/check-out/cerrada) y cancelar. Distinto de
// MONEY_ROLES (housekeeping/maintenance nunca aparecen aquí tampoco, pero `fnb`/
// `accountant` sí tienen acceso a dinero sin poder mover una reserva) — la lista fina
// por transición real vive en reservationStateMachine.ts::rolesAllowedForTransition.
export const MANAGE_RESERVATIONS_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "reservations"];

// Quién puede TOMAR un pedido de F&B (recepción suele tomarlo por teléfono/WhatsApp
// hasta que exista el canal real de REQ-AB-002; F&B y dirección también pueden).
export const TOMAR_PEDIDO_ROLES: readonly HotelRole[] = ["owner", "gm", "frontdesk", "fnb"];
// Quién puede confirmar que la cocina revisó el platillo, o afirmar seguridad al
// huésped en su nombre — deliberadamente MÁS estricto que tomar el pedido: nunca
// frontdesk.
export const CONFIRMAR_COCINA_ROLES: readonly HotelRole[] = ["owner", "gm", "fnb"];

/**
 * platformRole = techo común que core-auth entiende SIN saber nada de hoteles.
 * owner->owner, gm->admin (segundo al mando, gestiona todo salvo lo reservado al
 * dueño), el resto de los 6 roles operativos ->member. La distinción fina la hace
 * SIEMPRE `assertVerticalRole()` con HOTEL_ROLES, nunca `platformRole` — mismo
 * principio ya documentado en core-tenancy/session.ts y aplicado por
 * domain-restaurantes/src/roles.ts.
 */
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<HotelRole, "owner" | "admin" | "member"> = {
  owner: "owner",
  gm: "admin",
  frontdesk: "member",
  reservations: "member",
  housekeeping: "member",
  maintenance: "member",
  fnb: "member",
  accountant: "member",
};

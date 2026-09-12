// Roles del vertical despachos — puerto de `b2b_ai/features/roles` (RBAC en
// diccionario en memoria en el origen, ver comentario de ese módulo: "El store en
// memoria es la iteración del piloto; la persistencia real (PostgreSQL) queda como
// siguiente iteración"). Fase 1 aterriza ESA persistencia real (core.membership +
// RLS), pero solo con los 4 roles builtin fijos que el origen ya definía — roles
// custom por tenant quedan fuera de alcance, igual que hoteles/restaurantes no los
// tienen todavía (ver diseño Fase 1 §4, "Explícitamente FUERA de Fase 1").
export const DESPACHOS_ROLES = ["admin", "contador", "auditor", "readonly"] as const;

export type DespachosRole = (typeof DESPACHOS_ROLES)[number];

export function isDespachosRole(value: string): value is DespachosRole {
  return (DESPACHOS_ROLES as readonly string[]).includes(value);
}

/** Quién puede resolver la cola de revisión humana (aprobar/rechazar un CFDI marcado
 * `requiresHumanReview`) — nunca `readonly`, y deliberadamente sin `auditor` (auditor
 * VE pero no decide, mismo criterio de separación de funciones que ya aplica
 * `CONFIRMAR_COCINA_ROLES` en domain-hoteles: quien declara/ejecuta no es
 * necesariamente quien puede cerrar el caso). */
export const RESOLVER_REVISION_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede ingestar/validar un CFDI nuevo. */
export const INGESTA_CFDI_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede gestionar vencimientos fiscales (crear/marcar completado/escalar). */
export const GESTION_VENCIMIENTOS_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede calcular declaraciones (ISR de honorarios/PM/RESICO, agregación DIOT)
 * — Fase 4: mismo criterio que INGESTA_CFDI_ROLES/GESTION_VENCIMIENTOS_ROLES, son los
 * mismos operadores que preparan las obligaciones fiscales del cliente; `auditor`/
 * `readonly` ven el resultado ya persistido (invoice.diot vía GET /cfdi) pero no
 * ejecutan el cálculo/agregación en vivo. */
export const DECLARACIONES_ROLES: readonly DespachosRole[] = ["admin", "contador"];

/** Quién puede calcular nómina (Fase 4) — mismo criterio que DECLARACIONES_ROLES. */
export const NOMINA_ROLES: readonly DespachosRole[] = ["admin", "contador"];

export const ADMIN_ROLES: readonly DespachosRole[] = ["admin"];

/**
 * platformRole = techo común que core-auth entiende sin conocer despachos.
 * admin->owner (dueño del despacho), contador->admin (opera el día a día),
 * auditor/readonly->viewer (solo lectura, distinción fina vive en verticalRole).
 * Mismo principio que PLATFORM_ROLE_BY_VERTICAL_ROLE de domain-hoteles/domain-
 * restaurantes.
 */
export const PLATFORM_ROLE_BY_VERTICAL_ROLE: Record<DespachosRole, "owner" | "admin" | "viewer"> = {
  admin: "owner",
  contador: "admin",
  auditor: "viewer",
  readonly: "viewer",
};

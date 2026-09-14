// ═══════════════════════════════════════════════════════════════════════════
// JERARQUÍA DE ROL + FEATURE-GATING — generalización de
// atiende-ai/src/lib/auth/current-staff.ts (ROLE_HIERARCHY/hasRole/
// PLAN_FEATURES/hasFeature), adaptado al `PlatformRole` que YA define
// packages/core-tenancy/src/types.ts (owner/admin/member/viewer) en vez de
// reinventar un modelo de rol paralelo — core-authz consume ese techo común,
// nunca lo redefine (mismo principio que dice el comentario de PlatformRole:
// "el rol fino... sigue viviendo en el paquete de dominio correspondiente").
//
// FEATURE-GATING queda DESACOPLADO de dónde vive el plan (packages/billing,
// fase aparte — ver el comentario de `Organization` en core-tenancy/types.ts:
// "Campos de plan/facturación deliberadamente AUSENTES"). En vez de leer
// `staff.plan` como hacía current-staff.ts, `hasFeature` recibe un
// `ReadonlySet<string>` YA resuelto — el mismo patrón de inyección que
// `TenancyEngine` en core-auth: quien arma la app decide de dónde sale ese
// set (hoy: un caller de packages/billing), core-authz solo aplica la regla.
// ═══════════════════════════════════════════════════════════════════════════
import type { PlatformRole } from "@atiende/core-tenancy";
import { PLATFORM_ROLES } from "@atiende/core-tenancy";

/** Igual estructura que ROLE_HIERARCHY en current-staff.ts, con los 4 roles de
 * PLATAFORMA de core-tenancy en vez de los 4 propios de atiende-ai (owner/
 * admin/doctor/receptionist). Orden: a mayor número, más alcance. */
export const PLATFORM_ROLE_HIERARCHY: Readonly<Record<PlatformRole, number>> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

/** Sanity check en tiempo de carga: todo PlatformRole declarado en
 * core-tenancy tiene una entrada aquí — si core-tenancy agrega un rol nuevo
 * sin que esta tabla se actualice, esto explota en desarrollo en vez de
 * fallar en silencio (`PLATFORM_ROLE_HIERARCHY[rolNuevo]` -> `undefined` ->
 * comparaciones siempre falsas -> fail-closed silencioso, el peor tipo de bug). */
for (const role of PLATFORM_ROLES) {
  if (!(role in PLATFORM_ROLE_HIERARCHY)) {
    throw new Error(`[core-authz] falta "${role}" en PLATFORM_ROLE_HIERARCHY — actualiza roles.ts.`);
  }
}

/** Igual que `hasRole(staff, required)` en current-staff.ts: `role` alcanza
 * si su nivel es >= al de `required`. Ej.: `hasPlatformRole("owner","admin")`
 * -> true; `hasPlatformRole("member","admin")` -> false. */
export function hasPlatformRole(role: PlatformRole, required: PlatformRole): boolean {
  return PLATFORM_ROLE_HIERARCHY[role] >= PLATFORM_ROLE_HIERARCHY[required];
}

/** Variante por lista explícita (no por jerarquía) — para acciones que
 * conceden a un subconjunto no-contiguo, ej. ["owner","viewer"] (auditor de
 * solo lectura). Mismo criterio que `allowedRoles` en
 * `requirePropertyMembership` de core-auth. */
export function hasAnyPlatformRole(role: PlatformRole, allowed: readonly PlatformRole[]): boolean {
  return allowed.includes(role);
}

/**
 * Regla genérica de "quién puede invitar a quién" (Fase 10 — mecanismo de alta de
 * staff, ver `@atiende/db::CoreStaffRepository`), compartida por las 6 verticales:
 * solo owner/admin invitan (nunca member/viewer, sin importar lo que el
 * `verticalRole` concreto de cada dominio permita gestionar — ese filtro más fino
 * vive en el propio `domain-<vertical>`, ej. `STAFF_INVITE_ROLES` de
 * `domain-restaurantes/src/roles.ts`), y nadie puede invitar a un `platformRole` de
 * jerarquía MAYOR que el propio (un admin nunca da de alta a otro owner) — mismo
 * principio de "nunca ensanchar el alcance de quien invita" que ya aplica
 * `resolveEffectivePropertyIds` en las rutas admin de restaurantes.
 */
export function canInviteStaff(inviterRole: PlatformRole, targetRole: PlatformRole): boolean {
  return hasPlatformRole(inviterRole, "admin") && PLATFORM_ROLE_HIERARCHY[inviterRole] >= PLATFORM_ROLE_HIERARCHY[targetRole];
}

/** Se lanza cuando la ORGANIZACIÓN no tiene la feature contratada — distinto
 * de `InsufficientPlatformRoleError` (core-tenancy): ahí el rol no alcanza,
 * aquí el rol SÍ alcanza pero el plan no incluye la feature. Separar los dos
 * casos importa para el mensaje que ve el usuario ("pide que te den admin"
 * vs. "mejora tu plan") y es el mismo criterio de current-staff.ts, que
 * nunca confunde `hasRole` con `hasFeature`. */
export class FeatureNotAvailableError extends Error {
  readonly feature: string;
  readonly code = "feature_not_available";

  constructor(feature: string) {
    super(`la feature "${feature}" no está disponible en el plan de esta organización.`);
    this.name = "FeatureNotAvailableError";
    this.feature = feature;
  }
}

/**
 * Igual regla que `hasFeature(staff, feature)` de current-staff.ts:
 * `features` es el set YA resuelto de features activas de la organización
 * (billing decide su contenido; trial = todas, plan pagado = su subset,
 * `cancelled` = set vacío — mismos tres casos que `PLAN_FEATURES` allá).
 * `undefined`/`null` (billing no resolvió nada todavía) fail-closed a `false`,
 * nunca a `true` — una feature no resuelta no está disponible.
 */
export function hasFeature(features: ReadonlySet<string> | undefined | null, feature: string): boolean {
  return features?.has(feature) ?? false;
}

/** Lanza `FeatureNotAvailableError` si `hasFeature` es falso — para guardas
 * de handler, mismo estilo que `assertPropertyAccess`/`assertPlatformRole` de
 * core-tenancy/session.ts (siempre fail-closed, nunca degradan en silencio). */
export function requireFeature(features: ReadonlySet<string> | undefined | null, feature: string): void {
  if (!hasFeature(features, feature)) {
    throw new FeatureNotAvailableError(feature);
  }
}

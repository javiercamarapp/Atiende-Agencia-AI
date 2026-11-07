// Regla unica de "organizacion operable" (onboarding P0): una organizacion opera si esta 'active' o en prueba ('trial'), con o sin
// trial_ends_at y aunque esa fecha ya haya pasado. 'suspended' nunca.
//
// Antes, domain-citas (findOrganizationBySlug) y domain-licitaciones (listActiveOrganizations) solo aceptaban 'active': como toda
// organizacion nueva nace 'trial', un cliente en prueba recibia 404 en citas y no recibia convocatorias en licitaciones.
//
// Por que la fecha NO cuenta: no hay apagado automatico al terminar la prueba. Al vencer, la migracion 0072 solo avisa (al dueno por
// correo e in-app, y a superadmin); el pago la pasa a 'active' y suspender sigue siendo una decision humana (0038). La regla no lee
// trial_ends_at, asi que funciona igual contra una base sin la 0046.

function prefijo(alias: string | undefined): string {
  return alias ? `${alias}.` : "";
}

/** Predicado SQL (entre parentesis) sobre core.organization. `alias` = alias de la tabla en la consulta, si lo hay. */
export function sqlOrgOperable(alias?: string): string {
  return `(${prefijo(alias)}status in ('active', 'trial'))`;
}

/** Misma regla en TypeScript (dobles en memoria y pruebas). La fecha de fin de prueba no la cambia. */
export function organizacionOperable(org: { readonly status: string; readonly trialEndsAt?: string | Date | null }): boolean {
  return org.status === "active" || org.status === "trial";
}

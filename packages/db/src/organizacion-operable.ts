// Regla unica de "organizacion operable" (onboarding P0): una organizacion opera si esta 'active', o si esta en prueba ('trial') y su prueba
// sigue vigente (trial_ends_at futuro; sin fecha = prueba vigente, el caso de las cuentas anteriores a la migracion 0072). 'suspended' nunca.
//
// Antes, domain-citas (findOrganizationBySlug) y domain-licitaciones (listActiveOrganizations) solo aceptaban 'active': como toda
// organizacion nueva nace 'trial', un cliente en prueba recibia 404 en citas y no recibia convocatorias en licitaciones.
//
// `trial_ends_at` es de la migracion 0046. Contra una base sin ella (SQLSTATE 42703) los repositorios usan la variante SIN fecha dentro de un
// SAVEPOINT (runWithSavepointFallback): 'trial' cuenta como operable.

function prefijo(alias: string | undefined): string {
  return alias ? `${alias}.` : "";
}

/** Predicado SQL (entre parentesis) sobre core.organization. `alias` = alias de la tabla en la consulta, si lo hay. */
export function sqlOrgOperable(alias?: string): string {
  const p = prefijo(alias);
  return `(${p}status = 'active' or (${p}status = 'trial' and (${p}trial_ends_at is null or ${p}trial_ends_at > now())))`;
}

/** Variante para una base sin la 0046 (sin columna trial_ends_at). */
export function sqlOrgOperableSinFecha(alias?: string): string {
  return `(${prefijo(alias)}status in ('active', 'trial'))`;
}

/** Misma regla en TypeScript (dobles en memoria y pruebas). */
export function organizacionOperable(org: { readonly status: string; readonly trialEndsAt?: string | Date | null }, ahora: Date = new Date()): boolean {
  if (org.status === "active") return true;
  if (org.status !== "trial") return false;
  if (org.trialEndsAt === undefined || org.trialEndsAt === null) return true;
  const fin = org.trialEndsAt instanceof Date ? org.trialEndsAt.getTime() : Date.parse(org.trialEndsAt);
  return Number.isNaN(fin) ? true : fin > ahora.getTime();
}

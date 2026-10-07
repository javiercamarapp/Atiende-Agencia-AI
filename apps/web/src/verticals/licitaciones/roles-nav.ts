// Roles de la consola de licitaciones que ven las entradas administrativas del menú. Vive en un módulo
// propio (sin React ni componentes) para que App.tsx pueda decidir qué mostrar sin importar de forma
// estática LicitacionesShell: así el shell queda en su propio chunk y no engorda la carga inicial (R-37).

export const STAFF_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/** L-20: la privacidad de la organización (ARCO, retención, aviso) es solo de owner/admin: mismo umbral que exige el servidor
 * (`/v1/privacidad/*` responde 403 al resto). Cosmético: oculta la entrada del menú y evita la llamada; nunca la única barrera. */
export function puedeVerPrivacidad(role: string): boolean {
  return STAFF_NAV_ROLES.has(role);
}

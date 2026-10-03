// R-19/R-20 -- organizacion DEMO. Tipos compartidos por el widget publico de chat, el seed de volumen y la limpieza.

/** Rango RESERVADO de telefonos ficticios (lada 000: no existe en Mexico). El seed de volumen usa `0001xxxxxx` y las
 * sesiones del widget publico `0009xxxxxx`; la funcion SQL `restaurantes.demo_limpiar` (migracion 037) borra por este
 * mismo prefijo, asi que NUNCA se mezcla con una persona real. */
export const DEMO_PHONE_PREFIX_VOLUME = "0001";
export const DEMO_PHONE_PREFIX_WIDGET = "0009";

/** Telefono de 12 digitos con lada de pais (forma que `canonicalizeMexicanPhone` acepta): `+52` + prefijo + 6 digitos. */
export function demoPhone(prefix: typeof DEMO_PHONE_PREFIX_VOLUME | typeof DEMO_PHONE_PREFIX_WIDGET, sixDigits: number): string {
  if (!Number.isInteger(sixDigits) || sixDigits < 0 || sixDigits > 999_999) throw new RangeError("demoPhone: el sufijo debe ser un entero de 0 a 999999");
  return `+52${prefix}${String(sixDigits).padStart(6, "0")}`;
}

/** Sucursal con la que abre el chat de la demo: T7 Garcia Lavin, la FASE 1 del agente (decision de Javier del 2-oct-2026). Debe ser la misma que
 * el perfil de volumen `t7` (`DEMO_PERFIL_T7.sucursal`; una prueba lo vigila). */
export const DEMO_SUCURSAL_PREDETERMINADA = "garcia-lavin";

/** Slug de la sucursal predeterminada SOLO si esta entre las sucursales activas que el widget ofrece; si no, null (numero general). */
export function sucursalPredeterminadaDemo(sucursales: ReadonlyArray<{ readonly slug: string }>): string | null {
  return sucursales.some((s) => s.slug === DEMO_SUCURSAL_PREDETERMINADA) ? DEMO_SUCURSAL_PREDETERMINADA : null;
}

export function esTelefonoDemo(phone: string): boolean {
  const digits = phone.replace(/\D/g, "").slice(-10);
  return digits.startsWith(DEMO_PHONE_PREFIX_VOLUME) || digits.startsWith(DEMO_PHONE_PREFIX_WIDGET);
}

export interface DemoOrganizationInfo {
  readonly organizationId: string;
  readonly seedVersion: string;
  /** `false` = el operador apago el widget publico de esta demo (migracion 037). */
  readonly activo: boolean;
}

/** Puerto de lectura de la marca demo (`restaurantes.demo_organization`, migracion 037). Contra una base sin la
 * migracion devuelve `null` ("esta organizacion no es demo"): nunca lanza por falta de migracion. */
export interface DemoRepository {
  findDemoOrganization(organizationId: string): Promise<DemoOrganizationInfo | null>;
}

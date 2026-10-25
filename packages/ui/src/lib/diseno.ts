/**
 * Bandera del diseno nuevo (ds3). Se lee UNA sola vez, al cargar el modulo, y no cambia durante la sesion.
 *
 * Fuentes, en orden:
 *  1. `html.dataset.diseno === "ds3"`: lo pone `/theme-boot.js` antes del primer pintado (a partir de `?diseno=ds3` o de
 *     `localStorage["atiende-diseno"]`) y lo repite `ThemeBoot`. Con `?diseno=off` el atributo no existe.
 *  2. Valor de build `VITE_DISENO_DEFAULT`: vacio (lo normal hoy) = diseno actual; `ds3` lo enciende por defecto.
 *
 * Uso: `if (DISENO_DS3) { ...rama nueva... }` solo en las pocas ramas estructurales de JS autorizadas; el resto del
 * cambio visual va por CSS bajo `html[data-diseno="ds3"]`. Cada referencia nueva sube el trinquete
 * `apps/web/tests/diseno-bandera-baseline.spec.ts` (el numero solo puede bajar).
 */
import { VALOR_DISENO } from "./tema.js";

type EntornoVite = { env?: { VITE_DISENO_DEFAULT?: string } };

/** Valor de build (`VITE_DISENO_DEFAULT`), recortado; cadena vacia si no existe. */
export function disenoPorDefecto(): string {
  return ((import.meta as unknown as EntornoVite).env?.VITE_DISENO_DEFAULT ?? "").trim();
}

/** Regla pura: atributo de <html> primero; si no, el valor de build. Solo `ds3` enciende la bandera. */
export function resolverDisenoDs3(atributo: string | undefined, porDefecto: string): boolean {
  return atributo === VALOR_DISENO || porDefecto.trim() === VALOR_DISENO;
}

/** Lee la bandera ahora mismo. Sin `document` (SSR, pruebas en node) solo cuenta el valor de build. */
export function leerDisenoDs3(): boolean {
  const atributo = typeof document === "undefined" ? undefined : document.documentElement.dataset.diseno;
  return resolverDisenoDs3(atributo, disenoPorDefecto());
}

export const DISENO_DS3: boolean = leerDisenoDs3();

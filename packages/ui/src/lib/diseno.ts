/**
 * Diseno nuevo (ds3): es el de todos (organizaciones, superadmin, paginas publicas y de acceso). `DISENO_DS3` vale `true` salvo
 * con el interruptor de emergencia de build `VITE_DISENO_LEGADO=1` (apagado por omision; se retira junto con el diseno
 * anterior). El mismo valor de build inyecta <meta name="atiende-diseno-legado"> para que /theme-boot.js no ponga
 * `html[data-diseno="ds3"]`, asi el CSS y las ramas de JS coinciden siempre.
 *
 * Cada referencia a `DISENO_DS3` cuenta en el trinquete `apps/web/tests/diseno-bandera-baseline.spec.ts` (solo puede bajar).
 */
type EntornoVite = { env?: { VITE_DISENO_LEGADO?: string } };

/** Interruptor de emergencia: solo el valor exacto «1» (recortado) vuelve al diseno anterior. */
export function disenoLegadoActivo(valor: string | undefined = (import.meta as unknown as EntornoVite).env?.VITE_DISENO_LEGADO): boolean {
  return (valor ?? "").trim() === "1";
}

/** `true` (diseno nuevo) salvo con el interruptor de emergencia. */
export function leerDisenoDs3(): boolean {
  return !disenoLegadoActivo();
}

export const DISENO_DS3: boolean = leerDisenoDs3();

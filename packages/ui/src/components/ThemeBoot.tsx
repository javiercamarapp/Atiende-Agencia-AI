import { useEffect } from "react";
import { aplicarBanderaDiseno, aplicarTema, leerTema, suscribirTemaSistema } from "../lib/tema.js";

/**
 * Con la bandera de diseno `ds3` encendida garantiza el tema en TODAS las rutas (login, publicas), incluso fuera de cualquier
 * shell. El primer pintado ya lo resolvio `/theme-boot.js`; esto lo repite de forma idempotente (por si el script no corrio) y
 * sigue al sistema cuando la persona eligio «sistema». Con la bandera apagada no hace nada. No renderiza nada.
 */
export function ThemeBoot() {
  useEffect(() => {
    if (!aplicarBanderaDiseno()) return undefined;
    aplicarTema(leerTema());
    return suscribirTemaSistema();
  }, []);
  return null;
}

/** Aplica el tema guardado mientras la pantalla esta montada, sin importar la bandera (rutas fuera de todo shell, p. ej. el repartidor). */
export function useTemaGlobal(): void {
  useEffect(() => {
    aplicarTema(leerTema());
    return suscribirTemaSistema();
  }, []);
}

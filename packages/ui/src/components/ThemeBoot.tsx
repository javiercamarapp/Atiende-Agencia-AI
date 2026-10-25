import { useEffect } from "react";
import { aplicarBanderaDiseno, aplicarTema, leerTema, suscribirTemaSistema } from "../lib/tema.js";

/**
 * Garantiza el tema en TODAS las rutas (login, publicas, /repartidor), incluso fuera de cualquier shell. El primer pintado
 * ya lo resolvio `/theme-boot.js`; esto lo repite de forma idempotente (por si el script no corrio) y sigue al sistema
 * cuando la persona eligio «sistema». No renderiza nada.
 */
export function ThemeBoot() {
  useEffect(() => {
    aplicarTema(leerTema());
    aplicarBanderaDiseno();
    return suscribirTemaSistema();
  }, []);
  return null;
}

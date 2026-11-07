import { useEffect } from "react";
import { gobernarArranque } from "../lib/arranque";

/**
 * Monta el gobierno de la capa de arranque (`#arranque` de index.html; reglas en `lib/arranque`). Solo actua si la capa se pinta
 * (la hoja ds3 la muestra): sin ella (diseno actual) no observa nada ni toca <html>. No renderiza nada.
 */
export function CapaArranque() {
  useEffect(() => {
    const capa = document.getElementById("arranque");
    const raiz = document.documentElement;
    if (!capa || window.getComputedStyle(capa).display === "none") return undefined;
    return gobernarArranque({ raiz, documento: document, ruta: () => window.location.pathname });
  }, []);
  return null;
}

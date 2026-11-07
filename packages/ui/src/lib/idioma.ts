/**
 * Preferencia de idioma de la interfaz (ES/EN). Solo la GUARDA y la anuncia: hoy la consola esta en espanol y los catalogos de
 * traduccion son de otro carril (i18n). El selector del pie del sidebar (ds3) escribe aqui; quien traduzca escucha
 * `IDIOMA_CAMBIO_EVENTO` o lee `leerIdioma()`. Orden de resolucion: `?lang=` -> localStorage -> "es".
 * El login ya resuelve su idioma con `?lang=en`: misma convencion.
 */
export type Idioma = "es" | "en";

export const IDIOMAS: readonly Idioma[] = ["es", "en"];
export const CLAVE_IDIOMA = "atiende-idioma";
export const IDIOMA_CAMBIO_EVENTO = "atiende:idioma:cambio";

function esIdioma(valor: unknown): valor is Idioma {
  return valor === "es" || valor === "en";
}

/** Idioma preferido ahora mismo. Sin `window` (pruebas en node) devuelve "es". */
export function leerIdioma(): Idioma {
  if (typeof window === "undefined") return "es";
  try {
    const consulta = new URLSearchParams(window.location.search).get("lang");
    if (esIdioma(consulta)) return consulta;
  } catch {
    // URL ilegible: se sigue con lo guardado.
  }
  try {
    const guardado = window.localStorage.getItem(CLAVE_IDIOMA);
    if (esIdioma(guardado)) return guardado;
  } catch {
    // Sin almacenamiento (modo privado): se queda el valor por omision.
  }
  return "es";
}

/** Guarda la preferencia y la anuncia (`CustomEvent<Idioma>` en `window`). */
export function guardarIdioma(idioma: Idioma): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CLAVE_IDIOMA, idioma);
  } catch {
    // La preferencia solo dura esta pestana.
  }
  window.dispatchEvent(new CustomEvent<Idioma>(IDIOMA_CAMBIO_EVENTO, { detail: idioma }));
}

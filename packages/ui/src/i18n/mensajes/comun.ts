import { definirModulo } from "../tipos.ts";

/** Textos transversales (estados, acciones genericas, idioma). Ingles natural de producto, no calco del espanol. */
export const comun = definirModulo({
  es: {
    "comun.idioma.etiqueta": "Idioma de la interfaz",
    "comun.idioma.es": "Español (ES)",
    "comun.idioma.en": "English (EN)",
    "comun.cargando": "Cargando…",
    "comun.reintentar": "Reintentar",
    "comun.cancelar": "Cancelar",
    "comun.guardar": "Guardar",
    "comun.cerrar": "Cerrar",
    "comun.confirmar": "Confirmar",
    "comun.error.generico": "Algo salió mal. Inténtalo de nuevo.",
    "comun.sinDatos": "Sin datos aún",
    "comun.resultados": { one: "{count} resultado", other: "{count} resultados" },
  },
  en: {
    "comun.idioma.etiqueta": "Interface language",
    "comun.idioma.es": "Español (ES)",
    "comun.idioma.en": "English (EN)",
    "comun.cargando": "Loading…",
    "comun.reintentar": "Try again",
    "comun.cancelar": "Cancel",
    "comun.guardar": "Save",
    "comun.cerrar": "Close",
    "comun.confirmar": "Confirm",
    "comun.error.generico": "Something went wrong. Please try again.",
    "comun.sinDatos": "No data yet",
    "comun.resultados": { one: "{count} result", other: "{count} results" },
  },
});

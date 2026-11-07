import type { Traduccion } from "../../tipos.ts";
import type { comun } from "../comun.ts";

/** Ingles natural de producto, no calco del espanol. */
export const comunEn: Traduccion<typeof comun> = {
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
};

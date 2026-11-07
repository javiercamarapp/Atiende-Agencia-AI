import type { ModuloEs } from "../tipos.ts";

/** Textos transversales (estados, acciones genericas, idioma). La traduccion vive en `en/comun.ts`. */
export const comun = {
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
} as const satisfies ModuloEs;

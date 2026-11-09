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
  "comun.volver": "Back",
  "comun.deshacer": "Undo",
  "comun.ver": "View",
  "comun.obligatorio": " (required)",
  "comun.cerrarAviso": "Dismiss",
  "comun.migas": "Breadcrumb",
  "comun.error.titulo": "Not available right now",
  "comun.error.servidor": "We couldn't reach the server. Check your connection and try again.",
  "comun.error.integracion": "We couldn't connect to {integracion}. Check the connection and try again.",
  "comun.error.pendienteCredenciales": "{integracion} is waiting for credentials. Connect the integration to see real data here.",
  "comun.error.etiquetaPendiente": "Credentials pending",
  "comun.error.explicacionTecnica": "This isn't available right now. Try again in a moment.",
  "comun.error.verDetalle": "Show technical details",
  "comun.error.ocultarDetalle": "Hide technical details",
  "comun.comoLeerEsto": "How to read this",
};

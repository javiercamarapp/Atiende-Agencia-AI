import type { Traduccion } from "../../tipos.ts";
import type { carga } from "../carga.ts";

export const cargaEn: Traduccion<typeof carga> = {
  "carga.titulo": "We couldn't load this screen",
  "carga.mensaje": "There may be a new version of the app or the connection failed. Reload the page to continue.",
  "carga.limpiarCache": "Clear cache and reload",
  "carga.limpiando": "Clearing…",
  "carga.ayudaCache": "If it still won't load, clear the app cache. You'll stay signed in.",
};

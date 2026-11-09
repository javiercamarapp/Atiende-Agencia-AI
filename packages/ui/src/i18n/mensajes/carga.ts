import type { ModuloEs } from "../tipos.ts";

/** Recuperacion cuando una pantalla no carga (chunk roto). Va en la entrada: textos cortos. La traduccion vive en `en/carga.ts`. */
export const carga = {
  "carga.titulo": "No pudimos cargar esta pantalla",
  "carga.mensaje": "Puede que haya una versión nueva de la aplicación o que falle la conexión. Recarga la página para continuar.",
  "carga.limpiarCache": "Limpiar caché y recargar",
  "carga.limpiando": "Limpiando…",
  "carga.ayudaCache": "Si sigue sin cargar, limpia la caché de la aplicación. Tu sesión se conserva.",
} as const satisfies ModuloEs;

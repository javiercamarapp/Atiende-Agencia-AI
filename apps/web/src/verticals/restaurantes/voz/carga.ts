// Estado de una carga remota con el caso "el servicio aún no existe" como ciudadano
// de primera clase (404/503 -> `no_disponible`), distinto de un error real.
import { VozNoDisponibleError } from "../lib/voz-client.ts";

export type Carga<T> =
  | { readonly estado: "cargando" }
  | { readonly estado: "listo"; readonly datos: T }
  | { readonly estado: "no_disponible" }
  | { readonly estado: "error"; readonly mensaje: string };

export function desdeError<T>(err: unknown, fallback: string): Carga<T> {
  if (err instanceof VozNoDisponibleError) return { estado: "no_disponible" };
  return { estado: "error", mensaje: err instanceof Error ? err.message : fallback };
}

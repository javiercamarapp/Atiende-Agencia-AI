// CFO-07 · hook de carga de una vista del CFO con los cinco estados honestos: cargando, listo, no disponible (base sin migrar), sin acceso (403) y error.
import { useCallback, useEffect, useRef, useState } from "react";
import { VozNoDisponibleError } from "../lib/voz-client.ts";
import { CfoSinAccesoError } from "./cfo-client.ts";

export type CargaCfo<T> =
  | { readonly estado: "cargando" }
  | { readonly estado: "listo"; readonly datos: T }
  | { readonly estado: "no_disponible" }
  | { readonly estado: "sin_acceso" }
  | { readonly estado: "error"; readonly mensaje: string };

export function cargaDesdeError<T>(err: unknown, fallback: string): CargaCfo<T> {
  if (err instanceof CfoSinAccesoError) return { estado: "sin_acceso" };
  if (err instanceof VozNoDisponibleError) return { estado: "no_disponible" };
  return { estado: "error", mensaje: err instanceof Error ? err.message : fallback };
}

export interface ResultadoCarga<T> {
  readonly carga: CargaCfo<T>;
  /** true mientras se vuelve a pedir con datos ya en pantalla (se conservan para no parpadear). */
  readonly recargando: boolean;
  readonly recargar: () => void;
}

/** `cargar` se vuelve a ejecutar cuando cambia cualquier valor de `claves` (o al llamar `recargar`). */
export function useCargaCfo<T>(cargar: () => Promise<T>, claves: readonly unknown[], fallback = "No se pudo cargar la información del CFO."): ResultadoCarga<T> {
  const [carga, setCarga] = useState<CargaCfo<T>>({ estado: "cargando" });
  const [recargando, setRecargando] = useState(false);
  const [version, setVersion] = useState(0);
  const hayDatos = useRef(false);
  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;
  const recargar = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelado = false;
    if (hayDatos.current) setRecargando(true);
    else setCarga({ estado: "cargando" });
    (async () => {
      try {
        const datos = await cargarRef.current();
        if (!cancelado) {
          hayDatos.current = true;
          setCarga({ estado: "listo", datos });
          setRecargando(false);
        }
      } catch (err) {
        if (!cancelado) {
          hayDatos.current = false;
          setCarga(cargaDesdeError<T>(err, fallback));
          setRecargando(false);
        }
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...claves, version]);

  return { carga, recargando, recargar };
}

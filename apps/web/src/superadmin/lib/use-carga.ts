// Carga de un bloque con estados cargando / ok / error y reintento. Cada bloque de la pagina se pide POR SEPARADO.
import { useEffect, useState } from "react";

export type Carga<T> = { readonly estado: "cargando" } | { readonly estado: "ok"; readonly data: T } | { readonly estado: "error"; readonly mensaje: string };

export function useCarga<T>(cargar: () => Promise<T>, dependencias: readonly unknown[], mensajeVacio: string): { carga: Carga<T>; recargar: () => void } {
  const [carga, setCarga] = useState<Carga<T>>({ estado: "cargando" });
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    let cancelado = false;
    setCarga({ estado: "cargando" });
    cargar()
      .then((data) => {
        if (!cancelado) setCarga({ estado: "ok", data });
      })
      .catch((err) => {
        if (!cancelado) setCarga({ estado: "error", mensaje: err instanceof Error && err.message ? err.message : mensajeVacio });
      });
    return () => {
      cancelado = true;
    };
    // `cargar` se recrea en cada render: la identidad de la carga la fijan `dependencias`.
  }, [intento, ...dependencias]);
  return { carga, recargar: () => setIntento((n) => n + 1) };
}

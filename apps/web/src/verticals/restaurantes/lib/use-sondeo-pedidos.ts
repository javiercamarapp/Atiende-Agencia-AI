// Hook de sondeo del panel de pedidos (ver sondeo-pedidos.ts para las reglas). Encadena un setTimeout tras cada
// consulta, se pausa con la pestana oculta, hace backoff exponencial ante fallos y nunca solapa dos consultas.
import { useCallback, useEffect, useRef, useState } from "react";
import { siguienteIntervaloMs, SONDEO_BASE_MS } from "./sondeo-pedidos.ts";

export interface EstadoSondeo {
  /** Epoch ms de la ultima consulta exitosa (`null` = todavia ninguna). */
  readonly ultimaActualizacion: number | null;
  readonly fallosSeguidos: number;
  /** Proxima espera programada (ms); relevante para mostrar "reintentando en N s". */
  readonly proximoEnMs: number;
  /** `true` mientras la pestana esta oculta y no se consulta. */
  readonly pausado: boolean;
  readonly consultando: boolean;
}

export function useSondeoPedidos(opciones: {
  /** Reinicia el ciclo cuando cambia (sucursal, filtro...). */
  readonly clave: string;
  readonly activo: boolean;
  readonly consulta: () => Promise<void>;
  readonly baseMs?: number;
}): EstadoSondeo & { readonly refrescar: () => void } {
  const { clave, activo, baseMs = SONDEO_BASE_MS } = opciones;
  const consultaRef = useRef(opciones.consulta);
  consultaRef.current = opciones.consulta;
  const [estado, setEstado] = useState<EstadoSondeo>({ ultimaActualizacion: null, fallosSeguidos: 0, proximoEnMs: baseMs, pausado: false, consultando: false });
  const refrescarRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!activo) return;
    let cancelado = false;
    let timer: number | null = null;
    let enCurso = false;
    let fallos = 0;
    const oculto = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const limpiar = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };

    const programar = () => {
      limpiar();
      if (cancelado) return;
      if (oculto()) {
        setEstado((e) => ({ ...e, pausado: true }));
        return; // Sin timer: al volver visible se consulta de inmediato.
      }
      const espera = siguienteIntervaloMs(fallos, baseMs);
      setEstado((e) => ({ ...e, pausado: false, proximoEnMs: espera, fallosSeguidos: fallos }));
      timer = window.setTimeout(() => void ciclo(), espera);
    };

    const ciclo = async () => {
      if (cancelado || enCurso) return;
      limpiar();
      enCurso = true;
      setEstado((e) => ({ ...e, consultando: true }));
      try {
        await consultaRef.current();
        fallos = 0;
        if (!cancelado) setEstado((e) => ({ ...e, ultimaActualizacion: Date.now(), fallosSeguidos: 0 }));
      } catch {
        fallos += 1;
      } finally {
        enCurso = false;
        if (!cancelado) setEstado((e) => ({ ...e, consultando: false }));
        programar();
      }
    };

    const alCambiarVisibilidad = () => {
      if (oculto()) {
        limpiar();
        setEstado((e) => ({ ...e, pausado: true }));
      } else {
        void ciclo();
      }
    };

    refrescarRef.current = () => void ciclo();
    document.addEventListener("visibilitychange", alCambiarVisibilidad);
    programar();
    return () => {
      cancelado = true;
      limpiar();
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
    };
  }, [clave, activo, baseMs]);

  const refrescar = useCallback(() => refrescarRef.current(), []);
  return { ...estado, refrescar };
}

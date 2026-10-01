// Hook compartido para wirear `<NotificationBell />` (@atiende/ui) al contador real de no leidas
// (GET /notifications/unread-count, apps/api/src/routes/notifications.ts) -- UNA sola implementacion
// para los 7 Shells (6 verticales + superadmin).
//
// La campana es identica a la de Likida: un punto rojo SIN numero cuando hay notificaciones sin leer, que
// se apaga al leerlas. Aqui solo vive el contador; la lista y las acciones de leer viven en la pagina
// (`components/NotificacionesPagina.tsx`), que avisa a la campana con `anunciarCambioNotificaciones` (mismo
// criterio que el `EVENTO_CAMBIO` de `notificaciones-leidas.ts` de Likida: la campana del marco y la lista
// viven en la MISMA pestana, un evento propio las sincroniza sin recargar).
//
// Sondeo ligero (no hay realtime en el backend): una consulta indexada cada 30 s, que se PAUSA mientras la
// pestana esta oculta (y vuelve con un refresco inmediato al mostrarse o recuperar el foco) y se aleja con
// backoff exponencial (x2, tope 5 min) tras fallos de red/servidor. Un 401 detiene el sondeo: el token
// expiro, y la siguiente accion real del staff (cualquier fetch de negocio) ya dispara el flujo completo de
// refresh/`SESSION_EXPIRED_EVENT` de `authed-fetch.ts`; aqui nunca se rompe el Shell.
import { useCallback, useEffect, useRef, useState } from "react";

export const NOTIFICACIONES_CAMBIO_EVENTO = "atiende:notificaciones:cambio";
export const SONDEO_BASE_MS = 30_000;
export const SONDEO_MAX_MS = 5 * 60_000;

export interface CambioNotificaciones {
  /** Contador ya conocido por quien avisa; si falta, la campana lo vuelve a pedir. */
  readonly unreadCount?: number;
  /** `sondeo` = lo detecto el sondeo de la campana (llego algo nuevo); `pagina` = lo hizo una accion del usuario. */
  readonly origen: "sondeo" | "pagina";
}

/** Avisa a la campana (y a la pagina) de que cambio el estado de lectura en esta pestana. */
export function anunciarCambioNotificaciones(cambio: CambioNotificaciones): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<CambioNotificaciones>(NOTIFICACIONES_CAMBIO_EVENTO, { detail: cambio }));
}

export interface UseNotificationsResult {
  readonly unreadCount: number;
  /** Lo unico que pinta la campana: punto rojo si hay alguna sin leer. */
  readonly hayNoLeidas: boolean;
  readonly refetch: () => void;
}

/** Siguiente espera del sondeo: base tras un exito; doble por cada fallo seguido, con tope. */
export function esperaSondeo(fallosSeguidos: number): number {
  if (fallosSeguidos <= 0) return SONDEO_BASE_MS;
  return Math.min(SONDEO_BASE_MS * 2 ** fallosSeguidos, SONDEO_MAX_MS);
}

export function useNotifications(apiBaseUrl: string, token: string): UseNotificationsResult {
  const [unreadCount, setUnreadCount] = useState(0);
  // El token puede rotar (refresh) sin que el sondeo deba reiniciarse: se lee de una ref en cada llamada.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const refrescarRef = useRef<() => void>(() => {});
  // null = aun no se leyo ni una vez: la primera lectura nunca cuenta como "llego algo nuevo".
  const conocidoRef = useRef<number | null>(null);

  const hayToken = token !== "";

  useEffect(() => {
    if (!hayToken || typeof document === "undefined") return undefined;
    let activo = true;
    let detenido = false;
    let fallos = 0;
    let temporizador: ReturnType<typeof setTimeout> | null = null;
    let controlador: AbortController | null = null;

    const limpiarTemporizador = () => {
      if (temporizador !== null) clearTimeout(temporizador);
      temporizador = null;
    };

    const programar = () => {
      limpiarTemporizador();
      // Pestana oculta: sin sondeo hasta que vuelva a mostrarse (ver `alMostrar`).
      if (!activo || detenido || document.visibilityState === "hidden") return;
      temporizador = setTimeout(() => void sondear(), esperaSondeo(fallos));
    };

    const sondear = async () => {
      limpiarTemporizador();
      if (!activo || detenido) return;
      controlador?.abort();
      controlador = new AbortController();
      const mio = controlador;
      try {
        const res = await fetch(`${apiBaseUrl}/notifications/unread-count`, { headers: { authorization: `Bearer ${tokenRef.current}` }, signal: mio.signal });
        if (!activo || mio.signal.aborted) return;
        if (res.status === 401) {
          detenido = true;
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { unreadCount?: unknown };
        if (!activo || mio.signal.aborted) return;
        if (typeof body.unreadCount !== "number" || !Number.isFinite(body.unreadCount) || body.unreadCount < 0) throw new Error("respuesta invalida");
        fallos = 0;
        const nuevo = body.unreadCount;
        const habia = conocidoRef.current;
        conocidoRef.current = nuevo;
        setUnreadCount(nuevo);
        // Llego algo nuevo desde la ultima lectura: la pagina (si esta abierta) recarga su lista.
        if (habia !== null && nuevo > habia) anunciarCambioNotificaciones({ unreadCount: nuevo, origen: "sondeo" });
      } catch {
        if (!activo || mio.signal.aborted) return;
        // Sin red / API caida: la campana se queda en su ultimo estado conocido y el sondeo se aleja.
        fallos += 1;
      }
      programar();
    };

    const alMostrar = () => {
      if (document.visibilityState === "hidden") {
        limpiarTemporizador();
        controlador?.abort();
        return;
      }
      void sondear();
    };

    const alCambiar = (e: Event) => {
      const detalle = (e as CustomEvent<CambioNotificaciones>).detail;
      // El propio sondeo anuncia lo que ya sabe: no se vuelve a pedir ni se hace eco.
      if (detalle?.origen === "sondeo") return;
      if (typeof detalle?.unreadCount === "number") {
        conocidoRef.current = detalle.unreadCount;
        setUnreadCount(detalle.unreadCount);
        return;
      }
      void sondear();
    };

    refrescarRef.current = () => void sondear();
    document.addEventListener("visibilitychange", alMostrar);
    window.addEventListener("focus", alMostrar);
    window.addEventListener(NOTIFICACIONES_CAMBIO_EVENTO, alCambiar);
    void sondear();

    return () => {
      activo = false;
      limpiarTemporizador();
      controlador?.abort();
      document.removeEventListener("visibilitychange", alMostrar);
      window.removeEventListener("focus", alMostrar);
      window.removeEventListener(NOTIFICACIONES_CAMBIO_EVENTO, alCambiar);
      refrescarRef.current = () => {};
    };
  }, [apiBaseUrl, hayToken]);

  const refetch = useCallback(() => refrescarRef.current(), []);
  return { unreadCount, hayNoLeidas: unreadCount > 0, refetch };
}

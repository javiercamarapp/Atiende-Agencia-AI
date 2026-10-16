// Campana del encabezado con centro de notificaciones (popover): carga las recientes al abrir, las marca
// leidas con la misma API que la pagina completa y avisa a la campana/pagina con
// `anunciarCambioNotificaciones`. Una sola implementacion para las 6 verticales, el superadmin y el movil.
import { useCallback, useRef, useState } from "react";
import { NotificationBell } from "@atiende/ui";
import type { CentroNotificacionItem } from "@atiende/ui";
import { anunciarCambioNotificaciones } from "../lib/useNotifications.ts";
import { enlaceInternoSeguro, listarNotificaciones, marcarLeida, marcarTodasLeidas } from "../lib/notificaciones-client.ts";
import type { NotificacionFila } from "../lib/notificaciones-client.ts";
import { formatoRelativo } from "../lib/notificaciones-presentacion.ts";

const RECIENTES = 8;

export interface CampanaNotificacionesProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly href: string;
  readonly hayNoLeidas: boolean;
  readonly className?: string;
}

function aItem(f: NotificacionFila): CentroNotificacionItem {
  return { id: f.id, titulo: f.titulo, cuerpo: f.cuerpo, cuando: formatoRelativo(f.createdAt), severidad: f.severidad, sinLeer: f.readAt === null, enlace: enlaceInternoSeguro(f.enlace) };
}

export function CampanaNotificaciones({ apiBaseUrl, token, href, hayNoLeidas, className }: CampanaNotificacionesProps) {
  const [filas, setFilas] = useState<readonly NotificacionFila[]>([]);
  const [estado, setEstado] = useState<"cargando" | "error" | "listo">("cargando");
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const cargar = useCallback(async () => {
    setEstado((e) => (e === "listo" ? e : "cargando"));
    try {
      const r = await listarNotificaciones(fetch, apiBaseUrl, tokenRef.current, { soloNoLeidas: false, categoria: null, limit: RECIENTES });
      setFilas(r.notificaciones);
      setEstado("listo");
    } catch {
      setEstado("error");
    }
  }, [apiBaseUrl]);

  const leer = useCallback(
    async (id: string) => {
      const marca = new Date().toISOString();
      setFilas((cur) => cur.map((f) => (f.id === id ? { ...f, readAt: marca } : f)));
      try {
        const real = await marcarLeida(fetch, apiBaseUrl, tokenRef.current, id);
        anunciarCambioNotificaciones({ unreadCount: real, origen: "pagina" });
      } catch {
        void cargar();
      }
    },
    [apiBaseUrl, cargar],
  );

  const marcarTodas = useCallback(async () => {
    const marca = new Date().toISOString();
    setFilas((cur) => cur.map((f) => (f.readAt === null ? { ...f, readAt: marca } : f)));
    try {
      await marcarTodasLeidas(fetch, apiBaseUrl, tokenRef.current);
      anunciarCambioNotificaciones({ unreadCount: 0, origen: "pagina" });
    } catch {
      void cargar();
    }
  }, [apiBaseUrl, cargar]);

  return (
    <NotificationBell
      className={className}
      href={href}
      hayNoLeidas={hayNoLeidas}
      centro={{ items: filas.map(aItem), estado, onAbrir: () => void cargar(), onReintentar: () => void cargar(), onLeer: (id) => void leer(id), onMarcarTodas: () => void marcarTodas() }}
    />
  );
}

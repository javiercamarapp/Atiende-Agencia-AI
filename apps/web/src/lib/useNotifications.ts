// Hook compartido para wirear `<NotificationBell />` (@atiende/ui) a GET/POST
// /notifications (apps/api/src/routes/notifications.ts, ver la migración
// 0013_notifications_schema.sql) -- UNA sola implementación para los 7 Shells
// (6 verticales + superadmin) en vez de que cada uno reinvente su propio fetch,
// mismo criterio de "un solo lugar" que ya documenta authed-fetch.ts.
//
// Deliberadamente MÁS simple que `withAuthRefresh` (apps/web/src/lib/authed-
// fetch.ts): la campana es un elemento secundario del header, no una puerta de
// acceso al panel -- si el token expiró mientras estaba montada, la próxima
// acción real del staff (cualquier fetch de datos de negocio) ya dispara el
// flujo completo de refresh/`SESSION_EXPIRED_EVENT` que SÍ usa `withAuthRefresh`.
// Un 401 aquí simplemente deja la campana en su último estado conocido -- nunca
// rompe el resto del Shell.
//
// Actualizaciones optimistas (`markRead`/`markAllRead` cambian el estado local
// ANTES de que responda el POST): mismo criterio que la referencia real de
// atiende-restaurantes ("abrir un pedido debe limpiar su badge al instante").
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationBellItem } from "@atiende/ui";

interface NotificationApiRow {
  readonly id: string;
  readonly vertical: string | null;
  readonly titulo: string;
  readonly cuerpo: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface UseNotificationsResult {
  readonly items: readonly NotificationBellItem[];
  readonly unreadCount: number;
  readonly loading: boolean;
  readonly refetch: () => void;
  readonly onMarkRead: (id: string) => void;
  readonly onMarkAllRead: () => void;
}

export function useNotifications(apiBaseUrl: string, token: string): UseNotificationsResult {
  const [items, setItems] = useState<readonly NotificationBellItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  // El token puede rotar (refresh) sin que este hook necesite volver a montarse
  // -- se lee de una ref en las llamadas de red para no encadenar el `useCallback`
  // de fetch a la identidad del token en cada request.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/notifications`, { headers: { authorization: `Bearer ${tokenRef.current}` } });
      if (!res.ok) return;
      const body = (await res.json()) as { notifications: readonly NotificationApiRow[]; unreadCount: number };
      setItems(body.notifications.map((n) => ({ id: n.id, titulo: n.titulo, cuerpo: n.cuerpo, createdAt: n.createdAt, readAt: n.readAt, vertical: n.vertical })));
      setUnreadCount(body.unreadCount);
    } catch {
      // Sin red/API caída -- la campana se queda en su último estado conocido,
      // ver comentario de cabecera.
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  const onMarkRead = useCallback(
    (id: string) => {
      let eraNoLeida = false;
      setItems((cur) =>
        cur.map((n) => {
          if (n.id !== id || n.readAt) return n;
          eraNoLeida = true;
          return { ...n, readAt: new Date().toISOString() };
        }),
      );
      if (eraNoLeida) setUnreadCount((c) => Math.max(0, c - 1));
      void fetch(`${apiBaseUrl}/notifications/${id}/read`, { method: "POST", headers: { authorization: `Bearer ${tokenRef.current}` } }).catch(() => {});
    },
    [apiBaseUrl],
  );

  const onMarkAllRead = useCallback(() => {
    setItems((cur) => cur.map((n) => (n.readAt ? n : { ...n, readAt: new Date().toISOString() })));
    setUnreadCount(0);
    void fetch(`${apiBaseUrl}/notifications/read-all`, { method: "POST", headers: { authorization: `Bearer ${tokenRef.current}` } }).catch(() => {});
  }, [apiBaseUrl]);

  return { items, unreadCount, loading, refetch: () => void fetchNotifications(), onMarkRead, onMarkAllRead };
}

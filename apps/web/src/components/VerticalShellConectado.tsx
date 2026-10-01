// Conecta el <VerticalShell> de @atiende/ui (que no hace fetch) con las piezas de
// apps/web que si lo hacen: la campana de notificaciones (useNotifications) y el
// boton "Chatea con tus datos". Cada vertical migrada monta este componente en
// lugar de armar a mano el Sidebar, el MobileHeader y el BottomNav.
import { NotificationBell, VerticalShell } from "@atiende/ui";
import type { VerticalShellProps } from "@atiende/ui";
import { useNotifications } from "../lib/useNotifications.ts";
import { BotonChatDatos } from "./BotonChatDatos.tsx";
import type { ChatDatosConexion } from "./PanelChateaConTusDatos.tsx";

export type VerticalShellConectadoProps = Omit<VerticalShellProps, "notificationBell" | "mobileNotificationBell" | "chatButton" | "mobileChatButton"> & {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Conexion real al chat de la vertical (solo restaurantes por ahora); sin ella el boton dice "Pronto". */
  readonly chat?: ChatDatosConexion;
};

export function VerticalShellConectado({ apiBaseUrl, token, chat, ...shell }: VerticalShellConectadoProps) {
  const notif = useNotifications(apiBaseUrl, token);
  const campana = (className?: string) => (
    <NotificationBell
      className={className}
      items={notif.items}
      unreadCount={notif.unreadCount}
      loading={notif.loading}
      onOpenChange={(open) => {
        if (open) notif.refetch();
      }}
      onMarkRead={notif.onMarkRead}
      onMarkAllRead={notif.onMarkAllRead}
    />
  );
  return (
    <VerticalShell
      {...shell}
      notificationBell={campana()}
      mobileNotificationBell={campana("w-10 h-10")}
      chatButton={<BotonChatDatos chat={chat} />}
      mobileChatButton={<BotonChatDatos className="h-10 w-full justify-center" chat={chat} />}
    />
  );
}

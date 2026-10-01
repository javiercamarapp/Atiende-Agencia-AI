// Acciones del MobileHeader compartidas por las 6 verticales y el superadmin.
// En movil el Sidebar y el DashboardHeader estan ocultos (`hidden md:*`), asi
// que sin esto la campana, "Chatea con tus datos" y el cierre de sesion eran
// inalcanzables (hallazgo F-01 del informe de diseno-ux; solo licitaciones
// tenia un "Salir"). Campana visible en el header (con su contador) y el resto
// de la cuenta -- tema, chat y cerrar sesion -- en el menu de cuenta.
import type { ReactNode } from "react";
import { MobileAccountMenu, NotificationBell } from "@atiende/ui";
import type { UseNotificationsResult } from "../lib/useNotifications.ts";
import { BotonChatDatos } from "./BotonChatDatos.tsx";
import type { ChatDatosConexion } from "./PanelChateaConTusDatos.tsx";

export interface MobileHeaderActionsProps {
  /** Selector de sucursal/hotel/contribuyente que ya vivia en el header movil (opcional). */
  readonly selector?: ReactNode;
  readonly notif: UseNotificationsResult;
  readonly user: { email: string; rol?: string } | null;
  readonly onLogout: () => void;
  readonly loggingOut?: boolean;
  /** El back office de plataforma no tiene "Chatea con tus datos". */
  readonly conChat?: boolean;
  /** Conexion real al chat de la vertical (solo restaurantes por ahora); sin ella el boton dice "Pronto". */
  readonly chat?: ChatDatosConexion;
}

export function MobileHeaderActions({ selector, notif, user, onLogout, loggingOut, conChat = true, chat }: MobileHeaderActionsProps) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      {selector ? <div className="min-w-0 max-w-[40vw]">{selector}</div> : null}
      <NotificationBell
        className="w-10 h-10"
        items={notif.items}
        unreadCount={notif.unreadCount}
        loading={notif.loading}
        onOpenChange={(open) => {
          if (open) notif.refetch();
        }}
        onMarkRead={notif.onMarkRead}
        onMarkAllRead={notif.onMarkAllRead}
      />
      <MobileAccountMenu user={user} onLogout={onLogout} loggingOut={loggingOut}>
        {conChat ? <BotonChatDatos className="h-10 w-full justify-center" chat={chat} /> : null}
      </MobileAccountMenu>
    </div>
  );
}

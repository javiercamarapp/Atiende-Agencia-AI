// Acciones del MobileHeader compartidas por las 6 verticales y el superadmin.
// En movil el Sidebar y el BarraPagina estan ocultos (`hidden md:*`), asi
// que sin esto la campana, "Chatea con tus datos" y el cierre de sesion eran
// inalcanzables (hallazgo F-01 del informe de diseno-ux; solo licitaciones
// tenia un "Salir"). Campana visible en el header (punto rojo sin numero) y el resto
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
  /** Pagina de notificaciones de la consola: a donde lleva la campana. */
  readonly notificacionesHref: string;
  readonly user: { email: string; rol?: string } | null;
  readonly onLogout: () => void;
  readonly loggingOut?: boolean;
  /** El back office de plataforma no tiene "Chatea con tus datos". */
  readonly conChat?: boolean;
  /** Conexion real al chat de la vertical (solo restaurantes por ahora); sin ella el boton dice "Pronto". */
  readonly chat?: ChatDatosConexion;
}

export function MobileHeaderActions({ selector, notif, notificacionesHref, user, onLogout, loggingOut, conChat = true, chat }: MobileHeaderActionsProps) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      {selector ? <div className="min-w-0 max-w-[40vw]">{selector}</div> : null}
      <NotificationBell className="w-10 h-10" href={notificacionesHref} hayNoLeidas={notif.hayNoLeidas} />
      <MobileAccountMenu user={user} onLogout={onLogout} loggingOut={loggingOut}>
        {conChat ? <BotonChatDatos className="h-10 w-full justify-center" chat={chat} /> : null}
      </MobileAccountMenu>
    </div>
  );
}

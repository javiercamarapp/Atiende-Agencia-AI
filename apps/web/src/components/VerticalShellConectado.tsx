// Conecta el <VerticalShell> de @atiende/ui (que no hace fetch) con las piezas de
// apps/web que si lo hacen: la campana de notificaciones (useNotifications) y el
// boton "Chatea con tus datos". Cada vertical migrada monta este componente en
// lugar de armar a mano el Sidebar, el MobileHeader y el BottomNav.
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { VerticalShell } from "@atiende/ui";
import type { SidebarPiePildora, VerticalShellProps } from "@atiende/ui";
import { useNotifications } from "../lib/useNotifications.ts";
import { CampanaNotificaciones } from "./CampanaNotificaciones.tsx";
import { BotonChatDatos, useChatDatosDisponible } from "./BotonChatDatos.tsx";
import { BannerPlan } from "./BannerPlan.tsx";
import { PanelChateaConTusDatos } from "./PanelChateaConTusDatos.tsx";
import type { ChatDatosConexion } from "./PanelChateaConTusDatos.tsx";

export type VerticalShellConectadoProps = Omit<VerticalShellProps, "notificationBell" | "mobileNotificationBell" | "chatButton" | "mobileChatButton"> & {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Pagina de notificaciones de la consola (`/<vertical>/<orgSlug>/notificaciones`): a donde lleva la campana. */
  readonly notificacionesHref: string;
  /** Conexion real al chat de la vertical (solo restaurantes por ahora); sin ella el boton dice "Pronto". */
  readonly chat?: ChatDatosConexion;
  /** Ruta de la pagina del Copiloto (CHAT-08): la pildora del pie y el boton del header pasan a ser enlaces a ella. */
  readonly copilotoHref?: string;
  /** Rol sin acceso al Copiloto: no se ofrece ni el boton del header ni la pildora (el servidor igual responde 403). */
  readonly ocultarChat?: boolean;
};

/** `/<vertical>/<orgSlug>/notificaciones` -> `/<vertical>/<orgSlug>/plan` (la pantalla Plan y uso vive junto a las notificaciones). */
export function planHrefDe(notificacionesHref: string): string {
  return notificacionesHref.replace(/\/notificaciones\/?$/, "/plan");
}

/** `/<vertical>/<orgSlug>/notificaciones` -> `/<vertical>/<orgSlug>/seguridad` (Seguridad de la cuenta, PL-21). */
export function seguridadHrefDe(notificacionesHref: string): string {
  return notificacionesHref.replace(/\/notificaciones\/?$/, "/seguridad");
}

export function VerticalShellConectado({ apiBaseUrl, token, notificacionesHref, chat: chatProp, copilotoHref, ocultarChat = false, children, ...shell }: VerticalShellConectadoProps) {
  const notif = useNotifications(apiBaseUrl, token);
  const chat = ocultarChat ? undefined : chatProp;
  // Pildora "Pregunta a tus datos" del pie del Sidebar (gemela de la de Likida): abre el MISMO panel real que el
  // boton de la barra y solo existe cuando el servidor confirma que el asistente esta activo (nunca una pildora "Pronto").
  const chatDisponible = useChatDatosDisponible(chat);
  const [chatAbierto, setChatAbierto] = useState(false);
  // PL-21: destino de "Seguridad de la cuenta" en el pie del Sidebar (y en la hoja "Mas" del movil, seccion "Cuenta"),
  // comun a las 6 verticales. Si el shell ya lo trae como item de navegacion (licitaciones) no se duplica.
  const seguridadHref = seguridadHrefDe(notificacionesHref);
  const yaEnNavegacion = shell.sections.some((sec) => sec.items.some((item) => item.to === seguridadHref));
  const pie: SidebarPiePildora[] = [
    ...(shell.sidebarPie ?? []),
    ...(yaEnNavegacion ? [] : [{ label: "Seguridad de la cuenta", to: seguridadHref, icon: ShieldCheck }]),
    ...(chat && chatDisponible ? [copilotoHref ? { label: "Pregunta a tus datos", to: copilotoHref } : { label: "Pregunta a tus datos", onClick: () => setChatAbierto(true) }] : []),
  ];
  const campana = (className?: string) => (
    <CampanaNotificaciones apiBaseUrl={apiBaseUrl} token={token} className={className} href={notificacionesHref} hayNoLeidas={notif.hayNoLeidas} />
  );
  return (
    <>
      <VerticalShell
        {...shell}
        sidebarPie={pie}
        notificationBell={campana()}
        mobileNotificationBell={campana("w-10 h-10")}
        chatButton={ocultarChat ? null : <BotonChatDatos chat={chat} {...(copilotoHref ? { href: copilotoHref } : {})} />}
        mobileChatButton={ocultarChat ? null : <BotonChatDatos className="h-10 w-full justify-center" chat={chat} {...(copilotoHref ? { href: copilotoHref } : {})} />}
      >
        {/* PL-16: aviso de fin de prueba / tope de mensajes del plan, comun a las 6 verticales. */}
        <BannerPlan apiBaseUrl={apiBaseUrl} token={token} planHref={planHrefDe(notificacionesHref)} />
        {children}
      </VerticalShell>
      {chatAbierto && chat && <PanelChateaConTusDatos onClose={() => setChatAbierto(false)} chat={chat} />}
    </>
  );
}

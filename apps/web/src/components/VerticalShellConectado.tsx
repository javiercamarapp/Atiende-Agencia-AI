// Conecta el <VerticalShell> de @atiende/ui (que no hace fetch) con las piezas de
// apps/web que si lo hacen: el aviso de notificaciones sin leer (useNotifications) y la
// disponibilidad del chat "Pregúntale a tus datos". Campana, chat y fecha ya NO van en el
// encabezado: son pildoras del pie del Sidebar (y seccion "Cuenta" de la hoja "Mas" movil). Cada vertical migrada monta este componente en
// lugar de armar a mano el Sidebar, el MobileHeader y el BottomNav.
import { useEffect, useMemo, useState } from "react";
import { Bell, CircleHelp, MessageCircle, ShieldCheck } from "lucide-react";
import { abrirMenuGuia, leerDisenoDs3, limpiarProgresoGuia, traductorGuia, useIdiomaGuia, useT, vaciarGuardadoGuia, VerticalShell } from "@atiende/ui";
import type { SidebarPiePildora, VerticalShellProps } from "@atiende/ui";
import { GuiaDiferida, type CargarGuia } from "./GuiaDiferida.tsx";
import { baseDeConsola, pistaGuia, servidorProgresoGuia } from "../lib/guia-progreso.ts";
import { useNotifications } from "../lib/useNotifications.ts";
import { useChatDatosDisponible } from "./BotonChatDatos.tsx";
import { BannerPlan } from "./BannerPlan.tsx";
import { PanelChateaConTusDatos } from "./PanelChateaConTusDatos.tsx";
import type { ChatDatosConexion } from "./PanelChateaConTusDatos.tsx";
import { nav } from "@atiende/ui/i18n/nav";

export type VerticalShellConectadoProps = VerticalShellProps & {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Pagina de notificaciones de la consola (`/<vertical>/<orgSlug>/notificaciones`): destino de la pildora "Notificaciones" del pie. */
  readonly notificacionesHref: string;
  /** Conexion real al chat de la vertical (solo restaurantes por ahora); sin ella el boton dice "Pronto". */
  readonly chat?: ChatDatosConexion;
  /** Ruta de la pagina del Copiloto (CHAT-08): la pildora "Pregúntale a tus datos" del pie pasa a ser un enlace a ella. */
  readonly copilotoHref?: string;
  /** Rol sin acceso al Copiloto: no se ofrece la pildora (el servidor igual responde 403). */
  readonly ocultarChat?: boolean;
  /** ds3 «Guía»: contenido del recorrido por pantalla de la vertical. Sin el, cada pantalla del menu del rol lleva el texto generico. */
  readonly guia?: GuiaConsola;
};

/** Lo que cada vertical aporta al recorrido guiado; el recorrido en si sale del menu real del rol (`sections`). */
export interface GuiaConsola {
  /** Contenido por pantalla, esenciales del corto y exclusiones, cargados DIFERIDO (solo con la bandera ds3). */
  readonly cargar?: CargarGuia;
  /** «Primeros pasos» de la consola, si el rol la tiene. */
  readonly primerosPasosHref?: string;
  readonly organizacionNombre?: string;
}

/** `/<vertical>/<orgSlug>/notificaciones` -> `/<vertical>/<orgSlug>/plan` (la pantalla Plan y uso vive junto a las notificaciones). */
export function planHrefDe(notificacionesHref: string): string {
  return notificacionesHref.replace(/\/notificaciones\/?$/, "/plan");
}

/** `/<vertical>/<orgSlug>/notificaciones` -> `/<vertical>/<orgSlug>/seguridad` (Seguridad de la cuenta, PL-21). */
export function seguridadHrefDe(notificacionesHref: string): string {
  return notificacionesHref.replace(/\/notificaciones\/?$/, "/seguridad");
}

export function VerticalShellConectado({ apiBaseUrl, token, notificacionesHref, chat: chatProp, copilotoHref, ocultarChat = false, guia, children, ...shell }: VerticalShellConectadoProps) {
  const notif = useNotifications(apiBaseUrl, token);
  const t = useT(nav);
  const chat = ocultarChat ? undefined : chatProp;
  // Pildora "Pregúntale a tus datos" del pie del Sidebar (gemela de la de Likida): abre el panel real (o la pagina del Copiloto) y solo existe cuando el servidor confirma que el asistente esta activo (nunca una pildora "Pronto").
  const chatDisponible = useChatDatosDisponible(chat);
  const tGuia = traductorGuia(useIdiomaGuia());
  const guiaMovil = useGuiaMovil();
  const [chatAbierto, setChatAbierto] = useState(false);
  // PL-21: destino de "Seguridad de la cuenta" en el pie del Sidebar (y en la hoja "Mas" del movil, seccion "Cuenta"),
  // comun a las 6 verticales. Si el shell ya lo trae como item de navegacion (licitaciones) no se duplica.
  const seguridadHref = seguridadHrefDe(notificacionesHref);
  const yaEnNavegacion = shell.sections.some((sec) => sec.items.some((item) => item.to === seguridadHref));
  const pie: SidebarPiePildora[] = [
    ...(shell.sidebarPie ?? []),
    // La campana del encabezado se quito: las notificaciones (y su punto de "sin leer") viven aqui, en escritorio y en "Mas" > "Cuenta".
    { label: t("nav.notificaciones"), to: notificacionesHref, icon: Bell, indicador: notif.hayNoLeidas, contador: notif.unreadCount },
    ...(yaEnNavegacion ? [] : [{ label: t("nav.seguridadCuenta"), to: seguridadHref, icon: ShieldCheck }]),
    ...(chat && chatDisponible ? [copilotoHref ? { label: t("nav.preguntaleATusDatos"), to: copilotoHref, icon: MessageCircle } : { label: t("nav.preguntaleATusDatos"), onClick: () => setChatAbierto(true), icon: MessageCircle }] : []),
    // ds3 «Guía» en movil: el boton de la cabecera solo existe en escritorio, asi que en movil la guia se abre desde «Más» > «Cuenta».
    ...(guiaMovil ? [{ label: tGuia("guia.boton"), onClick: () => abrirMenuGuia(), icon: CircleHelp }] : []),
  ];
  // ds3 «Guía»: el recorrido de ESTE rol sale de su menu real; el progreso se guarda por persona en el servidor (y en el navegador).
  const consola = baseDeConsola(notificacionesHref);
  const pista = pistaGuia(shell.vertical, shell.user?.rol);
  const servidorGuia = useMemo(() => (consola ? servidorProgresoGuia(fetch, apiBaseUrl, token, pista, consola.orgSlug) : null), [apiBaseUrl, token, pista, consola?.orgSlug]);
  const salir = () => {
    // Equipo compartido: al cerrar sesion se envia lo pendiente al servidor y se borra el progreso del navegador (el del servidor es de la persona).
    vaciarGuardadoGuia();
    limpiarProgresoGuia(typeof window === "undefined" ? null : window.localStorage);
    shell.onLogout();
  };
  return (
    <>
      <VerticalShell
        {...shell}
        onLogout={salir}
        sidebarPie={pie}
        // ds3 (decision de Omar 7-nov-2026): campana con contador en la cabecera movil y «Preguntar» como destino fijo de la barra
        // inferior, solo para roles con chat de datos y con el asistente confirmado por el servidor. Sin la bandera existen ocultos.
        notificaciones={{ to: notificacionesHref, contador: notif.unreadCount, hayNoLeidas: notif.hayNoLeidas }}
        preguntarHref={chat && chatDisponible && copilotoHref ? copilotoHref : undefined}
      >
        {/* PL-16: aviso de fin de prueba / tope de mensajes del plan, comun a las 6 verticales. */}
        <BannerPlan apiBaseUrl={apiBaseUrl} token={token} planHref={planHrefDe(notificacionesHref)} />
        {children}
      </VerticalShell>
      {chatAbierto && chat && <PanelChateaConTusDatos onClose={() => setChatAbierto(false)} chat={chat} />}
      {consola ? (
        <GuiaDiferida
          sections={shell.sections}
          base={consola.base}
          pista={pista}
          persona={shell.user?.email ?? ""}
          organizacion={consola.orgSlug}
          organizacionNombre={guia?.organizacionNombre ?? consola.orgSlug}
          rolEtiqueta={shell.user?.rolEtiqueta ?? shell.user?.rol ?? ""}
          cargar={guia?.cargar}
          primerosPasosHref={guia?.primerosPasosHref}
          servidor={servidorGuia}
        />
      ) : null}
    </>
  );
}

/** ¿Ofrecer «Guía» en la hoja «Más»? Solo con la bandera ds3 y en pantallas estrechas (en escritorio esta el boton de la cabecera). */
function useGuiaMovil(): boolean {
  const [movil, setMovil] = useState(false);
  useEffect(() => {
    if (!leerDisenoDs3() || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(max-width: 767px)");
    const actualizar = () => setMovil(mq.matches);
    actualizar();
    mq.addEventListener?.("change", actualizar);
    return () => mq.removeEventListener?.("change", actualizar);
  }, []);
  return movil;
}

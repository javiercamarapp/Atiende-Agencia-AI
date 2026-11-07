// Shell del back office de plataforma. PR-10 del plan de diseno-ux (DS v2): igual que las
// verticales (restaurantes, hoteles, rentas, despachos, licitaciones) el chrome -- Sidebar,
// MobileHeader + menu de cuenta, BottomNav con "Mas", cabecera de escritorio y UN solo <main>
// con "Saltar al contenido" -- vive en `VerticalShell` de @atiende/ui. Lo propio de la
// plataforma se queda aqui: la sesion del superadmin (`atiende.superadmin.session`, sin
// organizacion ni sucursal activa: el superadmin ve TODAS a la vez), el mapa de navegacion,
// el banner de impersonacion, el dialogo de step-up y el Copiloto de plataforma (CHAT-17): el panel
// lateral Cmd+J (el boton "Pregúntale a tus datos" y la campana ya no van en el encabezado: el panel se abre con la pildora
// "Pregúntale a tus datos" del pie y el atajo; las notificaciones, con la pildora "Notificaciones" del pie). El shell es un LAYOUT (App.tsx lo monta una
// sola vez para todas las rutas /superadmin/*), asi que el panel no se desmonta al navegar y conserva su
// conversacion.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Bell, LayoutGrid, MessageCircle } from "lucide-react";
import { useT, VerticalShell, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarPiePildora, SidebarSection, Traductor } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { useNotifications } from "../lib/useNotifications.ts";
import { clearSuperadminSession, readPersistedSuperadminSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { CopilotoPanel, ID_PANEL_COPILOTO } from "./components/CopilotoPanel.tsx";
import { ImpersonacionBanner } from "./components/ImpersonacionBanner.tsx";
import { StepUpDialog } from "./components/StepUpDialog.tsx";
import { RUTA_COPILOTO } from "./lib/copiloto-cliente.ts";
import { COPILOTO, MOVIL_SUPERADMIN, PIE_SUPERADMIN, RESUMEN, SECCIONES } from "./rutas.ts";
import { limpiarStepUp } from "./lib/stepup.ts";

export interface SuperAdminShellProps {
  readonly apiBaseUrl: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: { readonly apiBaseUrl: string; readonly token: string; readonly staffFullName?: string; readonly staffEmail?: string }) => ReactNode;
}

// Resumen arriba (raiz, sin cabecera) + las secciones de Likida con paginas reales (rutas.ts, fuente unica).
// i18n ES/EN: rutas.ts guarda el nombre canonico (`label`) y su `clave`; aqui se pinta `t(clave)` en el idioma de la consola.
function construirSecciones(t: Traductor): SidebarSection[] {
  return [
    { title: t("nav.resumen"), siempreAbierto: true, items: [{ ...RESUMEN, label: t(RESUMEN.clave) }, { ...COPILOTO, label: t(COPILOTO.clave) }] },
    ...SECCIONES.map((s) => ({ title: t(s.clave), items: s.items.map((i) => ({ ...i, label: t(i.clave) })) })),
  ];
}

const construirPie = (t: Traductor): SidebarPiePildora[] => PIE_SUPERADMIN.map((p) => ({ ...p, label: t(p.clave) }));

/** Barra inferior móvil: los 4 destinos de uso diario; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las secciones. */
const construirMovil = (t: Traductor): BottomNavItem[] => MOVIL_SUPERADMIN.map((i) => ({ ...i, label: t(i.clave) }));

export function SuperAdminShell({ apiBaseUrl, onRequireLogin, children }: SuperAdminShellProps) {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [resuelto, setResuelto] = useState(false);
  const [copilotoAbierto, setCopilotoAbierto] = useState(false);
  const { pathname } = useLocation();
  const t = useT();
  const SECTIONS = useMemo(() => construirSecciones(t), [t]);
  const PIE_BASE = useMemo(() => construirPie(t), [t]);
  const MOBILE_ITEMS = useMemo(() => construirMovil(t), [t]);
  // En la pagina completa del Copiloto el panel sobra (seria el mismo chat dos veces): ni boton, ni atajo, ni panel.
  const enPaginaCopiloto = pathname === RUTA_COPILOTO;
  const alternarCopiloto = useCallback(() => setCopilotoAbierto((v) => !v), []);
  const cerrarCopiloto = useCallback(() => setCopilotoAbierto(false), []);

  // Cmd+J (macOS) / Ctrl+J abre y cierra el panel desde cualquier pagina del back office.
  useEffect(() => {
    if (enPaginaCopiloto) return undefined;
    const alTeclear = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        alternarCopiloto();
      }
    };
    window.addEventListener("keydown", alTeclear);
    return () => window.removeEventListener("keydown", alTeclear);
  }, [enPaginaCopiloto, alternarCopiloto]);

  useEffect(() => {
    const s = readPersistedSuperadminSession(window.localStorage);
    setSession(s);
    setResuelto(true);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  async function handleLogout() {
    if (!session) return;
    setLoggingOut(true);
    try {
      await logout(fetch, apiBaseUrl, session.refreshToken);
    } finally {
      limpiarStepUp();
      clearSuperadminSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
  }

  // Campana de notificaciones (mismo header compartido que las 6 verticales) --
  // llamada AQUÍ, antes de los returns condicionales de abajo (reglas de hooks).
  // `session?.token ?? ""` deja montar el hook mientras la sesión resuelve/no
  // existe; useNotifications ya tolera un token vacío (ver su cabecera).
  const notif = useNotifications(apiBaseUrl, session?.token ?? "");

  if (!resuelto) return <VerticalShellEstado estado="cargando" mensaje={t("shell.cargando")} />;
  if (!session) return null; // onRequireLogin ya disparó la redirección

  const rotuloRol = loggingOut ? t("shell.saliendo") : t("shell.superadmin");
  const user = { email: session.email, rol: rotuloRol, nombre: session.fullName, rolEtiqueta: rotuloRol };
  // La campana del encabezado se quito: la pildora "Notificaciones" del pie (escritorio y "Mas" > "Cuenta" en movil) lleva el punto de sin leer.
  // El panel lateral del Copiloto (antes el boton "Pregúntale a tus datos" de la barra) se abre desde la pildora del pie (y con Cmd+J).
  const pie: SidebarPiePildora[] = [
    ...PIE_BASE,
    { label: t("nav.notificaciones"), to: "/superadmin/notificaciones", icon: Bell, indicador: notif.hayNoLeidas },
    ...(enPaginaCopiloto ? [] : [{ label: t("nav.preguntaleATusDatos"), onClick: alternarCopiloto, icon: MessageCircle, ariaControls: ID_PANEL_COPILOTO, ariaPressed: copilotoAbierto }]),
  ];

  return (
    <VerticalShell
      vertical="superadmin"
      sections={SECTIONS}
      sidebarPie={pie}
      mobileItems={MOBILE_ITEMS}
      user={user}
      onLogout={() => void handleLogout()}
      loggingOut={loggingOut}
      header={{ icon: <LayoutGrid className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: t("shell.consolaAtiende"), resumenTo: "/superadmin" }}
      panelLateral={<CopilotoPanel abierto={copilotoAbierto && !enPaginaCopiloto} onCerrar={cerrarCopiloto} apiBaseUrl={apiBaseUrl} token={session.token} />}
    >
      <div className="grid min-w-0 gap-4">
        <ImpersonacionBanner apiBaseUrl={apiBaseUrl} token={session.token} />
        <StepUpDialog />
        {children({ apiBaseUrl, token: session.token, staffFullName: session.fullName, staffEmail: session.email })}
      </div>
    </VerticalShell>
  );
}

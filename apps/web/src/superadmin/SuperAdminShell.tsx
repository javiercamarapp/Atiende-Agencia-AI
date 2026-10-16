// Shell del back office de plataforma. PR-10 del plan de diseno-ux (DS v2): igual que las
// verticales (restaurantes, hoteles, rentas, despachos, licitaciones) el chrome -- Sidebar,
// MobileHeader + menu de cuenta, BottomNav con "Mas", cabecera de escritorio y UN solo <main>
// con "Saltar al contenido" -- vive en `VerticalShell` de @atiende/ui. Lo propio de la
// plataforma se queda aqui: la sesion del superadmin (`atiende.superadmin.session`, sin
// organizacion ni sucursal activa: el superadmin ve TODAS a la vez), el mapa de navegacion,
// el banner de impersonacion, el dialogo de step-up y el Copiloto de plataforma (CHAT-17): el boton
// "Chatea con tus datos" de la barra y el panel lateral Cmd+J. El shell es un LAYOUT (App.tsx lo monta una
// sola vez para todas las rutas /superadmin/*), asi que el panel no se desmonta al navegar y conserva su
// conversacion.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { LayoutGrid, MessageCircle } from "lucide-react";
import { Button, SheetClose, VerticalShell, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarPiePildora, SidebarSection } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { fechaCortaEsMx } from "../lib/formato-fecha.ts";
import { CampanaNotificaciones } from "../components/CampanaNotificaciones.tsx";
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
const SECTIONS: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ ...RESUMEN }, { ...COPILOTO }] },
  ...SECCIONES.map((s) => ({ title: s.title, items: s.items.map((i) => ({ ...i })) })),
];

const SIDEBAR_PIE: SidebarPiePildora[] = PIE_SUPERADMIN.map((p) => ({ ...p }));

/** Barra inferior móvil: los 4 destinos de uso diario; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las secciones. */
const MOBILE_ITEMS: BottomNavItem[] = MOVIL_SUPERADMIN.map((i) => ({ ...i }));

export function SuperAdminShell({ apiBaseUrl, onRequireLogin, children }: SuperAdminShellProps) {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [resuelto, setResuelto] = useState(false);
  const [copilotoAbierto, setCopilotoAbierto] = useState(false);
  const { pathname } = useLocation();
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

  if (!resuelto) return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (!session) return null; // onRequireLogin ya disparó la redirección

  const user = { email: session.email, rol: loggingOut ? "Saliendo…" : "Superadmin", nombre: session.fullName, rolEtiqueta: loggingOut ? "Saliendo…" : "Superadmin" };
  const campana = (className?: string) => (
    <CampanaNotificaciones apiBaseUrl={apiBaseUrl} token={session.token} className={className} href="/superadmin/notificaciones" hayNoLeidas={notif.hayNoLeidas} />
  );

  /** `enHoja` = el boton vive en la hoja del menu de cuenta movil: al pulsarlo la hoja se cierra y el panel (pantalla completa) queda a la vista. */
  const botonCopiloto = (className?: string, enHoja = false) => {
    if (enPaginaCopiloto) return null;
    const boton = (
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={copilotoAbierto}
        aria-controls={ID_PANEL_COPILOTO}
        onClick={alternarCopiloto}
        className={`h-8 rounded-full text-sm shrink-0 ${className ?? ""}`}
      >
        <MessageCircle className="w-3.5 h-3.5" />
        Chatea con tus datos
        <kbd className="hidden font-mono text-2xs text-muted-foreground md:inline">⌘J</kbd>
      </Button>
    );
    return enHoja ? <SheetClose asChild>{boton}</SheetClose> : boton;
  };

  return (
    <VerticalShell
      vertical="superadmin"
      sections={SECTIONS}
      sidebarPie={SIDEBAR_PIE}
      mobileItems={MOBILE_ITEMS}
      user={user}
      onLogout={() => void handleLogout()}
      loggingOut={loggingOut}
      header={{ icon: <LayoutGrid className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: "Consola de Atiende", fecha: fechaCortaEsMx(), resumenTo: "/superadmin" }}
      notificationBell={campana()}
      mobileNotificationBell={campana("w-10 h-10")}
      chatButton={botonCopiloto()}
      mobileChatButton={botonCopiloto("h-10 w-full justify-center", true)}
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

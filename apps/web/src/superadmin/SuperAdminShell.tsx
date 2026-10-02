// Shell del back office de plataforma. PR-10 del plan de diseno-ux (DS v2): igual que las
// verticales (restaurantes, hoteles, rentas, despachos, licitaciones) el chrome -- Sidebar,
// MobileHeader + menu de cuenta, BottomNav con "Mas", cabecera de escritorio y UN solo <main>
// con "Saltar al contenido" -- vive en `VerticalShell` de @atiende/ui. Lo propio de la
// plataforma se queda aqui: la sesion del superadmin (`atiende.superadmin.session`, sin
// organizacion ni sucursal activa: el superadmin ve TODAS a la vez), el mapa de navegacion,
// el banner de impersonacion, el dialogo de step-up y la ausencia de "Chatea con tus datos"
// (no aplica a un panel de plataforma).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LayoutGrid } from "lucide-react";
import { NotificationBell, VerticalShell, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarPiePildora, SidebarSection } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { fechaCortaEsMx } from "../lib/formato-fecha.ts";
import { useNotifications } from "../lib/useNotifications.ts";
import { clearSuperadminSession, readPersistedSuperadminSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { ImpersonacionBanner } from "./components/ImpersonacionBanner.tsx";
import { StepUpDialog } from "./components/StepUpDialog.tsx";
import { MOVIL_SUPERADMIN, PIE_SUPERADMIN, RESUMEN, SECCIONES } from "./rutas.ts";
import { limpiarStepUp } from "./lib/stepup.ts";

export interface SuperAdminShellProps {
  readonly apiBaseUrl: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: { readonly apiBaseUrl: string; readonly token: string }) => ReactNode;
}

// Resumen arriba (raiz, sin cabecera) + las secciones de Likida con paginas reales (rutas.ts, fuente unica).
const SECTIONS: SidebarSection[] = [
  { title: "Resumen", siempreAbierto: true, items: [{ ...RESUMEN }] },
  ...SECCIONES.map((s) => ({ title: s.title, items: s.items.map((i) => ({ ...i })) })),
];

const SIDEBAR_PIE: SidebarPiePildora[] = PIE_SUPERADMIN.map((p) => ({ ...p }));

/** Barra inferior móvil: los 4 destinos de uso diario; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las secciones. */
const MOBILE_ITEMS: BottomNavItem[] = MOVIL_SUPERADMIN.map((i) => ({ ...i }));

export function SuperAdminShell({ apiBaseUrl, onRequireLogin, children }: SuperAdminShellProps) {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [resuelto, setResuelto] = useState(false);

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
    <NotificationBell className={className} href="/superadmin/notificaciones" hayNoLeidas={notif.hayNoLeidas} />
  );

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
    >
      <div className="grid min-w-0 gap-4">
        <ImpersonacionBanner apiBaseUrl={apiBaseUrl} token={session.token} />
        <StepUpDialog />
        {children({ apiBaseUrl, token: session.token })}
      </div>
    </VerticalShell>
  );
}

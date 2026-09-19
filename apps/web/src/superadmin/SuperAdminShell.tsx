// Shell del back office de plataforma — mismo patrón exacto que
// `HotelesShell.tsx`/`RestaurantesShell.tsx` (resuelve sesión, Sidebar real de
// `@atiende/ui`), pero SIN selector de organización/propiedad (aquí no hay
// "una" organización activa -- el superadmin ve TODAS a la vez) y sin
// `BotonChatDatos` (no aplica a un panel de plataforma, no de negocio).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Building2, CalendarDays, ExternalLink, LayoutGrid, TrendingUp } from "lucide-react";
import { DashboardHeader, NotificationBell, Sidebar } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { fechaCortaEsMx } from "../lib/formato-fecha.ts";
import { useNotifications } from "../lib/useNotifications.ts";
import { clearSuperadminSession, readPersistedSuperadminSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";

export interface SuperAdminShellProps {
  readonly apiBaseUrl: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: { readonly apiBaseUrl: string; readonly token: string }) => ReactNode;
}

const SECTIONS = [
  {
    title: "Plataforma",
    siempreAbierto: true,
    items: [
      { to: "/superadmin", label: "Organizaciones", icon: Building2 },
      { to: "/superadmin/prospectos", label: "Prospectos", icon: TrendingUp },
      { to: "/superadmin/paneles", label: "Entrar a los otros paneles", icon: ExternalLink },
    ],
  },
];

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

  if (!resuelto) return null;
  if (!session) return null;

  return (
    <div className="min-h-screen bg-background flex gap-4 p-4">
      <Sidebar sections={SECTIONS} user={{ email: session.email, rol: loggingOut ? "Saliendo…" : "Superadmin" }} onLogout={handleLogout} />
      <main className="flex-1 min-w-0 flex flex-col gap-4">
        <DashboardHeader
          variant="superadmin"
          icon={<LayoutGrid className="w-[15px] h-[15px] text-muted-foreground" strokeWidth={1.75} />}
          title="Consola de Atiende"
          fecha={fechaCortaEsMx()}
          fechaIcon={<CalendarDays className="w-[15px] h-[15px]" strokeWidth={1.75} />}
          notificationBell={
            <NotificationBell
              items={notif.items}
              unreadCount={notif.unreadCount}
              loading={notif.loading}
              onOpenChange={(open) => {
                if (open) notif.refetch();
              }}
              onMarkRead={notif.onMarkRead}
              onMarkAllRead={notif.onMarkAllRead}
            />
          }
        />
        {children({ apiBaseUrl, token: session.token })}
      </main>
    </div>
  );
}

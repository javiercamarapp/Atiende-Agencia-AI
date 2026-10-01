// Shell del back office de plataforma — mismo patrón exacto que
// `HotelesShell.tsx`/`RestaurantesShell.tsx` (resuelve sesión, Sidebar real de
// `@atiende/ui`), pero SIN selector de organización/propiedad (aquí no hay
// "una" organización activa -- el superadmin ve TODAS a la vez) y sin
// `BotonChatDatos` (no aplica a un panel de plataforma, no de negocio).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Activity, AlertOctagon, Building2, CalendarDays, Coins, DollarSign, ExternalLink, KeyRound, LayoutGrid, LineChart, ListChecks, Newspaper, Plug, Power, Receipt, ReceiptText, ShieldAlert, ShieldCheck, ShieldOff, Tags, TrendingUp } from "lucide-react";
import { AtiendeWordmark, BottomNav, DashboardHeader, MobileHeader, NotificationBell, Sidebar } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { fechaCortaEsMx } from "../lib/formato-fecha.ts";
import { useNotifications } from "../lib/useNotifications.ts";
import { clearSuperadminSession, readPersistedSuperadminSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { MobileHeaderActions } from "../components/MobileHeaderActions.tsx";
import { ImpersonacionBanner } from "./components/ImpersonacionBanner.tsx";
import { StepUpDialog } from "./components/StepUpDialog.tsx";
import { limpiarStepUp } from "./lib/stepup.ts";

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
      { to: "/superadmin/gestion-organizaciones", label: "Gestión de organizaciones", icon: Building2 },
      { to: "/superadmin/interruptores", label: "Interruptores", icon: Power },
      { to: "/superadmin/seguridad", label: "Seguridad (MFA)", icon: KeyRound },
      { to: "/superadmin/resumen", label: "Resumen diario", icon: Newspaper },
      { to: "/superadmin/salud", label: "Salud operativa", icon: Activity },
      { to: "/superadmin/acciones", label: "Acciones", icon: ListChecks },
      { to: "/superadmin/prospectos", label: "Prospectos", icon: TrendingUp },
      { to: "/superadmin/gasto-api", label: "Gasto de API de LLM", icon: DollarSign },
      { to: "/superadmin/zona-cfo", label: "Zona CFO segura", icon: ShieldCheck },
      { to: "/superadmin/cfo", label: "Dashboard CFO", icon: LineChart },
      { to: "/superadmin/pyl", label: "P&L por vertical", icon: ReceiptText },
      { to: "/superadmin/costos-margen", label: "Costos y margen", icon: Coins },
      { to: "/superadmin/planes", label: "Planes y precios", icon: Tags },
      { to: "/superadmin/facturacion", label: "Facturación", icon: Receipt },
      { to: "/superadmin/break-glass", label: "Romper cristal", icon: AlertOctagon },
      { to: "/superadmin/impersonacion", label: "Impersonación", icon: ShieldAlert },
      { to: "/superadmin/auditoria-denegaciones", label: "Auditoría de denegaciones", icon: ShieldOff },
      { to: "/superadmin/integraciones", label: "Integraciones", icon: Plug },
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

  if (!resuelto) return null;
  if (!session) return null;

  return (
    <div className="min-h-screen bg-background flex gap-4 p-4">
      <Sidebar sections={SECTIONS} user={{ email: session.email, rol: loggingOut ? "Saliendo…" : "Superadmin" }} onLogout={handleLogout} />

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        action={<MobileHeaderActions notif={notif} user={{ email: session.email, rol: "Superadmin" }} onLogout={handleLogout} loggingOut={loggingOut} conChat={false} />}
      />

      <main className="flex-1 min-w-0 flex flex-col gap-4 pt-16 pb-24 md:pt-0 md:pb-0">
        <DashboardHeader
          className="hidden md:flex"
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
        <ImpersonacionBanner apiBaseUrl={apiBaseUrl} token={session.token} />
        <StepUpDialog />
        {children({ apiBaseUrl, token: session.token })}
      </main>

      {/* 17 destinos: la barra trae los 4 de uso diario y "Más" abre todos. */}
      <BottomNav
        items={[
          { to: "/superadmin", label: "Orgs", icon: Building2, end: true },
          { to: "/superadmin/resumen", label: "Resumen", icon: Newspaper },
          { to: "/superadmin/salud", label: "Salud", icon: Activity },
          { to: "/superadmin/acciones", label: "Acciones", icon: ListChecks },
        ]}
        moreSections={SECTIONS}
      />
    </div>
  );
}

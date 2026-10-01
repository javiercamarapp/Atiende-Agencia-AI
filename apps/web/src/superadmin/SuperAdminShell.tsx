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
import { Activity, AlertOctagon, ArrowLeftRight, Building2, Coins, DollarSign, FileSignature, KeyRound, LayoutDashboard, LayoutGrid, Lock, LineChart, ListChecks, Newspaper, Plug, Power, Receipt, ReceiptText, ShieldAlert, ShieldCheck, ShieldOff, Tags, TrendingUp } from "lucide-react";
import { NotificationBell, VerticalShell, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarPiePildora, SidebarSection } from "@atiende/ui";
import { logout } from "../lib/auth-client.ts";
import { fechaCortaEsMx } from "../lib/formato-fecha.ts";
import { useNotifications } from "../lib/useNotifications.ts";
import { clearSuperadminSession, readPersistedSuperadminSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { ImpersonacionBanner } from "./components/ImpersonacionBanner.tsx";
import { StepUpDialog } from "./components/StepUpDialog.tsx";
import { limpiarStepUp } from "./lib/stepup.ts";

export interface SuperAdminShellProps {
  readonly apiBaseUrl: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: { readonly apiBaseUrl: string; readonly token: string }) => ReactNode;
}

// UNI-6: el menú de HOY con el marco de Likida. Las categorías siguen el orden de Likida (Agentes, Negocio, Plataforma,
// Control, Sistema) con "Resumen" (/superadmin) como raíz sin título; las entradas son exactamente las de antes, solo
// reagrupadas, y "Entrar a los otros paneles" pasa al pie como "Ver los otros paneles". El menú objetivo de 41 entradas es un
// lote aparte (SA-L): aquí no se agrega ni se quita ninguna ruta.
const SECTIONS: SidebarSection[] = [
  {
    title: "Resumen",
    siempreAbierto: true,
    items: [{ to: "/superadmin", label: "Resumen", icon: LayoutDashboard, end: true }],
  },
  {
    title: "Agentes",
    items: [{ to: "/superadmin/gasto-api", label: "Gasto de API de LLM", icon: DollarSign }],
  },
  {
    title: "Negocio",
    items: [
      { to: "/superadmin/gestion-organizaciones", label: "Gestión de organizaciones", icon: Building2 },
      { to: "/superadmin/prospectos", label: "Prospectos", icon: TrendingUp },
      { to: "/superadmin/planes", label: "Planes y precios", icon: Tags },
      { to: "/superadmin/contratos", label: "Contratos por cliente", icon: FileSignature },
      { to: "/superadmin/facturacion", label: "Facturación", icon: Receipt },
      { to: "/superadmin/cfo", label: "Dashboard CFO", icon: LineChart },
      { to: "/superadmin/pyl", label: "P&L por vertical", icon: ReceiptText },
      { to: "/superadmin/costos-margen", label: "Costos y margen", icon: Coins },
      { to: "/superadmin/zona-cfo", label: "Zona CFO segura", icon: ShieldCheck },
    ],
  },
  {
    title: "Plataforma",
    items: [
      { to: "/superadmin/integraciones", label: "Integraciones", icon: Plug },
      { to: "/superadmin/interruptores", label: "Interruptores", icon: Power },
      { to: "/superadmin/acciones", label: "Acciones", icon: ListChecks },
    ],
  },
  {
    title: "Control",
    items: [
      { to: "/superadmin/seguridad", label: "Seguridad (MFA)", icon: KeyRound },
      { to: "/superadmin/privacidad", label: "Privacidad", icon: Lock },
      { to: "/superadmin/break-glass", label: "Romper cristal", icon: AlertOctagon },
      { to: "/superadmin/impersonacion", label: "Impersonación", icon: ShieldAlert },
      { to: "/superadmin/auditoria-denegaciones", label: "Auditoría de denegaciones", icon: ShieldOff },
    ],
  },
  {
    title: "Sistema",
    items: [
      { to: "/superadmin/salud", label: "Salud operativa", icon: Activity },
      { to: "/superadmin/resumen", label: "Resumen diario", icon: Newspaper },
    ],
  },
];

/** Pie del Sidebar (y sección "Cuenta" de la hoja "Más" en móvil): ambos destinos existen hoy y son reales. */
const SIDEBAR_PIE: SidebarPiePildora[] = [
  { label: "Costos de IA", to: "/superadmin/costos-margen" },
  { label: "Ver los otros paneles", to: "/superadmin/paneles", icon: ArrowLeftRight },
];

/** Barra inferior móvil: los 4 destinos de uso diario (etiquetas completas); el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las secciones. */
const MOBILE_ITEMS: BottomNavItem[] = [
  { to: "/superadmin", label: "Resumen", icon: LayoutDashboard, end: true },
  { to: "/superadmin/salud", label: "Salud", icon: Activity },
  { to: "/superadmin/acciones", label: "Acciones", icon: ListChecks },
  { to: "/superadmin/prospectos", label: "Prospectos", icon: TrendingUp },
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

  if (!resuelto) return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (!session) return null; // onRequireLogin ya disparó la redirección

  const user = { email: session.email, rol: loggingOut ? "Saliendo…" : "Superadmin", nombre: session.fullName, rolEtiqueta: loggingOut ? "Saliendo…" : "Superadmin" };
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

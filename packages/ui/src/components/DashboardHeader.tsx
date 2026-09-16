// Header compartido de panel de staff, dos variantes reales -- ver la
// investigación adjunta a esta fase (JSX real de AdminDashboard.tsx de
// atiende-restaurantes para "vertical" y de likida.ai/src/app/admin/consola.tsx
// + dashboard/resumen-visual.tsx::BarraPagina/ChipFecha para "superadmin"), NO
// una interpretación libre -- mismas clases, mismas medidas, por variante.
//
// "vertical" = ícono+título (h1 text-sm) a la izquierda; a la derecha, EN ESTE
// ORDEN: botón "Chatea con tus datos" (slot `chatButton`, típicamente
// `<BotonChatDatos />` de apps/web), la campana (slot `notificationBell`), la
// píldora de fecha SIN ícono (`font-mono text-xs ... rounded-full`) -- header
// h-12, borde inferior, fondo `bg-card`.
//
// "superadmin" = mismo layout general pero clonado de la Consola de Likida:
// título más chico (`text-[13px] font-medium`), SIN `chatButton` (no aplica a
// un panel de plataforma, no de negocio -- mismo criterio ya documentado en
// SuperAdminShell.tsx), la campana, y una píldora de fecha CON ícono opcional
// (`fechaIcon`, `rounded-lg` en vez de `rounded-full` -- así es el ChipFecha
// real de Likida) -- header h-11, `px-5` en vez de `px-4`.
//
// Deliberadamente "tonto" (mismo criterio que el resto de @atiende/ui): recibe
// `notificationBell`/`chatButton` ya armados como ReactNode (con su data/
// handlers reales ya conectados por quien monta el header), nunca hace fetch ni
// construye esos elementos por su cuenta.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface DashboardHeaderProps {
  readonly variant: "vertical" | "superadmin";
  /** Convención de tamaño por variante (la referencia real usa medidas distintas
   *  en cada una): en "vertical", `w-4 h-4 text-muted-foreground` (ej.
   *  `<LayoutGrid className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />`);
   *  en "superadmin", `w-[15px] h-[15px] text-muted-foreground` (el
   *  `ICONO_BARRA` real de Likida, 15x15). */
  readonly icon: ReactNode;
  readonly title: ReactNode;
  /** Texto ya formateado (ej. "16 sept 2026") — este componente no formatea
   *  fechas ni conoce locale, mismo criterio que el resto de @atiende/ui (sin
   *  dependencia de librería de fechas). */
  readonly fecha: string;
  /** Solo se pinta en variant="superadmin" — mismo slot que el `icono` de
   *  `ChipFecha` real de Likida (ej. `<CalendarDays .../>`). La píldora de
   *  variant="vertical" nunca lleva ícono en la referencia real, así que este
   *  prop se ignora ahí. */
  readonly fechaIcon?: ReactNode;
  /** `<NotificationBell .../>` ya armado, con `items`/`unreadCount`/handlers
   *  reales conectados por quien monta este header (ver @atiende/ui::NotificationBell). */
  readonly notificationBell: ReactNode;
  /** Solo se pinta en variant="vertical" (típicamente `<BotonChatDatos />` de
   *  apps/web) — la variante "superadmin" nunca lo muestra, mismo criterio ya
   *  documentado en SuperAdminShell.tsx: "no aplica a un panel de plataforma,
   *  no de negocio". */
  readonly chatButton?: ReactNode;
  readonly className?: string;
}

export function DashboardHeader({ variant, icon, title, fecha, fechaIcon, notificationBell, chatButton, className }: DashboardHeaderProps) {
  if (variant === "superadmin") {
    return (
      <header className={cn("flex items-center justify-between h-11 px-5 gap-3 shrink-0 border-b border-border bg-card", className)}>
        <div className="flex items-center gap-2 text-[13px] font-medium min-w-0 text-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <div className="flex items-center gap-2">
          {notificationBell}
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium px-3 h-8 rounded-lg border border-border bg-card shrink-0 text-foreground">
            {fechaIcon}
            {fecha}
          </span>
        </div>
      </header>
    );
  }

  return (
    <header className={cn("flex items-center justify-between h-12 px-4 shrink-0 border-b border-border bg-card", className)}>
      <h1 className="flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {title}
      </h1>
      <div className="flex items-center gap-2">
        {chatButton}
        {notificationBell}
        <span className="font-mono text-xs text-muted-foreground border border-border rounded-full px-3 py-1.5 shrink-0">{fecha}</span>
      </div>
    </header>
  );
}

// Campana de notificaciones compartida (6 verticales + superadmin) — mismo patrón
// visual EXACTO de campana que ya usa AdminDashboard.tsx de atiende-restaurantes
// (Bell de lucide-react + badge rojo numérico con `animate-pulse`, "999+" como
// techo), NO el punto rojo sin número de la Consola de Likida — pedido explícito
// de la fase de construcción de este componente (a diferencia del resto del
// header "superadmin", que sí clona Likida 1:1, la campana usa el mismo
// comportamiento numérico en las DOS variantes, para que un mismo componente
// sirva para ambas sin bifurcar visualmente el único elemento que además tiene
// backend real detrás).
//
// Deliberadamente "tonto"/controlado (mismo criterio que el resto de
// @atiende/ui, ej. Sidebar.tsx): no hace fetch, no conoce apiBaseUrl/token — solo
// pinta `items`/`unreadCount` y dispara los callbacks que ya trae. Quien lo monta
// (cada Shell de apps/web) es dueño de pedir GET /notifications y llamar a
// POST /notifications/:id/read · POST /notifications/read-all.
import { Bell } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { cn } from "../lib/utils";

export interface NotificationBellItem {
  readonly id: string;
  readonly titulo: string;
  readonly cuerpo: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, `null` = no leída — mismo shape que `NotificationRow` de `@atiende/db`. */
  readonly readAt: string | null;
  readonly vertical?: string | null;
}

export interface NotificationBellProps {
  readonly items: readonly NotificationBellItem[];
  readonly unreadCount: number;
  /** Mientras `GET /notifications` está en vuelo — pinta un estado de carga en vez
   *  de "Sin notificaciones" (que sería un falso negativo mientras carga). */
  readonly loading?: boolean;
  /** Se dispara al abrir/cerrar el dropdown — el caller lo usa típicamente para
   *  refrescar `items`/`unreadCount` justo al abrir (nunca lo hace este
   *  componente, que no conoce la red). */
  readonly onOpenChange?: (open: boolean) => void;
  readonly onMarkRead: (id: string) => void;
  readonly onMarkAllRead: () => void;
  readonly className?: string;
}

/** "hace un momento" / "hace Nh" / fecha corta — deliberadamente sin librería de
 *  fechas relativas (ninguna está instalada en @atiende/ui): mismo criterio de
 *  "usa lo que ya trae el proyecto" que el resto del design system. */
function formatRelativo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `hace ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias < 7) return `hace ${dias} d`;
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

export function NotificationBell({ items, unreadCount, loading, onOpenChange, onMarkRead, onMarkAllRead, className }: NotificationBellProps) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={unreadCount > 0 ? `Notificaciones: ${unreadCount} sin leer` : "Notificaciones"}
          className={cn(
            "relative w-8 h-8 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors shrink-0",
            className,
          )}
        >
          <Bell className="w-4 h-4" strokeWidth={1.75} />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-mono font-medium leading-4 text-center animate-pulse">
              {unreadCount > 999 ? "999+" : unreadCount}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Notificaciones</span>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                onMarkAllRead();
              }}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Marcar todas leídas
            </button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {loading ? (
            <p className="text-sm text-muted-foreground px-3 py-4 text-center">Cargando…</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground px-3 py-4 text-center">Sin notificaciones.</p>
          ) : (
            items.map((n) => {
              const noLeida = !n.readAt;
              return (
                <DropdownMenuItem
                  key={n.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    if (noLeida) onMarkRead(n.id);
                  }}
                  className={cn(
                    "flex flex-col items-stretch gap-0.5 px-3 py-2 whitespace-normal cursor-pointer rounded-none",
                    "hover:bg-muted hover:text-foreground focus:bg-muted focus:text-foreground",
                    noLeida && "bg-primary/5",
                  )}
                >
                  <div className="flex items-start gap-1.5 w-full">
                    {noLeida && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary shrink-0" aria-hidden />}
                    <span className={cn("text-[13px] leading-snug flex-1 min-w-0", noLeida ? "font-medium text-foreground" : "text-muted-foreground")}>{n.titulo}</span>
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">{formatRelativo(n.createdAt)}</span>
                  </div>
                  {n.cuerpo && <p className={cn("text-[12px] text-muted-foreground leading-snug", noLeida && "pl-3")}>{n.cuerpo}</p>}
                </DropdownMenuItem>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

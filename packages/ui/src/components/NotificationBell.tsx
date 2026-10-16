// Campana de notificaciones compartida (6 verticales + superadmin), identica a la de Likida
// (`admin/notificaciones.tsx`): NO abre un dropdown, lleva a la pagina de notificaciones, y avisa con un
// PUNTO rojo SIN numero cuando hay alguna sin leer; el punto se apaga al leerlas. El boton mide lo que el
// boton de barra de Likida (`dashboard/barra-acciones.tsx::BOTON_BARRA`): h-8 w-8, rounded-lg, hairline,
// Bell de 14 px (trazo 1.75), punto de 6 px (`size-1.5`) a `top-1 right-1` en `--bad` (`bg-destructive`).
//
// Deliberadamente "tonta"/controlada (mismo criterio que el resto de @atiende/ui, ej. Sidebar.tsx): no
// hace fetch ni conoce apiBaseUrl/token. Quien la monta (cada Shell de apps/web) pasa `hayNoLeidas`
// (sondeo del contador real, ver `useNotifications`) y `href` (la pagina de notificaciones de su consola).
import { Bell } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { CentroNotificaciones, type CentroNotificacionesProps } from "./CentroNotificaciones";

export interface NotificationBellProps {
  /** Ruta de la pagina de notificaciones de la consola (p. ej. `/restaurantes/mi-org/notificaciones`). */
  readonly href: string;
  /** `true` = hay al menos una notificacion sin leer: se pinta el punto rojo. Nunca un numero. */
  readonly hayNoLeidas: boolean;
  readonly className?: string;
  /**
   * Con `centro`, la campana abre el centro de notificaciones (popover con las recientes) en vez de
   * navegar; "Ver todas" lleva a `href`. Sin el, conserva el comportamiento de enlace de Likida.
   */
  readonly centro?: Omit<CentroNotificacionesProps, "href" | "hayNoLeidas" | "className">;
}

export function NotificationBell({ href, hayNoLeidas, className, centro }: NotificationBellProps) {
  if (centro) return <CentroNotificaciones href={href} hayNoLeidas={hayNoLeidas} className={className} {...centro} />;
  return (
    <Link
      to={href}
      aria-label={hayNoLeidas ? "Notificaciones: hay avisos sin leer" : "Notificaciones"}
      data-no-leidas={hayNoLeidas ? "true" : "false"}
      className={cn(
        "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground transition-colors hover:bg-canvas",
        className,
      )}
    >
      <Bell aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      {hayNoLeidas && <span data-testid="campana-punto" aria-hidden="true" className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" />}
    </Link>
  );
}

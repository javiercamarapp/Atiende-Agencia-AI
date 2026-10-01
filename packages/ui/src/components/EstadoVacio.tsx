import type { ComponentType } from "react";
import { Inbox } from "lucide-react";

import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

/**
 * Patrón "nunca inventar una cifra" (docs/referencia/06-backoffice-agentes-likida.md
 * §3.5, EstadoVacio de kit.tsx) portado literal para Atiende Hoteles: tarjeta
 * con ícono + mensaje cuando no hay dato real, en vez de simular un cero o
 * dejar la pantalla en blanco. REQ-UX-002.
 */
export function EstadoVacio({
  icon: Icon = Inbox,
  titulo = "Sin datos aún",
  mensaje,
  accion,
  compacto = false,
  className,
}: {
  icon?: IconType;
  titulo?: string;
  mensaje: string;
  accion?: React.ReactNode;
  /** Menos aire vertical, para vacíos dentro de una tarjeta o tabla. */
  compacto?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-card/50 px-6 text-center",
        compacto ? "py-6" : "py-12",
        className,
      )}
    >
      <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
        <Icon className="w-5 h-5" strokeWidth={1.75} />
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">{titulo}</p>
        <p className="mt-1 text-sm text-muted-foreground max-w-sm">{mensaje}</p>
      </div>
      {accion}
    </div>
  );
}

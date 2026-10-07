import type { ComponentType } from "react";
import { Info } from "lucide-react";

import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

/**
 * Estado vacio identico al `EstadoVacio` de Likida (kit.tsx; spec UNI-3c 6.5):
 * tarjeta p-4 con chip de icono de 36 px (canvas + hairline, icono de 17 px en el
 * color de marca) y el texto a la derecha. Patron "nunca inventar una cifra":
 * se muestra cuando no hay dato real, en vez de simular un cero o dejar la
 * pantalla en blanco. REQ-UX-002.
 */
export function EstadoVacio({
  icon: Icon = Info,
  titulo = "Sin datos aún",
  mensaje,
  accion,
  compacto = false,
  tituloH1 = false,
  className,
}: {
  icon?: IconType;
  titulo?: string;
  mensaje: string;
  accion?: React.ReactNode;
  /** Relleno p-3 en lugar de p-4, para vacíos dentro de una tarjeta o tabla. */
  compacto?: boolean;
  /** El título es el único encabezado de nivel 1 de la pantalla (p. ej. un 404 dentro del shell): se pinta como `<h1>` con el mismo aspecto. */
  tituloH1?: boolean;
  className?: string;
}) {
  return (
    <div role="status" className={cn("card flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card shadow-card", compacto ? "p-3" : "p-4", className)}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas">
        <Icon className="size-[17px] text-primary" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 pt-1 text-sm">
        {tituloH1 ? <h1 className="font-medium text-foreground">{titulo}</h1> : <p className="font-medium text-foreground">{titulo}</p>}
        <p className="mt-0.5 text-muted-foreground">{mensaje}</p>
        {accion ? <div className="mt-2">{accion}</div> : null}
      </div>
    </div>
  );
}

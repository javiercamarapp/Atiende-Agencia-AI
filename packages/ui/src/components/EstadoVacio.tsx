import type { ComponentType } from "react";
import { Info } from "lucide-react";

import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

/**
 * Estado vacio (por defecto el centrado del repo suelto; `variante="fila"` es el de Likida) (kit.tsx; spec UNI-3c 6.5):
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
  variante = "centrado",
  className,
}: {
  icon?: IconType;
  titulo?: string;
  mensaje: string;
  accion?: React.ReactNode;
  /** Relleno p-3 en lugar de p-4, para vacíos dentro de una tarjeta o tabla. */
  compacto?: boolean;
  /**
   * "centrado" (por defecto, el del repo suelto): icono grande tenue centrado, texto debajo, `py-10`.
   * "fila": chip de icono a la izquierda y texto a la derecha, para vacios dentro de una lista o celda.
   */
  variante?: "centrado" | "fila";
  className?: string;
}) {
  if (variante === "centrado") {
    return (
      <div role="status" className={cn("card grid min-w-0 justify-items-center gap-1 rounded-lg border border-border bg-card px-4 text-center", compacto ? "py-6" : "py-10", className)}>
        <Icon aria-hidden="true" className="mb-2 size-10 text-muted-foreground/40" strokeWidth={1.5} />
        <p className="text-sm font-medium text-foreground">{titulo}</p>
        <p className="max-w-sm text-ui text-muted-foreground">{mensaje}</p>
        {accion ? <div className="mt-3">{accion}</div> : null}
      </div>
    );
  }
  return (
    <div role="status" className={cn("card flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card shadow-card", compacto ? "p-3" : "p-4", className)}>
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas">
        <Icon className="size-[17px] text-primary" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1 pt-1 text-sm">
        <p className="font-medium text-foreground">{titulo}</p>
        <p className="mt-0.5 text-muted-foreground">{mensaje}</p>
        {accion ? <div className="mt-2">{accion}</div> : null}
      </div>
    </div>
  );
}

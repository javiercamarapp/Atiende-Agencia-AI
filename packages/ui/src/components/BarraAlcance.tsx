// Barra de alcance de una pantalla (ds3, §4.3 del shell): UNA sola linea bajo el PageHeader con controles de 32 px -- segmentado de
// periodo, «Filtros (n)», chips quitables de lo activo, espaciador y acciones a la derecha. Nunca hace wrap: si no cabe, se desplaza en
// horizontal DENTRO de la barra (sin barra de scroll visible) y la pagina no gana scroll horizontal. Es un contenedor sin datos: cada
// pantalla pone sus controles reales (no hay filtros maqueta).
import * as React from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { cn } from "../lib/utils";

export interface BarraAlcanceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Nombre accesible del grupo. @default "Alcance y filtros" */
  readonly etiqueta?: string;
}

export function BarraAlcance({ etiqueta = "Alcance y filtros", className, children, ...resto }: BarraAlcanceProps) {
  return (
    <div
      role="group"
      aria-label={etiqueta}
      className={cn(
        "ds3-alcance flex min-w-0 max-w-full items-center gap-2 overflow-x-auto overscroll-x-contain whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...resto}
    >
      {children}
    </div>
  );
}

/** Empuja lo que sigue al extremo derecho de la barra. */
export function BarraAlcanceEspaciador() {
  return <span aria-hidden="true" className="ds3-alcance-espaciador ml-auto shrink-0" />;
}

export interface BotonFiltrosProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Filtros activos; con 0 no se muestra el numero. */
  readonly activos?: number;
}

/** «Filtros (n)»: abre el panel de filtros de la pantalla (lo decide `onClick`). Alto de control de 32 px. */
export const BotonFiltros = React.forwardRef<HTMLButtonElement, BotonFiltrosProps>(function BotonFiltros({ activos = 0, className, ...resto }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-haspopup="dialog"
      className={cn(
        "ds3-alcance-filtros inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-ui font-medium text-foreground transition-colors duration-fast ease-brand hover:bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...resto}
    >
      <SlidersHorizontal aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
      Filtros{activos > 0 ? ` (${activos})` : ""}
    </button>
  );
});

export interface ChipFiltroProps {
  /** Texto del filtro activo, p. ej. «Sucursal: Centro». */
  readonly etiqueta: string;
  readonly onQuitar: () => void;
}

/** Chip de un filtro activo con su boton de quitar (28 px de alto; el boton tiene nombre accesible propio). */
export function ChipFiltro({ etiqueta, onQuitar }: ChipFiltroProps) {
  return (
    <span className="ds3-alcance-chip inline-flex h-7 max-w-[240px] shrink-0 items-center gap-1 rounded-full border border-border bg-card pl-2.5 pr-0.5 text-xs font-medium text-foreground">
      <span className="truncate">{etiqueta}</span>
      <button
        type="button"
        onClick={onQuitar}
        aria-label={`Quitar filtro ${etiqueta}`}
        className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast ease-brand hover:bg-soft hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-3" strokeWidth={2} />
      </button>
    </span>
  );
}

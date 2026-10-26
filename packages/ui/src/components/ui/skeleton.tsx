import { DISENO_DS3 } from "../../lib/diseno";
import { cn } from "../../lib/utils";

// `ds-skeleton` es el barrido de brillo de Likida (index.css): lleva su propia
// animacion y degradado, asi que ya no hace falta el pulso de Tailwind.
// ds3: sin esqueletos con forma (decision #1); queda un hueco transparente que conserva las medidas para no mover el
// layout, y el logo lo pinta la region que carga (RegionCargando / EstadoCargando).
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  if (DISENO_DS3) return <div aria-hidden="true" className={cn("rounded-md", className)} {...props} />;
  return <div className={cn("ds-skeleton rounded-md bg-canvas", className)} {...props} />;
}

export { Skeleton };

import { cn } from "../../lib/utils";

// `ds-skeleton` es el barrido de brillo de Likida (index.css): lleva su propia
// animacion y degradado, asi que ya no hace falta el pulso de Tailwind.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ds-skeleton rounded-md bg-canvas", className)} {...props} />;
}

export { Skeleton };

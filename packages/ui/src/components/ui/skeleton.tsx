import { cn } from "../../lib/utils";

// `ds-skeleton` engancha el barrido de brillo de DS v2 (index.css, solo con
// data-theme="v2"); sin la bandera sigue el animate-pulse de siempre.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ds-skeleton animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };

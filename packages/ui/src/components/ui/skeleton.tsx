import { cn } from "../../lib/utils";

// `ds-skeleton` engancha el barrido de brillo de Likida (index.css).
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ds-skeleton animate-pulse rounded-md bg-muted", className)} {...props} />;
}

export { Skeleton };

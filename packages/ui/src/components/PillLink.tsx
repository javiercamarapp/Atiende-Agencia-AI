// Pildora "Ver ... ->" de Likida (`VerMas`, admin/ui/kit.tsx:267-275): borde hairline, 12 px,
// `rounded-full`, texto ink2 y flecha de 12 px gris. Vive bajo un grupo de metricas y lleva a la
// pantalla donde se profundiza. Es un `Link` de react-router (ruta real, nunca un handler vacio).
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";

export interface PillLinkProps {
  /** Ruta de react-router de la pantalla de destino. */
  readonly to: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function PillLink({ to, children, className }: PillLinkProps) {
  return (
    <Link
      to={to}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground-2 transition-colors hover:bg-canvas",
        className,
      )}
    >
      {children}
      <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" strokeWidth={1.75} />
    </Link>
  );
}

// Tile de navegacion de los Resumenes: el enlace de "Orquestacion de agentes" de Likida
// (admin/consola.tsx:291-300). Icono de 15 px, titulo de 13 px con flecha de 13 px a la derecha y
// descripcion de 12 px. El tile solo navega: la descripcion la inyecta la pagina con datos reales
// (o un texto honesto de "sin dato"), nunca esta pieza.
import type { ComponentType, ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

export interface TileLinkProps {
  /** Ruta de react-router de la pantalla de destino. */
  readonly to: string;
  readonly icon: IconType;
  readonly titulo: string;
  readonly descripcion?: ReactNode;
  /** Insignia opcional (p. ej. un `StatusBadge`) entre el titulo y la flecha. */
  readonly badge?: ReactNode;
  readonly className?: string;
}

export function TileLink({ to, icon: Icon, titulo, descripcion, badge, className }: TileLinkProps) {
  return (
    <Link
      to={to}
      className={cn("flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:bg-canvas", className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-[15px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-ui font-medium text-foreground">{titulo}</span>
          {badge !== undefined && <span className="shrink-0">{badge}</span>}
          <ArrowRight aria-hidden="true" className="ml-auto size-[13px] shrink-0 text-muted-foreground" strokeWidth={1.75} />
        </div>
        {descripcion !== undefined && <p className="mt-0.5 text-xs text-muted-foreground">{descripcion}</p>}
      </div>
    </Link>
  );
}

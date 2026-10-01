// Rotulo de seccion de los Resumenes: `TituloSeccion` de Likida (dashboard/resumen-visual.tsx:28),
// 11 px en la mono de etiqueta, mayusculas, gris. En Atiende `text-eyebrow` = 11 px (spec §2).
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface SectionLabelProps {
  readonly children: ReactNode;
  /** Elemento. Por defecto `h2` (el unico `h1` de la pantalla es el saludo). */
  readonly as?: "h2" | "h3" | "p" | "span";
  readonly id?: string;
  readonly className?: string;
}

export function SectionLabel({ children, as: Tag = "h2", id, className }: SectionLabelProps) {
  return (
    <Tag id={id} className={cn("etiqueta-mono text-eyebrow font-medium uppercase text-muted-foreground", className)}>
      {children}
    </Tag>
  );
}

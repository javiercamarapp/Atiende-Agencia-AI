import * as React from "react";
import { cva } from "class-variance-authority";

import { cn } from "../../lib/utils";

/**
 * Tono semántico de un estado de negocio. Cada vertical mantiene su tabla
 * `estado -> tono` (p. ej. { pagado: "success", vencido: "danger" }) y deja
 * de escribir pares de colores crudos.
 */
export const STATUS_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type StatusTone = (typeof STATUS_TONES)[number];

const statusBadgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        neutral: "bg-canvas text-muted-foreground",
        info: "bg-info-tint text-info",
        success: "bg-success-tint text-success",
        warning: "bg-warning-tint text-warning",
        danger: "bg-destructive-tint text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface StatusBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  tone?: StatusTone;
  /** Punto de color antes del texto (por defecto sí; tinta de Likida, tamano size-1.5): refuerza el tono sin depender solo del color, el texto sigue siendo la señal accesible. */
  dot?: boolean;
}

export function StatusBadge({ tone = "neutral", dot = true, className, children, ...props }: StatusBadgeProps) {
  return (
    <span data-tone={tone} className={cn(statusBadgeVariants({ tone }), className)} {...props}>
      {dot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/**
 * Busca el tono de un estado en la tabla de la vertical; un estado que aún no
 * conoce la tabla cae a `fallback` (neutral) en vez de romper o pintarse mal.
 */
export function statusTone<K extends string>(tabla: Readonly<Partial<Record<K, StatusTone>>>, estado: K | null | undefined, fallback: StatusTone = "neutral"): StatusTone {
  return (estado != null ? tabla[estado] : undefined) ?? fallback;
}

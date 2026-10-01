import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, X } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "../lib/utils";

export const CALLOUT_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

const calloutVariants = cva("flex items-start gap-3 rounded-card border p-4 text-sm", {
  variants: {
    tone: {
      neutral: "border-border bg-muted",
      info: "border-info/30 bg-info-tint",
      success: "border-success/30 bg-success-tint",
      warning: "border-warning/30 bg-warning-tint",
      danger: "border-destructive/30 bg-destructive-tint",
    },
  },
  defaultVariants: { tone: "info" },
});

const iconoPorTono: Record<CalloutTone, { Icono: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>; clase: string }> = {
  neutral: { Icono: Info, clase: "text-muted-foreground" },
  info: { Icono: Info, clase: "text-info" },
  success: { Icono: CheckCircle2, clase: "text-success" },
  warning: { Icono: AlertTriangle, clase: "text-warning" },
  danger: { Icono: OctagonAlert, clase: "text-destructive" },
};

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: CalloutTone;
  titulo?: React.ReactNode;
  /** Reemplaza el icono del tono. */
  icon?: React.ReactNode;
  /** Botón o enlace de acción alineado a la derecha del texto. */
  accion?: React.ReactNode;
  /** Con handler, muestra una "x" para cerrar el aviso. */
  onDismiss?: () => void;
}

/**
 * Aviso persistente de negocio dentro de la página (p. ej. "falta subir la
 * constancia fiscal"). No es un toast (efímero) ni un error de campo (inline):
 * ver regla de feedback 4.7 de diseno-ux. `danger` usa role="alert"; el resto
 * role="status" (no interrumpe al lector de pantalla).
 */
export function Callout({ tone = "info", titulo, icon, accion, onDismiss, className, children, role, ...props }: CalloutProps) {
  const { Icono, clase } = iconoPorTono[tone];
  return (
    <div role={role ?? (tone === "danger" ? "alert" : "status")} data-tone={tone} className={cn(calloutVariants({ tone }), className)} {...props}>
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", clase)}>{icon ?? <Icono className="size-4" aria-hidden="true" />}</span>
      <div className="min-w-0 flex-1">
        {titulo && <p className="font-semibold text-foreground">{titulo}</p>}
        {children && <div className={cn("text-foreground/80", titulo && "mt-0.5")}>{children}</div>}
      </div>
      {accion && <div className="shrink-0">{accion}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cerrar aviso"
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors duration-fast ease-brand hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

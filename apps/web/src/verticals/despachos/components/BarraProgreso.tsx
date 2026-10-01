// Barra de avance de despachos (cierre mensual, score de cobranza) sobre el <progress> nativo:
// el ancho dinamico no necesita `style={{ width }}` (el DS v2 prohibe estilos inline) y el
// elemento ya es accesible (role progressbar, valor y rango). El color sale de tokens.
import { cn } from "@atiende/ui";

export type BarraProgresoTono = "primary" | "success" | "warning" | "danger";

const TONOS: Readonly<Record<BarraProgresoTono, string>> = {
  primary: "[&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary",
  success: "[&::-webkit-progress-value]:bg-success [&::-moz-progress-bar]:bg-success",
  warning: "[&::-webkit-progress-value]:bg-warning [&::-moz-progress-bar]:bg-warning",
  danger: "[&::-webkit-progress-value]:bg-destructive [&::-moz-progress-bar]:bg-destructive",
};

export interface BarraProgresoProps {
  /** Porcentaje 0-100 (se acota). */
  readonly valor: number;
  readonly tono?: BarraProgresoTono;
  readonly className?: string;
  readonly "aria-label"?: string;
}

export function BarraProgreso({ valor, tono = "primary", className, "aria-label": ariaLabel }: BarraProgresoProps) {
  const pct = Math.min(100, Math.max(0, Math.round(valor)));
  return (
    <progress
      value={pct}
      max={100}
      aria-label={ariaLabel}
      className={cn(
        "block h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-muted [&::-webkit-progress-bar]:bg-muted",
        TONOS[tono],
        className,
      )}
    />
  );
}

// Barra de % del Cerebro (la `Barra` de cerebro.tsx de Likida): etiqueta, trazo con su animacion de llenado y el numero. El ancho va como
// ATRIBUTO de un <rect> (no como estilo en linea: lo prohibe el DS v2) y se anima por CSS. Un score `null` es "sin calificar": se dice con
// palabras, nunca como una barra vacia ni como 0%.
import { cn } from "@atiende/ui";

export type TonoBarra = "warning" | "success" | "primary" | "info";

const RELLENO: Readonly<Record<TonoBarra, string>> = {
  warning: "fill-warning",
  success: "fill-success",
  primary: "fill-primary",
  info: "fill-info",
};

export function BarraScore({ etiqueta, pct, tono, className }: { readonly etiqueta: string; readonly pct: number | null; readonly tono: TonoBarra; readonly className?: string }) {
  if (pct === null) {
    return (
      <div className={cn("flex items-center gap-2 text-eyebrow text-muted-foreground", className)}>
        <span className="w-14 shrink-0">{etiqueta}</span>
        <span className="flex-1 italic">sin calificar</span>
      </div>
    );
  }
  const v = Math.min(100, Math.max(0, Math.round(pct)));
  return (
    <div className={cn("flex items-center gap-2 text-eyebrow text-muted-foreground", className)}>
      <span className="w-14 shrink-0">{etiqueta}</span>
      <svg role="progressbar" aria-label={etiqueta} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} className="h-1.5 flex-1 overflow-hidden rounded-full" preserveAspectRatio="none">
        <rect width="100%" height="100%" className="fill-border" />
        <rect width={`${v}%`} height="100%" className={cn("cerebro-llenado", RELLENO[tono])} />
      </svg>
      <span className="w-9 text-right font-medium tabular-nums text-foreground">{v}%</span>
    </div>
  );
}

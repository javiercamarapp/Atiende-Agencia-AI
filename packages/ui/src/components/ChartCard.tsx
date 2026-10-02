// Tarjeta contenedora de una grafica (Likida `ChartCard`): titulo en mayusculas de 12 px que envuelve a dos
// lineas antes de recortar, subtitulo, accion opcional (p. ej. `GlobalFilter`) y un alto minimo por tamano.
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";

const ALTURA_TAMANO = { S: 120, M: 200, L: 280, XL: 380 } as const;
export type ChartCardTamano = keyof typeof ALTURA_TAMANO;

export interface ChartCardProps {
  readonly titulo: string;
  readonly subtitulo?: string;
  readonly tamano?: ChartCardTamano;
  /** Variante "soft": fondo `--canvas` y sin sombra, para piezas secundarias que no compiten con la dominante. */
  readonly soft?: boolean;
  readonly accion?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function ChartCard({ titulo, subtitulo, tamano = "M", soft = false, accion, children, className }: ChartCardProps) {
  return (
    <Card data-testid="chart-card" className={cn("rounded-2xl p-4", soft && "border-line2 bg-canvas shadow-none", className)}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{titulo}</h3>
          {subtitulo && <p className="mt-0.5 text-xs text-faint">{subtitulo}</p>}
        </div>
        {accion}
      </div>
      <div style={{ minHeight: ALTURA_TAMANO[tamano] }}>{children}</div>
    </Card>
  );
}

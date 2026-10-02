// KPI con sparkline de Likida (`admin/ui/kit.tsx` KpiTile): chip de icono, cifra grande, etiqueta que puede
// envolver a dos lineas y, tras un divisor punteado, la serie real con su tendencia. `valor === null` = no
// medible: pinta "-" y el motivo en `vacio`, NUNCA un 0 con cara de medicion; la serie solo se dibuja si
// la pagina la trae real (nunca un sparkline plano de relleno).
import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { resolverFormato, type FormatoPreset } from "../lib/formato-preset";
import { Card } from "./ui/card";
import { SparklineConsola, Tendencia } from "./graficas";

export interface KpiTileProps {
  /** Elemento ya armado (`<Icon className="size-[15px]" strokeWidth={1.75} />`). */
  readonly icono: ReactNode;
  readonly etiqueta: string;
  /** `null` = no medible. */
  readonly valor: number | null;
  readonly formato?: FormatoPreset;
  /** Variacion % contra el periodo previo; `null` = sin historia suficiente. Omitida = sin concepto de tendencia. */
  readonly tendencia?: number | null;
  readonly sparkline?: readonly number[];
  /** Por que no hay serie ("sin historia suficiente"). */
  readonly vacio?: string;
  /** Nota fija de una linea (cita, aclaracion del supuesto): se pinta siempre que se pasa. */
  readonly nota?: string;
  readonly className?: string;
}

export function KpiTile({ icono, etiqueta, valor, formato = "numero", tendencia, sparkline, vacio, nota, className }: KpiTileProps) {
  const noMedible = valor === null || !Number.isFinite(valor);
  const texto = noMedible ? "—" : resolverFormato(formato)(valor);
  return (
    <Card className={cn("min-w-0 p-3.5", className)}>
      <div className="flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas">{icono}</div>
        <div className="min-w-0">
          <div
            data-testid="kpi-tile-valor"
            className={cn("min-w-0 truncate font-display text-xl font-semibold leading-tight tabular-nums", noMedible && "text-faint")}
            title={noMedible ? undefined : texto}
            aria-label={noMedible ? `${etiqueta}: sin dato` : undefined}
          >
            {texto}
          </div>
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{etiqueta}</div>
        </div>
      </div>
      {vacio ? (
        <p className="mt-2 text-xs text-faint">{vacio}</p>
      ) : sparkline && sparkline.length > 1 ? (
        <div className="mt-2 flex items-center gap-2 border-t border-dashed border-line2 pt-2">
          <div className="min-w-0 flex-1">
            <SparklineConsola valores={sparkline} alto={20} />
          </div>
          {tendencia !== undefined && <Tendencia valor={tendencia} />}
        </div>
      ) : null}
      {nota && <p className="mt-2 text-xs text-faint">{nota}</p>}
    </Card>
  );
}

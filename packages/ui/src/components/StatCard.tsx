import { cn } from "../lib/utils";
import { Card } from "./ui/card";

type IconType = React.ComponentType<{ className?: string; strokeWidth?: number | string }>;

/** Variacion contra el periodo anterior. `bueno` decide el color (subir un costo no es una buena noticia). */
export interface StatCardDelta {
  readonly pct: number;
  readonly bueno: boolean;
}

export interface StatCardProps {
  icon: IconType;
  label: string;
  value: string;
  /** Linea de pie libre. Si empieza con "+" se pinta en verde y con "-" en rojo (compatibilidad); en cualquier otro caso, en gris tenue. */
  nota?: string;
  /**
   * Variacion contra el periodo anterior (pie con `↑`/`↓`). `null` = se intento comparar y no hay base:
   * el pie dice "sin periodo comparable" en vez de inventar un "0 %". Omitido = sin concepto de comparativo.
   */
  delta?: StatCardDelta | null;
  /** Texto del periodo de la variacion (ej. "vs mes anterior"). */
  deltaNota?: string;
  /** Razón por la que no hay cifra real todavía (ej. "Pendiente de credenciales del PMS"). Si se pasa, la tarjeta ignora `value`/`nota`/`delta` y muestra "—" con esta explicación. */
  sinDato?: string;
  /**
   * `neutra` = la tarjeta de la consola de Likida tal cual (`admin/ui/kit.tsx` StatCard): chip de icono de 28 px con
   * esquina `rounded-lg`, en el acento de Atiende (`bg-primary`) donde Likida usa tinta negra. Sin ella (`marca`) el chip es
   * circular, como en los Resumenes de las verticales. El resto (cifra, pie punteado, delta en texto) es identico.
   */
  variante?: StatCardVariante;
  className?: string;
}

export type StatCardVariante = "marca" | "neutra";

/**
 * KPI de dos capas de Likida (admin/ui/kit.tsx:160-208): tarjeta exterior blanca
 * (`card p-2`) con una tarjeta interior de borde fino (icono en circulo azul de
 * Atiende, etiqueta gris, cifra grande) y, debajo, un pie tras divisor punteado.
 * Con la disciplina de "nunca inventar una cifra": sin dato real muestra "—" y dice por que.
 */
export function StatCard({ icon: Icon, label, value, nota, delta, deltaNota = "vs periodo anterior", sinDato, variante = "marca", className }: StatCardProps) {
  const mostrarSinDato = Boolean(sinDato);
  const pie = pieDe({ mostrarSinDato, sinDato, delta, deltaNota, nota });
  return (
    <Card className={cn("flex h-full min-w-0 flex-col p-2", className)}>
      <div className="min-w-0 rounded-xl border border-line2 bg-canvas px-3 py-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div data-testid="stat-card-chip" className={cn("flex size-7 shrink-0 items-center justify-center bg-primary text-primary-foreground", variante === "neutra" ? "rounded-lg" : "rounded-full")}>
            <Icon className="size-[15px]" strokeWidth={1.75} />
          </div>
          <span className="line-clamp-2 min-w-0 flex-1 text-ui text-muted-foreground">{label}</span>
        </div>
        <p
          className={cn("mt-0.5 min-w-0 truncate font-display text-xl font-semibold leading-tight tabular-nums", mostrarSinDato ? "text-faint" : "text-foreground")}
          title={mostrarSinDato ? undefined : value}
          aria-label={mostrarSinDato ? `${label}: sin dato` : undefined}
        >
          {mostrarSinDato ? "—" : value}
        </p>
      </div>
      {/* El espaciador alinea los pies en una fila de tarjetas parejas aunque una etiqueta envuelva a dos lineas. */}
      <div className="grow" />
      {pie && <div className="mx-1.5 mt-1.5 border-t border-dashed border-line2 pt-1.5 text-xs">{pie}</div>}
    </Card>
  );
}

function pieDe({
  mostrarSinDato,
  sinDato,
  delta,
  deltaNota,
  nota,
}: {
  mostrarSinDato: boolean;
  sinDato?: string;
  delta?: StatCardDelta | null;
  deltaNota: string;
  nota?: string;
}): React.ReactNode {
  if (mostrarSinDato) return <p className="text-faint">{sinDato}</p>;
  if (delta) {
    const cero = delta.pct === 0;
    return (
      <p className="flex min-w-0 items-baseline gap-1.5">
        <span className={cn("shrink-0 font-medium tabular-nums", cero ? "text-faint" : delta.bueno ? "text-success" : "text-destructive")}>
          {cero ? "" : delta.pct > 0 ? "↑ " : "↓ "}
          {Math.abs(delta.pct)}%
        </span>
        <span className="truncate text-faint">{cero ? "sin cambio vs periodo anterior" : deltaNota}</span>
      </p>
    );
  }
  if (nota) {
    const t = nota.trim();
    return <p className={t.startsWith("+") ? "text-success" : t.startsWith("-") ? "text-destructive" : "text-faint"}>{nota}</p>;
  }
  if (delta === null) return <p className="text-faint">sin periodo comparable</p>;
  return null;
}

export interface TrendStatCardProps {
  icon: IconType;
  label: string;
  value: string;
  /** Variacion porcentual contra el periodo anterior; subir se pinta como bueno. Omitido = sin pie de tendencia. */
  deltaPct?: number;
  deltaLabel?: string;
  sinDato?: string;
  variante?: StatCardVariante;
  className?: string;
}

/** KPI con tendencia: la misma tarjeta de dos capas con el pie `↑ 12 % vs periodo anterior`. */
export function TrendStatCard({ icon, label, value, deltaPct, deltaLabel = "vs periodo anterior", sinDato, variante, className }: TrendStatCardProps) {
  return (
    <StatCard
      icon={icon}
      label={label}
      value={value}
      sinDato={sinDato}
      variante={variante}
      className={className}
      delta={deltaPct === undefined ? undefined : { pct: Math.round(deltaPct * 10) / 10, bueno: deltaPct >= 0 }}
      deltaNota={deltaLabel}
    />
  );
}

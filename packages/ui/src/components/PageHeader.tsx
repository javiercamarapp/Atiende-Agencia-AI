import * as React from "react";
import { ArrowLeft, ChevronRight, Info } from "lucide-react";
import { Link } from "react-router-dom";

import { cn } from "../lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

/**
 * Grupo del menu de la pantalla activa (lo provee `VerticalShell`). Con la bandera ds3 el PageHeader lo muestra como antetitulo cuando la
 * pantalla no pasa `eyebrow` propio. Se pinta por CSS (data-eyebrow) para no duplicar el texto del menu en el DOM.
 */
export const GrupoNavContext = React.createContext<string | null>(null);

export interface PageHeaderMiga {
  readonly etiqueta: string;
  /** Ruta de react-router. La ultima miga (pagina actual) no lleva `to`. */
  readonly to?: string;
}

export interface PageHeaderAtras {
  /** @default "Volver" */
  readonly etiqueta?: string;
  readonly to: string;
}

export interface PageHeaderProps {
  /** El unico `<h1>` de la pantalla. */
  readonly titulo: React.ReactNode;
  readonly descripcion?: React.ReactNode;
  /** Botones de la pantalla (CTA primario a la derecha en escritorio, debajo del titulo en movil). */
  readonly acciones?: React.ReactNode;
  readonly migas?: readonly PageHeaderMiga[];
  readonly atras?: PageHeaderAtras;
  /** Metadatos bajo el titulo (estado, fecha, id...). */
  readonly meta?: React.ReactNode;
  /** Antetitulo corto sobre el `<h1>` (12 px, mayusculas), p. ej. «Ficha del cliente». Opcional. */
  readonly eyebrow?: React.ReactNode;
  /**
   * Guia de lectura de la pantalla: con ella, junto a la descripcion aparece «¿Cómo leer esto?», que abre un Popover de 340 px con
   * estas viñetas. Solo para pantallas con cifras derivadas. Opcional.
   */
  readonly guia?: readonly React.ReactNode[];
  readonly className?: string;
}

/**
 * Cabecera de pagina identica a `HeroSaludo` de Likida: `<h1>` de 20 px, descripcion
 * `text-ui` y acciones a la derecha (debajo en movil), con migas y enlace "atras" opcionales.
 * Es el unico `<h1>` de la pantalla; `BarraPagina` pinta el nombre de la pagina en un `<p>`.
 */
export function PageHeader({ titulo, descripcion, acciones, migas, atras, meta, eyebrow, guia, className }: PageHeaderProps) {
  const grupoNav = React.useContext(GrupoNavContext);
  return (
    <header className={cn("ds3-encabezado grid gap-2.5", className)}>
      {migas && migas.length > 0 && (
        <nav aria-label="Migas de pan">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {migas.map((m, i) => {
              const ultima = i === migas.length - 1;
              return (
                <li key={`${i}-${m.etiqueta}`} className="flex items-center gap-1">
                  {m.to && !ultima ? (
                    <Link to={m.to} className="rounded-sm underline-offset-4 transition-colors duration-fast ease-brand hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {m.etiqueta}
                    </Link>
                  ) : (
                    <span aria-current={ultima ? "page" : undefined} className={cn(ultima && "font-medium text-foreground")}>
                      {m.etiqueta}
                    </span>
                  )}
                  {!ultima && <ChevronRight aria-hidden="true" className="size-3.5" />}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      {atras && (
        <Link
          to={atras.to}
          className="inline-flex w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground transition-colors duration-fast ease-brand hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {atras.etiqueta ?? "Volver"}
        </Link>
      )}

      <div className="ds3-encabezado-fila flex flex-col gap-2.5 md:flex-row md:items-start md:justify-between md:gap-3 min-w-0">
        <div className="ds3-encabezado-texto min-w-0">
          {eyebrow !== undefined ? (
            <p className="ds3-encabezado-eyebrow text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{eyebrow}</p>
          ) : grupoNav ? (
            <p hidden data-eyebrow={grupoNav} data-testid="encabezado-eyebrow-derivado" className="ds3-solo ds3-encabezado-eyebrow ds3-eyebrow-derivado" />
          ) : null}
          <h1 className="ds3-encabezado-titulo font-display text-xl font-semibold truncate text-foreground">{titulo}</h1>
          {descripcion !== undefined && <p className="ds3-encabezado-descripcion text-ui text-muted-foreground mt-1 truncate">{descripcion}</p>}
          {guia && guia.length > 0 && (
            <Popover>
              <PopoverTrigger className="ds3-encabezado-guia mt-1 inline-flex items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground transition-colors duration-fast ease-brand hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Info aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
                ¿Cómo leer esto?
              </PopoverTrigger>
              <PopoverContent align="start" className="ds3-popover-guia w-[340px]">
                <ul className="grid list-disc gap-1.5 pl-4 text-ui">
                  {guia.map((punto, i) => (
                    <li key={i}>{punto}</li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          )}
          {meta !== undefined && <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{meta}</div>}
        </div>
        {acciones !== undefined && <div className="ds3-encabezado-acciones flex shrink-0 flex-wrap items-center gap-2.5 md:pt-1">{acciones}</div>}
      </div>
    </header>
  );
}

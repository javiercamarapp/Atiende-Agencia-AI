// Composicion de la pagina de Resumen de Likida (admin/consola.tsx:167-316 + HeroSaludo de
// dashboard/resumen-visual.tsx:69-80). El marco gris sumido, el relleno `md:px-5` y la barra superior
// los pone el `VerticalShell`; esta pieza solo pinta, en orden: cabecera (saludo `h1` de 20 px,
// subtitulo de 13 px y `destacado` a la derecha, debajo en movil), rejilla de KPIs
// (`grid-cols-2 md:grid-cols-4 gap-2`), pildoras de profundizacion a la derecha y el resto
// (secciones) con `space-y-2.5`.
//
// Es "tonta": no consulta nada. Los KPIs (`StatCard`), el destacado (`Odometro`...) y las secciones
// los arma la pagina con datos reales de sus endpoints; una rejilla o una pildora sin contenido no
// se pinta.
import { useId, type ReactNode } from "react";
import { cn } from "../lib/utils";
import { Card } from "./ui/card";
import { SectionLabel } from "./SectionLabel";

export interface ResumenLayoutProps {
  /** Saludo ya resuelto por la pagina (p. ej. "Buenas tardes"). */
  readonly saludo: string;
  readonly nombre: string;
  readonly subtitulo?: string;
  /**
   * ds3 (Rovaq «Hoy»): frase con las cifras clave en negritas (`<strong>`). Bajo html[data-diseno="ds3"] sustituye al subtitulo y al
   * odometro del destacado (Rovaq no tiene odometro; la cifra va en la frase y en la tira de KPI). Sin la bandera no se ve.
   */
  readonly frase?: ReactNode;
  /** Eyebrow ds3 (MAYUSCULAS, = grupo del menu). Por omision «Resumen». Sin la bandera no se ve. */
  readonly eyebrow?: string;
  /** Pieza a la derecha de la cabecera (`Odometro`, chip, CTA). Una sola accion primaria por vista. */
  readonly destacado?: ReactNode;
  /** `StatCard`s; se pintan en la rejilla de 2 / 4 columnas. */
  readonly kpis?: ReactNode;
  /** `PillLink`s de profundizacion, alineadas a la derecha. */
  readonly acciones?: ReactNode;
  /** Secciones (`ResumenSeccion`) y demas bloques. */
  readonly children?: ReactNode;
  readonly className?: string;
}

function hayContenido(nodo: ReactNode): boolean {
  if (nodo === undefined || nodo === null || nodo === false || nodo === "") return false;
  if (Array.isArray(nodo)) return nodo.some(hayContenido);
  return true;
}

export function ResumenLayout({ saludo, nombre, subtitulo, frase, eyebrow = "Resumen", destacado, kpis, acciones, children, className }: ResumenLayoutProps) {
  const hayCuerpo = hayContenido(kpis) || hayContenido(acciones) || hayContenido(children);
  const conFrase = hayContenido(frase);
  // Las piezas ds3 (eyebrow, frase) se pintan siempre y las muestra/oculta cifra.css bajo html[data-diseno="ds3"] (sin rama de JS);
  // los estilos se enganchan a `data-parte` para no cambiar las clases de Likida que fija resumen-piezas.spec.
  return (
    <div className={cn("ds3-resumen min-w-0", className)} data-con-frase={conFrase ? "" : undefined}>
      <div className="flex min-w-0 flex-col gap-2.5 pb-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <p data-parte="eyebrow" className="hidden" aria-hidden="true">
            {eyebrow}
          </p>
          <h1 data-parte="titulo" className="truncate font-display text-xl font-semibold text-foreground">
            {saludo}, {nombre}
          </h1>
          {subtitulo !== undefined && <p data-parte="subtitulo" className="mt-1 truncate text-ui text-muted-foreground">{subtitulo}</p>}
          {conFrase && (
            <p data-parte="frase" className="hidden" data-testid="resumen-frase">
              {frase}
            </p>
          )}
        </div>
        {hayContenido(destacado) && <div data-parte="destacado" className="flex shrink-0 items-center gap-2.5 sm:pt-1">{destacado}</div>}
      </div>
      {hayCuerpo && (
        <div className="space-y-2.5">
          {hayContenido(kpis) && <div data-parte="kpis" className="grid grid-cols-2 gap-2 md:grid-cols-4 max-md:[&>:last-child:nth-child(odd)]:col-span-2 md:[&>:last-child:nth-child(4n+3)]:col-span-2">{kpis}</div>}
          {hayContenido(acciones) && <div className="flex flex-wrap justify-end gap-2">{acciones}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

export interface ResumenSeccionProps {
  readonly titulo: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Seccion del Resumen: `Card p-3` con `SectionLabel` y rejilla `gap-1.5` de 1 / 2 / 3 columnas (consola.tsx:279-316). */
export function ResumenSeccion({ titulo, children, className }: ResumenSeccionProps) {
  const id = useId();
  return (
    <Card className={cn("p-3", className)} role="region" aria-labelledby={id}>
      <SectionLabel id={id}>{titulo}</SectionLabel>
      <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </Card>
  );
}

/** Subseccion dentro de una `ResumenSeccion` (`mt-4` entre bloques, consola.tsx:304-316). */
export function ResumenSubseccion({ titulo, children, className }: ResumenSeccionProps) {
  const id = useId();
  return (
    <div className={cn("mt-4", className)} role="group" aria-labelledby={id}>
      <SectionLabel id={id}>{titulo}</SectionLabel>
      <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </div>
  );
}

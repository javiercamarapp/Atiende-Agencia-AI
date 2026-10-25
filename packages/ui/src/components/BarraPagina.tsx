// Barra superior de pagina de los paneles (escritorio): 44 px de alto, icono de 15 px + NOMBRE DE LA PAGINA a la
// izquierda y, a la derecha, solo las acciones propias de la pagina activa (p. ej. «Vista previa»). Campana,
// «Pregúntale a tus datos» y fecha YA NO viven aqui (orden del dueno: el encabezado va delgado y sin huecos); la campana es la
// pildora «Notificaciones» y el chat la pildora «Pregúntale a tus datos» del pie del Sidebar / hoja «Mas».
//
// El nombre es un `<p>`, NO un `<h1>`: solo si la pagina no tiene ninguno, `comoH1` lo hace de nivel 1 (el shell lo detecta).
import type { ReactNode } from "react";
import { cn } from "../lib/utils";

export interface BarraPaginaProps {
  /** Icono de 15 px, p. ej. `<Icon className="size-[15px] text-muted-foreground" strokeWidth={1.75} />`. */
  readonly icon: ReactNode;
  /** Nombre de la pagina activa. */
  readonly title: ReactNode;
  /** Acciones propias de la pagina activa (p. ej. «Vista previa» del agente de voz), a la derecha. */
  readonly acciones?: ReactNode;
  /** Solo cuando la pagina activa no pinta ningun `<h1>`: el nombre hace de encabezado de nivel 1. */
  readonly comoH1?: boolean;
  readonly className?: string;
}

export function BarraPagina({ icon, title, acciones, comoH1 = false, className }: BarraPaginaProps) {
  return (
    <header data-testid="barra-pagina" className={cn("flex items-center justify-between h-11 px-4 gap-3 shrink-0 border-b border-border bg-card", className)}>
      <div className="flex items-center gap-2 text-ui font-medium min-w-0 text-foreground">
        {icon}
        <p data-testid="barra-pagina-titulo" role={comoH1 ? "heading" : undefined} aria-level={comoH1 ? 1 : undefined} className="truncate">
          {title}
        </p>
      </div>
      {acciones ? <div className="flex items-center gap-2 shrink-0">{acciones}</div> : null}
    </header>
  );
}

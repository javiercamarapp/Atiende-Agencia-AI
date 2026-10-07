// Barra superior de pagina de los paneles (escritorio): la `BarraPagina` de Likida
// (`dashboard/resumen-visual.tsx::BarraPagina` y `ChipFecha`), con las mismas clases y medidas
// en las 7 consolas (superadmin y las 6 verticales): 44 px de alto, icono de 15 px + NOMBRE DE
// LA PAGINA a la izquierda; a la derecha, en este orden, "Chatea con tus datos" (solo verticales),
// la campana y el chip de fecha con icono de calendario.
//
// El nombre es un `<p>`, NO un `<h1>`: el unico `<h1>` de cada pantalla es el de la pagina
// (`PageHeader`/su cabecera propia); solo si la pagina no tiene ninguno, `comoH1` deja que el
// nombre haga de encabezado de nivel 1 (el shell lo detecta). Quien monta la barra decide el texto y el icono (el
// `VerticalShell` los deriva de la ruta activa); aqui no se conoce la ruta.
//
// Deliberadamente "tonta" como el resto de @atiende/ui: recibe `notificationBell`/`chatButton`
// ya armados, nunca hace fetch ni formatea fechas.
import type { ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { cn } from "../lib/utils";

export interface BarraPaginaProps {
  /** Icono de 15 px, p. ej. `<Icon className="size-[15px] text-muted-foreground" strokeWidth={1.75} />`. */
  readonly icon: ReactNode;
  /** Nombre de la pagina activa. */
  readonly title: ReactNode;
  /** Texto ya formateado (ej. "16 sept 2026"). */
  readonly fecha: string;
  /** `<NotificationBell .../>` ya armado con sus datos reales conectados. */
  readonly notificationBell: ReactNode;
  /** Tipicamente `<BotonChatDatos />` de apps/web; las consolas que no lo tienen lo omiten. */
  readonly chatButton?: ReactNode;
  /**
   * Solo cuando la pagina activa no pinta ningun `<h1>` (el shell lo detecta): el nombre hace de
   * encabezado de nivel 1 para que la pantalla no se quede sin ninguno. Nunca coexiste con el de la pagina.
   */
  readonly comoH1?: boolean;
  readonly className?: string;
}

export function BarraPagina({ icon, title, fecha, notificationBell, chatButton, comoH1 = false, className }: BarraPaginaProps) {
  return (
    <header data-testid="barra-pagina" className={cn("flex items-center justify-between h-11 px-5 gap-3 shrink-0 border-b border-border bg-card", className)}>
      <div className="flex items-center gap-2 text-ui font-medium min-w-0 text-foreground">
        {icon}
        <p data-testid="barra-pagina-titulo" role={comoH1 ? "heading" : undefined} aria-level={comoH1 ? 1 : undefined} className="truncate">
          {title}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {chatButton}
        {notificationBell}
        <span data-testid="barra-pagina-fecha" className="inline-flex items-center gap-1.5 text-ui font-medium px-3 h-8 rounded-lg border border-border bg-card shrink-0 text-foreground">
          <CalendarDays aria-hidden="true" className="size-[15px] text-muted-foreground" strokeWidth={1.75} />
          {fecha}
        </span>
      </div>
    </header>
  );
}

import { useState, type ComponentType, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Ellipsis } from "lucide-react";
import { cn } from "../lib/utils";
import type { SidebarPiePildora, SidebarSection } from "./Sidebar";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

export interface BottomNavItem {
  to: string;
  label: string;
  icon: IconType;
  /** Activo solo con coincidencia exacta de ruta (p. ej. el Dashboard en la raíz de la vertical). */
  end?: boolean;
  /** Conteo real a mostrar como badge; nunca inventar un número — omitir si no hay dato. */
  count?: number;
}

export interface BottomNavProps {
  items: BottomNavItem[];
  /**
   * Cuando la vertical tiene más destinos de los que caben en la barra (hoteles
   * y despachos tienen 12-13), se pasan TODAS las secciones aquí y la barra suma
   * un botón "Más" que abre una hoja con cada destino real -- el mismo árbol de
   * navegación del Sidebar de escritorio, sin curar destinos a ojo.
   */
  moreSections?: SidebarSection[];
  /**
   * Pildoras del pie del Sidebar de escritorio ("Costos de IA", "Ver los otros paneles"): en movil el
   * Sidebar no existe, asi que se agregan a la hoja "Mas" como seccion "Cuenta". Sin `to`, `href` ni
   * `onClick` una pildora no se pinta (no hay controles maqueta).
   */
  pie?: SidebarPiePildora[];
}

/** Maximo de destinos curados de la barra; el 5.o lugar es "Mas" (spec UNI-1 §5.2). */
export const BOTTOM_NAV_MAX_DESTINOS = 4;

function rutaCoincide(pathname: string, to: string, end?: boolean): boolean {
  if (pathname === to) return true;
  return !end && pathname.startsWith(`${to}/`);
}

const claseDestino = "relative flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 py-2.5";
const claseFilaHoja = "flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-ui";
const claseTituloGrupo = "mb-1.5 px-2.5 py-1 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground";

/**
 * Barra inferior movil: la `NavInferior` del panel del chofer de Likida (63 px = borde 1 + py 10 +
 * icono 22 + gap 4 + etiqueta 16 + py 10, mas el inset inferior), solo `md:hidden`. Hasta 4 destinos
 * curados y, cuando la vertical tiene mas, un 5.o lugar "Mas" que abre una hoja con TODAS las secciones
 * (el mismo arbol del Sidebar de escritorio, sin curar destinos a ojo). El estado activo es color +
 * negrita + `aria-current="page"`, nunca color solo. z-40: queda bajo los overlays (z-50) y el skip link (z-60).
 */
export function BottomNav({ items, moreSections, pie }: BottomNavProps) {
  const [masAbierto, setMasAbierto] = useState(false);
  const { pathname } = useLocation();
  const destinos = items.slice(0, BOTTOM_NAV_MAX_DESTINOS);
  const hayMas = Boolean(moreSections && moreSections.length > 0);
  const enBarra = destinos.some((d) => rutaCoincide(pathname, d.to, d.end));
  // "Mas" queda activo cuando la ruta esta en alguna seccion pero no en un destino curado de la barra.
  const masActivo = hayMas && !enBarra && (moreSections ?? []).some((s) => s.items.some((it) => rutaCoincide(pathname, it.to, it.end)));
  const pildoras = (pie ?? []).filter((p) => p.to || p.href || p.onClick);
  const alCerrar = () => setMasAbierto(false);
  return (
    <nav
      aria-label="Navegación móvil"
      className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card safe-area-bottom pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <ul className="flex">
        {destinos.map((item) => (
          <li key={item.to} className="min-w-0 flex-1">
            <NavLink to={item.to} end={item.end} className={({ isActive }) => cn(claseDestino, isActive ? "text-primary" : "text-muted-foreground")}>
              {({ isActive }) => (
                <>
                  <item.icon aria-hidden="true" className="size-[22px]" strokeWidth={isActive ? 2.25 : 1.75} />
                  <span className={cn("max-w-full truncate px-1 text-xs", isActive ? "font-semibold" : "font-medium")}>{item.label}</span>
                  {typeof item.count === "number" && item.count > 0 && (
                    <span className="absolute right-2 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-2xs text-destructive-foreground">
                      {item.count}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          </li>
        ))}
        {hayMas && (
          <li className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setMasAbierto(true)}
              aria-haspopup="dialog"
              aria-expanded={masAbierto}
              className={cn("w-full", claseDestino, masActivo ? "text-primary" : "text-muted-foreground")}
            >
              <Ellipsis aria-hidden="true" className="size-[22px]" strokeWidth={masActivo ? 2.25 : 1.75} />
              <span className={cn("max-w-full truncate px-1 text-xs", masActivo ? "font-semibold" : "font-medium")}>Más</span>
            </button>
          </li>
        )}
      </ul>
      {hayMas && (
        <Sheet open={masAbierto} onOpenChange={setMasAbierto}>
          <SheetContent
            side="bottom"
            className="max-h-[80dvh] overflow-y-auto rounded-t-2xl bg-card px-4 pt-6 pb-[calc(2rem+var(--safe-area-bottom))]"
          >
            <SheetHeader className="mb-2 pr-11">
              <SheetTitle>Más secciones</SheetTitle>
              <SheetDescription className="sr-only">Todas las secciones del panel</SheetDescription>
            </SheetHeader>
            {(moreSections ?? []).map((section) => (
              <div key={section.title} className="mt-3">
                <p className={claseTituloGrupo}>{section.title}</p>
                <div className="flex flex-col">
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      onClick={alCerrar}
                      className={({ isActive }) =>
                        cn(claseFilaHoja, isActive ? "bg-primary text-primary-foreground font-medium" : "text-foreground hover:bg-muted-foreground/10")
                      }
                    >
                      <item.icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
            {pildoras.length > 0 && (
              <div className="mt-3">
                <p className={claseTituloGrupo}>Cuenta</p>
                <div className="flex flex-col">
                  {pildoras.map((p) => (
                    <PildoraCuenta key={p.label} pildora={p} onNavegar={alCerrar} />
                  ))}
                </div>
              </div>
            )}
          </SheetContent>
        </Sheet>
      )}
    </nav>
  );
}

function PildoraCuenta({ pildora, onNavegar }: { pildora: SidebarPiePildora; onNavegar: () => void }) {
  const Icono = pildora.icon;
  const contenido = (
    <>
      {Icono ? <Icono aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} /> : null}
      <span className="truncate">{pildora.label}</span>
    </>
  );
  const clase = cn(claseFilaHoja, "w-full text-foreground hover:bg-muted-foreground/10");
  if (pildora.to) {
    return (
      <NavLink to={pildora.to} onClick={onNavegar} className={clase}>
        {contenido}
      </NavLink>
    );
  }
  if (pildora.href) {
    return (
      <a href={pildora.href} onClick={onNavegar} className={clase}>
        {contenido}
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        onNavegar();
        pildora.onClick?.();
      }}
      className={clase}
    >
      {contenido}
    </button>
  );
}

export interface MobileHeaderTitulo {
  /** Icono de 15 px ya armado. */
  readonly icon: ReactNode;
  /** Nombre de la pagina activa. */
  readonly title: ReactNode;
  /** Solo si la pagina no pinta ningun <h1>: el nombre hace de encabezado de nivel 1 (visible en movil). */
  readonly comoH1?: boolean;
}

/**
 * Cabecera fija movil (logo + acciones), pareja de la barra inferior: el `h-14 px-4 border-b` del
 * panel del chofer de Likida, con el inset superior. Con `pagina`, una segunda fila de 32 px (fuera del <header> de logo y acciones) muestra el
 * icono y el NOMBRE de la pagina (la `BarraPagina` de escritorio esta oculta en movil); si la pagina no
 * trae `<h1>`, ese nombre es el encabezado de nivel 1 accesible.
 */
export function MobileHeader({
  title,
  action,
  pagina,
}: {
  title: ReactNode;
  action?: ReactNode;
  pagina?: MobileHeaderTitulo;
}) {
  return (
    <div
      data-testid="mobile-header"
      className="md:hidden fixed inset-x-0 top-0 z-40 bg-card safe-area-top pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <header className="md:hidden flex min-h-14 items-center justify-between border-b border-border px-4">
        {title}
        {action}
      </header>
      {pagina && (
        <div className="flex h-8 items-center gap-2 border-b border-border px-4 text-ui font-medium text-foreground">
          {pagina.icon}
          <p
            data-testid="mobile-pagina-titulo"
            role={pagina.comoH1 ? "heading" : undefined}
            aria-level={pagina.comoH1 ? 1 : undefined}
            className="truncate"
          >
            {pagina.title}
          </p>
        </div>
      )}
    </div>
  );
}

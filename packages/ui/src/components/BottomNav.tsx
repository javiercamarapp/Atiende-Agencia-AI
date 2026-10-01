import { useState, type ComponentType } from "react";
import { NavLink } from "react-router-dom";
import { Ellipsis } from "lucide-react";
import { cn } from "../lib/utils";
import type { SidebarSection } from "./Sidebar";
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
}

/**
 * Bottom-nav móvil real — cierra el hueco de mobile de atiende-restaurantes
 * (docs/referencia/05-frontend-restaurantes.md §2.5/§2.6: "el panel admin de
 * restaurantes no tiene una experiencia mobile real", solo el flujo del
 * repartidor la resuelve). Mismo patrón que
 * `RepartidorDashboard.tsx` (header+bottom-nav fijos `md:hidden`,
 * `safe-area-bottom`), portado para el personal operativo de hotel
 * (recepción/housekeeping/mantenimiento). Controles ≥44px (REQ-UX-003).
 */
export function BottomNav({ items, moreSections }: BottomNavProps) {
  const [masAbierto, setMasAbierto] = useState(false);
  return (
    <nav
      aria-label="Navegación móvil"
      className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 safe-area-bottom"
    >
      <div className="flex justify-around items-stretch py-1">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                "relative flex flex-col items-center justify-center gap-1 min-w-[64px] min-h-11 px-2 py-2 rounded-lg",
                isActive ? "text-primary" : "text-muted-foreground",
              )
            }
          >
            <item.icon className="w-5 h-5" strokeWidth={1.75} />
            <span className="text-[10px] leading-none">{item.label}</span>
            {typeof item.count === "number" && item.count > 0 && (
              <span className="absolute top-0.5 right-2 bg-destructive text-destructive-foreground text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                {item.count}
              </span>
            )}
          </NavLink>
        ))}
        {moreSections && moreSections.length > 0 && (
          <button
            type="button"
            onClick={() => setMasAbierto(true)}
            aria-haspopup="dialog"
            aria-expanded={masAbierto}
            className="relative flex flex-col items-center justify-center gap-1 min-w-[64px] min-h-11 px-2 py-2 rounded-lg text-muted-foreground"
          >
            <Ellipsis className="w-5 h-5" strokeWidth={1.75} />
            <span className="text-[10px] leading-none">Más</span>
          </button>
        )}
      </div>
      {moreSections && moreSections.length > 0 && (
        <Sheet open={masAbierto} onOpenChange={setMasAbierto}>
          <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto rounded-t-2xl px-4 pb-8 pt-6">
            <SheetHeader className="mb-2">
              <SheetTitle>Más secciones</SheetTitle>
              <SheetDescription className="sr-only">Todas las secciones del panel</SheetDescription>
            </SheetHeader>
            {moreSections.map((section) => (
              <div key={section.title} className="mt-3">
                <p className="px-2 mb-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{section.title}</p>
                <div className="flex flex-col">
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end
                      onClick={() => setMasAbierto(false)}
                      className={({ isActive }) =>
                        cn(
                          "flex items-center gap-3 min-h-11 px-2 rounded-lg text-sm",
                          isActive ? "bg-primary text-primary-foreground font-medium" : "text-foreground hover:bg-muted",
                        )
                      }
                    >
                      <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            ))}
          </SheetContent>
        </Sheet>
      )}
    </nav>
  );
}

/**
 * Header fijo móvil (logo + acción), pareja del BottomNav — mismo patrón
 * `md:hidden fixed top-0 ... safe-area-top` de `RepartidorDashboard.tsx`.
 */
export function MobileHeader({
  title,
  action,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <header className="md:hidden fixed top-0 left-0 right-0 bg-card border-b border-border z-50 safe-area-top">
      <div className="flex items-center justify-between px-4 py-3 min-h-14">
        {title}
        {action}
      </div>
    </header>
  );
}

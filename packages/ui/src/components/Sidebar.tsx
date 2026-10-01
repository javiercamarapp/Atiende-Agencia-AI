import { useState, type ComponentType, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { LogOut, PanelLeftClose, PanelLeftOpen, ChevronDown } from "lucide-react";
import { Button } from "./ui/button";
import { ThemeSelector } from "./ThemeSelector";
import { AtiendeMark, AtiendeWordmark } from "./AtiendeLogo";
import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

export interface SidebarItem {
  to: string;
  label: string;
  icon: IconType;
}

export interface SidebarSection {
  title: string;
  siempreAbierto?: boolean;
  items: SidebarItem[];
}

export interface SidebarProps {
  sections: SidebarSection[];
  user: { email: string; rol?: string } | null;
  onLogout: () => void;
  /** Selector de hotel (multi-hotel), renderizado bajo el logo. */
  hotelSelector?: ReactNode;
  /**
   * Identificador de la vertical ("citas", "hoteles"...). Con él el grupo
   * abierto y el colapso se recuerdan POR VERTICAL (`atiende:<vertical>:sidebar:*`);
   * sin él se conservan las claves compartidas de siempre, para no cambiar el
   * comportamiento de las verticales que aún no migran al shell único.
   */
  storageScope?: string;
}

const CLAVE_GRUPO_ABIERTO = "atiende-hoteles-sidebar-grupo-abierto";
const CLAVE_COLAPSADO = "atiende-hoteles-sidebar-colapsado";

/** Claves de localStorage del Sidebar: por vertical si hay `scope`, las compartidas heredadas si no. */
export function clavesSidebar(scope?: string): { grupo: string; colapsado: string } {
  if (!scope) return { grupo: CLAVE_GRUPO_ABIERTO, colapsado: CLAVE_COLAPSADO };
  return { grupo: `atiende:${scope}:sidebar:grupo`, colapsado: `atiende:${scope}:sidebar:colapsado` };
}

function leerAlmacen(clave: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(clave) : null;
  } catch {
    return null;
  }
}

function escribirAlmacen(clave: string, valor: string): void {
  try {
    window.localStorage.setItem(clave, valor);
  } catch {
    // Sin almacenamiento (modo privado, cuota): la preferencia solo dura la sesión de la pestaña.
  }
}

/**
 * Sidebar hotelero — misma anatomía visual que AdminSidebar de
 * atiende-restaurantes (docs/referencia/05-frontend-restaurantes.md §2.2):
 * acordeón por grupo (uno abierto a la vez, recordado en localStorage),
 * colapso de ancho, bloque de cuenta con ThemeSelector, chip de usuario.
 * Navegación real vía react-router `NavLink` (la fuente usaba un callback
 * de sección porque era un SPA de una sola ruta; aquí cada ítem es una
 * ruta real, lo que además hace cada pantalla capturable/enlazable).
 */
export function Sidebar({ sections, user, onLogout, hotelSelector, storageScope }: SidebarProps) {
  const location = useLocation();
  const claves = clavesSidebar(storageScope);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return leerAlmacen(claves.colapsado) === "1";
  });

  const grupoDeRuta = (pathname: string) =>
    sections.find((s) => s.items.some((it) => pathname.startsWith(it.to)))?.title ?? null;

  const [grupoAbierto, setGrupoAbierto] = useState<string | null>(() => {
    const guardado = leerAlmacen(claves.grupo);
    // La clave de localStorage la comparten todas las verticales: un grupo
    // guardado que no existe en ESTA vertical (p. ej. "Operación" de hoteles
    // dentro de citas) dejaba todos los acordeones cerrados. Solo se respeta si
    // existe en las secciones actuales.
    if (guardado && sections.some((s) => s.title === guardado)) return guardado;
    const activo = grupoDeRuta(location.pathname);
    return activo && !sections.find((s) => s.title === activo)?.siempreAbierto ? activo : sections[1]?.title ?? null;
  });

  const alternarGrupo = (titulo: string) => {
    setGrupoAbierto((actual) => {
      const nuevo = actual === titulo ? null : titulo;
      escribirAlmacen(claves.grupo, nuevo ?? "");
      return nuevo;
    });
  };

  const alternarColapso = () => {
    setCollapsed((v) => {
      escribirAlmacen(claves.colapsado, !v ? "1" : "0");
      return !v;
    });
  };

  return (
    <aside
      aria-label="Navegación principal"
      className={cn(
        "hidden md:flex flex-col bg-card border border-border rounded-2xl sticky top-3 h-[calc(100vh-1.5rem)] overflow-hidden transition-all duration-300",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className="px-3 py-3 flex items-center justify-between shrink-0">
        {!collapsed ? <AtiendeWordmark className="h-[18px] w-auto origin-left" /> : <AtiendeMark className="h-[18px] w-auto" />}
        <button
          onClick={alternarColapso}
          aria-label={collapsed ? "Expandir barra lateral" : "Colapsar barra lateral"}
          className="w-7 h-7 rounded-md border border-border/60 flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors shrink-0"
        >
          {collapsed ? <PanelLeftOpen className="w-3.5 h-3.5" strokeWidth={1.75} /> : <PanelLeftClose className="w-3.5 h-3.5" strokeWidth={1.75} />}
        </button>
      </div>

      {!collapsed && hotelSelector && <div className="px-2 pb-2">{hotelSelector}</div>}

      <nav className="flex-1 px-2 space-y-2 overflow-y-auto pb-3">
        {sections.map((section) => {
          const abierta = section.siempreAbierto || grupoAbierto === section.title;
          return (
            <div key={section.title}>
              {!collapsed &&
                (section.siempreAbierto ? (
                  <p className="px-2.5 mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{section.title}</p>
                ) : (
                  <button
                    onClick={() => alternarGrupo(section.title)}
                    aria-expanded={abierta}
                    className="w-full flex items-center justify-between px-2.5 mb-1.5 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {section.title}
                    <ChevronDown className={cn("w-3 h-3 transition-transform", abierta && "rotate-180")} />
                  </button>
                ))}
              {(abierta || collapsed) && (
                <div className="space-y-0.5">
                  {section.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      className={({ isActive }) =>
                        cn(
                          "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors",
                          isActive ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted",
                        )
                      }
                    >
                      <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                      {!collapsed && (
                        <span className="flex-1 min-w-0 truncate">{item.label}</span>
                      )}
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Bloque de cuenta — mismo patrón EXACTO (medidas incluidas) que
          admin/chrome.tsx de Likida: zona plana con fondo propio + separador
          de 1px, tarjeta de usuario simple abajo (sin el hack de superponer
          con margen negativo que tenía la versión anterior). Solo contiene
          controles con destino real: ya no hay "Centro de ayuda", "Notificaciones",
          "Mi perfil" ni "Plan y facturación" (eran maquetas sin acción; la campana
          vive en el header) ni el enlace fijo a /configuracion (ruta inexistente:
          cada vertical con pantalla de configuración ya la trae en sus secciones). */}
      <div className="shrink-0 border-t border-border">
        {!collapsed && (
          <div className="bg-muted px-2 pt-2 pb-1.5 space-y-0.5">
            <div className="pt-1.5 pb-0.5 flex justify-center">
              <ThemeSelector />
            </div>
          </div>
        )}

        <div className="px-2 pt-2 pb-2">
          {!collapsed ? (
            <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-2">
              <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-[11px] font-semibold shrink-0">
                {user?.email?.charAt(0).toUpperCase() || "A"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-foreground truncate leading-tight">{user?.email ?? "Sin sesión"}</p>
                <p className="font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">{user?.rol ?? "—"}</p>
              </div>
              <button onClick={onLogout} aria-label="Cerrar sesión" className="text-destructive hover:opacity-70 shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-colors">
                <LogOut className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ) : (
            <Button onClick={onLogout} variant="ghost" size="icon" className="w-full rounded-xl border border-border bg-card" aria-label="Cerrar sesión">
              <LogOut className="w-4 h-4" strokeWidth={1.75} />
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
}

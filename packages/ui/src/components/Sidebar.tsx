import { useState, type ComponentType, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Bell,
  CreditCard,
  HelpCircle,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  UserRound,
  ChevronDown,
} from "lucide-react";
import { Button } from "./ui/button";
import { ThemeSelector } from "./ThemeSelector";
import { AtiendeMark, AtiendeWordmark } from "./AtiendeLogo";
import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

export interface SidebarItem {
  to: string;
  label: string;
  icon: IconType;
  disabled?: boolean;
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
}

const CLAVE_GRUPO_ABIERTO = "atiende-hoteles-sidebar-grupo-abierto";
const CLAVE_COLAPSADO = "atiende-hoteles-sidebar-colapsado";

/**
 * Sidebar hotelero — misma anatomía visual que AdminSidebar de
 * atiende-restaurantes (docs/referencia/05-frontend-restaurantes.md §2.2):
 * acordeón por grupo (uno abierto a la vez, recordado en localStorage),
 * colapso de ancho, bloque de cuenta con ThemeSelector, chip de usuario.
 * Navegación real vía react-router `NavLink` (la fuente usaba un callback
 * de sección porque era un SPA de una sola ruta; aquí cada ítem es una
 * ruta real, lo que además hace cada pantalla capturable/enlazable).
 */
export function Sidebar({ sections, user, onLogout, hotelSelector }: SidebarProps) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(CLAVE_COLAPSADO) === "1";
  });

  const grupoDeRuta = (pathname: string) =>
    sections.find((s) => s.items.some((it) => pathname.startsWith(it.to)))?.title ?? null;

  const [grupoAbierto, setGrupoAbierto] = useState<string | null>(() => {
    const guardado = typeof window !== "undefined" ? window.localStorage.getItem(CLAVE_GRUPO_ABIERTO) : null;
    if (guardado) return guardado;
    const activo = grupoDeRuta(location.pathname);
    return activo && !sections.find((s) => s.title === activo)?.siempreAbierto ? activo : sections[1]?.title ?? null;
  });

  const alternarGrupo = (titulo: string) => {
    setGrupoAbierto((actual) => {
      const nuevo = actual === titulo ? null : titulo;
      window.localStorage.setItem(CLAVE_GRUPO_ABIERTO, nuevo ?? "");
      return nuevo;
    });
  };

  const alternarColapso = () => {
    setCollapsed((v) => {
      window.localStorage.setItem(CLAVE_COLAPSADO, !v ? "1" : "0");
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
                      aria-disabled={item.disabled}
                      onClick={(e) => item.disabled && e.preventDefault()}
                      className={({ isActive }) =>
                        cn(
                          "w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[13px] transition-colors",
                          item.disabled
                            ? "text-muted-foreground/50 cursor-not-allowed"
                            : isActive
                              ? "bg-primary text-primary-foreground font-medium"
                              : "text-muted-foreground hover:bg-muted",
                        )
                      }
                    >
                      <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                      {!collapsed && (
                        <span className="flex-1 flex items-center justify-between min-w-0 gap-2">
                          <span className="truncate">{item.label}</span>
                          {item.disabled && (
                            <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground/60 shrink-0">Pronto</span>
                          )}
                        </span>
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
          con margen negativo que tenía la versión anterior). */}
      <div className="shrink-0 border-t border-border">
        {!collapsed && (
          <div className="bg-muted px-2 pt-2 pb-1.5 space-y-0.5">
            <button className="w-full flex items-center gap-2 px-3 py-1.5 mb-1 rounded-full text-[12.5px] border border-border bg-card hover:bg-background transition-colors">
              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" strokeWidth={1.75} />
              <span className="truncate">Centro de ayuda</span>
            </button>
            {/* Mismos 5 ítems y mismo orden que el bloque ABAJO real de
                Likida; activo = píldora sólida bg-primary. Solo
                "Configuración" tiene página real hoy en este repo. */}
            <button
              type="button"
              disabled
              title="Notificaciones: todavía no existe una sección propia en Atiende Hoteles."
              className="w-full flex items-center justify-between gap-2.5 px-3 py-1.5 rounded-full text-[12.5px] text-muted-foreground/50 cursor-not-allowed"
            >
              <span className="flex items-center gap-2.5">
                <Bell className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                <span className="truncate">Notificaciones</span>
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground/60 shrink-0">Pronto</span>
            </button>
            <button
              type="button"
              disabled
              title="Mi perfil: todavía no existe esta pantalla en Atiende Hoteles."
              className="w-full flex items-center justify-between gap-2.5 px-3 py-1.5 rounded-full text-[12.5px] text-muted-foreground/50 cursor-not-allowed"
            >
              <span className="flex items-center gap-2.5">
                <UserRound className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                <span className="truncate">Mi perfil</span>
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground/60 shrink-0">Pronto</span>
            </button>
            <button
              type="button"
              disabled
              title="Plan y facturación: todavía no existe esta pantalla en Atiende Hoteles."
              className="w-full flex items-center justify-between gap-2.5 px-3 py-1.5 rounded-full text-[12.5px] text-muted-foreground/50 cursor-not-allowed"
            >
              <span className="flex items-center gap-2.5">
                <CreditCard className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                <span className="truncate">Plan y facturación</span>
              </span>
              <span className="font-mono text-[9px] uppercase tracking-[0.06em] text-muted-foreground/60 shrink-0">Pronto</span>
            </button>
            <NavLink
              to="/configuracion"
              className={({ isActive }) =>
                cn(
                  "w-full flex items-center gap-2.5 px-3 py-1.5 rounded-full text-[12.5px] transition-colors",
                  isActive ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-background",
                )
              }
            >
              <Settings className="w-4 h-4 shrink-0" strokeWidth={1.75} />
              <span className="truncate">Configuración</span>
            </NavLink>
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

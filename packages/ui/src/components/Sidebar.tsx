import { useState, type ComponentType, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight, LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { ThemeSelector } from "./ThemeSelector";
import { AtiendeWordmark } from "./AtiendeLogo";
import { cn } from "../lib/utils";

type IconType = ComponentType<{ className?: string; strokeWidth?: number | string }>;

export interface SidebarItem {
  to: string;
  label: string;
  icon: IconType;
  /** Activo solo con coincidencia exacta de la ruta (un item raiz como "Resumen" no debe quedar activo en todas las paginas hijas). */
  end?: boolean;
}

export interface SidebarSection {
  title: string;
  /**
   * Seccion raiz: se pinta SIN titulo y a todo el ancho (como "Resumen" en
   * Likida), nunca es una categoria del acordeon.
   */
  siempreAbierto?: boolean;
  items: SidebarItem[];
}

/**
 * Pildora compacta del pie ("Costos de IA ->", "Ver los otros paneles").
 * Cada una necesita un destino REAL: `to` (ruta del SPA), `href` (enlace
 * externo) u `onClick` (p. ej. abrir un dialogo). Sin ninguno de los tres no
 * se pinta (no hay controles maqueta).
 */
export interface SidebarPiePildora {
  label: string;
  to?: string;
  href?: string;
  onClick?: () => void;
  /** Con icono se pinta a la izquierda (sin flecha); sin icono el texto lleva la flecha "->". */
  icon?: IconType;
}

export interface SidebarUser {
  email: string;
  /** Rol tal cual lo da la sesion; se usa si no hay `rolEtiqueta`. */
  rol?: string;
  /** Nombre completo; si falta se muestra el correo. */
  nombre?: string;
  /** Rol legible para mostrar (se pinta en mayusculas). */
  rolEtiqueta?: string;
}

export interface SidebarProps {
  sections: SidebarSection[];
  user: SidebarUser | null;
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
  /** Pildoras del pie, sobre el selector de tema. Sin ellas el pie solo lleva tema y usuario. */
  pie?: SidebarPiePildora[];
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

/** Una ruta pertenece a un item si es igual o cuelga de el ("/x/a" no es hija de "/x/ab"). */
function rutaEnItem(pathname: string, to: string): boolean {
  const base = to.length > 1 && to.endsWith("/") ? to.slice(0, -1) : to;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/**
 * Categoria (seccion no raiz) de la ruta activa: la de la coincidencia de
 * prefijo mas largo. Las secciones raiz ("Resumen") no cuentan, o toda ruta
 * hija de la raiz abriria siempre la misma categoria.
 */
export function categoriaDeRuta(sections: readonly SidebarSection[], pathname: string): string | null {
  let mejor: { titulo: string; largo: number } | null = null;
  for (const s of sections) {
    if (s.siempreAbierto) continue;
    for (const it of s.items) {
      if (rutaEnItem(pathname, it.to) && (!mejor || it.to.length > mejor.largo)) mejor = { titulo: s.title, largo: it.to.length };
    }
  }
  return mejor?.titulo ?? null;
}

function idSeccion(titulo: string): string {
  const slug = titulo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `nav-seccion-${slug || "grupo"}`;
}

const CLASE_ITEM = "flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-ui transition-colors";
const CLASE_PILDORA =
  "flex items-center gap-2 px-3 py-1.5 mb-1 rounded-full border border-border bg-card text-pill font-medium text-foreground-2 transition-colors hover:bg-canvas";

function FilaItem({ item, colapsado }: { item: SidebarItem; colapsado: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={item.label}
      aria-label={item.label}
      className={({ isActive }) =>
        cn(
          CLASE_ITEM,
          colapsado && "justify-center",
          isActive ? "bg-primary text-primary-foreground font-medium" : "text-foreground hover:bg-muted-foreground/10",
        )
      }
    >
      {({ isActive }) => (
        <>
          <item.icon className={cn("size-4 shrink-0", !isActive && "text-muted-foreground")} strokeWidth={1.75} />
          <span className={cn("min-w-0 flex-1 truncate", colapsado ? "hidden" : "hidden lg:block")}>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

function PildoraPie({ pildora, colapsado }: { pildora: SidebarPiePildora; colapsado: boolean }) {
  const { label, to, href, onClick, icon: Icono } = pildora;
  const contenido = (
    <>
      {Icono ? <Icono className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} /> : null}
      <span className={cn("min-w-0 flex-1 truncate", colapsado ? "hidden" : "hidden lg:block")}>{label}</span>
      {Icono ? null : <span aria-hidden="true">→</span>}
    </>
  );
  const comunes = {
    title: label,
    "aria-label": label,
    className: cn(CLASE_PILDORA, colapsado ? "justify-center" : cn("justify-center", Icono ? "lg:justify-start" : "lg:justify-between")),
  };
  if (to) return <Link to={to} {...comunes}>{contenido}</Link>;
  if (href) return <a href={href} {...comunes}>{contenido}</a>;
  if (onClick) return <button type="button" onClick={onClick} {...comunes} className={cn(comunes.className, "w-full text-left")}>{contenido}</button>;
  return null;
}

/**
 * Sidebar de escritorio, identico al de Likida (admin/chrome.tsx +
 * admin/sidebar-nav.tsx): 232 px expandido / 72 px colapsado (y por debajo de
 * `lg`), acordeon EXCLUSIVO de categorias (abrir una cierra la otra), items
 * finos de 31.5 px con la pildora activa en el azul de marca, y el pie con
 * pildoras compactas, selector de tema de 24 px y tarjeta de usuario. La
 * unica excepcion tipografica es el titulo de categoria (mono de Atiende).
 *
 * Navegacion real via react-router (`NavLink`): cada item es una ruta.
 * Solo contiene controles con destino o accion real.
 */
export function Sidebar({ sections, user, onLogout, hotelSelector, storageScope, pie }: SidebarProps) {
  const location = useLocation();
  const claves = clavesSidebar(storageScope);
  const [collapsed, setCollapsed] = useState<boolean>(() => leerAlmacen(claves.colapsado) === "1");

  const categorias = sections.filter((s) => !s.siempreAbierto && s.items.length > 0);
  const activa = categoriaDeRuta(sections, location.pathname);

  const [grupoAbierto, setGrupoAbierto] = useState<string | null>(() => {
    if (activa) return activa;
    // Las claves de localStorage pueden venir de otra vertical (p. ej. "Operación"
    // de hoteles dentro de citas): solo se respeta si existe en ESTAS categorias.
    // Cadena vacia = el usuario cerro la categoria abierta a proposito.
    const guardado = leerAlmacen(claves.grupo);
    if (guardado === "") return null;
    if (guardado && categorias.some((s) => s.title === guardado)) return guardado;
    return categorias[0]?.title ?? null;
  });

  // Al navegar se abre la categoria de la nueva ruta (patron "derivar estado de
  // props durante el render"; evita un efecto con el arreglo de secciones, que
  // los shells recrean en cada render, como dependencia).
  const [rutaPrevia, setRutaPrevia] = useState(location.pathname);
  if (rutaPrevia !== location.pathname) {
    setRutaPrevia(location.pathname);
    if (activa && activa !== grupoAbierto) setGrupoAbierto(activa);
  }

  const alternarGrupo = (titulo: string) => {
    const nuevo = grupoAbierto === titulo ? null : titulo;
    setGrupoAbierto(nuevo);
    escribirAlmacen(claves.grupo, nuevo ?? "");
  };

  const alternarColapso = () => {
    const nuevo = !collapsed;
    setCollapsed(nuevo);
    escribirAlmacen(claves.colapsado, nuevo ? "1" : "0");
  };

  const pildoras = (pie ?? []).filter((p) => p.to || p.href || p.onClick);
  const nombre = user?.nombre?.trim() || user?.email || "";
  const rolEtiqueta = user?.rolEtiqueta ?? user?.rol;
  const visibles = sections.filter((s) => s.items.length > 0);

  return (
    <aside
      aria-label="Navegación principal"
      // Mantiene la paleta de Likida aunque la vertical tenga su propio ambito de tokens (index.css, [data-ambito-base]).
      data-ambito-base=""
      className={cn(
        "hidden md:flex flex-col rounded-lg border border-border bg-card shadow-card sticky top-4 h-[calc(100dvh-2rem)] overflow-hidden transition-[width] duration-base ease-brand",
        collapsed ? "w-[72px]" : "w-[72px] lg:w-[232px]",
      )}
    >
      <div className={cn("shrink-0 px-3 py-3 flex items-center gap-1.5", collapsed ? "justify-center" : "justify-center lg:justify-start")}>
        {!collapsed && (
          <span className="hidden lg:block min-w-0">
            <AtiendeWordmark tamano="sidebar" />
          </span>
        )}
        <button
          type="button"
          onClick={alternarColapso}
          aria-label={collapsed ? "Expandir barra lateral" : "Colapsar barra lateral"}
          title={collapsed ? "Expandir barra lateral" : "Colapsar barra lateral"}
          className={cn(
            "size-7 rounded-lg flex items-center justify-center shrink-0 text-muted-foreground transition-colors hover:bg-canvas",
            !collapsed && "lg:ml-auto",
          )}
        >
          {collapsed ? <PanelLeftOpen className="size-[15px]" strokeWidth={1.75} /> : <PanelLeftClose className="size-[15px]" strokeWidth={1.75} />}
        </button>
      </div>

      {!collapsed && hotelSelector && <div className="hidden lg:block px-2 pb-2">{hotelSelector}</div>}

      <nav className="flex-1 overflow-y-auto px-2 space-y-2 pb-3">
        {visibles.map((section, indice) => {
          // Raiz ("Resumen"): items a todo el ancho, sin cabecera ni acordeon.
          if (section.siempreAbierto) {
            return (
              <div key={section.title} className="space-y-0.5">
                {section.items.map((item) => (
                  <FilaItem key={item.to} item={item} colapsado={collapsed} />
                ))}
              </div>
            );
          }
          const abierta = grupoAbierto === section.title;
          const id = idSeccion(section.title);
          return (
            <div key={section.title} id={id}>
              {collapsed && indice > 0 && <div role="separator" className="mx-2 mb-2 border-t border-border" />}
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => alternarGrupo(section.title)}
                  aria-expanded={abierta}
                  aria-controls={`${id}-items`}
                  className="hidden lg:flex w-full items-center justify-between px-2.5 mb-1.5 font-mono text-2xs leading-[1.65] uppercase tracking-[0.08em] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {section.title}
                  {abierta ? <ChevronDown className="size-[13px]" strokeWidth={2} aria-hidden="true" /> : <ChevronRight className="size-[13px]" strokeWidth={2} aria-hidden="true" />}
                </button>
              )}
              <div id={`${id}-items`} className="space-y-0.5">
                {(abierta || collapsed) && section.items.map((item) => <FilaItem key={item.to} item={item} colapsado={collapsed} />)}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Pie — mismas medidas que admin/chrome.tsx de Likida: zona A (gris
          sumido, pildoras + tema) y zona B (tarjeta de usuario), cada una con
          su separador de 1px. Solo controles con destino o accion real. */}
      {(pildoras.length > 0 || !collapsed) && (
        <div className="shrink-0 border-t border-border bg-canvas px-2 pt-2 pb-1.5 space-y-0.5">
          {pildoras.map((p) => (
            <PildoraPie key={p.label} pildora={p} colapsado={collapsed} />
          ))}
          {!collapsed && (
            <div className="hidden lg:flex px-2.5 pt-1.5 justify-center">
              <ThemeSelector tamano="compacto" />
            </div>
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-border px-2 pt-2 pb-2">
        <div
          className={cn(
            "flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card p-2",
            collapsed ? "flex-col justify-center" : "flex-col justify-center lg:flex-row lg:justify-start",
          )}
        >
          <div className="size-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 text-eyebrow font-semibold" aria-hidden="true">
            {(nombre.charAt(0) || "A").toUpperCase()}
          </div>
          <div className={cn("min-w-0 flex-1", collapsed ? "hidden" : "hidden lg:block")}>
            <p className="text-ui font-medium leading-tight truncate" title={user?.email}>
              {nombre || "Sin sesión"}
            </p>
            <p className="text-2xs uppercase text-faint truncate">{rolEtiqueta ?? "—"}</p>
          </div>
          <button
            type="button"
            onClick={onLogout}
            aria-label="Cerrar sesión"
            title="Cerrar sesión"
            className="size-7 rounded-lg flex items-center justify-center shrink-0 text-destructive transition-colors hover:bg-destructive-tint"
          >
            <LogOut className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </aside>
  );
}

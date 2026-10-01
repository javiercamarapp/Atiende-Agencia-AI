// Shell unico de las verticales de Atiende (PR-4 del plan de diseno-ux, 4.5/4.6).
//
// Sustituye al shell artesanal que cada vertical repetia (sidebar, cabecera
// movil, BottomNav, menu de cuenta, cabecera de escritorio, <main>). Es
// deliberadamente "tonto" como el resto de @atiende/ui: no hace fetch ni conoce
// sesiones; recibe ya armados los datos y los slots (campana, chat, selector de
// sucursal u organizacion). La sesion vive en `useVerticalSession` (apps/web).
//
// Aspecto: sin `data-theme="v2"` la maqueta es la misma de siempre; las migas de
// escritorio solo se ven bajo v2 (clase condicionada al atributo del <html>, asi
// reacciona sin recargar). El orden y las medidas de Sidebar/MobileHeader/
// BottomNav/<main> no cambian.
import * as React from "react";
import { Link, useLocation } from "react-router-dom";
import { ChevronRight, Compass } from "lucide-react";
import { AtiendeWordmark } from "./AtiendeLogo";
import { BottomNav, MobileHeader, type BottomNavItem } from "./BottomNav";
import { DashboardHeader } from "./DashboardHeader";
import { EstadoCargando } from "./EstadoCargando";
import { EstadoError } from "./EstadoError";
import { EstadoVacio } from "./EstadoVacio";
import { MobileAccountMenu } from "./MobileAccountMenu";
import { Sidebar, type SidebarSection } from "./Sidebar";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export const VERTICAL_SHELL_MAIN_ID = "contenido-principal";

// ---- Migas ----------------------------------------------------------------

export interface VerticalMiga {
  readonly etiqueta: string;
  readonly to?: string;
}

/**
 * Migas de la ruta actual: `[raiz, grupo, destino]`. El destino es el item de
 * `sections` cuya ruta es el prefijo mas largo del `pathname`; si ninguno
 * coincide solo queda la raiz (p. ej. una pagina 404 dentro del shell). El
 * grupo se omite cuando es identico a la etiqueta del destino (un grupo de un
 * solo item, como "Agenda").
 */
export function construirMigas(sections: readonly SidebarSection[], pathname: string, raiz: VerticalMiga): VerticalMiga[] {
  let mejor: { grupo: string; etiqueta: string; to: string } | null = null;
  for (const s of sections) {
    for (const it of s.items) {
      const coincide = pathname === it.to || pathname.startsWith(`${it.to}/`);
      if (coincide && (!mejor || it.to.length > mejor.to.length)) mejor = { grupo: s.title, etiqueta: it.label, to: it.to };
    }
  }
  if (!mejor) return [{ etiqueta: raiz.etiqueta }];
  const migas: VerticalMiga[] = [raiz];
  if (mejor.grupo.trim().toLowerCase() !== mejor.etiqueta.trim().toLowerCase()) migas.push({ etiqueta: mejor.grupo });
  migas.push({ etiqueta: mejor.etiqueta });
  return migas;
}

function Migas({ migas }: { migas: readonly VerticalMiga[] }) {
  return (
    <nav
      aria-label="Migas de pan"
      data-testid="vertical-migas"
      className="hidden items-center border-b border-border bg-card px-4 py-1.5 text-xs text-muted-foreground [[data-theme=v2]_&]:flex"
    >
      <ol className="flex min-w-0 flex-wrap items-center gap-1">
        {migas.map((m, i) => {
          const ultima = i === migas.length - 1;
          return (
            <li key={`${i}-${m.etiqueta}`} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight aria-hidden="true" className="size-3 shrink-0" strokeWidth={1.75} />}
              {ultima || !m.to ? (
                <span aria-current={ultima ? "page" : undefined} className={cn("truncate", ultima && "font-medium text-foreground")}>
                  {m.etiqueta}
                </span>
              ) : (
                <Link to={m.to} className="truncate hover:text-foreground">
                  {m.etiqueta}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---- Estados de arranque y de ruta -----------------------------------------

export interface VerticalShellEstadoProps {
  readonly estado: "cargando" | "error" | "vacio";
  readonly mensaje?: string;
  readonly onReintentar?: () => void;
}

/** Centrado a pantalla completa para los estados que corren ANTES de que exista shell (sesion, sucursales). */
export function VerticalShellEstado({ estado, mensaje, onReintentar }: VerticalShellEstadoProps) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {estado === "cargando" && <EstadoCargando variante="pantalla" etiqueta={mensaje ?? "Cargando…"} />}
        {estado === "error" && <EstadoError mensaje={mensaje} onReintentar={onReintentar} />}
        {estado === "vacio" && <EstadoVacio mensaje={mensaje ?? "No hay nada que mostrar todavía."} />}
      </div>
    </div>
  );
}

interface RutaBoundaryProps {
  /** Al cambiar (la ruta), un error previo se descarta y se vuelve a pintar la pagina. */
  readonly resetKey: string;
  readonly children: React.ReactNode;
}
interface RutaBoundaryState {
  readonly error: Error | null;
  readonly resetKey: string;
}

/**
 * Limite de error + carga perezosa de una ruta: una pagina que lanza al
 * renderizar muestra `EstadoError` con "Reintentar" en vez de dejar el panel en
 * blanco, y una pagina `React.lazy` muestra `EstadoCargando`. No intercepta
 * errores de red: esos los maneja cada pagina con su propio estado.
 */
export class RutaBoundary extends React.Component<RutaBoundaryProps, RutaBoundaryState> {
  override state: RutaBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<RutaBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: RutaBoundaryProps, state: RutaBoundaryState): Partial<RutaBoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      return (
        <EstadoError
          titulo="Esta pantalla no pudo mostrarse"
          mensaje="Ocurrió un problema al abrir esta sección. Inténtalo de nuevo; el resto del panel sigue disponible."
          onReintentar={() => this.setState({ error: null })}
        />
      );
    }
    return <React.Suspense fallback={<EstadoCargando variante="tarjeta" etiqueta="Cargando pantalla…" />}>{this.props.children}</React.Suspense>;
  }
}

export interface VerticalNoEncontradoProps {
  /** Ruta del panel a la que vuelve el enlace (la landing de la vertical). */
  readonly volverA: string;
  readonly volverEtiqueta?: string;
}

/** 404 dentro del shell: la navegacion sigue disponible y hay un enlace de regreso al panel. */
export function VerticalNoEncontrado({ volverA, volverEtiqueta = "Volver al panel" }: VerticalNoEncontradoProps) {
  return (
    <EstadoVacio
      icon={Compass}
      titulo="Página no encontrada"
      mensaje="La dirección que abriste no existe en este panel o cambió de lugar."
      accion={
        <Button asChild variant="outline" size="sm">
          <Link to={volverA}>{volverEtiqueta}</Link>
        </Button>
      }
    />
  );
}

// ---- Shell ------------------------------------------------------------------

export interface VerticalShellProps {
  /** Identificador de la vertical ("citas"); namespace de las preferencias del Sidebar. */
  readonly vertical: string;
  readonly sections: SidebarSection[];
  /** Destinos curados de la barra inferior (hasta 4; el 5.o lugar es "Más", que lista TODAS las `sections`). */
  readonly mobileItems: BottomNavItem[];
  readonly user: { email: string; rol?: string } | null;
  readonly onLogout: () => void;
  readonly loggingOut?: boolean;
  /** Barra de escritorio (`DashboardHeader` variante vertical). */
  readonly header: { readonly icon: React.ReactNode; readonly title: string; readonly fecha: string };
  /** Campana ya armada; se usa en escritorio y, si no hay `mobileNotificationBell`, tambien en movil. */
  readonly notificationBell: React.ReactNode;
  readonly mobileNotificationBell?: React.ReactNode;
  /** "Chatea con tus datos": barra de escritorio y menu de cuenta movil. */
  readonly chatButton?: React.ReactNode;
  readonly mobileChatButton?: React.ReactNode;
  /** Slot: selector (o nombre) de sucursal, bajo el logo del Sidebar. */
  readonly branchSelector?: React.ReactNode;
  /** Slot: selector de organizacion, sobre el de sucursal. */
  readonly organizationSelector?: React.ReactNode;
  /** Selector que ademas se muestra en el MobileHeader (solo si hay varias opciones). */
  readonly mobileSelector?: React.ReactNode;
  /** `key` del <main>: al cambiar (sucursal activa) las paginas hijas se remontan. */
  readonly contentKey?: string;
  readonly children: React.ReactNode;
}

export function VerticalShell({
  vertical,
  sections,
  mobileItems,
  user,
  onLogout,
  loggingOut = false,
  header,
  notificationBell,
  mobileNotificationBell,
  chatButton,
  mobileChatButton,
  branchSelector,
  organizationSelector,
  mobileSelector,
  contentKey,
  children,
}: VerticalShellProps) {
  const { pathname } = useLocation();
  const migas = construirMigas(sections, pathname, { etiqueta: header.title });
  const selectores =
    organizationSelector || branchSelector ? (
      <div className="space-y-2">
        {organizationSelector}
        {branchSelector}
      </div>
    ) : undefined;

  return (
    <div data-vertical={vertical} className="min-h-screen bg-background flex w-full">
      <a
        href={`#${VERTICAL_SHELL_MAIN_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:border focus:border-border focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-elevated"
      >
        Saltar al contenido
      </a>

      <div className="hidden md:block p-3">
        <Sidebar sections={sections} user={user} onLogout={onLogout} hotelSelector={selectores} storageScope={vertical} />
      </div>

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        action={
          <div className="flex items-center gap-1 min-w-0">
            {mobileSelector ? <div className="min-w-0 max-w-[40vw]">{mobileSelector}</div> : null}
            {mobileNotificationBell ?? notificationBell}
            <MobileAccountMenu user={user} onLogout={onLogout} loggingOut={loggingOut}>
              {mobileChatButton ?? chatButton}
            </MobileAccountMenu>
          </div>
        }
      />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="hidden md:block">
          <DashboardHeader variant="vertical" icon={header.icon} title={header.title} fecha={header.fecha} notificationBell={notificationBell} chatButton={chatButton} />
          <Migas migas={migas} />
        </div>
        {/* `key` fuerza el remontaje de las paginas hijas cuando cambia la sucursal activa. */}
        <main id={VERTICAL_SHELL_MAIN_ID} tabIndex={-1} key={contentKey} className="flex-1 px-4 py-4 pt-20 pb-24 md:pt-4 md:pb-8 md:px-6 overflow-auto focus:outline-none">
          <div className="max-w-6xl mx-auto w-full">
            {/* Transicion de navegacion: entrada breve (tokens de motion) al cambiar de ruta, solo con movimiento permitido. */}
            <div key={pathname} className="motion-safe:animate-page-in">
              <RutaBoundary resetKey={pathname}>{children}</RutaBoundary>
            </div>
          </div>
        </main>
      </div>

      <BottomNav items={mobileItems} moreSections={sections} />
    </div>
  );
}

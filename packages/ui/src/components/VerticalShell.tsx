// Shell unico de las verticales de Atiende (PR-4 del plan de diseno-ux, 4.5/4.6).
//
// Sustituye al shell artesanal que cada vertical repetia (sidebar, cabecera
// movil, BottomNav, menu de cuenta, cabecera de escritorio, <main>). Es
// deliberadamente "tonto" como el resto de @atiende/ui: no hace fetch ni conoce
// sesiones; recibe ya armados los datos y los slots (campana, chat, selector de
// sucursal u organizacion). La sesion vive en `useVerticalSession` (apps/web).
//
// Marco (spec UNI-1 §4-5): lienzo `--background`; sidebar sticky `top-4` a `100dvh - 2rem`; columna de
// contenido gris sumido con hairline, `rounded-2xl` y scroll interno (misma altura y tope que el Sidebar);
// en movil, MobileHeader fijo (logo + nombre de la pagina) y BottomNav de 63 px, con los paddings de
// safe-area (`--safe-area-*`, que valen algo gracias a `viewport-fit=cover` en index.html).
import * as React from "react";
import { flushSync } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { Compass } from "lucide-react";
import { AtiendeWordmark } from "./AtiendeLogo";
import { BottomNav, MobileHeader, type BottomNavItem } from "./BottomNav";
import { BarraPagina } from "./BarraPagina";
import { EstadoCargando } from "./EstadoCargando";
import { EstadoError } from "./EstadoError";
import { EstadoVacio } from "./EstadoVacio";
import { MobileAccountMenu } from "./MobileAccountMenu";
import { Sidebar, type SidebarItem, type SidebarPiePildora, type SidebarSection, type SidebarUser } from "./Sidebar";
import { Button } from "./ui/button";

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
  const mejor = itemActivo(sections, pathname);
  if (!mejor) return [{ etiqueta: raiz.etiqueta }];
  const migas: VerticalMiga[] = [raiz];
  if (mejor.grupo.trim().toLowerCase() !== mejor.item.label.trim().toLowerCase()) migas.push({ etiqueta: mejor.grupo });
  migas.push({ etiqueta: mejor.item.label });
  return migas;
}

/** Item de navegacion activo: el de `sections` cuya ruta es el prefijo mas largo del `pathname` (null si ninguno). */
export function itemActivo(sections: readonly SidebarSection[], pathname: string): { grupo: string; item: SidebarItem } | null {
  let mejor: { grupo: string; item: SidebarItem } | null = null;
  for (const s of sections) {
    for (const it of s.items) {
      const coincide = pathname === it.to || pathname.startsWith(`${it.to}/`);
      if (coincide && (!mejor || it.to.length > mejor.item.to.length)) mejor = { grupo: s.title, item: it };
    }
  }
  return mejor;
}

// ---- Titulo de la barra superior -------------------------------------------

export interface TituloBarra {
  readonly titulo: string;
  /** Icono (componente lucide) de 15 px; sin el, la barra usa el del item activo o el de `header`. */
  readonly icono?: SidebarItem["icon"];
}

const TituloBarraContext = React.createContext<((t: TituloBarra | null) => void) | null>(null);

/**
 * Una pagina sobrescribe el nombre (y opcionalmente el icono) de la barra superior, p. ej. una
 * ficha de detalle ("Pedido 1042"). Al desmontarse la pagina la barra vuelve a derivarse de la
 * ruta activa. Fuera de un `VerticalShell` no hace nada.
 */
export function useTituloBarra(titulo: string | null | undefined, icono?: SidebarItem["icon"]): void {
  const fijar = React.useContext(TituloBarraContext);
  React.useEffect(() => {
    if (!fijar || !titulo) return undefined;
    fijar(icono ? { titulo, icono } : { titulo });
    return () => fijar(null);
  }, [fijar, titulo, icono]);
}

// ---- Acciones de pagina en la barra superior y marco de contenido ------------

const AccionesBarraContext = React.createContext<((n: React.ReactNode) => void) | null>(null);

/**
 * Una pagina pinta acciones propias en la barra superior de escritorio (junto al chat y la campana), p. ej. «Vista previa» del agente de voz.
 * Al desmontarse la pagina se quitan. Fuera de un `VerticalShell` no hace nada (la pagina debe tener su propio acceso, p. ej. para movil,
 * donde esta barra no existe).
 */
export function useAccionesBarra(acciones: React.ReactNode): void {
  const fijar = React.useContext(AccionesBarraContext);
  React.useEffect(() => {
    if (!fijar) return undefined;
    fijar(acciones);
    return () => fijar(null);
  }, [fijar, acciones]);
}

const MarcoShellContext = React.createContext<HTMLElement | null>(null);

/** Elemento del marco de contenido de escritorio (barra superior + pagina): destino de portales que deben cubrirlo entero, como la vista previa de llamada. */
export function useMarcoShell(): HTMLElement | null {
  return React.useContext(MarcoShellContext);
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
  readonly user: SidebarUser | null;
  /**
   * Pildoras del pie del Sidebar de escritorio ("Costos de IA", "Ver los otros paneles", "Pregunta a tus
   * datos"); en movil se agregan a la hoja "Mas" como seccion "Cuenta". Cada una necesita un destino real.
   */
  readonly sidebarPie?: SidebarPiePildora[];
  readonly onLogout: () => void;
  readonly loggingOut?: boolean;
  /**
   * Barra de escritorio (`BarraPagina`). `title`/`icon` son los de la raiz del panel ("Consola de
   * <vertical>") y solo se pintan en el Resumen (`resumenTo`) o si la ruta no coincide con ningun
   * item; en las demas paginas la barra muestra la etiqueta y el icono del item activo del
   * Sidebar, y la pagina puede sobrescribirlos con `useTituloBarra`.
   */
  readonly header: { readonly icon: React.ReactNode; readonly title: string; readonly fecha: string; readonly resumenTo?: string };
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
  /** Panel lateral derecho (p. ej. el Copiloto Cmd+J del superadmin): hermano de la columna de contenido; el propio panel anima su ancho. Sin el, nada cambia. */
  readonly panelLateral?: React.ReactNode;
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
  sidebarPie,
  contentKey,
  panelLateral,
  children,
}: VerticalShellProps) {
  const { pathname } = useLocation();
  const mainRef = React.useRef<HTMLElement>(null);
  const [sinH1, setSinH1] = React.useState(false);
  // Una pagina sin <h1> propio no deja la pantalla sin encabezado: la barra hace de nivel 1 hasta que la pagina pinte el suyo.
  React.useEffect(() => {
    const main = mainRef.current;
    if (!main) return undefined;
    const medir = () => setSinH1(main.querySelector('h1, [role="heading"][aria-level="1"]') === null);
    medir();
    // Sincrono (flushSync): si el cambio se aplicara en una tarea posterior, entre que la pagina pinta su <h1> (p. ej. al bajar
    // su chunk perezoso o sus datos) y que la barra deja de hacer de nivel 1 habria un instante con DOS encabezados de nivel 1.
    const observador = new MutationObserver(() => flushSync(medir));
    observador.observe(main, { childList: true, subtree: true });
    return () => observador.disconnect();
  }, [pathname, contentKey]);
  const [sobrescrito, fijarTitulo] = React.useState<TituloBarra | null>(null);
  const [accionesBarra, fijarAcciones] = React.useState<React.ReactNode>(null);
  const [marco, fijarMarco] = React.useState<HTMLElement | null>(null);
  // Los destinos del pie del Sidebar ("Ver los otros paneles") tambien son paginas del panel aunque no esten en `sections`:
  // la barra les pone su nombre en vez del titulo de la consola. Van DESPUES de `sections`, asi un destino que ya es de una
  // categoria (p. ej. "Costos de IA" -> "Costos y margen") conserva el nombre de su categoria.
  const destinosPie: SidebarSection[] = (sidebarPie ?? []).some((p) => p.to)
    ? [{ title: "Cuenta", items: (sidebarPie ?? []).filter((p) => p.to).map((p) => ({ to: p.to as string, label: p.label, icon: p.icon ?? Compass })) }]
    : [];
  const activo = itemActivo([...sections, ...destinosPie], pathname);
  const esResumen = header.resumenTo !== undefined && pathname === header.resumenTo;
  const barraDeRuta = !activo || esResumen ? null : activo.item;
  const IconoBarra = sobrescrito?.icono ?? barraDeRuta?.icon;
  const tituloBarra = sobrescrito?.titulo ?? barraDeRuta?.label ?? header.title;
  const iconoBarra = IconoBarra ? <IconoBarra className="size-[15px] text-muted-foreground" strokeWidth={1.75} /> : header.icon;
  const selectores =
    organizationSelector || branchSelector ? (
      <div className="space-y-2">
        {organizationSelector}
        {branchSelector}
      </div>
    ) : undefined;

  return (
    <div data-vertical={vertical} className="min-h-[100dvh] bg-background flex w-full">
      <a
        href={`#${VERTICAL_SHELL_MAIN_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:border focus:border-border focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-elevated"
      >
        Saltar al contenido
      </a>

      <div className="hidden md:block md:p-4 md:pr-0">
        <Sidebar sections={sections} user={user} onLogout={onLogout} hotelSelector={selectores} storageScope={vertical} pie={sidebarPie} />
      </div>

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        pagina={{ icon: iconoBarra, title: tituloBarra, comoH1: sinH1 }}
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

      {/* Marco de Likida: columna de contenido gris tenue (--sunken = --g1) con hairline y esquinas
          redondeadas; la barra queda dentro, blanca, y las tarjetas blancas encima. */}
      <div ref={fijarMarco} className="relative flex min-w-0 flex-1 flex-col bg-sunken md:sticky md:top-4 md:m-4 md:h-[calc(100dvh-2rem)] md:overflow-hidden md:rounded-2xl md:border md:border-border">
        <div className="hidden md:block shrink-0">
          <BarraPagina icon={iconoBarra} title={tituloBarra} fecha={header.fecha} notificationBell={notificationBell} chatButton={chatButton} acciones={accionesBarra} comoH1={sinH1} />
        </div>
        {/* `key` fuerza el remontaje de las paginas hijas cuando cambia la sucursal activa. */}
        <main
          ref={mainRef}
          id={VERTICAL_SHELL_MAIN_ID}
          tabIndex={-1}
          key={contentKey}
          className="flex-1 min-h-0 overflow-y-auto focus:outline-none px-4 pt-[calc(6rem+var(--safe-area-top))] pb-[calc(7rem+var(--safe-area-bottom))] md:px-5 md:pt-3.5 md:pb-5"
        >
          {/* Transicion de navegacion: entrada breve (tokens de motion) al cambiar de ruta, solo con movimiento permitido. Sin `max-w`: ancho completo del marco. */}
          <div key={pathname} className="motion-safe:animate-page-in">
            <TituloBarraContext.Provider value={fijarTitulo}>
              <AccionesBarraContext.Provider value={fijarAcciones}>
                <MarcoShellContext.Provider value={marco}>
                  <RutaBoundary resetKey={pathname}>{children}</RutaBoundary>
                </MarcoShellContext.Provider>
              </AccionesBarraContext.Provider>
            </TituloBarraContext.Provider>
          </div>
        </main>
      </div>

      {panelLateral}

      <BottomNav items={mobileItems} moreSections={sections} pie={sidebarPie} />
    </div>
  );
}

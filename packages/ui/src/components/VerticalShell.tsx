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
import { useLocation } from "react-router-dom";
import { CircleHelp, Compass, Ellipsis, ShieldCheck } from "lucide-react";
import { AtiendeWordmark } from "./AtiendeLogo";
import { BottomNav, CampanaMovil, MAS_ABRIR_EVENTO, MobileHeader, type BottomNavItem, type CampanaMovilProps } from "./BottomNav";
import { BarraPagina } from "./BarraPagina";
import { EstadoCargando } from "./EstadoCargando";
import { EstadoError } from "./EstadoError";
import { RecuperarCarga } from "./RecuperarCarga";
import { esErrorDeCarga } from "../lib/recuperar-carga";
import { EstadoVacio } from "./EstadoVacio";
import { MobileAccountMenu } from "./MobileAccountMenu";
import { Sidebar, type SidebarItem, type SidebarPiePildora, type SidebarSection, type SidebarUser } from "./Sidebar";
import { I18nContexto, useT, type ContextoI18n } from "../i18n/proveedor";
import { shell } from "../i18n/mensajes/shell.ts";
import { GrupoNavContext } from "./PageHeader";

export const VERTICAL_SHELL_MAIN_ID = "contenido-principal";

/**
 * Evento que anuncia «abrir la guia de esta pantalla» (boton «Guía» del encabezado ds3). El recorrido guiado es de otro carril:
 * se engancha escuchando este evento en `window` (`detail.ruta` = pathname) o pasando `onGuia` al shell.
 */
export const GUIA_ABRIR_EVENTO = "atiende:guia:abrir";

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

/**
 * La pagina declara que su nombre NO va en la barra: la barra muestra el titulo y el icono de la consola (como en el Resumen). Lo usa
 * el Copiloto de las verticales: «Pregúntale a tus datos» solo vive en el menu y en el h1 de su portada, nunca en el encabezado.
 */
export function useBarraDeConsola(): void {
  const fijar = React.useContext(TituloBarraContext);
  React.useEffect(() => {
    if (!fijar) return undefined;
    fijar({ titulo: "" });
    return () => fijar(null);
  }, [fijar]);
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
  const t = useT(shell);
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {estado === "cargando" && <EstadoCargando variante="pantalla" etiqueta={mensaje ?? t("shell.cargando")} />}
        {estado === "error" && <EstadoError mensaje={mensaje} onReintentar={onReintentar} />}
        {estado === "vacio" && <EstadoVacio mensaje={mensaje ?? t("shell.vacio")} />}
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
  static override contextType = I18nContexto;
  declare context: ContextoI18n;
  override state: RutaBoundaryState = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<RutaBoundaryState> {
    return { error };
  }

  static getDerivedStateFromProps(props: RutaBoundaryProps, state: RutaBoundaryState): Partial<RutaBoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  override render(): React.ReactNode {
    if (this.state.error) {
      // Chunk que no bajo: reintentar el render no sirve (React.lazy guarda el rechazo); se recarga o se limpia la cache.
      if (esErrorDeCarga(this.state.error)) return <RecuperarCarga />;
      return (
        <EstadoError
          titulo={this.context.t("shell.errorRuta.titulo")}
          mensaje={this.context.t("shell.errorRuta.mensaje")}
          onReintentar={() => this.setState({ error: null })}
        />
      );
    }
    return <React.Suspense fallback={<EstadoCargando variante="tarjeta" etiqueta={this.context.t("shell.cargandoPantalla")} />}>{this.props.children}</React.Suspense>;
  }
}

// VerticalNoEncontrado vive en su propio modulo para que la entrada de la app (App.tsx) lo importe sin arrastrar el shell
// completo (Sidebar, BottomNav, menus) al chunk de arranque; aqui solo se re-exporta para no romper importaciones existentes.
export { VerticalNoEncontrado, type VerticalNoEncontradoProps } from "./VerticalNoEncontrado";

// ---- Shell ------------------------------------------------------------------

export interface VerticalShellProps {
  /** Identificador de la vertical ("citas"); namespace de las preferencias del Sidebar. */
  readonly vertical: string;
  readonly sections: SidebarSection[];
  /** Destinos curados de la barra inferior (hasta 4; el 5.o lugar es "Más", que lista TODAS las `sections`). */
  readonly mobileItems: BottomNavItem[];
  readonly user: SidebarUser | null;
  /**
   * Pildoras del pie del Sidebar de escritorio ("Costos de IA", "Ver los otros paneles", "Pregúntale a tus
   * datos", "Notificaciones"); en movil se agregan a la hoja "Mas" como seccion "Cuenta". Cada una necesita un destino real.
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
  readonly header: { readonly icon: React.ReactNode; readonly title: string; readonly resumenTo?: string };
  /** Slot: selector (o nombre) de sucursal, bajo el logo del Sidebar. */
  readonly branchSelector?: React.ReactNode;
  /** Slot: selector de organizacion, sobre el de sucursal. */
  readonly organizationSelector?: React.ReactNode;
  /** Selector que ademas se muestra en el MobileHeader (solo si hay varias opciones). */
  readonly mobileSelector?: React.ReactNode;
  /** Panel lateral derecho (p. ej. el Copiloto Cmd+J del superadmin): hermano de la columna de contenido; el propio panel anima su ancho. Sin el, nada cambia. */
  readonly panelLateral?: React.ReactNode;
  /**
   * Ranura del historial de «Pregúntale a tus datos» (ds3): el carril del chat monta aqui UN `Drawer` (sm, 420) con el historial; el
   * shell solo le da un lugar unico y estable fuera del <main> (no se remonta al navegar ni al cambiar de sucursal). Sin ella no se pinta nada.
   */
  readonly historialChat?: React.ReactNode;
  /** `key` del <main>: al cambiar (sucursal activa) las paginas hijas se remontan. */
  readonly contentKey?: string;
  /** Nombre de la organizacion activa: en ds3 la tarjeta de cuenta del pie lo muestra junto al rol. Opcional. */
  readonly organizacion?: string;
  /**
   * Enlace a la administracion de la plataforma (solo para administradores de plataforma; quien arma el shell decide si lo pasa).
   * Va como ultima fila del pie del sidebar y de la hoja «Más». Sin el, no se pinta.
   */
  readonly adminHref?: string;
  /**
   * Accion del boton «Guía» del encabezado ds3 (punto de enganche del recorrido guiado). Sin ella el boton anuncia
   * `GUIA_ABRIR_EVENTO` en `window`. Sin la bandera ds3 el boton existe oculto.
   */
  readonly onGuia?: () => void;
  /**
   * ds3 (decision de Omar 7-nov-2026): campana con contador en la cabecera movil, enlace a la pagina de notificaciones. Sin la bandera
   * existe oculta (las notificaciones siguen en la pildora del pie / hoja «Más»).
   */
  readonly notificaciones?: CampanaMovilProps;
  /**
   * ds3 (decision de Omar 7-nov-2026): ruta del chat de datos («Pregúntale a tus datos») como destino fijo de la barra inferior movil,
   * entre los destinos curados y «Más». Solo para roles con acceso; sin ella no se pinta. Sin la bandera existe oculto.
   */
  readonly preguntarHref?: string;
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
  branchSelector,
  organizationSelector,
  mobileSelector,
  sidebarPie,
  contentKey,
  panelLateral,
  historialChat,
  organizacion,
  adminHref,
  onGuia,
  notificaciones,
  preguntarHref,
  children,
}: VerticalShellProps) {
  const t = useT(shell);
  const pie: SidebarPiePildora[] | undefined = adminHref
    ? [...(sidebarPie ?? []), { label: t("shell.administracionAtiende"), to: adminHref, icon: ShieldCheck }]
    : sidebarPie;
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
  const destinosPie: SidebarSection[] = (pie ?? []).some((p) => p.to)
    ? [{ title: t("shell.cuenta"), items: (pie ?? []).filter((p) => p.to).map((p) => ({ to: p.to as string, label: p.label, icon: p.icon ?? Compass })) }]
    : [];
  const activo = itemActivo([...sections, ...destinosPie], pathname);
  const esResumen = header.resumenTo !== undefined && pathname === header.resumenTo;
  const barraDeRuta = !activo || esResumen ? null : activo.item;
  // `titulo: ""` (useBarraDeConsola) = la pagina no pone su nombre en la barra: vale el titulo y el icono de la consola.
  const barraDeConsola = sobrescrito?.titulo === "";
  const IconoBarra = barraDeConsola ? undefined : (sobrescrito?.icono ?? barraDeRuta?.icon);
  const tituloBarra = barraDeConsola ? header.title : (sobrescrito?.titulo ?? barraDeRuta?.label ?? header.title);
  // ds3: el encabezado lleva SIEMPRE el nombre de la pagina (tambien en el Resumen); el de la consola queda solo si la ruta no es del menu.
  const tituloDs3 = sobrescrito?.titulo || activo?.item.label || header.title;
  // ds3: grupo del menu de la pantalla activa, antetitulo del PageHeader.
  const grupoNav = activo ? activo.grupo : null;
  const iconoBarra = IconoBarra ? <IconoBarra className="size-[15px] text-muted-foreground" strokeWidth={1.75} /> : header.icon;
  const selectores =
    organizationSelector || branchSelector ? (
      <div className="space-y-2">
        {organizationSelector}
        {branchSelector}
      </div>
    ) : undefined;

  return (
    <div data-vertical={vertical} className="ds3-shell min-h-[100dvh] bg-background flex w-full">
      <a
        href={`#${VERTICAL_SHELL_MAIN_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:border focus:border-border focus:bg-card focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-elevated"
      >
        {t("shell.saltarAlContenido")}
      </a>

      <div className="ds3-shell-lateral hidden md:block md:p-4 md:pr-0">
        <Sidebar sections={sections} user={user} onLogout={onLogout} hotelSelector={selectores} storageScope={vertical} pie={pie} organizacion={organizacion} />
      </div>

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        pagina={{ icon: iconoBarra, title: tituloBarra, comoH1: sinH1 }}
        action={
          <div className="ds3-movil-acciones flex items-center gap-1 min-w-0">
            {mobileSelector ? <div className="min-w-0 max-w-[48vw]">{mobileSelector}</div> : null}
            {/* ds3 (decision de Omar 7-nov-2026, igual que Rovaq): campana con contador y «Más» de 44 que abre la hoja con el sidebar
                completo (cuenta, tema y salir incluidos); el menu de cuenta del diseno actual se oculta. El chat de datos no va aqui: es
                «Preguntar» de la barra inferior. */}
            {notificaciones ? <CampanaMovil {...notificaciones} /> : null}
            <button
              type="button"
              hidden
              aria-label={t("shell.abrirMasSecciones")}
              aria-haspopup="dialog"
              onClick={() => window.dispatchEvent(new Event(MAS_ABRIR_EVENTO))}
              className="ds3-solo ds3-movil-mas"
            >
              <Ellipsis aria-hidden="true" strokeWidth={1.75} />
            </button>
            <span className="ds3-no contents">
              <MobileAccountMenu user={user} onLogout={onLogout} loggingOut={loggingOut} />
            </span>
          </div>
        }
      />

      {/* Marco de Likida: columna de contenido gris tenue (--sunken = --g1) con hairline y esquinas
          redondeadas; la barra queda dentro, blanca, y las tarjetas blancas encima. */}
      <div ref={fijarMarco} data-pantalla={barraDeConsola ? "chat" : undefined} className="ds3-shell-marco relative flex min-w-0 flex-1 flex-col bg-sunken md:sticky md:top-4 md:m-4 md:h-[calc(100dvh-2rem)] md:overflow-hidden md:rounded-2xl md:border md:border-border">
        {/* ds3: la zona es la barra de 44 px (la cabecera interna se aplana con display:contents) y el boton «Guía» queda junto al
            titulo; vive FUERA de [data-testid="barra-pagina"] para que la barra del diseno actual siga sin botones propios. */}
        <div className="ds3-cabecera-zona hidden md:block shrink-0" data-sin-cabecera={barraDeConsola ? "" : undefined}>
          <BarraPagina
            icon={iconoBarra}
            title={tituloBarra}
            tituloDs3={tituloDs3 !== tituloBarra ? tituloDs3 : undefined}
            acciones={accionesBarra}
            comoH1={sinH1}
            className="ds3-cabecera"
          />
          <button
            type="button"
            hidden
            data-testid="barra-guia"
            onClick={() => (onGuia ? onGuia() : window.dispatchEvent(new CustomEvent(GUIA_ABRIR_EVENTO, { detail: { ruta: pathname } })))}
            className="ds3-solo ds3-guia"
          >
            <CircleHelp aria-hidden="true" strokeWidth={1.75} />
            {t("shell.guia")}
          </button>
        </div>
        {/* `key` fuerza el remontaje de las paginas hijas cuando cambia la sucursal activa. */}
        <main
          ref={mainRef}
          id={VERTICAL_SHELL_MAIN_ID}
          tabIndex={-1}
          key={contentKey}
          className="ds3-shell-contenido flex-1 min-h-0 overflow-y-auto focus:outline-none px-4 pt-[calc(5.5rem+var(--safe-area-top))] pb-[calc(7rem+var(--safe-area-bottom))] md:px-5 md:pt-3.5 md:pb-5"
        >
          {/* Transicion de navegacion: entrada breve (tokens de motion) al cambiar de ruta, solo con movimiento permitido. Sin `max-w`: ancho completo del marco. */}
          <div key={pathname} className="ds3-shell-pagina motion-safe:animate-page-in">
            <TituloBarraContext.Provider value={fijarTitulo}>
              <AccionesBarraContext.Provider value={fijarAcciones}>
                <MarcoShellContext.Provider value={marco}>
                  <GrupoNavContext.Provider value={grupoNav}>
                    <RutaBoundary resetKey={pathname}>{children}</RutaBoundary>
                  </GrupoNavContext.Provider>
                </MarcoShellContext.Provider>
              </AccionesBarraContext.Provider>
            </TituloBarraContext.Provider>
          </div>
        </main>
      </div>

      {panelLateral}

      {historialChat ? <div data-testid="ranura-historial-chat" className="contents">{historialChat}</div> : null}

      <BottomNav
        items={mobileItems}
        moreSections={sections}
        pie={pie}
        cuenta={{ user, onLogout, loggingOut }}
        preguntar={preguntarHref ? { to: preguntarHref } : undefined}
      />
    </div>
  );
}

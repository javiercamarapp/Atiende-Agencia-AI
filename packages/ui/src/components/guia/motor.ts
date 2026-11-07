// Motor del recorrido guiado («Guía», ds3): logica PURA, sin DOM ni React ni red. Portado de Rovaq (lib/onboarding/recorrido.mjs,
// viaje.mjs, cableado.mjs, tour.mjs) y adaptado a Atiende: el recorrido se CONSTRUYE del menu real del rol (las mismas `sections`
// que recibe el Sidebar), asi cada vertical, cada rol y el superadmin tienen el suyo sin listas paralelas.
//
// Reglas que codifica (iguales a Rovaq):
//  - El recorrido SOLO se abre con `abrir` (una persona lo pidio). Un cambio de ruta jamas lo abre ni lo cierra: solo completa un paso
//    «ir» cuando llegas a la pantalla a la que te mandaba.
//  - Esc cierra y conserva el paso («Retomar donde lo dejé»); Siguiente en el ultimo paso cierra con `terminado`.
//  - Flechas izquierda/derecha cambian de paso salvo dentro de campos, listas o pestañas; Enter avanza SOLO dentro de la tarjeta.
//  - Viaje automatico de un paso «ir»: solo si se llego AVANZANDO por accion de la persona; cuenta visible de 3 s; se cancela con
//    «Quedarme aquí», Esc, Tab, clic fuera o tocar un campo; nunca con movimiento reducido, foco en un campo o formulario modificado.
// Diferencia deliberada con Rovaq: la tarjeta NUNCA tapa el elemento que resalta (`colocarTarjeta`; en Rovaq a 1440 px el paso 1 quedaba
// encima del primer KPI, BARRIDO-ROVAQ §5).

// ---------------------------------------------------------------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------------------------------------------------------------

export type TipoPaso = "ir" | "info" | "cierre";
export type ClavePaso = "ir" | "que" | "clave" | "accion" | "cierre";
export type ModoTour = "corto" | "completo";

/** Texto en los dos idiomas de la consola. */
export interface TextoBilingue {
  readonly es: string;
  readonly en: string;
}

export interface PasoTour {
  readonly id: string;
  readonly tipo: TipoPaso;
  readonly clave: ClavePaso;
  /** Ruta de la pantalla (null en el cierre). */
  readonly pantalla: string | null;
  /** Indice de la pantalla dentro del recorrido. */
  readonly grupo: number;
  readonly ilu: string;
  /** Selectores del elemento real; el primero visible gana. Vacio = tarjeta centrada. */
  readonly objetivos: readonly string[];
  /** null = usar el nombre de la pantalla (su etiqueta del menu). */
  readonly titulo: TextoBilingue | null;
  readonly cuerpo: TextoBilingue | null;
  /** Titulo del grupo del menu donde vive la pantalla (para desplegar el acordeon antes de señalar el item). */
  readonly menuGrupo?: string;
}

export interface EstadoRecorrido {
  readonly abierto: boolean;
  readonly indice: number;
  readonly terminado: boolean;
  readonly iniciadoPorPersona: boolean;
}

export type EventoRecorrido =
  | { readonly tipo: "abrir" | "ir"; readonly indice?: number }
  | { readonly tipo: "ruta"; readonly ruta?: string }
  | { readonly tipo: "siguiente" | "anterior" | "cerrar" | "clic" };

export const estadoInicial = (): EstadoRecorrido => ({ abierto: false, indice: 0, terminado: false, iniciadoPorPersona: false });

/** ¿La ruta actual es la pantalla `href`? Coincidencia exacta o subruta (las fichas de detalle cuentan como su pantalla). */
export function enPantalla(ruta: string | null | undefined, href: string | null | undefined): boolean {
  if (typeof ruta !== "string" || typeof href !== "string" || href === "") return false;
  const r = ruta.replace(/\/+$/, "") || "/";
  const h = href.replace(/\/+$/, "") || "/";
  return r === h || r.startsWith(`${h}/`);
}

/**
 * Como `enPantalla`, pero gana la pantalla MAS especifica del recorrido: en `/restaurantes/x/operacion/viajes` estas en «Viajes», no en
 * «Cola» (`/restaurantes/x/operacion`), aunque la segunda sea prefijo. `hrefs` = todas las pantallas del recorrido.
 */
export function pantallaActiva(ruta: string, hrefs: readonly string[]): string | null {
  let mejor: string | null = null;
  for (const h of hrefs) if (enPantalla(ruta, h) && (!mejor || h.length > mejor.length)) mejor = h;
  return mejor;
}

const acotar = (n: number, total: number) => Math.max(0, Math.min(Math.trunc(Number.isFinite(n) ? n : 0), Math.max(0, total - 1)));
const esIr = (p: PasoTour | undefined) => p?.tipo === "ir";

function estaEn(ruta: string | null, href: string | null, pasos: readonly PasoTour[]): boolean {
  if (ruta == null || !href) return false;
  return pantallaActiva(ruta, hrefsDe(pasos)) === href;
}
function hrefsDe(pasos: readonly PasoTour[]): string[] {
  return [...new Set(pasos.map((p) => p.pantalla).filter((h): h is string => Boolean(h)))];
}

/** No detenerse en un paso «ir» de la pantalla donde ya estamos (no hay nada que apretar). */
function sinIrInutiles(indice: number, dir: 1 | -1, pasos: readonly PasoTour[] | undefined, ruta: string | null): number {
  let i = indice;
  while (pasos && ruta != null && esIr(pasos[i]) && estaEn(ruta, pasos[i]!.pantalla, pasos)) i += dir;
  return i;
}

export function reducir(estado: EstadoRecorrido, evento: EventoRecorrido, total: number, pasos?: readonly PasoTour[], ruta: string | null = null): EstadoRecorrido {
  if (total <= 0) return estadoInicial();
  const avanzar = (): EstadoRecorrido => {
    if (!estado.abierto) return estado;
    if (estado.indice >= total - 1) return { ...estado, abierto: false, terminado: true };
    const i = sinIrInutiles(estado.indice + 1, 1, pasos, ruta);
    return i >= total ? { ...estado, abierto: false, terminado: true } : { ...estado, indice: i };
  };
  switch (evento.tipo) {
    case "abrir":
    case "ir": {
      if (evento.tipo === "ir" && !estado.abierto) return estado;
      const i = sinIrInutiles(acotar(evento.indice ?? 0, total), 1, pasos, ruta);
      return { abierto: true, indice: Math.min(i, total - 1), terminado: false, iniciadoPorPersona: true };
    }
    case "siguiente":
      return avanzar();
    case "anterior": {
      if (!estado.abierto) return estado;
      // Hacia atras un paso «ir» nunca es destino: volver a el solo re-dispararia el viaje.
      let i = acotar(estado.indice - 1, total);
      while (i >= 0 && esIr(pasos?.[i])) i--;
      return { ...estado, indice: i < 0 ? estado.indice : i };
    }
    case "cerrar":
      return estado.abierto ? { ...estado, abierto: false, terminado: false } : estado;
    case "clic":
      return estado.abierto && esIr(pasos?.[estado.indice]) ? avanzar() : estado;
    case "ruta": {
      const actual = pasos?.[estado.indice];
      return estado.abierto && actual && esIr(actual) && estaEn(evento.ruta ?? "", actual.pantalla, pasos ?? []) ? avanzar() : estado;
    }
    default:
      return estado;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------------------------------------------------------------

const ENTER_PROPIO = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"]);
const ROLES_PROPIOS = new Set(["textbox", "searchbox", "combobox", "listbox", "option", "slider", "spinbutton", "radio", "radiogroup", "tab", "tablist", "menu", "menubar", "menuitem", "tree", "treeitem", "grid", "gridcell"]);

interface ElementoMinimo {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  getAttribute?(nombre: string): string | null;
}

/** ¿El elemento usa las flechas/teclas para lo suyo? Entonces el recorrido no se las quita. */
export function teclasPropias(el: ElementoMinimo | null | undefined): boolean {
  if (!el) return false;
  const tag = String(el.tagName ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true) return true;
  const rol = typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
  return rol != null && ROLES_PROPIOS.has(rol);
}

export function eventoDeTecla(key: string, etiquetaObjetivo = "", { propias = false, modificador = false } = {}): EventoRecorrido | null {
  if (key === "Escape") return { tipo: "cerrar" };
  if (propias || modificador) return null;
  if (key === "ArrowRight") return { tipo: "siguiente" };
  if (key === "ArrowLeft") return { tipo: "anterior" };
  if (key === "Enter" && !ENTER_PROPIO.has(String(etiquetaObjetivo).toUpperCase())) return { tipo: "siguiente" };
  return null;
}

/** Evento del recorrido para una tecla del documento. Un evento ya consumido no hace nada (el Esc que cancelo la cuenta no cierra la guia). */
export function eventoDeTeclado(e: { key: string; defaultPrevented: boolean; tagName: string; dentroDeTarjeta: boolean; propias: boolean; modificador: boolean }): EventoRecorrido | null {
  if (e.defaultPrevented) return null;
  const ev = eventoDeTecla(e.key, e.tagName, { propias: e.propias, modificador: e.modificador });
  if (!ev) return null;
  if (e.key === "Enter" && !e.dentroDeTarjeta) return null;
  return ev;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Viaje automatico de un paso «ir»
// ---------------------------------------------------------------------------------------------------------------------------------

/** Cuenta regresiva visible antes de viajar. Nunca menos de 3 s: quien usa lector de pantalla necesita llegar a «Quedarme aquí». */
export const CUENTA_MS = 3000;
/** Tiempo para que llegue la ruta tras el clic; pasado, el paso sale por «No pude abrir esta pantalla». */
export const FALLO_MS = 3000;
export const TICK_MS = 1000;

export type OrigenCambio = "siguiente" | "abrir" | "anterior" | "cerrar" | "ruta" | "restaurar" | "clic" | "ir";
/** ¿Un paso alcanzado por este origen puede viajar solo? Solo avanzar por voluntad de la persona. */
export const armadoTras = (origen: string): boolean => origen === "siguiente" || origen === "abrir";

export type MotivoPlan = "no-ir" | "no-armado" | "buscando" | "movimiento-reducido" | "campo" | "formulario" | "ok";
export interface PlanViaje {
  readonly armar: boolean;
  readonly ms: number;
  readonly manual: boolean;
  readonly motivo: MotivoPlan;
}

export function planearViaje(e: { tipo?: string; armado: boolean; elemento: "buscando" | "existe" | "ausente"; movimientoReducido?: boolean; focoEnCampo?: boolean; formularioSucio?: boolean }): PlanViaje {
  if (e.tipo && e.tipo !== "ir") return { armar: false, ms: 0, manual: false, motivo: "no-ir" };
  if (!e.armado) return { armar: false, ms: 0, manual: false, motivo: "no-armado" };
  if (e.elemento === "buscando") return { armar: false, ms: 0, manual: false, motivo: "buscando" };
  if (e.movimientoReducido) return { armar: false, ms: 0, manual: true, motivo: "movimiento-reducido" };
  if (e.focoEnCampo) return { armar: false, ms: 0, manual: true, motivo: "campo" };
  if (e.formularioSucio) return { armar: false, ms: 0, manual: true, motivo: "formulario" };
  return { armar: true, ms: CUENTA_MS, manual: false, motivo: "ok" };
}

export type FaseViaje = "inactivo" | "cuenta" | "manual" | "viajando" | "fallo";
export interface EstadoViaje {
  readonly fase: FaseViaje;
  readonly restan: number;
  readonly motivo: string | null;
}
export type EventoViaje =
  | { readonly tipo: "planear"; readonly plan: PlanViaje }
  | { readonly tipo: "cancelar"; readonly motivo: string }
  | { readonly tipo: "tick" | "siguiente" | "manual" | "clic" | "plazo" | "reiniciar" };

export const estadoViajeInicial = (): EstadoViaje => ({ fase: "inactivo", restan: 0, motivo: null });

export function reducirViaje(estado: EstadoViaje, evento: EventoViaje): { estado: EstadoViaje; efecto: "viajar" | null } {
  const igual = { estado, efecto: null };
  switch (evento.tipo) {
    case "planear": {
      if (estado.fase !== "inactivo") return igual;
      const p = evento.plan;
      if (p.armar) return { estado: { fase: "cuenta", restan: Math.ceil(p.ms / TICK_MS), motivo: null }, efecto: null };
      if (p.manual) return { estado: { fase: "manual", restan: 0, motivo: p.motivo }, efecto: null };
      return igual;
    }
    case "tick": {
      if (estado.fase !== "cuenta") return igual;
      const restan = estado.restan - 1;
      if (restan <= 0) return { estado: { fase: "viajando", restan: 0, motivo: null }, efecto: "viajar" };
      return { estado: { ...estado, restan }, efecto: null };
    }
    case "cancelar":
      return estado.fase === "cuenta" ? { estado: { fase: "manual", restan: 0, motivo: evento.motivo }, efecto: null } : igual;
    case "siguiente":
    case "manual":
      // Si ya se viaja (o ya fallo) no se dispara otra vez: Siguiente + temporizador son UN solo viaje.
      if (estado.fase === "viajando" || estado.fase === "fallo") return igual;
      return { estado: { fase: "viajando", restan: 0, motivo: null }, efecto: "viajar" };
    case "clic":
      if (estado.fase === "viajando") return igual;
      return { estado: { fase: "viajando", restan: 0, motivo: null }, efecto: null };
    case "plazo":
      return estado.fase === "viajando" ? { estado: { fase: "fallo", restan: 0, motivo: "sin-ruta" }, efecto: null } : igual;
    case "reiniciar":
      return { estado: estadoViajeInicial(), efecto: null };
    default:
      return igual;
  }
}

export interface ConductorViaje {
  enviar(evento: EventoViaje): EstadoViaje;
  estado(): EstadoViaje;
  reiniciar(): EstadoViaje;
  destruir(): void;
}

/** Une `reducirViaje` con la cuenta (un temporizador por segundo) y el plazo de fallo. Temporizadores inyectables para las pruebas. */
export function crearViaje(deps: { alCambiar?: (e: EstadoViaje) => void; alViajar?: () => void; programar?: (f: () => void, ms: number) => unknown; cancelar?: (id: unknown) => void } = {}): ConductorViaje {
  const programar = deps.programar ?? ((f: () => void, ms: number) => globalThis.setTimeout(f, ms));
  const cancelar = deps.cancelar ?? ((id: unknown) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>));
  let estado = estadoViajeInicial();
  let cuenta: unknown = null;
  let plazo: unknown = null;
  const limpiar = () => {
    if (cuenta != null) cancelar(cuenta);
    if (plazo != null) cancelar(plazo);
    cuenta = plazo = null;
  };
  const enviar = (evento: EventoViaje): EstadoViaje => {
    const antes = estado;
    const r = reducirViaje(estado, evento);
    estado = r.estado;
    if (estado.fase !== antes.fase || estado.restan !== antes.restan) {
      limpiar();
      if (estado.fase === "cuenta") cuenta = programar(() => { cuenta = null; enviar({ tipo: "tick" }); }, TICK_MS);
      if (estado.fase === "viajando") plazo = programar(() => { plazo = null; enviar({ tipo: "plazo" }); }, FALLO_MS);
      deps.alCambiar?.(estado);
    }
    if (r.efecto === "viajar") deps.alViajar?.();
    return estado;
  };
  return {
    enviar,
    estado: () => estado,
    reiniciar: () => enviar({ tipo: "reiniciar" }),
    destruir: () => { limpiar(); estado = estadoViajeInicial(); },
  };
}

/** Qué hace «Siguiente» en el paso actual (ver Rovaq cableado.mjs). */
export function siguienteDelPaso(e: { tipo: TipoPaso | undefined; conductor: Pick<ConductorViaje, "enviar" | "estado"> | null; despachar: (ev: EventoRecorrido) => void; llevar: () => void }): "conductor" | "continuar" | "llevar" | "avanzar" {
  if (e.tipo !== "ir") {
    e.despachar({ tipo: "siguiente" });
    return "avanzar";
  }
  if (!e.conductor) {
    e.llevar();
    return "llevar";
  }
  if (e.conductor.estado().fase === "fallo") {
    e.despachar({ tipo: "siguiente" });
    return "continuar";
  }
  e.conductor.enviar({ tipo: "siguiente" });
  return "conductor";
}

/** Teclas que cancelan la cuenta: Tab (sigue su curso) y Escape (se consume: el segundo Escape cierra la guia). */
export function teclaQueCancela(key: string): { motivo: "tab" | "escape"; consumir: boolean } | null {
  if (key === "Tab") return { motivo: "tab", consumir: false };
  if (key === "Escape") return { motivo: "escape", consumir: true };
  return null;
}

/** ¿Se le puede mover el foco a la persona? Si no esta en ningun sitio, o esta en la tarjeta, el menu o el boton que abrio la guia. */
export function puedeTomarFoco(e: { activo: unknown; cuerpo?: unknown; dentroDeGuia: boolean; esDisparador: boolean }): boolean {
  if (!e.activo || e.activo === e.cuerpo) return true;
  return e.dentroDeGuia || e.esDisparador;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Construccion del recorrido desde el menu real
// ---------------------------------------------------------------------------------------------------------------------------------

/** Lo minimo de un item del Sidebar (`SidebarItem`) que necesita el recorrido. */
export interface ItemMenu {
  readonly to: string;
  readonly label: string;
}
export interface SeccionMenu {
  readonly title: string;
  readonly items: readonly ItemMenu[];
}

/** Contenido de una pantalla del recorrido. Lo que falte cae al texto generico (nunca se inventa algo que la pantalla no hace). */
export interface ContenidoPantalla {
  readonly ilu?: string;
  /** Qué es la pantalla («Pedidos: lo que entra hoy»). */
  readonly queT?: TextoBilingue;
  readonly que: TextoBilingue;
  /** Elemento clave de la pantalla. Sin `clave` el paso «clave» no existe. */
  readonly clave?: { readonly titulo: TextoBilingue; readonly cuerpo: TextoBilingue; readonly objetivos?: readonly string[] };
  /** Acción principal. Solo para roles que la pueden hacer (lo decide quien arma el contenido: el menu ya viene filtrado por rol). */
  readonly accion?: { readonly titulo: TextoBilingue; readonly cuerpo: TextoBilingue; readonly objetivos?: readonly string[] };
}

/** Contenido por ruta RELATIVA a la raiz de la consola ("" = Resumen, "pedidos", "operacion/viajes"…). */
export type ContenidoConsola = Readonly<Record<string, ContenidoPantalla>>;

/** Selectores de la zona de contenido del shell (`VERTICAL_SHELL_MAIN_ID`). */
const MAIN = "#contenido-principal";
export const OBJETIVOS_QUE: readonly string[] = [`${MAIN} [data-tour="titulo"]`, `${MAIN} h1:not(.sr-only)`, `${MAIN} h2`, "header h1:not(.sr-only)", "[data-barra-pagina]"];
export const OBJETIVOS_CLAVE: readonly string[] = [`${MAIN} [data-tour="clave"]`, `${MAIN} table`, `${MAIN} [role="tablist"]`, `${MAIN} form`, `${MAIN} section`, `${MAIN} [class*="rounded"]`];
export const OBJETIVOS_ACCION: readonly string[] = [`${MAIN} [data-tour="accion"]`, `${MAIN} form button[type="submit"]`, `${MAIN} button`];

/**
 * Selectores del item del menu de una pantalla. El shell no lleva anclas propias de la guia: se busca el enlace real por su `href`
 * (Sidebar de escritorio y barra inferior movil) para no tocar los archivos del carril del shell.
 */
export function objetivosMenu(href: string): string[] {
  const h = cssString(href);
  return [`[data-tour="menu:${h}"]`, `aside a[href="${h}"]`, `nav a[href="${h}"]`];
}
/** Escapa un valor para ir entre comillas dobles en un selector CSS. */
export const cssString = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** «/restaurantes/x/operacion/viajes» con base «/restaurantes/x» → «operacion/viajes»; la raiz → "". */
export function rutaRelativa(href: string, base: string): string {
  const b = base.replace(/\/+$/, "");
  if (href === b) return "";
  return href.startsWith(`${b}/`) ? href.slice(b.length + 1).replace(/\/+$/, "") : href.replace(/^\/+/, "");
}
/** Slug estable para el id del paso: «operacion/viajes» → «operacion-viajes»; la raiz → «resumen». */
export const slugDe = (relativa: string): string => (relativa === "" ? "resumen" : relativa.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "").slice(0, 60) || "pantalla");

export interface PantallaTour {
  readonly href: string;
  readonly nombre: string;
  readonly grupoMenu: string;
}

/** Pantallas del recorrido: todos los items del menu del rol, en su orden, sin repetir rutas. */
export function pantallasDelMenu(sections: readonly SeccionMenu[]): PantallaTour[] {
  const vistas = new Set<string>();
  const salida: PantallaTour[] = [];
  for (const s of sections) {
    for (const it of s.items) {
      if (!it.to || vistas.has(it.to)) continue;
      vistas.add(it.to);
      salida.push({ href: it.to, nombre: it.label, grupoMenu: s.title });
    }
  }
  return salida;
}

const QUE_GENERICO: TextoBilingue = {
  es: "Aquí ves y administras {pantalla}. El encabezado dice qué muestra y los botones de arriba hacen las acciones de esta pantalla.",
  en: "Here you view and manage {pantalla}. The header says what it shows and the buttons at the top run this screen's actions.",
};

export interface OpcionesTour {
  /** Raiz de la consola («/restaurantes/mi-org»): el contenido se busca por ruta relativa a ella. */
  readonly base: string;
  readonly contenido?: ContenidoConsola;
  /** Rutas RELATIVAS de las pantallas del recorrido corto, en orden. Sin ellas: las primeras 5 del menu. */
  readonly esenciales?: readonly string[];
  /** Pantallas que el recorrido NO visita (p. ej. la propia «Primeros pasos»). */
  readonly excluir?: readonly string[];
}

/** Pantallas del recorrido corto. Siempre 5 o menos; las que no estan en el menu del rol se omiten. */
const MAX_CORTO = 5;

/**
 * Arma el recorrido: por pantalla un «ir» (no cuenta en el contador), un «que» y, si la pantalla lo tiene, «clave» y «accion»; al final
 * un «cierre». El corto visita las pantallas esenciales con «ir»+«que» (la primera tambien con «clave»): 5 pantallas = 7 pasos con el cierre.
 * Los ids son iguales en los dos modos: lo guardado sirve en ambos.
 */
export function construirTour(sections: readonly SeccionMenu[], modo: ModoTour, o: OpcionesTour): PasoTour[] {
  const excluir = new Set(o.excluir ?? []);
  let pantallas = pantallasDelMenu(sections).filter((p) => !excluir.has(rutaRelativa(p.href, o.base)));
  if (modo === "corto") {
    const porRel = new Map(pantallas.map((p) => [rutaRelativa(p.href, o.base), p]));
    const elegidas = (o.esenciales ?? []).map((r) => porRel.get(r)).filter((p): p is PantallaTour => Boolean(p));
    pantallas = (elegidas.length > 0 ? elegidas : pantallas).slice(0, MAX_CORTO);
  }
  const pasos: PasoTour[] = [];
  pantallas.forEach((p, grupo) => {
    const rel = rutaRelativa(p.href, o.base);
    const slug = slugDe(rel);
    const c = o.contenido?.[rel];
    const ilu = c?.ilu ?? "tarjetas";
    const base = { pantalla: p.href, grupo, ilu, menuGrupo: p.grupoMenu };
    pasos.push({ ...base, id: `${slug}.ir`, tipo: "ir", clave: "ir", objetivos: objetivosMenu(p.href), titulo: null, cuerpo: null });
    pasos.push({ ...base, id: `${slug}.que`, tipo: "info", clave: "que", objetivos: OBJETIVOS_QUE, titulo: c?.queT ?? null, cuerpo: c?.que ?? QUE_GENERICO });
    const conClave = modo === "completo" || grupo === 0;
    if (conClave && c?.clave) pasos.push({ ...base, id: `${slug}.clave`, tipo: "info", clave: "clave", objetivos: c.clave.objetivos ?? OBJETIVOS_CLAVE, titulo: c.clave.titulo, cuerpo: c.clave.cuerpo });
    if (modo === "completo" && c?.accion) pasos.push({ ...base, id: `${slug}.accion`, tipo: "info", clave: "accion", objetivos: c.accion.objetivos ?? OBJETIVOS_ACCION, titulo: c.accion.titulo, cuerpo: c.accion.cuerpo });
  });
  if (pasos.length === 0) return [];
  pasos.push({ id: "cierre", tipo: "cierre", clave: "cierre", pantalla: null, grupo: pantallas.length, ilu: "cierre", objetivos: [], titulo: null, cuerpo: null });
  return pasos;
}

/** Pantallas del recorrido en orden, con el indice de su primer paso. */
export function gruposDe(pasos: readonly PasoTour[]): { href: string; grupo: number; desde: number }[] {
  const salida: { href: string; grupo: number; desde: number }[] = [];
  pasos.forEach((p, i) => {
    if (p.pantalla && !salida.some((g) => g.href === p.pantalla)) salida.push({ href: p.pantalla, grupo: p.grupo, desde: i });
  });
  return salida;
}

/** Pasos que cuenta la persona: los saltos de menu («ir») no cuentan. */
export const contarPasos = (lista: readonly { tipo: string }[]): number => lista.filter((p) => p.tipo !== "ir").length;

/** Ruta del recorrido en una ventana corta alrededor de la pantalla actual: «… · Pedidos · Productos · Clientes · …». */
export function ventanaRuta(nombres: readonly string[], actual: number, ancho = 5) {
  const desde = Math.max(0, Math.min(actual - 1, nombres.length - ancho));
  const hasta = Math.min(nombres.length, desde + ancho);
  return { items: nombres.slice(desde, hasta).map((nombre, i) => ({ nombre, actual: desde + i === actual })), antes: desde > 0, despues: hasta < nombres.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Geometria: la tarjeta nunca tapa el elemento resaltado
// ---------------------------------------------------------------------------------------------------------------------------------

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
const intersecta = (a: Rect, b: Rect) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** Margen al borde de la ventana y separacion minima entre la tarjeta y el foco (incluye el aro de 4 px y su pulso). */
export const MARGEN_TARJETA = 24;
export const HOLGURA_FOCO = 14;

/**
 * Posicion (esquina superior izquierda) de la tarjeta para que NO toque el rectangulo del foco. Prueba, en orden: esquinas de la ventana
 * del lado contrario al objetivo, luego a la derecha/izquierda/abajo/arriba pegada al foco. Si nada cabe sin tocarlo (objetivo enorme),
 * devuelve la esquina con MENOR area tapada y `tapa: true` (la capa entonces deja el foco y la tarjeta se puede mover con el scroll).
 * Sin objetivo: centrada.
 */
export function colocarTarjeta(objetivo: Rect | null, tarjeta: { width: number; height: number }, ventana: { width: number; height: number }): { left: number; top: number; tapa: boolean; centrada: boolean } {
  const w = Math.min(tarjeta.width, ventana.width - 2 * 16);
  const h = Math.min(tarjeta.height, ventana.height - 2 * 16);
  const m = ventana.width < 2 * MARGEN_TARJETA + w ? 16 : MARGEN_TARJETA;
  const acot = (x: number, y: number) => ({ left: Math.round(Math.max(m, Math.min(x, ventana.width - w - m))), top: Math.round(Math.max(m, Math.min(y, ventana.height - h - m))) });
  if (!objetivo) return { ...acot((ventana.width - w) / 2, (ventana.height - h) / 2), tapa: false, centrada: true };
  const foco: Rect = { left: objetivo.left - HOLGURA_FOCO, top: objetivo.top - HOLGURA_FOCO, width: objetivo.width + 2 * HOLGURA_FOCO, height: objetivo.height + 2 * HOLGURA_FOCO };
  const derecha = objetivo.left + objetivo.width / 2 > ventana.width / 2;
  const abajo = objetivo.top + objetivo.height / 2 > ventana.height / 2;
  const xLejos = derecha ? m : ventana.width - w - m;
  const xCerca = derecha ? ventana.width - w - m : m;
  const yLejos = abajo ? m : ventana.height - h - m;
  const yCerca = abajo ? ventana.height - h - m : m;
  const candidatos = [
    acot(xLejos, yLejos),
    acot(xLejos, yCerca),
    acot(xCerca, yLejos),
    acot(objetivo.left + objetivo.width + HOLGURA_FOCO, objetivo.top),
    acot(objetivo.left - HOLGURA_FOCO - w, objetivo.top),
    acot(objetivo.left, objetivo.top + objetivo.height + HOLGURA_FOCO),
    acot(objetivo.left, objetivo.top - HOLGURA_FOCO - h),
    acot(xCerca, yCerca),
  ];
  for (const c of candidatos) if (!intersecta({ ...c, width: w, height: h }, foco)) return { ...c, tapa: false, centrada: false };
  const area = (c: { left: number; top: number }) => {
    const x = Math.max(0, Math.min(c.left + w, foco.left + foco.width) - Math.max(c.left, foco.left));
    const y = Math.max(0, Math.min(c.top + h, foco.top + foco.height) - Math.max(c.top, foco.top));
    return x * y;
  };
  const mejor = [...candidatos].sort((a, b) => area(a) - area(b))[0]!;
  return { ...mejor, tapa: true, centrada: false };
}

/** Hoja inferior movil: si el objetivo queda debajo del borde superior de la hoja, la hoja sube arriba (tampoco tapa en movil). */
export function ladoHojaMovil(objetivo: Rect | null, ventanaAlto: number, hojaAlto: number, reservaInferior: number): "abajo" | "arriba" {
  if (!objetivo) return "abajo";
  const bordeHoja = ventanaAlto - reservaInferior - hojaAlto - 12;
  return objetivo.top + objetivo.height > bordeHoja ? "arriba" : "abajo";
}

// «Guía» de Atiende (ds3): escucha el boton «Guía» de la cabecera (`GUIA_ABRIR_EVENTO`) y pinta el menu de la guia, la invitacion del
// primer ingreso, la capa de foco, la etiqueta «Haz clic aquí» y la tarjeta del paso. Port de Rovaq (components/onboarding/contexto.tsx,
// guia.tsx, paneles.tsx) con dos diferencias deliberadas: la tarjeta NUNCA tapa el elemento resaltado (motor.ts `colocarTarjeta`) y el
// progreso tambien vive en el servidor (para retomar en otro equipo), con el navegador como respaldo sin red.
//
// Es "tonto" como el resto de @atiende/ui: no hace fetch. El recorrido sale del MISMO menu que recibe el Sidebar (`sections`, ya filtrado
// por rol); el contenido por pantalla y el puente al servidor los pone apps/web. Accesibilidad: la tarjeta es un dialogo NO modal (no
// atrapa el foco; la pagina sigue usable), el teclado vive a nivel de documento (→ ← Enter Esc), Esc devuelve el foco a quien abrio la
// guia, y con «reducir movimiento» no hay viaje automatico ni animaciones.
import * as React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  colocarTarjeta,
  construirTour,
  contarPasos,
  crearViaje,
  CUENTA_MS,
  estadoInicial,
  estadoViajeInicial,
  eventoDeTeclado,
  gruposDe,
  ladoHojaMovil,
  pantallaActiva,
  planearViaje,
  rectResaltado,
  puedeTomarFoco,
  reducir,
  siguienteDelPaso,
  teclaQueCancela,
  teclasPropias,
  TICK_MS,
  ventanaRuta,
  armadoTras,
  type ConductorViaje,
  type ContenidoConsola,
  type EstadoRecorrido,
  type EstadoViaje,
  type EventoRecorrido,
  type ModoTour,
  type PasoTour,
  type Rect,
  type SeccionMenu,
} from "./motor";
import { almacenDelNavegador, claveProgreso, guardarLocal, leerLocal, PROGRESO_VACIO, reconciliar, type ProgresoLocal, type ServidorProgreso } from "./estado";
import { abrirGrupoDelMenu, enCampo, esperarObjetivo, hayFormularioSucio, nombreDe, pantallaEstrecha, primerVisible, reducirMovimiento } from "./dom";
import { Ilustracion } from "./ilustraciones";
import { enIdioma, traductorGuia, useIdiomaGuia, type TraductorGuia } from "./textos";
import { GUIA_ABRIR_EVENTO_RECORRIDO, GUIA_RECORRIDO_EVENTO, GUIA_VACIAR_EVENTO } from "./eventos";
import "./guia.css";

export { GUIA_ABRIR_EVENTO_RECORRIDO, GUIA_RECORRIDO_EVENTO, iniciarRecorridoGuia } from "./eventos";

export interface GuiaRecorridoProps {
  /** Menu real del rol (las mismas `sections` del Sidebar). */
  readonly sections: readonly SeccionMenu[];
  /** Raiz de la consola («/restaurantes/mi-org»); el contenido se busca por ruta relativa a ella. */
  readonly base: string;
  /** «<vertical>.<rol>» o «superadmin»: separa el progreso por rol. */
  readonly pista: string;
  /** Identificador de la persona (id o correo) y de la organizacion (slug): solo para la clave local, que va con hash. */
  readonly persona: string;
  readonly organizacion: string;
  readonly organizacionNombre: string;
  /** Rol legible. Sin el: «Superadmin» (traducido) en la pista de plataforma o el rol de la pista. */
  readonly rolEtiqueta?: string;
  readonly contenido?: ContenidoConsola;
  /** Rutas relativas del recorrido corto. */
  readonly esenciales?: readonly string[];
  /** Rutas relativas que el recorrido no visita. */
  readonly excluir?: readonly string[];
  /** «Primeros pasos» de la consola (si el rol la tiene). */
  readonly primerosPasosHref?: string;
  readonly servidor?: ServidorProgreso | null;
}

const PAD = 6;
const GAP = 10;
const MARGEN = 8;
type LadoEtiqueta = "arriba" | "abajo" | "izq" | "der";
const esControl = (el: HTMLElement) => el.matches('a,button,summary,input,select,textarea,[role="button"],[role="link"]');

export function GuiaRecorrido(props: GuiaRecorridoProps) {
  const { sections, base, pista, persona, organizacion, contenido, esenciales, excluir, servidor } = props;
  const idioma = useIdiomaGuia();
  const t = React.useMemo(() => traductorGuia(idioma), [idioma]);
  const { pathname: ruta } = useLocation();
  const navigate = useNavigate();

  // ---- Bandera: la guia solo vive si su hoja (guia.css) esta aplicada y la bandera ds3 encendida: entonces la raiz computa
  // `display: contents`. Sin bandera computa `none`; sin la hoja (un entorno sin CSS), `block`. En esos dos casos no lee, no escribe
  // y no escucha nada: la produccion sin ds3 no cambia.
  const raiz = React.useRef<HTMLDivElement>(null);
  const [activa, setActiva] = React.useState(false);
  React.useEffect(() => {
    const el = raiz.current;
    if (!el || typeof getComputedStyle !== "function") return;
    setActiva(getComputedStyle(el).display === "contents");
  }, []);

  // ---- Recorridos (corto y completo) del menu real -----------------------------------------------------------------------------
  const opciones = React.useMemo(() => ({ base, contenido, esenciales, excluir }), [base, contenido, esenciales, excluir]);
  const completo = React.useMemo(() => construirTour(sections, "completo", opciones), [sections, opciones]);
  const corto = React.useMemo(() => construirTour(sections, "corto", opciones), [sections, opciones]);
  const hayCorto = corto.length > 0 && contarPasos(corto) < contarPasos(completo);
  const [modo, setModo] = React.useState<ModoTour>("completo");
  const pasos = modo === "corto" && hayCorto ? corto : completo;
  const pantallas = React.useMemo(() => gruposDe(pasos), [pasos]);
  const nombres = React.useMemo(() => {
    const porHref = new Map<string, string>();
    for (const s of sections) for (const it of s.items) porHref.set(it.to, it.label);
    return porHref;
  }, [sections]);
  const nombreDePantalla = React.useCallback((href: string | null) => (href ? (nombres.get(href) ?? href) : ""), [nombres]);
  const hrefsTour = React.useMemo(() => pantallas.map((p) => p.href), [pantallas]);

  // ---- Progreso (navegador + servidor) ---------------------------------------------------------------------------------------------
  const clave = React.useMemo(() => claveProgreso(persona, organizacion, pista), [persona, organizacion, pista]);
  const [listo, setListo] = React.useState(false);
  const [local, setLocal] = React.useState<ProgresoLocal>(PROGRESO_VACIO);
  const localRef = React.useRef(local);
  const [rec, setRec] = React.useState<EstadoRecorrido>(estadoInicial);
  const recRef = React.useRef(rec);
  recRef.current = rec;
  const servidorRef = React.useRef(servidor);
  servidorRef.current = servidor;
  const pendiente = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const guardar = React.useCallback(
    (parche: Partial<ProgresoLocal>) => {
      const siguiente: ProgresoLocal = { ...localRef.current, ...parche, actualizado: Date.now() };
      localRef.current = siguiente;
      setLocal(siguiente);
      guardarLocal(almacenDelNavegador(), clave, siguiente);
      // Un guardado al servidor por rafaga de cambios (las flechas pueden saltar varios pasos seguidos).
      if (pendiente.current) clearTimeout(pendiente.current);
      pendiente.current = setTimeout(() => {
        pendiente.current = null;
        servidorRef.current?.guardar(localRef.current).catch(() => undefined);
      }, 400);
    },
    [clave],
  );
  // Lo que quedo en la rafaga no se pierde: al desmontar (cambio de consola), al cerrar la pestaña (`pagehide`) o al cerrar sesion
  // (`vaciarGuardadoGuia`) se envia ya, con `keepalive` para que sobreviva a la descarga de la pagina.
  React.useEffect(() => {
    const vaciar = () => {
      if (!pendiente.current) return;
      clearTimeout(pendiente.current);
      pendiente.current = null;
      servidorRef.current?.guardar(localRef.current, { keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", vaciar);
    window.addEventListener(GUIA_VACIAR_EVENTO, vaciar);
    return () => {
      window.removeEventListener("pagehide", vaciar);
      window.removeEventListener(GUIA_VACIAR_EVENTO, vaciar);
      vaciar();
    };
  }, []);

  // Lectura al montar (y al cambiar de rol u organizacion): primero el navegador; luego el servidor, gana el mas nuevo. Si el recorrido
  // estaba abierto, se reabre en el mismo paso pero SIN viaje automatico.
  const rutaRef = React.useRef(ruta);
  rutaRef.current = ruta;
  React.useEffect(() => {
    if (!activa) return undefined;
    let vivo = true;
    const aplicar = (p: ProgresoLocal) => {
      const elegido: ModoTour = p.modo === "corto" && hayCorto ? "corto" : "completo";
      const lista = elegido === "corto" ? corto : completo;
      const indice = p.activo && !p.descartado ? lista.findIndex((x) => x.id === p.paso) : -1;
      localRef.current = p;
      setModo(elegido);
      setLocal(p);
      setRec(indice >= 0 ? reducir(estadoInicial(), { tipo: "abrir", indice }, lista.length, lista, rutaRef.current) : estadoInicial());
    };
    const leido = leerLocal(almacenDelNavegador(), clave);
    aplicar(leido);
    setListo(true);
    const s = servidorRef.current;
    if (s) {
      s.leer()
        .then((remoto) => {
          if (!vivo || !remoto) return;
          const r = reconciliar(localRef.current, remoto);
          if (r !== localRef.current && !recRef.current.abierto) aplicar(r);
          guardarLocal(almacenDelNavegador(), clave, r);
        })
        .catch(() => undefined);
    }
    return () => { vivo = false; };
  }, [activa, clave]);

  // ---- Recorrido ------------------------------------------------------------------------------------------------------------------
  const armado = React.useRef(false);
  const viajeCtl = React.useRef<ConductorViaje | null>(null);
  const disparador = React.useRef<HTMLElement | null>(null);

  const aplicar = React.useCallback(
    (sig: EstadoRecorrido, navegar: boolean, lista: readonly PasoTour[] = pasos) => {
      setRec(sig);
      if (sig.abierto) {
        const p = lista[sig.indice];
        if (p) {
          guardar({ paso: p.id, visto: true, activo: true });
          // Un paso de otra pantalla (Anterior, Retomar, Saltar) lleva a esa pantalla; un paso «ir» no navega: dice qué apretar.
          if (navegar && p.tipo !== "ir" && p.pantalla && pantallaActiva(rutaRef.current, hrefsTour) !== p.pantalla) navigate(p.pantalla);
        }
      } else if (sig.terminado) guardar({ paso: null, visto: true, omitido: false, activo: false, terminado: true });
      else guardar({ activo: false });
    },
    [guardar, hrefsTour, navigate, pasos],
  );

  const despachar = React.useCallback(
    (e: EventoRecorrido) => {
      armado.current = armadoTras(e.tipo);
      aplicar(reducir(recRef.current, e, pasos.length, pasos, rutaRef.current), e.tipo !== "clic" && e.tipo !== "ruta");
    },
    [aplicar, pasos],
  );

  // Llegar a la pantalla de un paso «ir» (por clic, viaje o atras del navegador) lo completa. Otro cambio de ruta no mueve nada.
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const actual = recRef.current;
      const sig = reducir(actual, { tipo: "ruta", ruta }, pasos.length, pasos, ruta);
      if (sig !== actual) {
        armado.current = false;
        aplicar(sig, false);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [ruta]);

  const paso = rec.abierto ? (pasos[rec.indice] ?? null) : null;
  const [menuAbierto, setMenuAbierto] = React.useState(false);

  // Al cerrar (Esc, Omitir, Terminar) el foco vuelve a quien abrio la guia (el boton «Guía»).
  const abiertoAntes = React.useRef(false);
  const devolverFoco = React.useCallback(() => {
    const d = disparador.current;
    if (d && d.isConnected) d.focus({ preventScroll: true });
  }, []);
  React.useEffect(() => {
    if (abiertoAntes.current && !rec.abierto) devolverFoco();
    abiertoAntes.current = rec.abierto;
  }, [rec.abierto, devolverFoco]);

  const iniciar = React.useCallback(
    (como: "inicio" | "retomar", elegido?: ModoTour) => {
      const m: ModoTour = elegido && (elegido === "completo" || hayCorto) ? elegido : modo;
      const lista = m === "corto" ? corto : completo;
      const desde = como === "retomar" ? lista.findIndex((p) => p.id === localRef.current.paso) : -1;
      armado.current = true;
      setMenuAbierto(false);
      setModo(m);
      guardar({ omitido: false, modo: m });
      aplicar(reducir(recRef.current, { tipo: "abrir", indice: desde >= 0 ? desde : 0 }, lista.length, lista, rutaRef.current), false, lista);
    },
    [aplicar, completo, corto, guardar, hayCorto, modo],
  );
  const iniciarRef = React.useRef(iniciar);
  iniciarRef.current = iniciar;
  const irAPantalla = React.useCallback(
    (href: string) => {
      const g = pantallas.find((x) => x.href === href);
      if (!g) return;
      armado.current = true;
      setMenuAbierto(false);
      guardar({ omitido: false });
      aplicar(reducir(recRef.current, { tipo: "abrir", indice: g.desde }, pasos.length, pasos, rutaRef.current), false);
    },
    [aplicar, guardar, pantallas, pasos],
  );

  // Viaje de un paso «ir»: clic real en el item del menu (despliega antes su grupo); si no se ve (movil, barra colapsada), navega directo.
  const llevame = React.useCallback(() => {
    const p = recRef.current.abierto ? pasos[recRef.current.indice] : null;
    if (!p || p.tipo !== "ir" || !p.pantalla) return;
    abrirGrupoDelMenu(p.objetivos, p.menuGrupo);
    const el = primerVisible(p.objetivos);
    if (el) {
      el.click();
      return;
    }
    navigate(p.pantalla);
  }, [navigate, pasos]);
  const siguiente = React.useCallback(() => {
    siguienteDelPaso({ tipo: paso?.tipo, conductor: viajeCtl.current, despachar, llevar: llevame });
  }, [despachar, llevame, paso?.tipo]);

  const omitir = React.useCallback(() => {
    guardar({ omitido: true, visto: true, paso: null, activo: false });
    setRec((r) => reducir(r, { tipo: "cerrar" }, pasos.length, pasos, rutaRef.current));
  }, [guardar, pasos]);
  const noVolver = React.useCallback(() => {
    setMenuAbierto(false);
    guardar({ descartado: true, omitido: true, visto: true, paso: null, activo: false });
    setRec((r) => reducir(r, { tipo: "cerrar" }, pasos.length, pasos, rutaRef.current));
    devolverFoco();
  }, [devolverFoco, guardar, pasos]);
  const volverAMostrar = React.useCallback(() => {
    setMenuAbierto(false);
    guardar({ descartado: false, omitido: false, visto: false });
  }, [guardar]);
  const irPrimerosPasos = React.useCallback(() => {
    setMenuAbierto(false);
    if (props.primerosPasosHref) navigate(props.primerosPasosHref);
  }, [navigate, props.primerosPasosHref]);

  // Boton «Guía» de la cabecera: alterna el menu. Recuerda el disparador para devolverle el foco.
  React.useEffect(() => {
    if (!activa) return undefined;
    const alAbrir = (e: Event) => {
      // Safari no enfoca un <button> al hacer clic: si quien emite el evento dice de donde viene, ese es el disparador.
      const desde = (e as CustomEvent<{ desde?: unknown } | undefined>).detail?.desde;
      const a = desde instanceof HTMLElement ? desde : document.activeElement;
      if (a instanceof HTMLElement && a !== document.body && !a.closest(".guia-raiz")) disparador.current = a;
      setMenuAbierto((v) => !v);
    };
    const alRecorrido = (e: Event) => {
      const d = (e as CustomEvent<{ modo?: unknown; desde?: unknown }>).detail;
      if (d?.desde instanceof HTMLElement) disparador.current = d.desde;
      iniciarRef.current("inicio", d?.modo === "completo" ? "completo" : "corto");
    };
    window.addEventListener(GUIA_ABRIR_EVENTO_RECORRIDO, alAbrir);
    window.addEventListener(GUIA_RECORRIDO_EVENTO, alRecorrido);
    return () => {
      window.removeEventListener(GUIA_ABRIR_EVENTO_RECORRIDO, alAbrir);
      window.removeEventListener(GUIA_RECORRIDO_EVENTO, alRecorrido);
    };
  }, [activa]);

  // Teclado del recorrido a nivel de documento.
  const abierto = rec.abierto;
  React.useEffect(() => {
    if (!abierto) return undefined;
    const alTeclear = (e: KeyboardEvent) => {
      const objetivo = e.target instanceof HTMLElement ? e.target : null;
      const ev = eventoDeTeclado({
        key: e.key,
        defaultPrevented: e.defaultPrevented,
        tagName: objetivo?.tagName ?? "",
        dentroDeTarjeta: Boolean(objetivo?.closest(".guia-tarjeta")),
        propias: teclasPropias(objetivo),
        modificador: e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
      });
      if (!ev) return;
      e.preventDefault();
      if (ev.tipo === "siguiente") siguiente();
      else despachar(ev);
    };
    document.addEventListener("keydown", alTeclear);
    return () => document.removeEventListener("keydown", alTeclear);
  }, [abierto, siguiente, despachar]);

  const invitacionVisible = activa && listo && completo.length > 0 && !rec.abierto && !menuAbierto && !local.visto && !local.omitido && !local.descartado;

  return (
    <div ref={raiz} className="guia-raiz" data-guia="">
      {activa && listo && completo.length > 0 ? (
        <Paneles
          t={t}
          idioma={idioma}
          pasos={pasos}
          pantallas={pantallas}
          rec={rec}
          paso={paso}
          ruta={ruta}
          hrefsTour={hrefsTour}
          nombreDePantalla={nombreDePantalla}
          menuAbierto={menuAbierto}
          cerrarMenu={() => {
            setMenuAbierto(false);
            devolverFoco();
          }}
          contexto={t("guia.menu.contexto", { organizacion: props.organizacionNombre, rol: props.rolEtiqueta ?? (pista === "superadmin" ? t("guia.rol.superadmin") : pista.split(".")[1] ?? "") })}
          opciones={hayCorto ? { corto: contarPasos(corto), completo: contarPasos(completo) } : undefined}
          tienePaso={pasos.some((p) => p.id === local.paso)}
          descartado={local.descartado}
          primerosPasos={Boolean(props.primerosPasosHref)}
          invitacionVisible={invitacionVisible}
          disparador={disparador}
          iniciar={iniciar}
          irAPantalla={irAPantalla}
          noVolver={noVolver}
          volverAMostrar={volverAMostrar}
          irPrimerosPasos={irPrimerosPasos}
          saltarInvitacion={() => guardar({ omitido: true, visto: true })}
          despachar={despachar}
          siguiente={siguiente}
          omitir={omitir}
          llevame={llevame}
          viajeAutomatico={() => armado.current}
          registrarViaje={(c) => {
            viajeCtl.current = c;
          }}
        />
      ) : null}
    </div>
  );
}

interface PanelesProps {
  readonly t: TraductorGuia;
  readonly idioma: "es" | "en";
  readonly pasos: readonly PasoTour[];
  readonly pantallas: readonly { href: string; grupo: number; desde: number }[];
  readonly rec: EstadoRecorrido;
  readonly paso: PasoTour | null;
  readonly ruta: string;
  readonly hrefsTour: readonly string[];
  readonly nombreDePantalla: (href: string | null) => string;
  readonly menuAbierto: boolean;
  readonly cerrarMenu: () => void;
  readonly contexto: string;
  readonly opciones?: { corto: number; completo: number };
  readonly tienePaso: boolean;
  readonly descartado: boolean;
  readonly primerosPasos: boolean;
  readonly invitacionVisible: boolean;
  readonly disparador: React.MutableRefObject<HTMLElement | null>;
  readonly iniciar: (como: "inicio" | "retomar", modo?: ModoTour) => void;
  readonly irAPantalla: (href: string) => void;
  readonly noVolver: () => void;
  readonly volverAMostrar: () => void;
  readonly irPrimerosPasos: () => void;
  readonly saltarInvitacion: () => void;
  readonly despachar: (e: EventoRecorrido) => void;
  readonly siguiente: () => void;
  readonly omitir: () => void;
  readonly llevame: () => void;
  readonly viajeAutomatico: () => boolean;
  readonly registrarViaje: (c: ConductorViaje | null) => void;
}

function Paneles(c: PanelesProps) {
  const { t, paso, rec, ruta } = c;
  const tarjeta = React.useRef<HTMLElement>(null);
  const menu = React.useRef<HTMLDivElement>(null);
  const capa = React.useRef<HTMLDivElement>(null);
  const etiqueta = React.useRef<HTMLDivElement>(null);
  const abierto = rec.abierto;
  const enLaPantalla = paso?.pantalla ? pantallaActiva(ruta, c.hrefsTour) === paso.pantalla : true;
  const clave = abierto && paso && paso.tipo !== "cierre" ? `${paso.id}|${ruta}` : null;
  const [res, setRes] = React.useState<{ clave: string; el: HTMLElement | null } | null>(null);
  const [reintento, setReintento] = React.useState(0);
  const el = clave && res && res.clave === clave ? res.el : undefined;

  // Menu: clic fuera lo cierra; al abrir, el foco va a su primera opcion.
  const cerrarMenu = c.cerrarMenu;
  React.useEffect(() => {
    if (!c.menuAbierto) return undefined;
    const fuera = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!menu.current?.contains(n) && !c.disparador.current?.contains(n)) cerrarMenu();
    };
    document.addEventListener("pointerdown", fuera);
    menu.current?.querySelector<HTMLElement>("button")?.focus();
    return () => document.removeEventListener("pointerdown", fuera);
  }, [c.menuAbierto, c.disparador, cerrarMenu]);

  // 1) Esperar el elemento real (tope 4 s). Un paso «ir» despliega antes el grupo del menu. Un paso de otra pantalla no busca nada.
  React.useEffect(() => {
    if (!clave || !paso) return undefined;
    if (paso.tipo !== "ir" && !enLaPantalla) {
      const id = setTimeout(() => setRes({ clave, el: null }), 0);
      return () => clearTimeout(id);
    }
    if (paso.tipo === "ir") abrirGrupoDelMenu(paso.objetivos, paso.menuGrupo);
    return esperarObjetivo(paso.objetivos, (e) => setRes({ clave, el: e }), () => setRes({ clave, el: null }));
  }, [clave, reintento]);

  // 2) Llevarlo a la vista (instantaneo con «reducir movimiento»). En movil arriba, para que no quede bajo la hoja.
  const pasoId = paso?.id;
  React.useEffect(() => {
    if (!el) return undefined;
    const estrecha = pantallaEstrecha();
    if (estrecha || el.getBoundingClientRect().height > innerHeight * 0.6) el.style.setProperty("scroll-margin-top", "88px");
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: reducirMovimiento() ? "auto" : "smooth", block: estrecha || el.getBoundingClientRect().height > innerHeight * 0.6 ? "start" : "center" });
    return () => {
      el.style.removeProperty("scroll-margin-top");
    };
  }, [el, pasoId]);

  // 3) Viaje de un paso «ir» (reglas en motor.ts).
  const tipo = paso?.tipo;
  const llevarRef = React.useRef(c.llevame);
  const viajeRef = React.useRef(c.viajeAutomatico);
  llevarRef.current = c.llevame;
  viajeRef.current = c.viajeAutomatico;
  const ctlRef = React.useRef<ConductorViaje | null>(null);
  const [viaje, setViaje] = React.useState<EstadoViaje>(estadoViajeInicial);
  const registrarViaje = c.registrarViaje;
  React.useEffect(() => {
    const ctl = crearViaje({ alCambiar: setViaje, alViajar: () => llevarRef.current() });
    ctlRef.current = ctl;
    registrarViaje(ctl);
    return () => {
      ctl.destruir();
      ctlRef.current = null;
      registrarViaje(null);
    };
  }, [registrarViaje]);
  React.useEffect(() => {
    if (!el || tipo !== "ir") return undefined;
    const alClic = () => ctlRef.current?.enviar({ tipo: "clic" });
    el.addEventListener("click", alClic, true);
    return () => el.removeEventListener("click", alClic, true);
  }, [el, tipo]);
  React.useEffect(() => () => { ctlRef.current?.reiniciar(); }, [pasoId]);
  React.useEffect(() => {
    if (tipo !== "ir" || el === undefined) return;
    ctlRef.current?.enviar({
      tipo: "planear",
      plan: planearViaje({ tipo, armado: viajeRef.current(), elemento: el ? "existe" : "ausente", movimientoReducido: reducirMovimiento(), focoEnCampo: enCampo(document.activeElement), formularioSucio: hayFormularioSucio() }),
    });
  }, [el, tipo, pasoId]);
  const faseViaje = viaje.fase;
  React.useEffect(() => {
    if (faseViaje !== "cuenta") return undefined;
    const cancelar = (motivo: string) => ctlRef.current?.enviar({ tipo: "cancelar", motivo });
    const alTecla = (e: KeyboardEvent) => {
      const r = teclaQueCancela(e.key);
      if (!r) return;
      cancelar(r.motivo);
      if (r.consumir) e.preventDefault();
    };
    const alPuntero = (e: PointerEvent) => {
      if (!(e.target instanceof Node && tarjeta.current?.contains(e.target))) cancelar("clic-fuera");
    };
    const alCampo = (e: Event) => {
      if (e.target instanceof HTMLElement && teclasPropias(e.target)) cancelar("campo");
    };
    document.addEventListener("keydown", alTecla, true);
    document.addEventListener("pointerdown", alPuntero, true);
    document.addEventListener("focusin", alCampo, true);
    document.addEventListener("input", alCampo, true);
    return () => {
      document.removeEventListener("keydown", alTecla, true);
      document.removeEventListener("pointerdown", alPuntero, true);
      document.removeEventListener("focusin", alCampo, true);
      document.removeEventListener("input", alCampo, true);
    };
  }, [faseViaje]);

  // 4) Seguir al elemento (scroll, tamaño, animaciones): recorte, etiqueta y tarjeta por CSSOM. La tarjeta evita el foco.
  React.useEffect(() => {
    const capaEl = capa.current;
    const tarjetaEl = tarjeta.current;
    if (!capaEl) return undefined;
    let cuadro = 0;
    let ultima = "";
    let primera = true;
    // Hueco real entre la hoja movil y el borde inferior (barra de navegacion + respiro), medido cuando la hoja esta abajo.
    let reservaMovil = 0;
    const colocar = (r: Rect | null) => {
      if (!tarjetaEl) return;
      if (pantallaEstrecha()) {
        if (tarjetaEl.getAttribute("data-hoja") !== "arriba") reservaMovil = Math.max(0, innerHeight - tarjetaEl.getBoundingClientRect().bottom);
        tarjetaEl.setAttribute("data-hoja", ladoHojaMovil(r, innerHeight, tarjetaEl.offsetHeight, reservaMovil));
        return;
      }
      const pos = colocarTarjeta(r, { width: tarjetaEl.offsetWidth || 380, height: tarjetaEl.offsetHeight || 320 }, { width: innerWidth, height: innerHeight });
      tarjetaEl.style.setProperty("--guia-x", `${pos.left}px`);
      tarjetaEl.style.setProperty("--guia-y", `${pos.top}px`);
      tarjetaEl.setAttribute("data-posicionada", "");
      if (primera) requestAnimationFrame(() => tarjetaEl.setAttribute("data-animar", ""));
    };
    if (!el) {
      capaEl.setAttribute("data-sin-foco", "");
      etiqueta.current?.style.setProperty("visibility", "hidden");
      const medirSola = () => {
        cuadro = requestAnimationFrame(medirSola);
        const k = [tarjetaEl?.offsetHeight ?? 0, innerWidth, innerHeight].join(",");
        if (k === ultima) return;
        ultima = k;
        colocar(null);
        primera = false;
      };
      medirSola();
      return () => cancelAnimationFrame(cuadro);
    }
    const medir = () => {
      cuadro = requestAnimationFrame(medir);
      if (!el.isConnected) {
        cancelAnimationFrame(cuadro);
        capaEl.setAttribute("data-sin-foco", "");
        setRes(null);
        setReintento((n) => n + 1);
        return;
      }
      const caja = el.getBoundingClientRect();
      if (caja.width === 0 && caja.height === 0) {
        capaEl.setAttribute("data-sin-foco", "");
        return;
      }
      // Un objetivo mas alto que media ventana se resalta por su franja superior visible: el foco cabe y la tarjeta nunca lo tapa.
      const v = rectResaltado(caja, { width: innerWidth, height: innerHeight }, pantallaEstrecha() ? 0 : (tarjetaEl?.offsetHeight ?? 0));
      const r = { ...v, right: v.left + v.width, bottom: v.top + v.height };
      const e = etiqueta.current;
      const w = e?.offsetWidth ?? 0;
      const h = e?.offsetHeight ?? 0;
      const k = [r.left, r.top, r.width, r.height, w, h, tarjetaEl?.offsetHeight ?? 0, innerWidth, innerHeight].map(Math.round).join(",");
      if (k === ultima) return;
      ultima = k;
      capaEl.style.setProperty("--tour-x", `${Math.round(r.left - PAD)}px`);
      capaEl.style.setProperty("--tour-y", `${Math.round(r.top - PAD)}px`);
      capaEl.style.setProperty("--tour-w", `${Math.round(r.width + 2 * PAD)}px`);
      capaEl.style.setProperty("--tour-h", `${Math.round(r.height + 2 * PAD)}px`);
      capaEl.removeAttribute("data-sin-foco");
      if (primera) requestAnimationFrame(() => capaEl.setAttribute("data-animar", ""));
      if (e) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const cabe: Record<LadoEtiqueta, boolean> = {
          abajo: r.bottom + PAD + GAP + h < innerHeight - MARGEN,
          arriba: r.top - PAD - GAP - h > MARGEN,
          der: r.right + PAD + GAP + w < innerWidth - MARGEN,
          izq: r.left - PAD - GAP - w > MARGEN,
        };
        // Junto al item del menu (sidebar a la izquierda) la etiqueta va a la derecha: no tapa los items vecinos.
        const orden: LadoEtiqueta[] = tipo === "ir" ? ["der", "abajo", "arriba", "izq"] : ["abajo", "arriba", "der", "izq"];
        const lado = orden.find((l) => cabe[l]) ?? "abajo";
        const x = lado === "der" ? r.right + PAD + GAP : lado === "izq" ? r.left - PAD - GAP - w : cx - w / 2;
        const y = lado === "abajo" ? r.bottom + PAD + GAP : lado === "arriba" ? r.top - PAD - GAP - h : cy - h / 2;
        e.style.setProperty("--lab-x", `${Math.round(Math.max(MARGEN, Math.min(x, innerWidth - w - MARGEN)))}px`);
        e.style.setProperty("--lab-y", `${Math.round(Math.max(MARGEN, Math.min(y, innerHeight - h - MARGEN)))}px`);
        e.setAttribute("data-lado", lado);
        e.style.setProperty("visibility", "visible");
      }
      colocar(r);
      primera = false;
    };
    medir();
    return () => cancelAnimationFrame(cuadro);
  }, [el, tipo, pasoId]);

  // 5) Foco al boton principal del paso, salvo que la persona este trabajando en la pagina.
  React.useEffect(() => {
    if (!abierto) return;
    const activo = document.activeElement;
    const dentro = activo instanceof Node && Boolean(tarjeta.current?.contains(activo) || menu.current?.contains(activo));
    if (puedeTomarFoco({ activo, cuerpo: document.body, dentroDeGuia: dentro, esDisparador: activo === c.disparador.current }))
      tarjeta.current?.querySelector<HTMLElement>("[data-guia-primario]")?.focus({ preventScroll: true });
  }, [abierto, pasoId, c.disparador]);
  // 6) Al aparecer la cuenta, el foco va a «Quedarme aquí» (lo unico que hay que alcanzar en 3 s); al cancelarla, a «Ir a …».
  const faseAntes = React.useRef(faseViaje);
  React.useEffect(() => {
    const antes = faseAntes.current;
    faseAntes.current = faseViaje;
    const quien = faseViaje === "cuenta" ? "[data-guia-quedarme]" : antes === "cuenta" && faseViaje === "manual" ? "[data-guia-manual]" : null;
    if (!quien) return;
    const activo = document.activeElement;
    const dentro = activo instanceof Node && Boolean(tarjeta.current?.contains(activo));
    if (!puedeTomarFoco({ activo, cuerpo: document.body, dentroDeGuia: dentro, esDisparador: activo === c.disparador.current })) return;
    tarjeta.current?.querySelector<HTMLElement>(quien)?.focus({ preventScroll: true });
  }, [faseViaje, c.disparador]);

  const nombres = c.pantallas.map((g) => c.nombreDePantalla(g.href));
  const total = Math.max(1, contarPasos(c.pasos));
  const n = Math.max(1, contarPasos(c.pasos.slice(0, rec.indice + 1)) + (paso?.tipo === "ir" ? 1 : 0));

  let tarjetaUi: React.ReactNode = null;
  let etiquetaUi: React.ReactNode = null;
  if (abierto && paso) {
    const cierre = paso.tipo === "cierre";
    const pantalla = c.nombreDePantalla(paso.pantalla);
    const titulo = cierre ? t("guia.cierre.titulo") : paso.tipo === "ir" ? t("guia.ir.titulo", { pantalla }) : paso.titulo ? enIdioma(paso.titulo, c.idioma) : pantalla;
    const viaja = viaje.fase === "cuenta" || (viaje.fase === "inactivo" && c.viajeAutomatico() && !reducirMovimiento());
    const cuerpo = cierre
      ? t("guia.cierre.cuerpo")
      : paso.tipo === "ir"
        ? t(viaja ? "guia.ir.cuerpoViaja" : "guia.ir.cuerpo", { nombre: pantalla })
        : enIdioma(paso.cuerpo, c.idioma).replace(/\{pantalla\}/g, pantalla);
    const hayAnterior = reducir(rec, { tipo: "anterior" }, c.pasos.length, c.pasos, ruta).indice !== rec.indice;
    tarjetaUi = (
      <TarjetaPaso
        t={t}
        innerRef={tarjeta}
        tipo={paso.tipo}
        titulo={titulo}
        cuerpo={cuerpo}
        ilu={paso.ilu}
        n={n}
        total={total}
        grupoN={Math.min(paso.grupo + 1, nombres.length)}
        grupoTotal={nombres.length}
        nombres={cierre ? [] : nombres}
        actual={paso.grupo}
        hayAnterior={hayAnterior}
        sinObjetivo={!cierre && paso.tipo !== "ir" && el === null}
        primerosPasos={cierre && c.primerosPasos ? () => { c.despachar({ tipo: "siguiente" }); c.irPrimerosPasos(); } : undefined}
        viaje={paso.tipo === "ir" ? { ...viaje, nombre: pantalla, quedarme: () => ctlRef.current?.enviar({ tipo: "cancelar", motivo: "quedarme" }), irManual: () => ctlRef.current?.enviar({ tipo: "manual" }), continuar: () => c.despachar({ tipo: "siguiente" }) } : undefined}
        anterior={() => c.despachar({ tipo: "anterior" })}
        omitir={c.omitir}
        primario={cierre ? () => c.despachar({ tipo: "siguiente" }) : c.siguiente}
      />
    );
    const nombreEl = el ? nombreDe(el) : "";
    if (el && ((paso.tipo === "ir" && pantalla) || (nombreEl && esControl(el))))
      etiquetaUi = <EtiquetaObjetivo innerRef={etiqueta} texto={paso.tipo === "ir" ? t("guia.etiqueta.clic", { nombre: pantalla }) : t("guia.etiqueta.aqui", { nombre: nombreEl })} />;
  }

  return (
    <>
      {c.menuAbierto ? (
        <div ref={menu} id="guia-menu" className="guia-menu" role="group" aria-label={t("guia.menu.aria")} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); c.cerrarMenu(); } }}>
          <p className="guia-menu-ctx">{c.contexto}</p>
          {c.opciones ? (
            <>
              <button type="button" data-guia-modo="corto" onClick={() => c.iniciar("inicio", "corto")}>{t("guia.menu.corto", { n: c.opciones.corto })}</button>
              <button type="button" data-guia-modo="completo" onClick={() => c.iniciar("inicio", "completo")}>{t("guia.menu.completo", { n: c.opciones.completo })}</button>
            </>
          ) : (
            <button type="button" onClick={() => c.iniciar("inicio")}>{t("guia.menu.repetir")}</button>
          )}
          {c.tienePaso ? <button type="button" data-guia-retomar="" onClick={() => c.iniciar("retomar")}>{t("guia.menu.retomar")}</button> : null}
          {c.pantallas.length > 0 ? (
            <div className="guia-menu-pantallas" role="group" aria-label={t("guia.menu.pantallas")}>
              <p className="guia-menu-sub">{t("guia.menu.pantallas")}</p>
              {c.pantallas.map((g) => (
                <button key={g.href} type="button" aria-current={abierto && paso?.grupo === g.grupo ? "step" : undefined} onClick={() => c.irAPantalla(g.href)}>
                  {c.nombreDePantalla(g.href)}
                </button>
              ))}
            </div>
          ) : null}
          {c.primerosPasos ? <button type="button" onClick={c.irPrimerosPasos}>{t("guia.menu.primerosPasos")}</button> : null}
          {c.descartado ? <button type="button" onClick={c.volverAMostrar}>{t("guia.menu.volverAMostrar")}</button> : <button type="button" onClick={c.noVolver}>{t("guia.menu.noVolver")}</button>}
        </div>
      ) : null}
      {c.invitacionVisible ? (
        <section className="guia-invitacion" aria-labelledby="guia-inv-titulo">
          <h2 id="guia-inv-titulo">{t("guia.inv.titulo")}</h2>
          <p>{c.opciones ? t("guia.inv.elige") : t("guia.inv.cuerpo")}</p>
          <div className="guia-acciones">
            <button type="button" className="guia-btn-sec" onClick={c.saltarInvitacion}>{t("guia.inv.omitir")}</button>
            {c.opciones ? (
              <>
                <button type="button" className="guia-btn-sec" data-guia-modo="completo" onClick={() => c.iniciar("inicio", "completo")}>{t("guia.menu.completo", { n: c.opciones.completo })}</button>
                <button type="button" className="guia-btn" data-guia-modo="corto" onClick={() => c.iniciar("inicio", "corto")}>{t("guia.menu.corto", { n: c.opciones.corto })}</button>
              </>
            ) : (
              <button type="button" className="guia-btn" onClick={() => c.iniciar("inicio")}>{t("guia.inv.empezar")}</button>
            )}
          </div>
        </section>
      ) : null}
      {abierto && paso ? (
        <div ref={capa} className="guia-capa" aria-hidden="true" data-sin-foco="" data-velo={paso.tipo === "cierre" || el === null ? "" : undefined}>
          <div className="guia-foco" />
        </div>
      ) : null}
      {etiquetaUi}
      {tarjetaUi}
    </>
  );
}

interface ViajeUi extends EstadoViaje {
  readonly nombre: string;
  readonly quedarme: () => void;
  readonly irManual: () => void;
  readonly continuar: () => void;
}

export interface TarjetaPasoProps {
  readonly t: TraductorGuia;
  readonly innerRef?: React.Ref<HTMLElement>;
  readonly tipo: PasoTour["tipo"];
  readonly titulo: string;
  readonly cuerpo: string;
  readonly ilu: string;
  readonly n: number;
  readonly total: number;
  readonly grupoN: number;
  readonly grupoTotal: number;
  readonly nombres: readonly string[];
  readonly actual: number;
  readonly hayAnterior: boolean;
  readonly sinObjetivo: boolean;
  readonly primerosPasos?: () => void;
  readonly viaje?: ViajeUi;
  readonly anterior: () => void;
  readonly omitir: () => void;
  readonly primario: () => void;
}

/** Tarjeta del paso (380 px). Dialogo NO modal: no atrapa el foco ni intercepta teclas (el teclado vive a nivel de documento). */
export function TarjetaPaso(p: TarjetaPasoProps) {
  const { t } = p;
  const v = ventanaRuta(p.nombres, p.actual);
  const cierre = p.tipo === "cierre";
  const vi = p.tipo === "ir" ? p.viaje : undefined;
  const fallo = vi?.fase === "fallo";
  return (
    <section ref={p.innerRef} className="guia-tarjeta" role="dialog" aria-modal="false" aria-labelledby="guia-t-titulo" aria-describedby="guia-t-cuerpo" data-tipo={p.tipo}>
      <div className="guia-ilu-marco" key={p.ilu}>
        <Ilustracion tipo={p.ilu} />
      </div>
      <div className="guia-cab" aria-hidden="true">
        <p className="guia-contador">{t("guia.tarjeta.paso", { n: p.n, total: p.total })}</p>
        {!cierre ? <p className="guia-contador">{t("guia.tarjeta.pantalla", { n: p.grupoN, total: p.grupoTotal })}</p> : null}
      </div>
      <progress className="guia-avance" max={p.total} value={p.n} aria-label={t("guia.tarjeta.progreso")} />
      <h2 id="guia-t-titulo">{p.titulo}</h2>
      <p id="guia-t-cuerpo">{p.cuerpo}</p>
      {p.sinObjetivo ? <p className="guia-nota">{t("guia.tarjeta.noVisible")}</p> : null}
      {vi?.fase === "cuenta" ? (
        <div className="guia-cuenta" data-guia-cuenta="">
          <p className="guia-cuenta-texto" aria-hidden="true">{t("guia.ir.cuenta", { nombre: vi.nombre, n: vi.restan })}</p>
          <progress className="guia-cuenta-barra" max={CUENTA_MS / TICK_MS} value={CUENTA_MS / TICK_MS - vi.restan} aria-hidden="true" />
          <p className="sr-only" role="status" aria-live="polite">{t("guia.ir.anuncio", { nombre: vi.nombre })}</p>
        </div>
      ) : null}
      {vi?.fase === "viajando" ? <p className="guia-nota" role="status">{t("guia.ir.abriendo", { nombre: vi.nombre })}</p> : null}
      {fallo ? <p className="guia-nota guia-fallo" role="status" data-guia-fallo="">{t("guia.ir.fallo")}</p> : null}
      {p.nombres.length > 0 ? (
        <ol className="guia-ruta" aria-label={t("guia.tarjeta.ruta")}>
          {v.antes ? <li className="guia-ruta-mas" aria-hidden="true">…</li> : null}
          {v.items.map((i) => (
            <li key={i.nombre} aria-current={i.actual && !cierre ? "step" : undefined} data-actual={(i.actual && !cierre) || undefined}>{i.nombre}</li>
          ))}
          {v.despues ? <li className="guia-ruta-mas" aria-hidden="true">…</li> : null}
        </ol>
      ) : null}
      <div className="guia-acciones">
        {!cierre ? <button type="button" className="guia-btn-sec" onClick={p.omitir}>{t("guia.tarjeta.omitir")}</button> : null}
        {p.hayAnterior ? <button type="button" className="guia-btn-sec" onClick={p.anterior}>{t("guia.tarjeta.anterior")}</button> : null}
        {p.primerosPasos ? <button type="button" className="guia-btn-sec" onClick={p.primerosPasos}>{t("guia.cierre.primerosPasos")}</button> : null}
        {vi?.fase === "cuenta" ? <button type="button" className="guia-btn-sec" data-guia-quedarme="" onClick={vi.quedarme}>{t("guia.ir.quedarme")}</button> : null}
        {vi?.fase === "manual" ? <button type="button" className="guia-btn-sec" data-guia-manual="" onClick={vi.irManual}>{t("guia.ir.manual", { nombre: vi.nombre })}</button> : null}
        <button type="button" className="guia-btn" data-guia-primario="" onClick={fallo && vi ? vi.continuar : p.primario}>
          {cierre ? t("guia.tarjeta.terminar") : fallo ? t("guia.ir.continuar") : t("guia.tarjeta.siguiente")}
        </button>
      </div>
      {/* «Paso n de N» se anuncia una vez por paso; la linea visible de arriba va oculta a lectores de pantalla. */}
      <p className="sr-only" role="status">{t("guia.tarjeta.aviso", { n: p.n, total: p.total, titulo: p.titulo })}</p>
    </section>
  );
}

function EtiquetaObjetivo({ texto, innerRef }: { texto: string; innerRef?: React.Ref<HTMLDivElement> }) {
  return (
    <div ref={innerRef} className="guia-etiqueta" aria-hidden="true">
      <span className="guia-etq-in">
        <svg className="guia-etq-flecha" viewBox="0 0 16 16" focusable="false">
          <path d="M8 13 V3 M3.5 7.5 L8 3 L12.5 7.5" />
        </svg>
        <span>{texto}</span>
      </span>
    </div>
  );
}

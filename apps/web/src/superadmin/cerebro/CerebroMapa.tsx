// ═══════════════════════════════════════════════════════════════════════════
// EL CEREBRO DE VENTAS, EL MUNDO VIRTUAL (SA-L-42) — cerebro.tsx de Likida portado a Atiende: Mexico entero "respirando", cada prospecto
// una luz del color de su VERTICAL (orden de Javier, 3-oct: "cada vertical tiene su color y de ese color se ven los clientes, y puedes
// filtrar asi"). Se navega pais -> estado (zoom animado) -> calles (Leaflet con racimos). Camara LIBRE: rueda = zoom al cursor, arrastre =
// paneo, clic = vuelo al estado (de un estado a otro sin pasar por el pais). Latido de refresco cada 5 min (no con la pestana oculta).
// La ETAPA del embudo ya no es el color: es un filtro, un dato de la tarjeta/tooltip/ficha y un anillo secundario del pin.
//
// REGLA NO MAQUETAS: todo lo que se ve sale de GET /superadmin/cerebro/prospectos; un score que el API no calculo se muestra "sin
// calificar", nunca como 0; sin la migracion 0051 el mapa lo dice (no hay coordenadas ni scores que pintar) en vez de inventar luces.
// Toda animacion respeta prefers-reduced-motion. Estilos: clases del DS y cerebro.css (nada de style en linea ni hex: guard del DS v2).
// ═══════════════════════════════════════════════════════════════════════════
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Brain, Maximize2, Minimize2, Home, SlidersHorizontal, X } from "lucide-react";
import { Callout, EstadoCargando, EstadoError, EstadoVacio, cn, resolverFormato } from "@atiende/ui";
import { fechaHoraEsMx } from "../../lib/formato-fecha.ts";
import { Chip } from "./Chip.tsx";
import { PanelFiltros } from "./PanelFiltros.tsx";
import { TarjetaProspecto } from "./TarjetaProspecto.tsx";
import { cargarCartera, registrarExportacion } from "./cerebro-client.ts";
import { fuentesPresentes, subtiposPresentes, tamanosPresentes, taxonomiaPorVertical } from "./cartera.ts";
import { CRITERIO_SCORES, aProspectoMapa, tieneCoordenadas } from "./datos.ts";
import type { ProspectoMapa, RespuestaProspectosApi } from "./datos.ts";
import { ETAPAS_EMBUDO, NOMBRE_ETAPA, claseAnilloEtapa } from "./embudo.ts";
import { SIN_FILTROS, alternarEnSet, calcularPlazas, contarFiltrosActivos, contarPorVertical, csvDe, filtrar, filtrosParaBitacora, ordenar } from "./filtros.ts";
import type { Filtros } from "./filtros.ts";
import { estadoDeEntidad, proyectar } from "./geo.ts";
import { arrancarLatido, visibilidadDelNavegador } from "./latido.ts";
import { ESTADOS_GEO, VIEWBOX_ESTADOS } from "./mexico-estados-geo.ts";
import type { EstadoGeo } from "./mexico-estados-geo.ts";
import { useCountUp } from "./use-count-up.ts";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion.ts";
import { NOMBRE_VERTICAL, VERTICALES_CEREBRO, claseVertical, nombreVertical } from "./verticales.ts";
import "./cerebro.css";

const Calles = lazy(() => import("./Calles.tsx"));

/** Con mas de este numero de luces a nivel pais el DOM se arrastra: se ensenan las N mas calientes y el pie lo DICE (nunca se recorta callado). */
const TOPE_LUCES_PAIS = 2200;
const TOPE_LUCES_ESTADO = 1500;
/** Cada cuanto pregunta el mapa por lo que cambio (tablero de venta, no monitor de tiempo real). */
export const LATIDO_MS = 300_000;
const SIN_LISTA: ProspectoMapa[] = [];
const entero = resolverFormato("entero");

const BOTON_BARRA = "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-pill font-medium backdrop-blur-sm transition-colors shadow-elevated";
const FLOTANTE = "border-border bg-card text-foreground";

function Kpi({ etiqueta, valor, animar, divisor, className }: { readonly etiqueta: string; readonly valor: number; readonly animar: boolean; readonly divisor?: boolean; readonly className?: string }) {
  const mostrado = useCountUp(valor, animar);
  return (
    <div className={cn("flex items-baseline gap-2 whitespace-nowrap px-3.5 py-1.5", divisor && "border-l border-border", className)}>
      <span className="text-2xs uppercase tracking-[0.08em] text-muted-foreground">{etiqueta}</span>
      <span data-testid={`cerebro-kpi-${etiqueta.toLowerCase()}`} className="text-sm font-semibold tabular-nums text-foreground">{entero(mostrado)}</span>
    </div>
  );
}

/** Revela sus hijos al entrar al viewport (el "scroll change" de Likida). Con reduced-motion se pinta visto desde el render. */
function Reveal({ children, retraso = "" }: { readonly children: React.ReactNode; readonly retraso?: "" | "delay-100" | "delay-150" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visto, setVisto] = useState(false);
  const reducido = usePrefersReducedMotion();
  const mostrar = visto || reducido;
  useEffect(() => {
    if (reducido) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) {
        setVisto(true);
        obs.disconnect();
      }
    }, { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [reducido]);
  return (
    <div ref={ref} className={cn(mostrar ? "translate-y-0 opacity-100" : "translate-y-[22px] opacity-0", reducido ? "transition-none" : cn("transition-[opacity,transform] duration-[650ms] ease-out", retraso))}>
      {children}
    </div>
  );
}

/** Barra horizontal de una fila de resumen (embudo, verticales, estados). El ancho es un atributo SVG: sin estilos en linea. */
function FilaBarra({ nombre, valor, pct, claseRelleno, punto }: { readonly nombre: string; readonly valor: number; readonly pct: number; readonly claseRelleno: string; readonly punto?: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="flex w-32 shrink-0 items-center gap-1.5 truncate">
        {punto && <span aria-hidden="true" className={cn("cerebro-punto-sin-halo size-1.5 shrink-0 rounded-full", punto)} />}
        <span className="truncate">{nombre}</span>
      </span>
      <svg aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full" preserveAspectRatio="none">
        <rect width="100%" height="100%" className="fill-border" />
        <rect width={`${Math.min(100, Math.max(valor > 0 ? 2 : 0, pct))}%`} height="100%" className={cn("cerebro-llenado", claseRelleno)} />
      </svg>
      <span className="w-10 text-right tabular-nums text-foreground">{entero(valor)}</span>
    </div>
  );
}

const PANEL_RESUMEN = "rounded-2xl border border-border bg-card p-4";
const TITULO_RESUMEN = "etiqueta-mono mb-3 text-2xs font-medium uppercase text-muted-foreground";

export function SuperAdminCerebroMapaPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [respuesta, setRespuesta] = useState<RespuestaProspectosApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generadoEn, setGeneradoEn] = useState<Date | null>(null);
  const [recientes, setRecientes] = useState<ReadonlySet<string>>(new Set());
  const conocidos = useRef<Set<string> | null>(null);

  const aplicar = useCallback((r: RespuestaProspectosApi) => {
    // Las luces que llegan DESPUES de la primera carga titilan ("recien llegadas"): lo nuevo se nota sin recargar.
    const ids = new Set(r.prospectos.map((p) => p.id));
    if (conocidos.current) {
      const nuevos = new Set([...ids].filter((id) => !conocidos.current!.has(id)));
      if (nuevos.size > 0) setRecientes(nuevos);
    }
    conocidos.current = ids;
    setRespuesta(r);
    setGeneradoEn(new Date());
    setError(null);
  }, []);

  const cargar = useCallback(async () => {
    setError(null);
    try {
      aplicar(await cargarCartera(apiBaseUrl, token));
    } catch {
      setError("No se pudo cargar la cartera de prospectos.");
    }
  }, [apiBaseUrl, token, aplicar]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // EL LATIDO: se pregunta por lo que cambio cada 5 min y SOLO con la pestana a la vista (latido.ts). Un fallo de red deja el mapa vigente:
  // no se pinta un error como si la cartera estuviera vacia.
  useEffect(
    () =>
      arrancarLatido({
        intervaloMs: LATIDO_MS,
        ...visibilidadDelNavegador(),
        latir: async () => {
          try {
            aplicar(await cargarCartera(apiBaseUrl, token));
          } catch {
            /* sin red: el mapa vigente sigue */
          }
        },
      }),
    [apiBaseUrl, token, aplicar],
  );

  if (error && !respuesta) return <EstadoError titulo="No se pudo cargar el mapa" mensaje={error} onReintentar={() => void cargar()} />;
  if (!respuesta) return <EstadoCargando variante="tarjeta" etiqueta="Cargando el mapa de prospectos…" />;
  if (!respuesta.disponible) {
    return (
      <div className="grid gap-3">
        <Callout tone="warning" titulo="El mapa no está disponible aún: requiere la migración 0051_cerebro_ventas_base">
          {respuesta.mensaje ?? "Sin la migración no hay ubicación ni scores por prospecto, y el mapa no inventa luces."} La lista de prospectos de siempre sigue funcionando.
        </Callout>
        <EstadoVacio titulo="Sin mapa todavía" mensaje="Cuando se aplique la migración, cada prospecto con ubicación aparecerá aquí con el color de su vertical." accion={<Link className="text-primary underline" to="/superadmin/cerebro">Ir a la lista de prospectos</Link>} />
      </div>
    );
  }
  return <Mundo respuesta={respuesta} generadoEn={generadoEn} recientes={recientes} apiBaseUrl={apiBaseUrl} token={token} />;
}

function Mundo({ respuesta, generadoEn, recientes, apiBaseUrl, token }: {
  readonly respuesta: RespuestaProspectosApi;
  readonly generadoEn: Date | null;
  readonly recientes: ReadonlySet<string>;
  readonly apiBaseUrl: string;
  readonly token: string;
}) {
  const reducido = usePrefersReducedMotion();
  const reducidoRef = useRef(reducido);
  useEffect(() => {
    reducidoRef.current = reducido;
  }, [reducido]);
  const navegar = useNavigate();
  const [params] = useSearchParams();

  const prospectos = useMemo(() => respuesta.prospectos.map(aProspectoMapa), [respuesta.prospectos]);
  const tax = useMemo(() => taxonomiaPorVertical(respuesta.taxonomias), [respuesta.taxonomias]);
  const ahoraMs = generadoEn?.getTime() ?? 0;

  const [seleccion, setSeleccion] = useState<EstadoGeo | null>(() => {
    const e = params.get("estado");
    return e ? (ESTADOS_GEO.find((x) => x.nombre === e) ?? null) : null;
  });
  const [hover, setHover] = useState<string | null>(null);
  const [calles, setCalles] = useState(false);

  // Pantalla completa nativa (el monitor entero).
  const zonaRef = useRef<HTMLElement>(null);
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
  useEffect(() => {
    const alCambiar = () => setPantallaCompleta(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", alCambiar);
    return () => document.removeEventListener("fullscreenchange", alCambiar);
  }, []);
  const alternarPantalla = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void zonaRef.current?.requestFullscreen();
  };

  // ── Filtros y orden ──
  const [filtros, setFiltros] = useState<Filtros>(SIN_FILTROS);
  const [filtrosAbiertos, setFiltrosAbiertos] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const botonFiltrosRef = useRef<HTMLButtonElement>(null);
  // El popup se cierra al hacer clic FUERA (pointerdown en captura, ignorando el propio boton de Filtros).
  useEffect(() => {
    if (!filtrosAbiertos) return;
    const fuera = (ev: PointerEvent) => {
      const t = ev.target as Node;
      if (popupRef.current?.contains(t) || botonFiltrosRef.current?.contains(t)) return;
      setFiltrosAbiertos(false);
    };
    document.addEventListener("pointerdown", fuera, true);
    return () => document.removeEventListener("pointerdown", fuera, true);
  }, [filtrosAbiertos]);
  const filtrosActivos = contarFiltrosActivos(filtros);
  const filtrados = useMemo(() => filtrar(prospectos, filtros, ahoraMs), [prospectos, filtros, ahoraMs]);
  const ordenados = useMemo(() => ordenar(filtrados, filtros.orden), [filtrados, filtros.orden]);
  const plazas = useMemo(() => calcularPlazas(prospectos), [prospectos]);
  const fuentes = useMemo(() => fuentesPresentes(prospectos), [prospectos]);
  const subtipos = useMemo(() => subtiposPresentes(prospectos, tax), [prospectos, tax]);
  const tamanos = useMemo(() => tamanosPresentes(prospectos, tax), [prospectos, tax]);
  // La leyenda cuenta con TODOS los filtros menos el de vertical: asi sigue informando cuando una vertical esta elegida.
  const conteoVertical = useMemo(() => contarPorVertical(filtrar(prospectos, { ...filtros, verticales: null }, ahoraMs)), [prospectos, filtros, ahoraMs]);

  const [exportando, setExportando] = useState(false);
  const [avisoExport, setAvisoExport] = useState<string | null>(null);
  const exportarCsv = async () => {
    const lista = ordenados;
    setExportando(true);
    setAvisoExport(null);
    try {
      // El rastro se registra ANTES de armar el archivo (con el total y la FORMA de los filtros, nunca datos de prospectos). Si registrar
      // FALLA, no se exporta: una descarga con telefonos y correos sin huella es lo que esta bitacora existe para evitar.
      const r = await registrarExportacion(apiBaseUrl, token, lista.length, filtrosParaBitacora(filtros));
      const blob = new Blob([csvDe(lista)], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `cerebro-prospectos-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (!r.registrada) setAvisoExport("Se exportó, pero la bitácora de exportaciones no está disponible en este despliegue: no quedó rastro de esta descarga.");
    } catch {
      setAvisoExport("No se exportó: no se pudo registrar la exportación en la bitácora. Inténtalo de nuevo.");
    } finally {
      setExportando(false);
    }
  };

  // ── Agregados por estado ──
  const porEstado = useMemo(() => {
    const m = new Map<string, ProspectoMapa[]>();
    for (const p of filtrados) {
      const e = estadoDeEntidad(p.entidad);
      if (!e) continue;
      const l = m.get(e.id) ?? [];
      l.push(p);
      m.set(e.id, l);
    }
    for (const [k, l] of m) m.set(k, ordenar(l, filtros.orden));
    return m;
  }, [filtrados, filtros.orden]);
  const sinPlaza = useMemo(() => filtrados.filter((p) => estadoDeEntidad(p.entidad) === null).length, [filtrados]);
  const maxEstado = useMemo(() => Math.max(1, ...[...porEstado.values()].map((l) => l.length)), [porEstado]);
  const conTelefono = useMemo(() => filtrados.filter((p) => p.telefono).length, [filtrados]);
  const conDecisor = useMemo(() => filtrados.filter((p) => p.contacto).length, [filtrados]);
  const urgentes = useMemo(() => filtrados.filter((p) => (p.urgencia ?? 0) >= 70).length, [filtrados]);
  const sinCalificar = useMemo(() => filtrados.filter((p) => p.urgencia === null && p.cierre === null && p.ajuste === null).length, [filtrados]);

  // ── LA CAMARA LIBRE ──
  // Vive en un ref y se aplica DIRECTO al <g> (sin re-render por frame): la rueda acerca hacia el cursor, el arrastre panea, el clic en un
  // estado VUELA hacia el con transicion. `camK` es la copia en estado (grosor de trazos y radio de luces) y se sincroniza al SOLTAR el gesto.
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<SVGGElement>(null);
  const cam = useRef({ x: 0, y: 0, k: 1 });
  const [camK, setCamK] = useState(1);
  const arrastro = useRef(false);
  const arrastrando = useRef<{ cx: number; cy: number; acumulado: number } | null>(null);
  const sincro = useRef<ReturnType<typeof setTimeout> | null>(null);

  const aplicarCam = (transicion: boolean) => {
    const g = gRef.current;
    if (!g) return;
    g.style.transition = transicion && !reducidoRef.current ? "transform 750ms cubic-bezier(.22,1,.36,1)" : "none";
    g.style.transform = `translate(${cam.current.x}px, ${cam.current.y}px) scale(${cam.current.k})`;
  };

  /** Coordenadas de pantalla -> unidades del viewBox (preserveAspectRatio meet). */
  const factorViewBox = () => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return { f: 1, ox: 0, oy: 0, left: 0, top: 0 };
    const f = Math.min(r.width / VIEWBOX_ESTADOS.w, r.height / VIEWBOX_ESTADOS.h);
    return { f, ox: (r.width - VIEWBOX_ESTADOS.w * f) / 2, oy: (r.height - VIEWBOX_ESTADOS.h * f) / 2, left: r.left, top: r.top };
  };

  const volarA = (e: EstadoGeo | null) => {
    if (!e) {
      cam.current = { x: 0, y: 0, k: 1 };
    } else {
      const margen = 1.35;
      const k = Math.min(9, VIEWBOX_ESTADOS.w / (e.bw * margen), VIEWBOX_ESTADOS.h / (e.bh * margen));
      // El estado aterriza al centro-izquierda: el panel vive a la derecha.
      cam.current = { x: VIEWBOX_ESTADOS.w * 0.36 - k * e.cx, y: VIEWBOX_ESTADOS.h * 0.5 - k * e.cy, k };
    }
    aplicarCam(true);
    setCamK(cam.current.k);
  };

  const alRodar = (ev: WheelEvent) => {
    ev.preventDefault();
    const { f, ox, oy, left, top } = factorViewBox();
    const px = (ev.clientX - left - ox) / f;
    const py = (ev.clientY - top - oy) / f;
    const { x, y, k } = cam.current;
    const k2 = Math.min(16, Math.max(1, k * Math.exp(-ev.deltaY * 0.0016)));
    if (k2 === k) return;
    cam.current = { x: px - ((px - x) * k2) / k, y: py - ((py - y) * k2) / k, k: k2 };
    if (k2 === 1) cam.current = { x: 0, y: 0, k: 1 }; // al fondo, el pais completo
    aplicarCam(false);
    if (sincro.current) clearTimeout(sincro.current);
    sincro.current = setTimeout(() => setCamK(cam.current.k), 120);
  };

  // La rueda necesita listener NO pasivo (preventDefault): React no lo da. Con un estado inicial (deep-link) la camara vuela hacia el al montar.
  useEffect(() => {
    if (seleccion) volarA(seleccion);
    else aplicarCam(false);
    const svg = svgRef.current;
    if (!svg) return;
    svg.addEventListener("wheel", alRodar, { passive: false });
    return () => {
      svg.removeEventListener("wheel", alRodar);
      if (sincro.current) clearTimeout(sincro.current);
    };
    // Dependencias vacias a proposito: alRodar solo lee refs.
  }, []);

  const alBajarPuntero = (ev: React.PointerEvent<SVGSVGElement>) => {
    arrastro.current = false;
    arrastrando.current = { cx: ev.clientX, cy: ev.clientY, acumulado: 0 };
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
  };
  const alMoverPuntero = (ev: React.PointerEvent<SVGSVGElement>) => {
    const a = arrastrando.current;
    if (!a) return;
    const { f } = factorViewBox();
    const dx = ev.clientX - a.cx;
    const dy = ev.clientY - a.cy;
    a.acumulado += Math.abs(dx) + Math.abs(dy);
    a.cx = ev.clientX;
    a.cy = ev.clientY;
    if (a.acumulado > 4) arrastro.current = true;
    cam.current = { ...cam.current, x: cam.current.x + dx / f, y: cam.current.y + dy / f };
    aplicarCam(false);
  };
  const alSoltarPuntero = () => {
    if (arrastrando.current) setCamK(cam.current.k);
    arrastrando.current = null;
  };

  const listaSeleccion = useMemo(() => (seleccion ? (porEstado.get(seleccion.id) ?? SIN_LISTA) : SIN_LISTA), [seleccion, porEstado]);
  const conCoords = useMemo(() => filtrados.filter(tieneCoordenadas), [filtrados]);
  const universoLuces = useMemo(() => (seleccion ? conCoords.filter((p) => estadoDeEntidad(p.entidad)?.id === seleccion.id) : conCoords), [conCoords, seleccion]);
  const tope = seleccion ? TOPE_LUCES_ESTADO : TOPE_LUCES_PAIS;
  const lucesRecortadas = universoLuces.length > tope;
  const pines = useMemo(() => {
    // Con estado elegido solo se pintan SUS luces; a nivel pais, las mas calientes hasta el tope.
    const base = universoLuces.length > tope ? [...universoLuces].sort((a, b) => (b.urgencia ?? 0) + (b.cierre ?? 0) - ((a.urgencia ?? 0) + (a.cierre ?? 0))).slice(0, tope) : universoLuces;
    return base.map((p) => ({ p, xy: proyectar(p.lat, p.lng) }));
  }, [universoLuces, tope]);

  const volverAlPais = () => {
    setSeleccion(null);
    setCalles(false);
    volarA(null);
  };
  const elegirEstado = (e: EstadoGeo) => {
    if (arrastro.current) return; // fue paneo, no clic
    setCalles(false);
    setFiltrosAbiertos(false);
    const destino = seleccion?.id === e.id ? null : e;
    setSeleccion(destino);
    volarA(destino);
  };

  const vacio = prospectos.length === 0;

  return (
    <div className="min-w-0 space-y-10">
      {avisoExport && <Callout tone="warning" role="status" onDismiss={() => setAvisoExport(null)}>{avisoExport}</Callout>}
      {/* ── El mundo ─────────────────────────────────────────────────────── */}
      <section
        ref={zonaRef}
        data-testid="cerebro-zona"
        aria-label="Mapa del Cerebro de ventas"
        className={cn("cerebro-zona relative min-h-[540px] overflow-hidden rounded-3xl border border-border bg-canvas", pantallaCompleta ? "h-screen" : "h-[calc(100dvh-11rem)] md:h-[calc(100dvh-7.5rem)]")}
      >
        {/* KPIs flotantes */}
        <div className="pointer-events-none absolute left-4 right-4 top-4 z-20 flex flex-wrap items-start gap-2">
          <div className="pointer-events-auto">
            <h1 className="flex items-center gap-2 text-lg font-semibold text-foreground">
              <Brain className="size-[18px] text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
              Mapa de prospectos
            </h1>
            <p className="max-w-[26rem] text-xs text-muted-foreground">
              {seleccion ? `${seleccion.nombre} — ${entero(listaSeleccion.length)} prospectos` : "Rueda para acercar, arrastra para moverte, toca un estado para volar a él. Se actualiza solo."}
            </p>
          </div>
          <div className="pointer-events-auto ml-auto flex flex-wrap items-center gap-2">
            <div className="flex items-center overflow-hidden rounded-full border border-border bg-card shadow-elevated backdrop-blur-sm">
              <Kpi etiqueta="Prospectos" valor={filtrados.length} animar={!reducido} />
              <Kpi etiqueta="Teléfono" valor={conTelefono} animar={!reducido} divisor className="hidden sm:flex" />
              <Kpi etiqueta="Decisor" valor={conDecisor} animar={!reducido} divisor className="hidden sm:flex" />
              <Kpi etiqueta="Urgentes" valor={urgentes} animar={!reducido} divisor className="hidden sm:flex" />
            </div>
            {(camK > 1.02 || seleccion) && (
              <button type="button" onClick={volverAlPais} title="Volver al país" aria-label="Volver al país" className={cn(BOTON_BARRA, FLOTANTE, "hover:bg-canvas")}>
                <Home className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            {/* Los dos atajos mas pedidos: un clic, sin abrir el popup de Filtros (mismo estado que sus chips de adentro). */}
            <button
              type="button"
              aria-pressed={filtros.soloDecisor}
              onClick={() => setFiltros((f) => ({ ...f, soloDecisor: !f.soloDecisor }))}
              className={cn(BOTON_BARRA, filtros.soloDecisor ? "border-success bg-success text-card" : cn(FLOTANTE, "hover:bg-canvas"))}
            >
              Con decisor
            </button>
            <button
              type="button"
              aria-pressed={filtros.minUrgencia === 70}
              onClick={() => setFiltros((f) => ({ ...f, minUrgencia: f.minUrgencia === 70 ? 0 : 70 }))}
              className={cn(BOTON_BARRA, filtros.minUrgencia === 70 ? "border-warning bg-warning text-card" : cn(FLOTANTE, "hover:bg-canvas"))}
            >
              Urgentes
            </button>
            <button
              type="button"
              ref={botonFiltrosRef}
              aria-expanded={filtrosAbiertos}
              onClick={() => setFiltrosAbiertos((v) => !v)}
              className={cn(BOTON_BARRA, filtrosActivos ? "border-foreground bg-foreground text-card" : cn(FLOTANTE, "hover:bg-canvas"))}
            >
              <SlidersHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              Filtros{filtrosActivos ? ` · ${filtrosActivos}` : ""}
            </button>
            <button type="button" onClick={alternarPantalla} title="Pantalla completa" aria-label="Pantalla completa" className={cn(BOTON_BARRA, FLOTANTE, "hover:bg-canvas")}>
              {pantallaCompleta ? <Minimize2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" /> : <Maximize2 className="size-3.5" strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </div>
        </div>

        {filtrosAbiertos && (
          <PanelFiltros
            filtros={filtros}
            setFiltros={setFiltros}
            prospectos={prospectos}
            filtrados={filtrados}
            fuentes={fuentes}
            subtipos={subtipos}
            tamanos={tamanos}
            plazas={plazas}
            conteoVertical={conteoVertical}
            exportando={exportando}
            onExportar={() => void exportarCsv()}
            popupRef={popupRef}
          />
        )}

        {/* El ala izquierda: solo en pantallas anchas. El embudo y los mas cerrables VIVEN junto al pais, sin taparlo. */}
        <aside className="cerebro-ala pointer-events-auto absolute bottom-5 left-4 top-24 z-10 hidden w-[300px] flex-col gap-3 overflow-y-auto pr-1">
          <div className="rounded-2xl border border-border bg-card p-4 backdrop-blur-sm">
            <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">El embudo</h3>
            <div className="space-y-2">
              {ETAPAS_EMBUDO.map((e) => (
                <div key={e} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex-1">{NOMBRE_ETAPA[e]}</span>
                  <span className="font-medium tabular-nums text-foreground">{entero(filtrados.filter((p) => p.estado === e).length)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-card p-4 backdrop-blur-sm">
            <h3 className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Más cerrables</h3>
            <div className="space-y-2.5">
              {ordenados.slice(0, 7).map((p) => (
                <div key={p.id} className="text-xs leading-snug">
                  <p className="truncate font-medium text-foreground">{p.empresa}</p>
                  <p className="flex items-center gap-1.5 text-muted-foreground">
                    <span aria-hidden="true" className={cn("cerebro-punto-sin-halo size-1.5 rounded-full", claseVertical(p.vertical))} />
                    {estadoDeEntidad(p.entidad)?.nombre ?? "sin plaza"} · cierre {p.cierre === null ? "sin calificar" : `${p.cierre}%`}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* El pais: camara libre (rueda, arrastre y vuelo) */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEWBOX_ESTADOS.w} ${VIEWBOX_ESTADOS.h}`}
          className="absolute inset-0 h-full w-full cursor-grab touch-none"
          onPointerDown={alBajarPuntero}
          onPointerMove={alMoverPuntero}
          onPointerUp={alSoltarPuntero}
          onPointerCancel={alSoltarPuntero}
          role="img"
          aria-label="Mapa de México con la cartera de prospectos"
        >
          {/* El mar: clic fuera de un estado = volver al pais (si no fue arrastre). */}
          <rect x={0} y={0} width={VIEWBOX_ESTADOS.w} height={VIEWBOX_ESTADOS.h} fill="transparent" onClick={() => { if (!arrastro.current) volverAlPais(); }} />
          <g ref={gRef} className="will-change-transform [transform-origin:0_0]">
            {ESTADOS_GEO.map((e, i) => {
              const lista = porEstado.get(e.id) ?? SIN_LISTA;
              const activo = seleccion?.id === e.id;
              const apagado = seleccion !== null && !activo;
              return (
                <path
                  key={e.id}
                  d={e.path}
                  data-estado={e.id}
                  ref={(el) => el?.style.setProperty("animation-delay", `${i * 22}ms`)}
                  strokeWidth={Math.max(0.12, (activo ? 0.8 : 0.55) / camK)}
                  className={cn("cerebro-estado", `cerebro-int-${Math.round((lista.length / maxEstado) * 12)}`, !reducido && "cerebro-estado-entra", activo && "cerebro-estado-activo", apagado && "cerebro-estado-apagado", hover === e.id && !activo && "cerebro-estado-hover")}
                  onMouseEnter={() => setHover(e.id)}
                  onMouseLeave={() => setHover((h) => (h === e.id ? null : h))}
                  onClick={() => elegirEstado(e)}
                />
              );
            })}
            {/* Las luces: cada prospecto con coordenadas reales, del color de su vertical */}
            {pines.map(({ p, xy }) => (
              <circle
                key={p.id}
                cx={xy.x}
                cy={xy.y}
                r={Math.max(0.5, Math.min(2.4, 2.4 / camK))}
                strokeWidth={Math.max(0.1, 0.4 / camK)}
                data-vertical={p.vertical}
                data-etapa={p.estado}
                className={cn("cerebro-luz", claseVertical(p.vertical), claseAnilloEtapa(p.estado), recientes.has(p.id) ? "cerebro-pin-nuevo" : !reducido && (p.urgencia ?? 0) >= 70 && "cerebro-pin-pulso")}
              />
            ))}
          </g>
        </svg>

        {/* Tooltip del hover a nivel pais */}
        {hover && !seleccion && (() => {
          const e = ESTADOS_GEO.find((x) => x.id === hover);
          if (!e) return null;
          const lista = porEstado.get(e.id) ?? SIN_LISTA;
          const porVertical = [...contarPorVertical(lista).entries()].sort((a, b) => b[1] - a[1]);
          return (
            <div role="status" className="absolute bottom-16 left-5 z-20 rounded-2xl border border-border bg-card px-4 py-3 text-foreground backdrop-blur-sm">
              <div className="text-sm font-semibold">{e.nombre}</div>
              <div className="text-xs text-muted-foreground">
                {entero(lista.length)} prospectos · {entero(lista.filter((p) => p.telefono).length)} con teléfono · {entero(lista.filter((p) => (p.urgencia ?? 0) >= 70).length)} urgentes
              </div>
              {porVertical.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-eyebrow text-muted-foreground">
                  {porVertical.map(([v, n]) => (
                    <span key={v} className="flex items-center gap-1.5">
                      <span aria-hidden="true" className={cn("cerebro-punto-sin-halo size-1.5 rounded-full", claseVertical(v))} />
                      {nombreVertical(v)} {n}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {vacio && (
          <div className="absolute inset-x-4 top-1/2 z-10 -translate-y-1/2">
            <EstadoVacio titulo="Todavía no hay prospectos" mensaje="Cuando se den de alta en el Cerebro de ventas, cada uno con ubicación aparece aquí como una luz del color de su vertical." accion={<Link className="text-primary underline" to="/superadmin/cerebro">Ir a la lista de prospectos</Link>} />
          </div>
        )}

        {lucesRecortadas && (
          <p className="absolute bottom-16 right-4 z-10 rounded-full border border-border bg-card px-3 py-1.5 text-eyebrow text-muted-foreground backdrop-blur-sm sm:bottom-5">
            Luces: las más calientes ({entero(pines.length)} de {entero(universoLuces.length)}) — afina el filtro para verlas todas.
          </p>
        )}

        {/* La leyenda: las 6 verticales, cada una con su color y su conteo. FILTRABLE: un clic la agrega al filtro (otro clic la quita). */}
        <div role="group" aria-label="Verticales (leyenda y filtro)" data-testid="cerebro-leyenda" className={cn("absolute bottom-5 left-5 z-10 max-w-[calc(100%-2.5rem)] flex-wrap items-center gap-x-1.5 gap-y-1 rounded-3xl border border-border bg-card px-3 py-2 backdrop-blur-sm", seleccion && !calles ? "hidden sm:flex sm:max-w-[calc(100%-24rem)]" : "flex")}>
          {VERTICALES_CEREBRO.map((v) => (
            <Chip key={v} vertical={v} activo={filtros.verticales?.has(v) ?? false} title={`${NOMBRE_VERTICAL[v]}: clic para ver solo esta vertical (otro clic la quita)`} onClick={() => setFiltros((f) => ({ ...f, verticales: alternarEnSet(f.verticales, v) }))}>
              {NOMBRE_VERTICAL[v]} <span className="tabular-nums">{entero(conteoVertical.get(v) ?? 0)}</span>
            </Chip>
          ))}
          {filtros.verticales && (
            <button type="button" onClick={() => setFiltros((f) => ({ ...f, verticales: null }))} className="px-2 text-eyebrow text-muted-foreground underline hover:text-foreground">
              Todas
            </button>
          )}
        </div>

        {/* Los leads del estado: tarjetas FLOTANDO al lateral del pais, sin recuadro contenedor. Solo la columna hace scroll. */}
        {seleccion && !calles && (
          <div data-testid="cerebro-panel-estado" className="cerebro-panel pointer-events-none absolute bottom-4 right-4 top-44 z-20 flex w-[min(92vw,330px)] flex-col gap-2.5 sm:top-[9rem] min-[1500px]:top-[4.4rem]">
            <div className="pointer-events-auto flex items-center gap-2.5 self-end rounded-full border border-border bg-card px-3.5 py-1.5 shadow-elevated backdrop-blur-sm">
              <span className="text-ui font-semibold text-foreground">{seleccion.nombre}</span>
              <span className="text-eyebrow tabular-nums text-muted-foreground">{entero(listaSeleccion.length)}</span>
              {listaSeleccion.some(tieneCoordenadas) && (
                <button type="button" onClick={() => setCalles(true)} className="rounded-full bg-foreground px-2.5 py-1 text-eyebrow font-medium text-card">
                  Calles →
                </button>
              )}
              <button type="button" onClick={volverAlPais} title="Cerrar" aria-label="Cerrar estado" className="px-1 text-muted-foreground hover:text-foreground">
                <X className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <div className="cerebro-scroll pointer-events-auto flex-1 space-y-2.5 overflow-y-auto pr-0.5">
              {listaSeleccion.length === 0 ? (
                <p className="rounded-2xl border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground shadow-elevated backdrop-blur-sm">
                  {filtrosActivos > 0 ? "Ningún prospecto de este estado pasa los filtros." : "Todavía no hay prospectos aquí — cuando se den de alta, aparecen solos."}
                </p>
              ) : (
                <>
                  {listaSeleccion.slice(0, 60).map((p) => (
                    <TarjetaProspecto key={p.id} p={p} tax={tax} nuevo={recientes.has(p.id)} />
                  ))}
                  {listaSeleccion.length > 60 && (
                    <p className="rounded-2xl border border-border bg-card px-3.5 py-2 text-eyebrow text-muted-foreground shadow-elevated backdrop-blur-sm">
                      Se enseñan los 60 mejores de {entero(listaSeleccion.length)} — afina el filtro o exporta el CSV completo.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* El nivel calles */}
        {seleccion && calles && (
          <Suspense fallback={<div className="absolute inset-0 z-30 grid place-items-center rounded-3xl bg-card"><EstadoCargando variante="tarjeta" etiqueta="Cargando el nivel calle…" /></div>}>
            <Calles prospectos={listaSeleccion} tax={tax} titulo={seleccion.nombre} onCerrar={() => setCalles(false)} onFicha={(id) => navegar(`/superadmin/mapa-prospectos/${id}`)} />
          </Suspense>
        )}
      </section>

      {/* ── Lo que se revela al hacer scroll ─────────────────────────────── */}
      <Reveal>
        <section className="grid gap-4 lg:grid-cols-3">
          <div className={PANEL_RESUMEN}>
            <h3 className={TITULO_RESUMEN}>La cartera por vertical</h3>
            <div className="space-y-2.5">
              {VERTICALES_CEREBRO.map((v) => {
                const n = filtrados.filter((p) => p.vertical === v).length;
                return <FilaBarra key={v} nombre={NOMBRE_VERTICAL[v]} valor={n} pct={filtrados.length ? Math.round((n / filtrados.length) * 100) : 0} claseRelleno={cn("cerebro-barra-vertical", claseVertical(v))} punto={claseVertical(v)} />;
              })}
            </div>
          </div>
          <div className={PANEL_RESUMEN}>
            <h3 className={TITULO_RESUMEN}>El embudo</h3>
            <div className="space-y-2.5">
              {ETAPAS_EMBUDO.map((e) => {
                const n = filtrados.filter((p) => p.estado === e).length;
                return <FilaBarra key={e} nombre={NOMBRE_ETAPA[e]} valor={n} pct={filtrados.length ? Math.round((n / filtrados.length) * 100) : 0} claseRelleno="fill-foreground/55" />;
              })}
            </div>
          </div>
          <div className={PANEL_RESUMEN}>
            <h3 className={TITULO_RESUMEN}>Dónde vive la cartera</h3>
            <div className="space-y-2">
              {[...porEstado.entries()]
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, 8)
                .map(([id, lista]) => (
                  <FilaBarra key={id} nombre={ESTADOS_GEO.find((x) => x.id === id)?.nombre ?? id} valor={lista.length} pct={Math.round((lista.length / maxEstado) * 100)} claseRelleno="fill-foreground/55" />
                ))}
              <p className="pt-1 text-eyebrow text-muted-foreground">{entero(sinPlaza)} sin plaza conocida — se dice, no se les inventa estado.</p>
            </div>
          </div>
        </section>
      </Reveal>

      <Reveal retraso="delay-100">
        <section data-testid="cerebro-top12" className={PANEL_RESUMEN}>
          <h3 className={TITULO_RESUMEN}>Los 12 más cerrables del país</h3>
          {ordenados.length === 0 ? (
            <p className="text-xs text-muted-foreground">{filtrosActivos > 0 ? "Ningún prospecto pasa los filtros." : "Todavía no hay prospectos."}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {ordenados.slice(0, 12).map((p) => (
                <TarjetaProspecto key={p.id} p={p} tax={tax} plana nuevo={recientes.has(p.id)} />
              ))}
            </div>
          )}
        </section>
      </Reveal>

      <Reveal retraso="delay-150">
        <footer className="space-y-1 px-1 text-eyebrow leading-relaxed text-muted-foreground">
          <p>{CRITERIO_SCORES.ajuste}</p>
          <p>{CRITERIO_SCORES.urgencia}</p>
          <p>{CRITERIO_SCORES.cierre}</p>
          <p>{CRITERIO_SCORES.completitud}</p>
          <p>{CRITERIO_SCORES.insuficiente}{sinCalificar > 0 ? ` Ahora mismo ${entero(sinCalificar)} prospectos están sin calificar.` : ""}</p>
          <p>
            Puntos en el mapa: solo prospectos con coordenadas reales capturadas en el Cerebro.{generadoEn ? ` Actualizado ${fechaHoraEsMx(generadoEn)}` : ""} · se refresca cada 5 min (y no mientras la pestaña está oculta). La etapa del embudo es un filtro y un dato de cada tarjeta; el color de cada luz es el de su vertical.
          </p>
        </footer>
      </Reveal>
    </div>
  );
}

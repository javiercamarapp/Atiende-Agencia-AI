// Pedidos en operacion (Fase 5 + UNI-R1) — tablero de despacho IDENTICO al del repo suelto: «N en total» a la izquierda y tres pildoras a la
// derecha (Ordenes recibidas / enviadas / programadas), lista a la izquierda y la tarjeta «Entrega en curso» con el mapa a la derecha;
// clic en una fila = detalle del pedido a pagina completa. Por debajo van las MISMAS llamadas reales de siempre: el cambio de estado pasa por
// la maquina de estados de order-lifecycle.ts (el servidor SIEMPRE re-valida la transicion; los botones ofrecidos son solo un espejo de
// NEXT_STATUSES para no mostrar una accion que el servidor rechazaria).
//
// Mapeo de estados reales -> pildoras: «Ordenes recibidas» = todo lo que sigue en el restaurante antes de salir (Recibido, Preparando, Listo
// para recoger, No recogido, Incidencia; mas «Por aprobar» del autopiloto, como filtro); «Ordenes enviadas» = En camino; «Ordenes programadas» =
// Programado. Las funciones del monorepo que el original no tiene (sondeo, sonido, auto-impresion, vista previa, reglas del autopiloto) se
// compactan en el boton «Herramientas».
import { useEffect, useRef, useState } from "react";
import { Loader2, Package, Truck, CalendarClock } from "lucide-react";
import { EstadoError, PageContainer, StatusBadge, TicketCocinaDialog, cn, construirTicketCocina, imprimirTicketsCocina, notify, pedidosPorImprimir } from "@atiende/ui";
import type { TicketCocina } from "@atiende/ui";
import { fetchAvisos, sonidoPedidoNuevoPermitido } from "../lib/avisos-client.ts";
import { fetchAdminBranches } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import { fetchAutopilotoConfig, fetchSolicitudes, fetchTiempoPrometido, registrarTicketImpreso } from "../lib/autopiloto-client.ts";
import type { AutopilotoConfigRespuesta, MotivoCancelacion, SolicitudesRespuesta, TiempoPrometido } from "../lib/autopiloto-client.ts";
import { assignRepartidor, etiquetaFolio, fetchOrders, fetchRepartidorSugerido, fetchScheduledOrders, updateOrderStatus } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary, RepartidorSugerido } from "../lib/orders-client.ts";
import { guardarSonido, idsNuevos, leerSonido, etiquetaActualizado, reproducirAviso, SONDEO_BASE_MS } from "../lib/sondeo-pedidos.ts";
import { useSondeoPedidos } from "../lib/use-sondeo-pedidos.ts";
import { ProgramadosPanel, sigueProgramado } from "./ProgramadosPanel.tsx";
import { AprobacionesPanel } from "./AprobacionesPanel.tsx";
import { AutopilotoReglasDialogo } from "../components/AutopilotoReglasDialogo.tsx";
import { HistorialPedidoDialogo } from "../components/HistorialPedidoDialogo.tsx";
import { MotivoDialogo } from "../components/MotivoDialogo.tsx";
import { FilaPedido } from "../components/pedidos/FilaPedido.tsx";
import { HerramientasPedidos } from "../components/pedidos/HerramientasPedidos.tsx";
import { IncidenciaDialogo } from "../components/pedidos/IncidenciaDialogo.tsx";
import { MapaEntrega } from "../components/pedidos/MapaEntrega.tsx";
import { PedidoDetalle } from "../components/pedidos/PedidoDetalle.tsx";
import { fetchEstadosComandaPorPedido } from "../lib/pos-comandas-client.ts";
import type { EstadoComandaWire } from "../lib/pos-comandas-client.ts";
import { fetchRepartidores } from "../lib/staff-client.ts";
import type { RepartidorMember } from "../lib/staff-client.ts";
import { clavePrefsTicketCocina, conCandadoDeImpresion, guardarPrefs, leerPrefs, liberarReclamo, PREFS_VACIAS, marcarImpresos, reclamarImpresion, registrarReimpresion, storageDisponible } from "../lib/ticket-cocina-prefs.ts";
import type { PrefsTicketCocina } from "../lib/ticket-cocina-prefs.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

/** Las tres pildoras del tablero (repo suelto). */
type Vista = "recibidas" | "enviadas" | "programadas";
/** Filtro de estado dentro de «Ordenes recibidas» (chips): conserva los estados reales que el original no tiene. */
type FiltroRecibidas = "todos" | "por_aprobar" | "pending" | "preparando" | "listo_para_recoger" | "no_recogido" | "problema";
/** Lo que se pide al servidor: un estado, la union de las recibidas, la lista de programados o la bandeja de aprobaciones. */
type PestanaPedidos = OrderStatus | "todos" | "programados";

/** Estados que siguen «en el restaurante» (todas las recibidas). */
const RECIBIDAS_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "listo_para_recoger", "no_recogido", "problema"];

const VISTAS: readonly { readonly id: Vista; readonly etiqueta: string; readonly icono: typeof Package }[] = [
  { id: "recibidas", etiqueta: "Órdenes recibidas", icono: Package },
  { id: "enviadas", etiqueta: "Órdenes enviadas", icono: Truck },
  { id: "programadas", etiqueta: "Órdenes programadas", icono: CalendarClock },
];

const CHIPS_RECIBIDAS: readonly { readonly id: FiltroRecibidas; readonly etiqueta: string }[] = [
  { id: "todos", etiqueta: "Todos" },
  { id: "por_aprobar", etiqueta: "Por aprobar" },
  { id: "pending", etiqueta: "Recibido" },
  { id: "preparando", etiqueta: "Preparando" },
  { id: "listo_para_recoger", etiqueta: "Listo para recoger" },
  { id: "no_recogido", etiqueta: "No recogido" },
  { id: "problema", etiqueta: "Incidencia" },
];

/** Minutos que se le dan a una entrega al confirmar el envio (igual que el original). */
const MINUTOS_ENTREGA_ESTIMADA = 35;
/** Cada cuanto se consulta la lista de programados (la consulta promueve al servidor los que ya les toca). */
const PROGRAMADOS_REVISION_MS = 60_000;

/** Cada cuánto consulta el panel los pedidos nuevos para la auto-impresión de cocina. */
const AUTO_IMPRESION_INTERVALO_MS = 20_000;

function storageLocal(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function PedidosPage({ apiBaseUrl, token, propertyId, orgSlug, role }: RestaurantesShellContext) {
  const [vista, setVista] = useState<Vista>("recibidas");
  const [filtro, setFiltro] = useState<FiltroRecibidas>("todos");
  // Lo que se consulta segun la pildora y el chip activos.
  const status: PestanaPedidos | "por_aprobar" = vista === "enviadas" ? "en_camino" : vista === "programadas" ? "programados" : filtro;
  const [orders, setOrders] = useState<readonly OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  // Sucursales con lat/lng reales para el mapa (un fallo solo deja el mapa en su estado vacio: nunca tumba la lista).
  const [branches, setBranches] = useState<readonly BranchDetail[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  // Detalle a pagina completa (como el original: estado local, «Volver» regresa a la lista).
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [incidencia, setIncidencia] = useState<OrderSummary | null>(null);
  const [errorIncidencia, setErrorIncidencia] = useState<string | null>(null);
  const ultimoRevisionProgramados = useRef(0);
  // R-11: pestana Programados + tiempo real (sondeo). `programadosDisponible=false` = base sin la migracion 034.
  const [programados, setProgramados] = useState<readonly OrderSummary[] | null>(null);
  const [programadosDisponible, setProgramadosDisponible] = useState(true);
  // Autopiloto (migracion 050): pestana "Por aprobar" (pedido grande, cancelacion pedida por el cliente, quejas con compensacion) y reglas por sucursal.
  const [aprobaciones, setAprobaciones] = useState<SolicitudesRespuesta | null>(null);
  const [autoConfig, setAutoConfig] = useState<AutopilotoConfigRespuesta | null>(null);
  // QA-restaurantes-R2-botones-02: si la carga de las reglas falla, el dialogo muestra el error con Reintentar en vez de 'Cargando reglas…' eterno.
  const [autoConfigError, setAutoConfigError] = useState<string | null>(null);
  const [reglasAbiertas, setReglasAbiertas] = useState(false);
  // Historial de transiciones del pedido (A-03): quien lo movio, cuando y por que.
  const [historialDe, setHistorialDe] = useState<OrderSummary | null>(null);
  // Tiempo prometido hoy por canal (aprendido de las entregas de la franja, nunca menos que el piso del dueno). Un fallo solo oculta la linea.
  const [tiempos, setTiempos] = useState<{ readonly domicilio: TiempoPrometido; readonly recoger: TiempoPrometido } | null>(null);
  // Cancelar un pedido exige un motivo de la lista cerrada (taxonomia de cancelacion): el dialogo guarda el pedido a cancelar.
  const [cancelando, setCancelando] = useState<OrderSummary | null>(null);
  const [errorCancelar, setErrorCancelar] = useState<string | null>(null);
  const [sonido, setSonido] = useState<boolean>(() => leerSonido(storageLocal(), orgSlug, propertyId));
  // R-16: la preferencia de la persona (Avisos) manda sobre la casilla local: con el aviso de pedido nuevo o su sonido apagados no suena.
  // Sin respuesta (base sin migrar, error de red) conserva el comportamiento de siempre.
  const [sonidoPermitido, setSonidoPermitido] = useState<boolean>(true);
  const [nuevosAviso, setNuevosAviso] = useState<number>(0);
  const [ahoraMs, setAhoraMs] = useState<number>(() => Date.now());
  const pendientesVistos = useRef<ReadonlySet<string> | null>(null);
  // Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
  // no tiene UI"): lista de repartidores REALES de la organización (ver
  // admin-staff.ts::GET .../admin/staff/repartidores) para poblar el selector de abajo.
  // Estado separado de `orders`/`error` a propósito: si este fetch falla, el selector
  // simplemente no aparece -- nunca debe tumbar la lista de pedidos, que es la función
  // principal de esta página.
  const [repartidores, setRepartidores] = useState<readonly RepartidorMember[] | null>(null);
  const [repartidoresError, setRepartidoresError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  // Autopiloto (semiautomatico): repartidor SUGERIDO por el servidor para los pedidos a domicilio en preparando sin repartidor.
  // Solo sugiere: asignar es un clic del gerente (el mismo PATCH assign-repartidor). Si el fetch falla no se muestra nada.
  const [sugeridos, setSugeridos] = useState<Readonly<Record<string, RepartidorSugerido>>>({});
  // Estado de la comanda al POS de cada pedido de la lista (lectura liviana, solo ids). Sin respuesta (base sin migrar, error de red) no se pinta
  // ninguna insignia: nunca bloquea ni tumba la lista de pedidos.
  const [comandaEstados, setComandaEstados] = useState<Readonly<Record<string, EstadoComandaWire>>>({});
  // Insignia "En POS" / "Capturar a mano" / "Falló": se consulta cada vez que cambia el conjunto de pedidos visibles.
  const idsVisibles = orders ? [...new Set(orders.map((o) => o.id))].join(",") : "";
  useEffect(() => {
    if (idsVisibles === "") {
      setComandaEstados({});
      return;
    }
    let cancelado = false;
    fetchEstadosComandaPorPedido(fetch, apiBaseUrl, token, propertyId, idsVisibles.split(","))
      .then((r) => !cancelado && setComandaEstados(r.disponible ? r.estados : {}))
      .catch(() => !cancelado && setComandaEstados({}));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, idsVisibles]);
  // Aviso OPCIONAL por WhatsApp al marcar "listo para recoger" (por defecto sí avisa; el staff puede apagarlo
  // por pedido, p. ej. si el cliente ya está en mostrador).
  const [sinAvisoPorPedido, setSinAvisoPorPedido] = useState<ReadonlySet<string>>(new Set());

  // PM PR-7 -- ticket de cocina imprimible. El estado de impresión (auto-impresión por
  // sucursal, pedidos ya impresos, reimpresiones) vive en el navegador que imprime; no
  // hay cola en el servidor (ver lib/ticket-cocina-prefs.ts).
  const [prefs, setPrefs] = useState<PrefsTicketCocina>(() => {
    const st = storageLocal();
    return st ? leerPrefs(st, orgSlug, propertyId) : PREFS_VACIAS;
  });
  const prefsRef = useRef(prefs);
  const [vistaPrevia, setVistaPrevia] = useState<{ ticket: TicketCocina; orderId: string } | null>(null);
  const [avisoImpresion, setAvisoImpresion] = useState<string | null>(null);
  const autoEnCurso = useRef(false);
  // `load` cambia con el filtro de estado; el ciclo de auto-impresión debe refrescar
  // siempre con el filtro vigente, no con el del momento en que se activó.
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  // Generacion de la carga vigente (QA-restaurantes-R1-botones-01): una respuesta vieja (p. ej. la lenta de "Todos" tras
  // elegir "Preparando") se descarta en vez de pisar la lista de la pestana actual.
  const cargaGenRef = useRef(0);

  function actualizarPrefs(next: PrefsTicketCocina): void {
    prefsRef.current = next;
    setPrefs(next);
    const st = storageLocal();
    if (st) guardarPrefs(st, orgSlug, propertyId, next);
  }

  // Al cambiar de sucursal u organización se recargan las preferencias de ESA sucursal.
  useEffect(() => {
    const st = storageLocal();
    const cargadas = st ? leerPrefs(st, orgSlug, propertyId) : prefsRef.current;
    prefsRef.current = cargadas;
    setPrefs(cargadas);
  }, [orgSlug, propertyId]);

  // Las preferencias de impresion viven en localStorage y las comparten todas las pestanas del equipo: antes de
  // decidir/escribir se re-leen (QA-restaurantes-R1-caos-18) para no pisar lo que otra pestana ya marco.
  function prefsActuales(): PrefsTicketCocina {
    const st = storageLocal();
    return st ? leerPrefs(st, orgSlug, propertyId) : prefsRef.current;
  }

  // Otra pestana cambio las preferencias (auto-impresion, pedidos ya impresos): la copia en memoria las sigue.
  useEffect(() => {
    const clave = clavePrefsTicketCocina(orgSlug, propertyId);
    function alCambiarStorage(e: StorageEvent): void {
      if (e.key !== clave) return;
      const st = storageLocal();
      if (!st) return;
      const cargadas = leerPrefs(st, orgSlug, propertyId);
      prefsRef.current = cargadas;
      setPrefs(cargadas);
    }
    window.addEventListener("storage", alCambiarStorage);
    return () => window.removeEventListener("storage", alCambiarStorage);
  }, [orgSlug, propertyId]);

  // Sin POS, imprimir el ticket es lo que habilita la aceptacion automatica (QA R2 features-05): se avisa al servidor de cada pedido PENDIENTE impreso.
  // Es de mejor esfuerzo: si falla, el ticket ya salio y el pedido sigue pendiente (se acepta a mano); se dice, no se calla.
  async function avisarTicketsImpresos(pedidos: readonly OrderSummary[]): Promise<void> {
    const pendientes = pedidos.filter((o) => o.status === "pending");
    const resultados = await Promise.allSettled(pendientes.map((o) => registrarTicketImpreso(fetch, apiBaseUrl, token, propertyId, o.id)));
    if (resultados.some((r) => r.status === "rejected")) {
      setAvisoImpresion("El ticket salió, pero no se pudo avisar al sistema: la aceptación automática no se activará para ese pedido; acéptelo a mano.");
    }
  }

  function imprimirPedido(order: OrderSummary): void {
    const base = prefsActuales();
    const yaImpreso = base.impresos.includes(order.id);
    const reimpresion = yaImpreso ? (base.reimpresiones[order.id] ?? 0) + 1 : 0;
    const ok = imprimirTicketsCocina([construirTicketCocina(order, { reimpresion })]);
    if (!ok) {
      setAvisoImpresion("Este navegador no pudo abrir la impresión.");
      return;
    }
    setAvisoImpresion(null);
    actualizarPrefs(yaImpreso ? registrarReimpresion(base, order.id) : marcarImpresos(base, [order.id]));
    void avisarTicketsImpresos([order]);
  }

  async function activarAutoImpresion(): Promise<void> {
    const st = storageLocal();
    if (!st || !storageDisponible(st)) {
      setAvisoImpresion("La auto-impresión necesita guardar datos en este navegador y no está disponible.");
      return;
    }
    try {
      // Solo esta sucursal (branchId): sin él el API devuelve todo el alcance de la membresía.
      // Línea base: lo que ya está pendiente NO se imprime solo (evita vomitar el rezago).
      const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: "pending", limit: 50, branchId: propertyId });
      actualizarPrefs({ ...marcarImpresos(prefsActuales(), page.orders.map((o) => o.id)), autoImprimir: true });
      setAvisoImpresion(null);
    } catch (err) {
      setAvisoImpresion(err instanceof Error ? err.message : "No se pudo activar la auto-impresión.");
    }
  }

  function desactivarAutoImpresion(): void {
    actualizarPrefs({ ...prefsActuales(), autoImprimir: false });
  }

  // Polling del panel como "cola de impresión": solo mientras esta pantalla está abierta
  // y la auto-impresión está activa en esta sucursal.
  useEffect(() => {
    if (!prefs.autoImprimir) return;
    let cancelado = false;
    async function ciclo() {
      if (autoEnCurso.current) return;
      autoEnCurso.current = true;
      try {
        const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: "pending", limit: 50, branchId: propertyId });
        if (cancelado) return;
        const st = storageLocal();
        // Reclamo entre pestanas: solo se imprimen los pedidos que NINGUNA pestana del equipo habia marcado ya.
        const candidatos = pedidosPorImprimir(page.orders, new Set(prefsActuales().impresos));
        if (candidatos.length === 0) return;
        const reclamados = st
          ? new Set(await conCandadoDeImpresion(orgSlug, propertyId, () => reclamarImpresion(st, orgSlug, propertyId, candidatos.map((o) => o.id))))
          : new Set(candidatos.map((o) => o.id));
        if (cancelado) {
          if (st && reclamados.size > 0) liberarReclamo(st, orgSlug, propertyId, [...reclamados]);
          return;
        }
        const nuevos = candidatos.filter((o) => reclamados.has(o.id));
        if (st) {
          const frescas = leerPrefs(st, orgSlug, propertyId);
          prefsRef.current = frescas;
          setPrefs(frescas);
        }
        if (nuevos.length === 0) return;
        if (imprimirTicketsCocina(nuevos.map((o) => construirTicketCocina(o)))) {
          if (!st) actualizarPrefs(marcarImpresos(prefsRef.current, nuevos.map((o) => o.id)));
          setAvisoImpresion(null);
          await avisarTicketsImpresos(nuevos);
          void loadRef.current();
        } else {
          if (st) {
            liberarReclamo(st, orgSlug, propertyId, nuevos.map((o) => o.id));
            const frescas = leerPrefs(st, orgSlug, propertyId);
            prefsRef.current = frescas;
            setPrefs(frescas);
          }
          setAvisoImpresion("Este navegador no pudo abrir la impresión automática.");
        }
      } catch (err) {
        if (!cancelado) setAvisoImpresion(`Auto-impresión sin conexión: ${err instanceof Error ? err.message : "error al consultar pedidos"}`);
      } finally {
        autoEnCurso.current = false;
      }
    }
    const id = window.setInterval(() => void ciclo(), AUTO_IMPRESION_INTERVALO_MS);
    return () => {
      cancelado = true;
      window.clearInterval(id);
    };
  }, [prefs.autoImprimir, apiBaseUrl, token, propertyId, orgSlug]);

  /** Aprobaciones pendientes de la sucursal (tambien alimentan la insignia de la pestana). Un fallo nunca tumba la lista de pedidos. */
  async function loadAprobaciones() {
    try {
      const r = await fetchSolicitudes(fetch, apiBaseUrl, token, propertyId, "pendiente");
      // Una respuesta que no tiene la forma esperada (despliegue viejo) se trata como "no disponible", nunca rompe la pantalla.
      setAprobaciones(r && Array.isArray(r.solicitudes) ? r : { disponible: false, solicitudes: [] });
    } catch {
      setAprobaciones((previa) => previa ?? { disponible: false, solicitudes: [] });
    }
  }

  async function loadTiempos() {
    try {
      const [domicilio, recoger] = await Promise.all([
        fetchTiempoPrometido(fetch, apiBaseUrl, token, propertyId, "domicilio"),
        fetchTiempoPrometido(fetch, apiBaseUrl, token, propertyId, "recoger"),
      ]);
      setTiempos(domicilio?.texto && recoger?.texto ? { domicilio, recoger } : null);
    } catch {
      setTiempos(null);
    }
  }

  async function loadAutoConfig() {
    setAutoConfigError(null);
    try {
      const r = await fetchAutopilotoConfig(fetch, apiBaseUrl, token, propertyId);
      const valida = r?.config && Array.isArray(r.plantillas);
      setAutoConfig(valida ? r : null);
      if (!valida) setAutoConfigError("No se pudieron cargar las reglas del autopiloto.");
    } catch (err) {
      setAutoConfig(null);
      setAutoConfigError(err instanceof Error ? err.message : "No se pudieron cargar las reglas del autopiloto.");
    }
  }

  async function load() {
    const gen = ++cargaGenRef.current;
    setError(null);
    void loadAprobaciones();
    try {
      if (status === "por_aprobar") {
        // La lista de aprobaciones ya se pidio arriba; no hay lista de pedidos en esta pestana.
        setOrders([]);
      } else if (status === "programados") {
        const page = await fetchScheduledOrders(fetch, apiBaseUrl, token, propertyId, { limit: 100 });
        if (gen !== cargaGenRef.current) return;
        setProgramadosDisponible(page.disponible);
        setProgramados(page.orders);
      } else if (status === "todos") {
        const pages = await Promise.all(RECIBIDAS_STATUSES.map((s) => fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: s, limit: 50 })));
        if (gen !== cargaGenRef.current) return;
        const merged = pages.flatMap((p) => p.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setOrders(merged);
        fijarLineaBase(pages[RECIBIDAS_STATUSES.indexOf("pending")]?.orders ?? []);
      } else {
        const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, { status, limit: 50 });
        if (gen !== cargaGenRef.current) return;
        setOrders(page.orders);
        if (status === "pending") fijarLineaBase(page.orders);
      }
    } catch (err) {
      if (gen === cargaGenRef.current) setError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos.");
    }
  }

  // QA-restaurantes-R1-botones-02: la linea base de "pedidos ya vistos" parte de la lista que la pantalla YA cargo (lo que la
  // persona ya ve), no del primer sondeo: un pedido que entra entre la carga y el primer sondeo cuenta como nuevo (suena, sube
  // el contador y repinta la lista) en vez de quedar absorbido en silencio.
  function fijarLineaBase(pendientes: readonly OrderSummary[]): void {
    if (pendientesVistos.current === null) pendientesVistos.current = new Set(pendientes.map((o) => o.id));
  }

  loadRef.current = load;

  useEffect(() => {
    // QA-restaurantes-R2-botones-01: al cambiar de pestana o de sucursal se limpia la lista anterior; mientras carga se ve 'Cargando' y, si la
    // carga falla, solo el EstadoError (nunca tarjetas de otra pestana con sus botones activos).
    setOrders(null);
    setProgramados(null);
    void load();
  }, [apiBaseUrl, token, propertyId, status]);

  useEffect(() => {
    void loadAutoConfig();
    void loadTiempos();
  }, [apiBaseUrl, token, propertyId]);

  // Al cambiar de sucursal u organizacion se recarga la preferencia de sonido y se reinicia la linea base de
  // "pedidos ya vistos" (el primer sondeo no suena por el rezago).
  useEffect(() => {
    setSonido(leerSonido(storageLocal(), orgSlug, propertyId));
    pendientesVistos.current = null;
    setNuevosAviso(0);
  }, [orgSlug, propertyId]);

  // La preferencia se lee al montar y de nuevo cuando la pestana vuelve a estar visible: si owner/admin cambia el sonido de
  // esta persona desde Avisos, la pantalla de Pedidos lo recoge al volver a ella (sin recargar).
  useEffect(() => {
    let cancelado = false;
    const cargar = () => {
      fetchAvisos(fetch, apiBaseUrl, token, propertyId)
        .then((a) => {
          if (!cancelado) setSonidoPermitido(sonidoPedidoNuevoPermitido(a));
        })
        .catch(() => {
          if (!cancelado) setSonidoPermitido(true);
        });
    };
    const alVolver = () => {
      if (document.visibilityState === "visible") cargar();
    };
    cargar();
    document.addEventListener("visibilitychange", alVolver);
    return () => {
      cancelado = true;
      document.removeEventListener("visibilitychange", alVolver);
    };
  }, [apiBaseUrl, token, propertyId]);

  // R-11 -- tiempo real por sondeo con backoff y pausa con la pestana oculta (ver lib/sondeo-pedidos.ts). Cada
  // consulta pide SOLO los pendientes (una peticion liviana; el servidor ademas promueve los programados
  // vencidos); la lista completa se recarga unicamente si aparecio un pedido nuevo o cambio el conjunto.
  const sondeo = useSondeoPedidos({
    clave: `${apiBaseUrl}|${propertyId}|${status}`,
    activo: true,
    baseMs: SONDEO_BASE_MS,
    consulta: async () => {
      const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: "pending", limit: 50 });
      const ids = page.orders.map((o) => o.id);
      const previos = pendientesVistos.current;
      const nuevos = idsNuevos(previos, ids);
      const cambio = previos !== null && (nuevos.length > 0 || previos.size !== ids.length);
      pendientesVistos.current = new Set(ids);
      setAhoraMs(Date.now());
      if (nuevos.length > 0) {
        setNuevosAviso((n) => n + nuevos.length);
        if (sonido && sonidoPermitido) reproducirAviso();
      }
      void loadAprobaciones();
      // La consulta de programados la promueve el servidor (los que ya les toca entrar a cocina pasan a «Recibido»): se revisa cada minuto
      // en cualquier pildora, como el original, y si promovio alguno se recarga la lista.
      let promovio = false;
      if (status !== "programados" && Date.now() - ultimoRevisionProgramados.current >= PROGRAMADOS_REVISION_MS) {
        ultimoRevisionProgramados.current = Date.now();
        try {
          const sp = await fetchScheduledOrders(fetch, apiBaseUrl, token, propertyId, { limit: 100 });
          setProgramadosDisponible(sp.disponible);
          setProgramados(sp.orders);
          promovio = sp.promovidos.length > 0;
        } catch {
          // Mejor esfuerzo: un fallo aqui nunca tumba el sondeo de los pendientes.
        }
      }
      if (cambio || promovio || status === "programados") await loadRef.current();
    },
  });

  async function loadRepartidores() {
    setRepartidoresError(null);
    try {
      setRepartidores(await fetchRepartidores(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setRepartidores(null);
      setRepartidoresError(err instanceof Error ? err.message : "No se pudieron cargar los repartidores.");
    }
  }

  useEffect(() => {
    void loadRepartidores();
  }, [apiBaseUrl, token, propertyId]);

  // Ubicacion REAL de las sucursales (lat/lng) para el mapa «Entrega en curso». Sin respuesta, el mapa muestra su estado vacio.
  useEffect(() => {
    let cancelado = false;
    fetchAdminBranches(fetch, apiBaseUrl, token, propertyId)
      .then((b) => !cancelado && setBranches(b))
      .catch(() => !cancelado && setBranches([]));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  // Pide las sugerencias de los pedidos visibles que las admiten (a domicilio, preparando, sin repartidor) cada vez que cambia la lista.
  useEffect(() => {
    const ids = (orders ?? []).filter((o) => o.status === "preparando" && o.canal !== "recoger" && !o.assignedRepartidorId).map((o) => o.id);
    if (ids.length === 0) {
      setSugeridos({});
      return;
    }
    let cancelado = false;
    fetchRepartidorSugerido(fetch, apiBaseUrl, token, propertyId, ids.slice(0, 30))
      .then((r) => {
        if (!cancelado) setSugeridos(r);
      })
      .catch(() => {
        if (!cancelado) setSugeridos({});
      });
    return () => {
      cancelado = true;
    };
  }, [orders, apiBaseUrl, token, propertyId]);

  async function aplicarCambioEstado(order: OrderSummary, nextStatus: OrderStatus, extra: { readonly motivo?: MotivoCancelacion; readonly incidentNote?: string } = {}): Promise<boolean> {
    setChangingId(order.id);
    setError(null);
    try {
      const sinAviso = nextStatus === "listo_para_recoger" && sinAvisoPorPedido.has(order.id);
      await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, nextStatus, {
        ...(sinAviso ? { notifyCustomer: false } : {}),
        ...(extra.motivo ? { motivo: extra.motivo } : {}),
        ...(extra.incidentNote !== undefined ? { incidentNote: extra.incidentNote } : {}),
      });
      await load();
      return true;
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "No se pudo cambiar el estado del pedido.";
      setError(mensaje);
      if (extra.motivo) setErrorCancelar(mensaje);
      if (extra.incidentNote !== undefined) setErrorIncidencia(mensaje);
      return false;
    } finally {
      setChangingId(null);
    }
  }

  // "cancelado" es el unico estado terminal negativo (se pierde el pedido): nunca se cancela de un clic. El servidor exige un motivo de la lista
  // cerrada, asi que el dialogo («¿Cancelar este pedido?») lo pide y solo al confirmar se llama al API.
  async function handleChangeStatus(order: OrderSummary, nextStatus: OrderStatus) {
    if (nextStatus === "cancelado") {
      setErrorCancelar(null);
      setCancelando(order);
      return;
    }
    const ok = await aplicarCambioEstado(order, nextStatus);
    if (ok && nextStatus === "entregado") notify.success(`Pedido entregado — ${etiquetaFolio(order)} se marcó como entregado.`);
  }

  // «Confirmar envío» (repo suelto): asigna al repartidor Y manda el pedido a reparto. Respeta la maquina de estados real: solo un pedido en
  // `preparando` sale «en camino» (primero pasa por cocina); en `pending` solo se asigna el repartidor y el envio se confirma despues.
  async function handleDespachar(order: OrderSummary, repartidorId: string): Promise<boolean> {
    if (!repartidorId) return false;
    setAssigningId(order.id);
    setError(null);
    try {
      const sale = order.status === "preparando";
      const estimada = sale ? new Date(Date.now() + MINUTOS_ENTREGA_ESTIMADA * 60_000).toISOString() : undefined;
      await assignRepartidor(fetch, apiBaseUrl, token, propertyId, order.id, repartidorId, estimada);
      if (sale) await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, "en_camino");
      if (sale) {
        notify.success(`Pedido enviado — ${etiquetaFolio(order)} pasó a Enviadas.`);
        setVista("enviadas");
        setSelectedOrderId(order.id);
      } else {
        notify.success(`Repartidor asignado — ${etiquetaFolio(order)}. Márcalo como Preparando para poder enviarlo.`);
      }
      await load();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo despachar el pedido.");
      // El repartidor ya pudo quedar asignado aunque el cambio de estado fallara: se recarga para no mostrar un estado viejo.
      void load();
      return false;
    } finally {
      setAssigningId(null);
    }
  }

  function abrirDetalle(order: OrderSummary): void {
    setSelectedOrderId(order.id);
    setDetalleId(order.id);
  }

  // ---- Derivados de la vista ----
  const listaVisible: readonly OrderSummary[] = vista === "programadas" ? (programados ?? []).filter((o) => sigueProgramado(o, ahoraMs)) : (orders ?? []);
  const conteo = status === "por_aprobar" ? (aprobaciones?.solicitudes.length ?? 0) : listaVisible.length;
  const seleccionado = listaVisible.find((o) => o.id === selectedOrderId) ?? listaVisible[0] ?? null;
  const sucursalDe = (o: OrderSummary | null) => {
    const b = o ? branches.find((x) => x.propertyId === o.propertyId) : undefined;
    return b ? { nombre: b.name, lat: b.lat, lng: b.lng } : null;
  };
  const repartidorDe = (o: OrderSummary | null): string | null => {
    const r = o?.assignedRepartidorId ? repartidores?.find((x) => x.id === o.assignedRepartidorId) : undefined;
    return r ? r.fullName || r.email : null;
  };
  const cargandoLista = vista === "programadas" ? programados === null : orders === null;
  const porAprobar = aprobaciones?.solicitudes.length ?? 0;
  const textoTiempos = tiempos
    ? `Tiempo prometido hoy: domicilio ${tiempos.domicilio.texto}; recoger ${tiempos.recoger.texto}${
        tiempos.domicilio.origen === "aprendido" || tiempos.recoger.origen === "aprendido" ? " (aprendido de las entregas recientes; nunca menos que el tiempo que fijó el dueño)" : " (el tiempo que fijó el dueño; aún no hay entregas suficientes para aprender)"
      }${tiempos.domicilio.saturacion !== "normal" || tiempos.recoger.saturacion !== "normal" ? ". Hay alta carga: se está alargando el tiempo prometido." : "."}`
    : null;
  const estadoActualizacion = sondeo.pausado
    ? "En pausa (pestaña oculta)"
    : sondeo.fallosSeguidos > 0
      ? `Sin conexión: reintentando en ${Math.round(sondeo.proximoEnMs / 1000)} s`
      : `${etiquetaActualizado(sondeo.ultimaActualizacion, ahoraMs)} · cada ${SONDEO_BASE_MS / 1000} s`;
  const vacioTexto = vista === "enviadas" ? "No hay pedidos en camino" : filtro === "todos" ? "No hay pedidos por despachar" : "No hay pedidos en este filtro";
  const IconoVacio = vista === "enviadas" ? Truck : Package;

  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina lo pinta la barra superior del shell (contrato de pagina UNI-4): el h1 queda solo para lectores de pantalla. */}
      <h1 className="sr-only">Pedidos en operación</h1>

      {detalleId ? (
        <PedidoDetalle
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          orderId={detalleId}
          repartidores={repartidores}
          onVolver={() => setDetalleId(null)}
          onSelect={setDetalleId}
          onHistorial={setHistorialDe}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="font-mono text-eyebrow tabular-nums text-muted-foreground" data-testid="total-pedidos">
                {conteo} en total
              </p>
              <HerramientasPedidos
                estadoActualizacion={estadoActualizacion}
                consultando={sondeo.consultando}
                onActualizar={() => sondeo.refrescar()}
                nuevos={nuevosAviso}
                sonido={sonido}
                sonidoPermitido={sonidoPermitido}
                onSonido={(activo) => {
                  setSonido(activo);
                  guardarSonido(storageLocal(), orgSlug, propertyId, activo);
                  if (activo) reproducirAviso();
                }}
                autoImprimir={prefs.autoImprimir}
                onAutoImprimir={(activo) => (activo ? void activarAutoImpresion() : desactivarAutoImpresion())}
                intervaloAutoImpresionS={AUTO_IMPRESION_INTERVALO_MS / 1000}
                onReglas={role === "owner" || role === "admin" ? () => setReglasAbiertas(true) : null}
                tiempoPrometido={textoTiempos}
              />
            </div>
            <div role="tablist" aria-label="Vista de pedidos" className="inline-flex w-full items-center gap-1 rounded-full border border-border bg-muted/40 p-1 sm:w-auto">
              {VISTAS.map(({ id, etiqueta, icono: Icono }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={vista === id}
                  onClick={() => setVista(id)}
                  className={cn(
                    "inline-flex flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1.5 text-center text-2xs font-medium leading-tight transition-colors sm:flex-none sm:flex-row sm:gap-1.5 sm:px-3 sm:text-pill",
                    vista === id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icono className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  {etiqueta}
                </button>
              ))}
            </div>
          </div>

          {vista === "recibidas" && (
            <div role="group" aria-label="Filtrar por estado" className="flex flex-wrap items-center gap-1.5">
              {CHIPS_RECIBIDAS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={filtro === c.id}
                  onClick={() => setFiltro(c.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-eyebrow font-medium transition-colors",
                    filtro === c.id ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {c.etiqueta}
                  {c.id === "por_aprobar" && porAprobar > 0 && (
                    <StatusBadge tone="warning" dot={false} className="px-1.5 py-0 text-2xs" data-testid="insignia-por-aprobar">
                      {porAprobar}
                    </StatusBadge>
                  )}
                </button>
              ))}
            </div>
          )}

          {avisoImpresion && (
            <p role="alert" className="m-0 text-xs text-destructive">
              {avisoImpresion}
            </p>
          )}
          {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
          {repartidoresError && (
            <p role="alert" className="m-0 text-xs text-destructive">
              No se pudo cargar la lista de repartidores: {repartidoresError}
            </p>
          )}

          {status === "por_aprobar" ? (
            <AprobacionesPanel
              datos={aprobaciones}
              ahoraMs={ahoraMs}
              apiBaseUrl={apiBaseUrl}
              token={token}
              propertyId={propertyId}
              topeDescuentoPct={autoConfig?.config.compensacionTopePct ?? 20}
              onResuelta={async () => {
                await loadAprobaciones();
                await loadRef.current();
              }}
            />
          ) : cargandoLista ? (
            !error && (
              <div role="status" aria-busy="true" className="flex items-center justify-center rounded-2xl border border-border bg-card p-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
                <span className="sr-only">{vista === "programadas" ? "Cargando pedidos programados…" : "Cargando pedidos…"}</span>
              </div>
            )
          ) : vista === "programadas" ? (
            <ProgramadosPanel
              orders={programados ?? []}
              disponible={programadosDisponible}
              ahoraMs={ahoraMs}
              changingId={changingId}
              onAbrir={abrirDetalle}
              onAdelantar={(o) => void handleChangeStatus(o, "pending")}
              onCancelar={(o) => void handleChangeStatus(o, "cancelado")}
            />
          ) : (
            <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
              <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
                {listaVisible.length === 0 ? (
                  <div role="status" className="py-12 text-center">
                    <IconoVacio className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} aria-hidden="true" />
                    <p className="text-ui text-muted-foreground">{vacioTexto}</p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-border">
                    {listaVisible.map((o) => (
                      <FilaPedido
                        key={o.id}
                        order={o}
                        vista={vista === "enviadas" ? "enviadas" : "recibidas"}
                        seleccionado={seleccionado?.id === o.id}
                        ahoraMs={ahoraMs}
                        orgSlug={orgSlug}
                        repartidores={repartidores}
                        sugerido={sugeridos[o.id]}
                        comandaEstado={comandaEstados[o.id]}
                        impreso={prefs.impresos.includes(o.id)}
                        ocupado={changingId === o.id || assigningId === o.id}
                        sinAviso={sinAvisoPorPedido.has(o.id)}
                        onSinAviso={(sin) =>
                          setSinAvisoPorPedido((prev) => {
                            const next = new Set(prev);
                            if (sin) next.add(o.id);
                            else next.delete(o.id);
                            return next;
                          })
                        }
                        onAbrir={abrirDetalle}
                        onMarcar={(order, st) => void handleChangeStatus(order, st)}
                        onIncidencia={(order) => {
                          setErrorIncidencia(null);
                          setIncidencia(order);
                        }}
                        onCancelar={(order) => void handleChangeStatus(order, "cancelado")}
                        onDespachar={handleDespachar}
                        onImprimir={imprimirPedido}
                        onVistaPrevia={(order) => setVistaPrevia({ ticket: construirTicketCocina(order, { reimpresion: prefs.impresos.includes(order.id) ? (prefs.reimpresiones[order.id] ?? 0) + 1 : 0 }), orderId: order.id })}
                        onHistorial={setHistorialDe}
                      />
                    ))}
                  </div>
                )}
              </div>
              <MapaEntrega order={seleccionado} sucursal={sucursalDe(seleccionado)} repartidorNombre={repartidorDe(seleccionado)} />
            </div>
          )}
        </>
      )}

      <TicketCocinaDialog
        ticket={vistaPrevia?.ticket ?? null}
        onClose={() => setVistaPrevia(null)}
        etiquetaImprimir={vistaPrevia && prefs.impresos.includes(vistaPrevia.orderId) ? "Reimprimir" : "Imprimir"}
        onImprimir={() => {
          const o = orders?.find((x) => x.id === vistaPrevia?.orderId);
          if (o) imprimirPedido(o);
          setVistaPrevia(null);
        }}
      />

      <IncidenciaDialogo
        order={incidencia}
        enCurso={changingId !== null && changingId === incidencia?.id}
        error={errorIncidencia}
        onCerrar={() => setIncidencia(null)}
        onConfirmar={(order, nota) => {
          void aplicarCambioEstado(order, "problema", { incidentNote: nota }).then((ok) => {
            if (!ok) return;
            setIncidencia(null);
            notify.success(`Incidencia reportada — ${etiquetaFolio(order)} pasó a Incidencias.`);
          });
        }}
      />

      <MotivoDialogo
        open={cancelando !== null}
        onOpenChange={(o) => !o && setCancelando(null)}
        titulo="¿Cancelar este pedido?"
        subtitulo={cancelando ? `${etiquetaFolio(cancelando)} — ${cancelando.customerName} pasará a "Cancelado" y saldrá de Recibidos. Sigue visible en Historial. Se avisa al cliente y no se puede deshacer.` : undefined}
        textoConfirmar="Sí, cancelar pedido"
        tonoPeligro
        error={errorCancelar}
        enCurso={changingId !== null}
        onConfirmar={(motivo) => {
          if (!cancelando) return;
          void aplicarCambioEstado(cancelando, "cancelado", { motivo }).then((ok) => {
            if (!ok) return;
            notify.success(`Pedido cancelado — ${etiquetaFolio(cancelando)} se canceló.`);
            setCancelando(null);
          });
        }}
      />

      <HistorialPedidoDialogo
        orderId={historialDe?.id ?? null}
        titulo={historialDe ? `${historialDe.customerName} · ${etiquetaFolio(historialDe)}` : ""}
        onClose={() => setHistorialDe(null)}
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
      />

      <AutopilotoReglasDialogo
        open={reglasAbiertas}
        onOpenChange={setReglasAbiertas}
        datos={autoConfig}
        error={autoConfigError}
        onReintentar={loadAutoConfig}
        apiBaseUrl={apiBaseUrl}
        token={token}
        propertyId={propertyId}
        onGuardado={loadAutoConfig}
      />
    </PageContainer>
  );
}

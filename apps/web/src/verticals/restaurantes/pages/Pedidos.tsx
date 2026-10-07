// Pedidos en operación (Fase 5) — lista por estado + cambio de estado real vía la
// máquina de estados de order-lifecycle.ts (el servidor SIEMPRE re-valida la
// transición; los botones ofrecidos aquí son solo un espejo de NEXT_STATUSES para
// no mostrar una acción que el servidor rechazaría).
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Tabs` para el filtro por estado, `Card` por pedido,
// `Badge` para el estado, `Button` para cada transición y `useConfirm` para la
// confirmación de "cancelado" (antes un `window.confirm` del navegador y luego un
// `AlertDialog` local, ver el comentario de `handleChangeStatus`). El
// gate de confirmación, las transiciones ofrecidas y todas las llamadas al
// backend son EXACTAMENTE las mismas.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  Card,
  CardContent,
  Checkbox,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
  Tabs,
  TabsList,
  TabsTrigger,
  TicketCocinaDialog,
  construirTicketCocina,
  formatMoney,
  imprimirTicketsCocina,
  pedidosPorImprimir,
  statusTone,
} from "@atiende/ui";
import type { TicketCocina } from "@atiende/ui";
import { AlertTriangle, Clock, Printer, RefreshCw, SlidersHorizontal } from "lucide-react";
import { fetchAvisos, sonidoPedidoNuevoPermitido } from "../lib/avisos-client.ts";
import { fetchAutopilotoConfig, fetchSolicitudes, fetchTiempoPrometido } from "../lib/autopiloto-client.ts";
import type { AutopilotoConfigRespuesta, MotivoCancelacion, SolicitudesRespuesta, TiempoPrometido } from "../lib/autopiloto-client.ts";
import { assignRepartidor, fetchOrders, fetchRepartidorSugerido, fetchScheduledOrders, nextStatusesForCanal, ORDER_STATUS_LABELS, updateOrderStatus } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary, RepartidorSugerido } from "../lib/orders-client.ts";
import { guardarSonido, idsNuevos, leerSonido, etiquetaActualizado, reproducirAviso, SONDEO_BASE_MS } from "../lib/sondeo-pedidos.ts";
import { useSondeoPedidos } from "../lib/use-sondeo-pedidos.ts";
import { ProgramadosPanel } from "./ProgramadosPanel.tsx";
import { AprobacionesPanel } from "./AprobacionesPanel.tsx";
import { AutopilotoReglasDialogo } from "../components/AutopilotoReglasDialogo.tsx";
import { HistorialPedidoDialogo } from "../components/HistorialPedidoDialogo.tsx";
import { MotivoDialogo } from "../components/MotivoDialogo.tsx";
import { ETIQUETA_ESTADO_COMANDA, TONO_ESTADO_COMANDA, etiquetaInsigniaPedido, fetchEstadosComandaPorPedido } from "../lib/pos-comandas-client.ts";
import type { EstadoComandaWire } from "../lib/pos-comandas-client.ts";
import { fetchRepartidores } from "../lib/staff-client.ts";
import type { RepartidorMember } from "../lib/staff-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import { clavePrefsTicketCocina, conCandadoDeImpresion, guardarPrefs, leerPrefs, liberarReclamo, PREFS_VACIAS, marcarImpresos, reclamarImpresion, registrarReimpresion, storageDisponible } from "../lib/ticket-cocina-prefs.ts";
import type { PrefsTicketCocina } from "../lib/ticket-cocina-prefs.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

/** Pestana de pedidos programados (R-11): no es un estado de `orders.status` operativo, es su propia lista. */
type PestanaPedidos = OrderStatus | "todos" | "programados";

const OPERATIVE_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "listo_para_recoger", "no_recogido", "problema"];

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
  const [status, setStatus] = useState<PestanaPedidos>("todos");
  const [orders, setOrders] = useState<readonly OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
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
        const pages = await Promise.all(OPERATIVE_STATUSES.map((s) => fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: s, limit: 50 })));
        if (gen !== cargaGenRef.current) return;
        const merged = pages.flatMap((p) => p.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setOrders(merged);
        fijarLineaBase(pages[OPERATIVE_STATUSES.indexOf("pending")]?.orders ?? []);
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
      if (cambio || status === "programados") await loadRef.current();
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

  async function aplicarCambioEstado(order: OrderSummary, nextStatus: OrderStatus, motivo?: MotivoCancelacion): Promise<boolean> {
    setChangingId(order.id);
    setError(null);
    try {
      const sinAviso = nextStatus === "listo_para_recoger" && sinAvisoPorPedido.has(order.id);
      await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, nextStatus, { ...(sinAviso ? { notifyCustomer: false } : {}), ...(motivo ? { motivo } : {}) });
      await load();
      return true;
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : "No se pudo cambiar el estado del pedido.";
      setError(mensaje);
      if (motivo) setErrorCancelar(mensaje);
      return false;
    } finally {
      setChangingId(null);
    }
  }

  // Fase 12 — hallazgo de auditoría (severidad ALTA, "'Marcar cancelado' ejecuta con un
  // clic sin confirmación"): "cancelado" es el único estado terminal (NEXT_STATUSES lo
  // deja sin salidas, junto con "completado") que además es un desenlace NEGATIVO — se
  // pierde el pedido, nunca se puede reabrir desde aquí — mismo patrón de confirmación
  // real que citas/Agenda.tsx::runLifecycleAction usa para su acción "cancel". Las demás
  // transiciones (preparando/en_camino/entregado/problema, y "completado" mismo — el
  // desenlace ESPERADO del flujo feliz) no ganan nada con un confirm de más. El gate es
  // el MISMO de siempre; lo pinta `useConfirm` (Cancelar o Escape no llaman al API).
  async function handleChangeStatus(order: OrderSummary, nextStatus: OrderStatus) {
    if (nextStatus === "cancelado") {
      // Taxonomia cerrada: el servidor rechaza cancelar sin motivo. El dialogo pide el motivo y confirma la cancelacion.
      setErrorCancelar(null);
      setCancelando(order);
      return;
    }
    await aplicarCambioEstado(order, nextStatus);
  }

  // Fase 12 — dispara el dispatch real (PATCH .../assign-repartidor) en cuanto se
  // elige un repartidor del selector; volver a elegir uno distinto reasigna (el
  // servidor lo permite, no hay restricción de "una sola vez" — ver admin-orders.ts).
  // Elegir "Sin asignar" (repartidorId vacío) es un no-op: no existe un endpoint de
  // "desasignar" en el backend, así que nunca se finge uno aquí.
  async function handleAssignRepartidor(order: OrderSummary, repartidorId: string) {
    if (!repartidorId) return;
    setAssigningId(order.id);
    setError(null);
    try {
      await assignRepartidor(fetch, apiBaseUrl, token, propertyId, order.id, repartidorId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar el repartidor.");
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <PageContainer padding="none">
      {/* El nombre de la pagina lo pinta la barra superior del shell (contrato de pagina UNI-4): el h1 queda solo para lectores de pantalla. */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="sr-only">Pedidos en operación</h1>
        <Tabs value={status} onValueChange={(v) => setStatus(v as PestanaPedidos)}>
          <TabsList className="flex-wrap">
            {(["todos", "por_aprobar", ...OPERATIVE_STATUSES, "programados"] as const).map((s) => (
              <TabsTrigger key={s} value={s}>
                {s === "todos" ? "Todos" : s === "programados" ? "Programados" : ORDER_STATUS_LABELS[s]}
                {s === "por_aprobar" && aprobaciones && aprobaciones.solicitudes.length > 0 && (
                  <StatusBadge tone="warning" dot={false} className="ml-1.5" data-testid="insignia-por-aprobar">
                    {aprobaciones.solicitudes.length}
                  </StatusBadge>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {(role === "owner" || role === "admin") && (
          <Button type="button" size="sm" variant="outline" onClick={() => setReglasAbiertas(true)}>
            <SlidersHorizontal className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} />
            Reglas del autopiloto
          </Button>
        )}
      </header>

      {/* R-11: indicador de actualizacion (sondeo con backoff, en pausa con la pestana oculta) y sonido opcional. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="indicador-actualizacion">
        <span className="inline-flex items-center gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${sondeo.consultando ? "animate-spin" : ""}`} strokeWidth={1.75} aria-hidden="true" />
          {sondeo.pausado
            ? "En pausa (pestaña oculta)"
            : sondeo.fallosSeguidos > 0
              ? `Sin conexión: reintentando en ${Math.round(sondeo.proximoEnMs / 1000)} s`
              : `${etiquetaActualizado(sondeo.ultimaActualizacion, ahoraMs)} · cada ${SONDEO_BASE_MS / 1000} s`}
        </span>
        <Button type="button" size="xs" variant="ghost" onClick={() => sondeo.refrescar()} disabled={sondeo.consultando}>
          Actualizar ahora
        </Button>
        {nuevosAviso > 0 && (
          <StatusBadge tone="neutral" dot={false} data-testid="aviso-nuevos">
            {nuevosAviso} pedido{nuevosAviso === 1 ? "" : "s"} nuevo{nuevosAviso === 1 ? "" : "s"}
          </StatusBadge>
        )}
        <Checkbox
          id="sonido-pedidos"
          checked={sonido && sonidoPermitido}
          disabled={!sonidoPermitido}
          onChange={(e) => {
            setSonido(e.target.checked);
            guardarSonido(storageLocal(), orgSlug, propertyId, e.target.checked);
            if (e.target.checked) reproducirAviso();
          }}
          label={sonidoPermitido ? "Sonido al llegar un pedido nuevo" : "Sonido al llegar un pedido nuevo (apagado en tus Avisos)"}
          wrapperClassName="text-xs text-foreground"
        />
      </div>

      {tiempos && (
        <p className="m-0 text-xs text-muted-foreground" data-testid="tiempo-prometido">
          Tiempo prometido hoy: domicilio {tiempos.domicilio.texto}; recoger {tiempos.recoger.texto}
          {tiempos.domicilio.origen === "aprendido" || tiempos.recoger.origen === "aprendido" ? " (aprendido de las entregas recientes; nunca menos que el tiempo que fijó el dueño)" : " (el tiempo que fijó el dueño; aún no hay entregas suficientes para aprender)"}
          {tiempos.domicilio.saturacion !== "normal" || tiempos.recoger.saturacion !== "normal" ? ". Hay alta carga: se está alargando el tiempo prometido." : "."}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground">
        <Checkbox
          id="auto-imprimir-cocina"
          checked={prefs.autoImprimir}
          onChange={(e) => (e.target.checked ? void activarAutoImpresion() : desactivarAutoImpresion())}
          label="Imprimir ticket de cocina automáticamente al llegar un pedido (esta sucursal, este equipo)"
        />
      </div>
      {prefs.autoImprimir && (
        <p className="m-0 text-xs text-muted-foreground">
          Revisando pedidos nuevos cada {AUTO_IMPRESION_INTERVALO_MS / 1000} s mientras esta pantalla esté abierta. Para imprimir sin diálogo, configura el navegador en modo de impresión silenciosa.
        </p>
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
      ) : status === "programados" ? (
        programados ? (
          <ProgramadosPanel
            orders={programados}
            disponible={programadosDisponible}
            ahoraMs={ahoraMs}
            changingId={changingId}
            onAdelantar={(o) => void handleChangeStatus(o, "pending")}
            onCancelar={(o) => void handleChangeStatus(o, "cancelado")}
          />
        ) : (
          !error && <EstadoCargando etiqueta="Cargando pedidos programados…" />
        )
      ) : (
        <>
      {!orders && !error && <EstadoCargando etiqueta="Cargando pedidos…" />}
      {orders && orders.length === 0 && <EstadoVacio mensaje="No hay pedidos en este filtro." />}

      <div className="flex flex-col gap-2.5">
        {orders?.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="m-0 font-semibold text-foreground">
                    {o.customerName} · ${formatMoney(o.total)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {o.customerPhone} · {o.branch ?? "sin sucursal"} · {new Date(o.createdAt).toLocaleString("es-MX")}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-1.5 self-start">
                  {o.canal && (
                    <StatusBadge tone="neutral" dot={false} data-testid={`canal-${o.id}`}>
                      {o.canal === "recoger" ? "Recoger" : "Domicilio"}
                    </StatusBadge>
                  )}
                  {comandaEstados[o.id] && (
                    <Link to={`/restaurantes/${orgSlug}/comandas-pos`} className="no-underline" title={`Comanda al POS: ${ETIQUETA_ESTADO_COMANDA[comandaEstados[o.id]!]}. Ver la cola.`} data-testid={`comanda-pos-${o.id}`}>
                      <StatusBadge tone={TONO_ESTADO_COMANDA[comandaEstados[o.id]!]} dot={false}>
                        {etiquetaInsigniaPedido(comandaEstados[o.id]!)}
                      </StatusBadge>
                    </Link>
                  )}
                  <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)}>{ORDER_STATUS_LABELS[o.status]}</StatusBadge>
                </div>
              </div>
              {o.programadoPara && (
                <p className="mt-1 text-xs font-medium text-foreground" data-testid={`programado-${o.id}`}>
                  Pedido programado para las {new Date(o.programadoPara).toLocaleString("es-MX", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </p>
              )}
              {(o.horaRecogida || (o.propina !== null && o.propina !== undefined)) && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid={`recoger-${o.id}`}>
                  {o.horaRecogida ? `Recoge a las ${new Date(o.horaRecogida).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}` : null}
                  {o.horaRecogida && o.propina !== null && o.propina !== undefined ? " · " : null}
                  {o.propina !== null && o.propina !== undefined ? `Propina $${formatMoney(o.propina)} (no incluida en el total)` : null}
                </p>
              )}
              <p className="mt-2 text-sm text-foreground">{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>

              {o.canal !== "recoger" && (
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Label htmlFor={`repartidor-${o.id}`} className="text-xs font-normal text-foreground">
                  Repartidor:
                </Label>
                <NativeSelect
                  id={`repartidor-${o.id}`}
                  size="sm"
                  value={o.assignedRepartidorId ?? ""}
                  disabled={assigningId === o.id || !repartidores || repartidores.length === 0}
                  onChange={(e) => void handleAssignRepartidor(o, e.target.value)}
                  wrapperClassName="w-auto min-w-36"
                >
                  <option value="">Sin asignar</option>
                  {repartidores?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
                </NativeSelect>
                {!o.assignedRepartidorId && sugeridos[o.id] && (
                  <Button type="button" size="sm" variant="outline" disabled={assigningId === o.id} onClick={() => void handleAssignRepartidor(o, sugeridos[o.id]!.repartidorId)} data-testid={`asignar-sugerido-${o.id}`}>
                    Asignar a {sugeridos[o.id]!.nombre}
                  </Button>
                )}
                {assigningId === o.id && <span className="text-xs text-muted-foreground">Asignando…</span>}
                {o.estimatedDeliveryAt && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" strokeWidth={1.75} />
                    ETA {new Date(o.estimatedDeliveryAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                {repartidores && repartidores.length === 0 && <span className="text-xs text-muted-foreground">Sin repartidores dados de alta en esta organización.</span>}
              </div>
              )}
              {o.incidentNote && (
                <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                  {o.incidentNote}
                </p>
              )}

              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={() => imprimirPedido(o)}>
                  <Printer className="mr-1 h-3.5 w-3.5" strokeWidth={1.75} />
                  {prefs.impresos.includes(o.id) ? "Reimprimir ticket" : "Imprimir ticket"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setVistaPrevia({ ticket: construirTicketCocina(o, { reimpresion: prefs.impresos.includes(o.id) ? (prefs.reimpresiones[o.id] ?? 0) + 1 : 0 }), orderId: o.id })}
                >
                  Vista previa
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setHistorialDe(o)}>
                  Historial
                </Button>
              </div>

              {nextStatusesForCanal(o.status, o.canal).length > 0 && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {nextStatusesForCanal(o.status, o.canal).includes("listo_para_recoger") && (
                    <Checkbox
                      checked={!sinAvisoPorPedido.has(o.id)}
                      onChange={(e) =>
                        setSinAvisoPorPedido((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.delete(o.id);
                          else next.add(o.id);
                          return next;
                        })
                      }
                      label="Avisar al cliente por WhatsApp cuando esté listo"
                      wrapperClassName="text-xs"
                    />
                  )}
                  {nextStatusesForCanal(o.status, o.canal).map((next) => (
                    <Button
                      key={next}
                      type="button"
                      size="sm"
                      variant={next === "cancelado" ? "danger" : "outline"}
                      onClick={() => void handleChangeStatus(o, next)}
                      loading={changingId === o.id}
                    >
                      Marcar {ORDER_STATUS_LABELS[next]}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
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

      <MotivoDialogo
        open={cancelando !== null}
        onOpenChange={(o) => !o && setCancelando(null)}
        titulo="Cancelar pedido"
        subtitulo={cancelando ? `¿Cancelar el pedido de ${cancelando.customerName}? Se avisa al cliente y no se puede deshacer.` : undefined}
        textoConfirmar="Cancelar el pedido"
        tonoPeligro
        error={errorCancelar}
        enCurso={changingId !== null}
        onConfirmar={(motivo) => {
          if (!cancelando) return;
          void aplicarCambioEstado(cancelando, "cancelado", motivo).then((ok) => ok && setCancelando(null));
        }}
      />

      <HistorialPedidoDialogo
        orderId={historialDe?.id ?? null}
        titulo={historialDe ? `${historialDe.customerName} · $${formatMoney(historialDe.total)}` : ""}
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

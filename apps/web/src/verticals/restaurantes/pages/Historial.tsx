// Historial de órdenes (Fase 5) — mismo endpoint de listado que Pedidos.tsx (ver
// comentario de cabecera de admin-orders.ts), con filtro de fecha y paginación por
// cursor en vez de por-estado-operativo.
//
// Presentación real desde esta ronda: la `<table>` hecha a mano con `style={{...}}`
// pasa a `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` de
// `@atiende/ui`, los filtros a `Input`/`Label`/`Selector` y "Cargar más" a
// `Button`. El estado de cada orden se pinta con `StatusBadge` (tono por estado).
// La lógica de carga/paginación de abajo es la MISMA: solo cambia el JSX.
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EstadoError,
  FormField,
  Input,
  cn,
  Selector,
  PageContainer,
  StatusBadge,
  statusTone,
  useConfirm,
} from "@atiende/ui";
import { AlertTriangle, CalendarDays, ChevronDown, Search, Store } from "lucide-react";
import { etiquetaFolio, fetchOrders, ORDER_STATUS_LABELS, updateOrderStatus } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary } from "../lib/orders-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import { BotonExportar } from "../components/BotonExportar.tsx";
import { urlExportarHistorial } from "../lib/exportar-client.ts";
import { fetchAdminBranches } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import { fechaAnioHoraEsMx, hoyFechaSolo, medianocheLocalUTC, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import { PedidoDetalle } from "../components/pedidos/PedidoDetalle.tsx";
import { HistorialPedidoDialogo } from "../components/HistorialPedidoDialogo.tsx";
import { montoFila } from "../components/pedidos/formato.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

/** Periodos rapidos (chip «Periodo» del original): fijan «Desde» y vacian «Hasta»; editar las fechas a mano pasa a «Personalizado». */
const PERIODOS: ReadonlyArray<{ readonly id: string; readonly rotulo: string; readonly dias: number | null }> = [
  { id: "todo", rotulo: "Todo el historial", dias: null },
  { id: "hoy", rotulo: "Hoy", dias: 0 },
  { id: "7", rotulo: "Últimos 7 días", dias: 7 },
  { id: "30", rotulo: "Últimos 30 días", dias: 30 },
  { id: "90", rotulo: "Últimos 90 días", dias: 90 },
];
const BUSQUEDA_MIN = 2;

const ALL_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema"];

export function HistorialPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [periodo, setPeriodo] = useState("todo");
  const [sucursal, setSucursal] = useState("");
  const [sucursales, setSucursales] = useState<readonly BranchDetail[] | null>(null);
  const [soloIncidencias, setSoloIncidencias] = useState(false);
  const [busquedaTexto, setBusquedaTexto] = useState("");
  // La busqueda se manda con una pausa de 350 ms y solo con 2+ caracteres (el API ignora lo mas corto; aqui ni se pregunta).
  const [busqueda, setBusqueda] = useState("");
  const [orders, setOrders] = useState<readonly OrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Acciones sobre un pedido entregado (cerrar / registrar incidencia): su error no se mezcla con el de la lista.
  const [accionError, setAccionError] = useState<string | null>(null);
  const [accionId, setAccionId] = useState<string | null>(null);
  // Clic en una fila = detalle del pedido a pagina completa (como el original); «Volver» regresa a la lista con los mismos filtros.
  const [detalleId, setDetalleId] = useState<string | null>(null);
  const [historialDe, setHistorialDe] = useState<OrderSummary | null>(null);
  const { pedirTexto, dialogo } = useConfirm();
  // Generacion de la carga vigente (QA-restaurantes-R1-botones-06/07): cambiar un filtro la incrementa y una respuesta de una
  // generacion anterior (mas lenta) se descarta en vez de pisar el filtro actual, igual que Auditoria.tsx.
  const generacionRef = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setBusqueda(busquedaTexto.trim().length >= BUSQUEDA_MIN ? busquedaTexto.trim() : ""), 350);
    return () => clearTimeout(t);
  }, [busquedaTexto]);

  // Chip de sucursal: solo si el staff puede leer la lista de sucursales; si falla, el chip no se pinta (sin error ruidoso).
  useEffect(() => {
    let vivo = true;
    void fetchAdminBranches(fetch, apiBaseUrl, token, propertyId).then(
      (b) => { if (vivo) setSucursales(b); },
      () => { if (vivo) setSucursales(null); },
    );
    return () => { vivo = false; };
  }, [apiBaseUrl, token, propertyId]);

  function elegirPeriodo(id: string) {
    setPeriodo(id);
    const p = PERIODOS.find((x) => x.id === id);
    if (!p || p.dias === null) { setDateFrom(""); setDateTo(""); return; }
    setDateFrom(p.dias === 0 ? hoyFechaSolo() : sumarDiasFechaSolo(hoyFechaSolo(), -p.dias));
    setDateTo("");
  }

  async function load(reset: boolean) {
    const generacion = generacionRef.current;
    setLoading(true);
    setError(null);
    // Filtro nuevo: las filas del filtro anterior no se quedan visibles si la carga nueva falla.
    if (reset) {
      setOrders([]);
      setNextCursor(null);
      setCursor(undefined);
    }
    try {
      // Bug real (revisión de PR #164, "no bloqueante" #2, punto 4 del encargo original):
      // `new Date(dateFrom).toISOString()` sobre "YYYY-MM-DD" de estos `<input
      // type="date">` daba la medianoche UTC de ese día -- 18:00 CDMX del día ANTERIOR
      // (UTC-6). El servidor filtra `created_at >= dateFrom`/`created_at < dateTo`
      // (postgres-repository.ts) contra el día de calendario del NEGOCIO: "hasta el 15"
      // debía incluir TODO el 15 local y en cambio excluía el día completo. `dateTo` usa
      // la medianoche del día SIGUIENTE como límite exclusivo (`medianocheLocalUTC` es un
      // instante concreto, no puede ser "inclusive" para un rango de timestamps reales).
      const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, {
        status: statusFilter || undefined,
        dateFrom: dateFrom ? medianocheLocalUTC(dateFrom).toISOString() : undefined,
        dateTo: dateTo ? medianocheLocalUTC(sumarDiasFechaSolo(dateTo, 1)).toISOString() : undefined,
        branchId: sucursal || undefined,
        q: busqueda || undefined,
        incidencias: soloIncidencias || undefined,
        limit: 20,
        cursor: reset ? undefined : cursor,
      });
      if (generacion !== generacionRef.current) return;
      setOrders((prev) => (reset ? page.orders : [...prev, ...page.orders]));
      setNextCursor(page.nextCursor);
      setCursor(page.nextCursor ?? undefined);
    } catch (err) {
      if (generacion === generacionRef.current) setError(err instanceof Error ? err.message : "No se pudo cargar el historial.");
    } finally {
      if (generacion === generacionRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    generacionRef.current += 1;
    void load(true);
  }, [apiBaseUrl, token, propertyId, statusFilter, dateFrom, dateTo, sucursal, busqueda, soloIncidencias]);

  // QA-restaurantes-R1-viaje-11: un pedido entregado sale de Pedidos (solo lista los operativos); aqui se cierra
  // administrativamente (Completado) o se registra una queja posterior a la entrega (Incidencia, con nota). El servidor
  // re-valida la transicion (order-lifecycle.ts).
  async function cerrarPedido(o: OrderSummary) {
    setAccionId(o.id);
    setAccionError(null);
    try {
      await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, o.id, "completado");
      generacionRef.current += 1;
      await load(true);
    } catch (err) {
      setAccionError(err instanceof Error ? err.message : "No se pudo cerrar el pedido.");
    } finally {
      setAccionId(null);
    }
  }

  async function registrarIncidencia(o: OrderSummary) {
    const nota = await pedirTexto({
      titulo: `Registrar incidencia del pedido de ${o.customerName}`,
      descripcion: "¿Qué pasó después de la entrega? La nota queda en el pedido y el equipo la ve de inmediato.",
      tono: "danger",
      confirmar: "Registrar incidencia",
      cancelar: "Volver",
      campo: { etiqueta: "Nota de la incidencia", placeholder: "Ej. El cliente reporta que faltó un producto.", multilinea: true, maxLength: 2000 },
    });
    if (nota === null) return; // Volver, Escape o cerrar: no se llama al API
    setAccionId(o.id);
    setAccionError(null);
    try {
      await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, o.id, "problema", { incidentNote: nota.trim() });
      generacionRef.current += 1;
      await load(true);
    } catch (err) {
      setAccionError(err instanceof Error ? err.message : "No se pudo registrar la incidencia.");
    } finally {
      setAccionId(null);
    }
  }

  if (detalleId) {
    return (
      <PageContainer padding="none">
        <h1 className="sr-only">Detalle del pedido</h1>
        <PedidoDetalle
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
          orderId={detalleId}
          repartidores={null}
          onVolver={() => setDetalleId(null)}
          onSelect={setDetalleId}
          onHistorial={setHistorialDe}
        />
        <HistorialPedidoDialogo
          orderId={historialDe?.id ?? null}
          titulo={historialDe ? `${historialDe.customerName} · ${etiquetaFolio(historialDe)}` : ""}
          onClose={() => setHistorialDe(null)}
          apiBaseUrl={apiBaseUrl}
          token={token}
          propertyId={propertyId}
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Historial de órdenes</h1>

      {/* Chips de filtro del original: periodo, sucursal, incidencias / no entregados y busqueda por cliente o telefono. */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtros rápidos del historial">
        <span className="relative inline-flex items-center">
          <CalendarDays className="pointer-events-none absolute left-3 z-10 size-3.5 text-muted-foreground" aria-hidden="true" />
          <Selector aria-label="Periodo" value={periodo === "custom" ? "custom" : periodo} onChange={(e) => elegirPeriodo(e.target.value)} wrapperClassName="w-auto" className="rounded-full pl-9">
            {PERIODOS.map((p) => (
              <option key={p.id} value={p.id}>{p.rotulo}</option>
            ))}
            {periodo === "custom" && <option value="custom">Personalizado</option>}
          </Selector>
        </span>
        {sucursales && sucursales.length > 1 && (
          <span className="relative inline-flex items-center">
            <Store className="pointer-events-none absolute left-3 z-10 size-3.5 text-muted-foreground" aria-hidden="true" />
            <Selector aria-label="Sucursal" value={sucursal} onChange={(e) => setSucursal(e.target.value)} wrapperClassName="w-auto" className="rounded-full pl-9">
              <option value="">Todas las sucursales</option>
              {sucursales.map((b) => (
                <option key={b.propertyId} value={b.propertyId}>{b.name}</option>
              ))}
            </Selector>
          </span>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={soloIncidencias}
          onClick={() => setSoloIncidencias((v) => !v)}
          className={cn("rounded-full", soloIncidencias && "border-primary bg-primary/10 text-primary")}
          iconLeft={<AlertTriangle />}
        >
          Incidencias / no entregados
        </Button>
        <span className="relative inline-flex items-center">
          <Search className="pointer-events-none absolute left-3 size-3.5 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            aria-label="Buscar por cliente o teléfono"
            placeholder="Cliente o teléfono…"
            value={busquedaTexto}
            maxLength={60}
            onChange={(e) => setBusquedaTexto(e.target.value)}
            className="w-56 rounded-full pl-9"
          />
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Estado">
          <Selector
            id="restaurantes-historial-estado"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as OrderStatus | "")}
            wrapperClassName="w-auto min-w-44"
          >
            <option value="">Todos los estados</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </Selector>
        </FormField>
        <FormField label="Desde">
          <Input id="restaurantes-historial-desde" type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPeriodo("custom"); }} className="w-auto" />
        </FormField>
        <FormField label="Hasta">
          <Input id="restaurantes-historial-hasta" type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPeriodo("custom"); }} className="w-auto" />
        </FormField>
        {/* R-17: exporta con los filtros vigentes (mismos limites de fecha que la tabla). Solo owner/admin. */}
        <div className="ml-auto">
          <BotonExportar
            variante="default"
            role={role}
            token={token}
            urlPara={(formato) =>
              urlExportarHistorial(apiBaseUrl, propertyId, formato, {
                status: statusFilter || undefined,
                branchId: sucursal || undefined,
                q: busqueda || undefined,
                incidencias: soloIncidencias || undefined,
                dateFrom: dateFrom ? medianocheLocalUTC(dateFrom).toISOString() : undefined,
                dateTo: dateTo ? medianocheLocalUTC(sumarDiasFechaSolo(dateTo, 1)).toISOString() : undefined,
              })
            }
          />
        </div>
      </div>

      {error && <EstadoError mensaje={error} onReintentar={() => { generacionRef.current += 1; void load(true); }} />}
      {accionError && <EstadoError titulo="No se pudo completar la acción" mensaje={accionError} compacto onReintentar={() => setAccionError(null)} />}

      {!(error && orders.length === 0) && (
        <Card>
          <CardHeader className="p-3 pb-2">
            <CardTitle className="sr-only">Órdenes</CardTitle>
            <p className="font-mono text-eyebrow tabular-nums text-muted-foreground" data-testid="historial-conteo">
              {orders.length === 0 ? "0 pedidos" : `Mostrando ${orders.length}${nextCursor ? " · hay más" : ""}`}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<OrderSummary>
              etiqueta="Historial de órdenes de esta sucursal"
              filas={orders}
              obtenerId={(o) => o.id}
              estado={loading && orders.length === 0 ? "loading" : orders.length === 0 ? "empty" : "ok"}
              vacio={{ titulo: "Sin pedidos", mensaje: "No hay pedidos que coincidan con estos filtros." }}
              paginacion={false}
              onFilaClick={(o) => setDetalleId(o.id)}
              columnas={[
                {
                  id: "cliente",
                  encabezado: "Cliente",
                  principal: true,
                  celda: (o) => (
                    <span className="block">
                      <span className="block font-medium text-foreground">{o.customerName}</span>
                      {o.customerPhone ? <span className="block text-eyebrow text-muted-foreground">{o.customerPhone}</span> : null}
                    </span>
                  ),
                },
                { id: "pedido", encabezado: "N° de pedido", className: "whitespace-nowrap font-mono text-eyebrow text-muted-foreground", celda: (o) => etiquetaFolio(o) },
                { id: "sucursal", encabezado: "Sucursal", celda: (o) => o.branch ?? "—" },
                { id: "total", encabezado: "Monto", alinear: "right", className: "font-semibold tabular-nums", celda: (o) => montoFila(o.total) },
                { id: "estado", encabezado: "Estado", celda: (o) => <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)}>{ORDER_STATUS_LABELS[o.status]}</StatusBadge> },
                { id: "fecha", encabezado: "Fecha", className: "whitespace-nowrap text-muted-foreground", celda: (o) => fechaAnioHoraEsMx(o.createdAt) },
                {
                  id: "acciones",
                  encabezado: "Acciones",
                  alinear: "right",
                  celda: (o) =>
                    o.status === "entregado" ? (
                      <span className="inline-flex flex-wrap justify-end gap-1.5">
                        <Button type="button" size="sm" variant="outline" loading={accionId === o.id} onClick={() => void cerrarPedido(o)}>
                          Cerrar (completado)
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={accionId === o.id} onClick={() => void registrarIncidencia(o)}>
                          Registrar incidencia
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
          </CardContent>
        </Card>
      )}

      {nextCursor && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void load(false)} loading={loading}>
          <ChevronDown />
          Cargar más
        </Button>
      )}

      {dialogo}
    </PageContainer>
  );
}

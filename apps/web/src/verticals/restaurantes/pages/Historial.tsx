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
  Selector,
  PageContainer,
  StatusBadge,
  formatMoney,
  statusTone,
  useConfirm,
} from "@atiende/ui";
import { ChevronDown } from "lucide-react";
import { fetchOrders, ORDER_STATUS_LABELS, updateOrderStatus } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary } from "../lib/orders-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import { BotonExportar } from "../components/BotonExportar.tsx";
import { urlExportarHistorial } from "../lib/exportar-client.ts";
import { medianocheLocalUTC, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ALL_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema"];

export function HistorialPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [orders, setOrders] = useState<readonly OrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Acciones sobre un pedido entregado (cerrar / registrar incidencia): su error no se mezcla con el de la lista.
  const [accionError, setAccionError] = useState<string | null>(null);
  const [accionId, setAccionId] = useState<string | null>(null);
  const { pedirTexto, dialogo } = useConfirm();
  // Generacion de la carga vigente (QA-restaurantes-R1-botones-06/07): cambiar un filtro la incrementa y una respuesta de una
  // generacion anterior (mas lenta) se descarta en vez de pisar el filtro actual, igual que Auditoria.tsx.
  const generacionRef = useRef(0);

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
  }, [apiBaseUrl, token, propertyId, statusFilter, dateFrom, dateTo]);

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

  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Historial de órdenes</h1>

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
          <Input id="restaurantes-historial-desde" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
        </FormField>
        <FormField label="Hasta">
          <Input id="restaurantes-historial-hasta" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
        </FormField>
        {/* R-17: exporta con los filtros vigentes (mismos limites de fecha que la tabla). Solo owner/admin. */}
        <div className="ml-auto">
          <BotonExportar
            role={role}
            token={token}
            urlPara={(formato) =>
              urlExportarHistorial(apiBaseUrl, propertyId, formato, {
                status: statusFilter || undefined,
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
            <CardTitle>Órdenes</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <DataTable<OrderSummary>
              etiqueta="Historial de órdenes de esta sucursal"
              filas={orders}
              obtenerId={(o) => o.id}
              estado={loading && orders.length === 0 ? "loading" : orders.length === 0 ? "empty" : "ok"}
              vacio={{ titulo: "Sin pedidos", mensaje: "No hay pedidos en este filtro." }}
              paginacion={false}
              columnas={[
                { id: "fecha", encabezado: "Fecha", principal: true, className: "whitespace-nowrap", celda: (o) => new Date(o.createdAt).toLocaleString("es-MX") },
                { id: "cliente", encabezado: "Cliente", celda: (o) => o.customerName },
                { id: "sucursal", encabezado: "Sucursal", celda: (o) => <span className="text-muted-foreground">{o.branch ?? "—"}</span> },
                { id: "estado", encabezado: "Estado", celda: (o) => <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)}>{ORDER_STATUS_LABELS[o.status]}</StatusBadge> },
                { id: "total", encabezado: "Total", alinear: "right", className: "tabular-nums", celda: (o) => `$${formatMoney(o.total)}` },
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

// Historial de órdenes (Fase 5) — mismo endpoint de listado que Pedidos.tsx (ver
// comentario de cabecera de admin-orders.ts), con filtro de fecha y paginación por
// cursor en vez de por-estado-operativo.
//
// Presentación real desde esta ronda: la `<table>` hecha a mano con `style={{...}}`
// pasa a `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` de
// `@atiende/ui`, los filtros a `Input`/`Label`/`NativeSelect` y "Cargar más" a
// `Button`. El estado de cada orden se pinta con `StatusBadge` (tono por estado).
// La lógica de carga/paginación de abajo es la MISMA: solo cambia el JSX.
import { useEffect, useState } from "react";
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
  NativeSelect,
  PageContainer,
  StatusBadge,
  formatMoney,
  statusTone,
} from "@atiende/ui";
import { ChevronDown } from "lucide-react";
import { fetchOrders, ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
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

  async function load(reset: boolean) {
    setLoading(true);
    setError(null);
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
      setOrders((prev) => (reset ? page.orders : [...prev, ...page.orders]));
      setNextCursor(page.nextCursor);
      setCursor(page.nextCursor ?? undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el historial.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, [apiBaseUrl, token, propertyId, statusFilter, dateFrom, dateTo]);

  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Historial de órdenes</h1>

      <div className="flex flex-wrap items-end gap-3">
        <FormField label="Estado">
          <NativeSelect
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
          </NativeSelect>
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

      {error && <EstadoError mensaje={error} onReintentar={() => void load(true)} />}

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
    </PageContainer>
  );
}

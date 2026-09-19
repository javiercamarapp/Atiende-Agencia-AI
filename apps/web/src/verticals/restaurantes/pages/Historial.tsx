// Historial de órdenes (Fase 5) — mismo endpoint de listado que Pedidos.tsx (ver
// comentario de cabecera de admin-orders.ts), con filtro de fecha y paginación por
// cursor en vez de por-estado-operativo.
//
// Presentación real desde esta ronda: la `<table>` hecha a mano con `style={{...}}`
// pasa a `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell` de
// `@atiende/ui`, los filtros a `Input`/`Label` (+ `<select>` nativo restilado con
// tokens) y "Cargar más" a `Button`. El estado de cada orden se pinta con `Badge`.
// La lógica de carga/paginación de abajo es la MISMA: solo cambia el JSX.
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EstadoError,
  EstadoVacio,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { ChevronDown } from "lucide-react";
import { fetchOrders, ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary } from "../lib/orders-client.ts";
import { medianocheLocalUTC, sumarDiasFechaSolo } from "../../../lib/formato-fecha.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ALL_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema"];

/** Mismo criterio de color que Pedidos.tsx: "problema" es el único estado que se
 * destaca en rojo; el resto usa el gris neutro del sistema. */
function badgeVariantForStatus(status: OrderStatus): "destructive" | "secondary" {
  return status === "problema" ? "destructive" : "secondary";
}

const SELECT_CLASES =
  "h-11 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function HistorialPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
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
    <div className="flex flex-col gap-4 p-6">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Historial de órdenes</h1>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="restaurantes-historial-estado" className="text-xs text-muted-foreground">
            Estado
          </Label>
          <select
            id="restaurantes-historial-estado"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as OrderStatus | "")}
            className={SELECT_CLASES}
          >
            <option value="">Todos los estados</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ORDER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="restaurantes-historial-desde" className="text-xs text-muted-foreground">
            Desde
          </Label>
          <Input id="restaurantes-historial-desde" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="restaurantes-historial-hasta" className="text-xs text-muted-foreground">
            Hasta
          </Label>
          <Input id="restaurantes-historial-hasta" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
        </div>
      </div>

      {error && <EstadoError mensaje={error} onReintentar={() => void load(true)} />}

      {orders.length === 0 && !loading && !error && <EstadoVacio mensaje="No hay pedidos en este filtro." />}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableCaption className="sr-only">Historial de órdenes de esta sucursal</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Sucursal</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="whitespace-nowrap">{new Date(o.createdAt).toLocaleString("es-MX")}</TableCell>
                  <TableCell>{o.customerName}</TableCell>
                  <TableCell className="text-muted-foreground">{o.branch ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={badgeVariantForStatus(o.status)}>{ORDER_STATUS_LABELS[o.status]}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">{formatMoney(o.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {nextCursor && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void load(false)} disabled={loading}>
          <ChevronDown />
          {loading ? "Cargando…" : "Cargar más"}
        </Button>
      )}
    </div>
  );
}

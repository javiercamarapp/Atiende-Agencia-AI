// Pedidos en operación (Fase 5) — lista por estado + cambio de estado real vía la
// máquina de estados de order-lifecycle.ts (el servidor SIEMPRE re-valida la
// transición; los botones ofrecidos aquí son solo un espejo de NEXT_STATUSES para
// no mostrar una acción que el servidor rechazaría).
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Tabs` para el filtro por estado, `Card` por pedido,
// `Badge` para el estado, `Button` para cada transición y `Dialog` para la
// confirmación de "cancelado" (antes un `window.confirm` del navegador, ver el
// comentario de `handleChangeStatus`). El gate de confirmación, las transiciones
// ofrecidas y todas las llamadas al backend son EXACTAMENTE las mismas.
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Label,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import { AlertTriangle, Clock } from "lucide-react";
import { assignRepartidor, fetchOrders, NEXT_STATUSES, ORDER_STATUS_LABELS, updateOrderStatus } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary } from "../lib/orders-client.ts";
import { fetchRepartidores } from "../lib/staff-client.ts";
import type { RepartidorMember } from "../lib/staff-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const OPERATIVE_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "problema"];

const SELECT_CLASES =
  "h-9 rounded-md border border-input bg-background px-2.5 text-xs text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PedidosPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [status, setStatus] = useState<OrderStatus | "todos">("todos");
  const [orders, setOrders] = useState<readonly OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  // Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
  // no tiene UI"): lista de repartidores REALES de la organización (ver
  // admin-staff.ts::GET .../admin/staff/repartidores) para poblar el selector de abajo.
  // Estado separado de `orders`/`error` a propósito: si este fetch falla, el selector
  // simplemente no aparece -- nunca debe tumbar la lista de pedidos, que es la función
  // principal de esta página.
  const [repartidores, setRepartidores] = useState<readonly RepartidorMember[] | null>(null);
  const [repartidoresError, setRepartidoresError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  // Pedido esperando la confirmación de cancelación (ver `handleChangeStatus`) —
  // `null` mientras no haya ninguna en curso, que es lo que mantiene cerrado el
  // <Dialog> del final del archivo.
  const [pedidoACancelar, setPedidoACancelar] = useState<OrderSummary | null>(null);

  async function load() {
    setError(null);
    try {
      if (status === "todos") {
        const pages = await Promise.all(OPERATIVE_STATUSES.map((s) => fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: s, limit: 50 })));
        const merged = pages.flatMap((p) => p.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setOrders(merged);
      } else {
        const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, { status, limit: 50 });
        setOrders(page.orders);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, status]);

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

  async function aplicarCambioEstado(order: OrderSummary, nextStatus: OrderStatus) {
    setChangingId(order.id);
    setError(null);
    try {
      await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, nextStatus);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado del pedido.");
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
  // el MISMO de siempre; desde esta ronda lo pinta el <Dialog> del sistema de diseño en
  // vez del `window.confirm` del navegador.
  function handleChangeStatus(order: OrderSummary, nextStatus: OrderStatus) {
    if (nextStatus === "cancelado") {
      setPedidoACancelar(order);
      return;
    }
    void aplicarCambioEstado(order, nextStatus);
  }

  async function confirmarCancelacion() {
    const order = pedidoACancelar;
    if (!order) return;
    setPedidoACancelar(null);
    await aplicarCambioEstado(order, "cancelado");
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
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">Pedidos en operación</h1>
        <Tabs value={status} onValueChange={(v) => setStatus(v as OrderStatus | "todos")}>
          <TabsList className="flex-wrap">
            {(["todos", ...OPERATIVE_STATUSES] as const).map((s) => (
              <TabsTrigger key={s} value={s}>
                {s === "todos" ? "Todos" : ORDER_STATUS_LABELS[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {repartidoresError && (
        <p role="alert" className="m-0 text-xs text-destructive">
          No se pudo cargar la lista de repartidores: {repartidoresError}
        </p>
      )}
      {!orders && !error && <EstadoCargando etiqueta="Cargando pedidos…" />}
      {orders && orders.length === 0 && <EstadoVacio mensaje="No hay pedidos en este filtro." />}

      <div className="flex flex-col gap-2.5">
        {orders?.map((o) => (
          <Card key={o.id}>
            <CardContent className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="m-0 font-semibold text-foreground">
                    {o.customerName} · {formatMoney(o.total)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {o.customerPhone} · {o.branch ?? "sin sucursal"} · {new Date(o.createdAt).toLocaleString("es-MX")}
                  </p>
                </div>
                <Badge variant={o.status === "problema" ? "destructive" : "secondary"} className="self-start">
                  {ORDER_STATUS_LABELS[o.status]}
                </Badge>
              </div>
              <p className="mt-2 text-[13px] text-foreground">{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Label htmlFor={`repartidor-${o.id}`} className="text-xs font-normal text-foreground">
                  Repartidor:
                </Label>
                <select
                  id={`repartidor-${o.id}`}
                  value={o.assignedRepartidorId ?? ""}
                  disabled={assigningId === o.id || !repartidores || repartidores.length === 0}
                  onChange={(e) => void handleAssignRepartidor(o, e.target.value)}
                  className={SELECT_CLASES}
                >
                  <option value="">Sin asignar</option>
                  {repartidores?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
                {assigningId === o.id && <span className="text-xs text-muted-foreground">Asignando…</span>}
                {o.estimatedDeliveryAt && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" strokeWidth={1.75} />
                    ETA {new Date(o.estimatedDeliveryAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                {repartidores && repartidores.length === 0 && <span className="text-xs text-muted-foreground">Sin repartidores dados de alta en esta organización.</span>}
              </div>
              {o.incidentNote && (
                <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3" strokeWidth={1.75} />
                  {o.incidentNote}
                </p>
              )}

              {NEXT_STATUSES[o.status].length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {NEXT_STATUSES[o.status].map((next) => (
                    <Button
                      key={next}
                      type="button"
                      size="sm"
                      variant={next === "cancelado" ? "destructive" : "outline"}
                      className="h-9 text-xs"
                      onClick={() => handleChangeStatus(o, next)}
                      disabled={changingId === o.id}
                    >
                      {changingId === o.id ? "…" : `Marcar ${ORDER_STATUS_LABELS[next]}`}
                    </Button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={pedidoACancelar !== null} onOpenChange={(abierto) => !abierto && setPedidoACancelar(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancelar pedido</DialogTitle>
            <DialogDescription>
              {pedidoACancelar ? `¿Cancelar el pedido de ${pedidoACancelar.customerName}? Esta acción no se puede deshacer.` : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPedidoACancelar(null)}>
              Volver
            </Button>
            <Button type="button" variant="destructive" onClick={() => void confirmarCancelacion()}>
              Cancelar el pedido
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

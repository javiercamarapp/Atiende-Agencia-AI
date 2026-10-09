// Detalle de un pedido a PAGINA COMPLETA (replica PedidoDetalleSection del repo suelto): «Venta 1001», estado, cliente, canal, direccion, pago,
// tabla de productos, notas, incidencia, entrega y «Pedidos recientes». Autosuficiente (pide el pedido y los recientes por su cuenta) y se monta
// EN VEZ de la lista mientras haya un pedido abierto; «Volver» regresa a la lista. Lo propio del monorepo: el estado real, el repartidor
// asignado, la propina, la hora de recogida / programacion y el boton «Historial» (bitacora de transiciones).
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeft, Banknote, Bike, Clock, CreditCard, Globe, History, Loader2, MapPin, MessageCircle, Mic, Phone, ShoppingCart, StickyNote, Store, Truck, User, Wallet } from "lucide-react";
import { Button, DataTable, StatusBadge, cn, formatMoney, statusTone } from "@atiende/ui";
import { fechaAnioHoraEsMx, fechaCortaHoraEsMx, hora24EsMx } from "../../../../lib/formato-fecha.ts";
import { etiquetaVenta, fetchOrder, fetchOrders, ORDER_STATUS_LABELS } from "../../lib/orders-client.ts";
import type { OrderItem, OrderSummary } from "../../lib/orders-client.ts";
import type { RepartidorMember } from "../../lib/staff-client.ts";
import { ORDER_STATUS_TONES } from "../../lib/status-tones.ts";
import "./mapa-entrega.css";

const dinero = (n: number): string => `$${formatMoney(n)}`;

const ETIQUETA_FUENTE: Record<OrderSummary["source"], string> = { voice: "Llamada", whatsapp: "WhatsApp", web: "Web", admin: "Capturado a mano" };

function IconoFuente({ source, className }: { readonly source: OrderSummary["source"]; readonly className: string }) {
  if (source === "voice") return <Mic className={className} strokeWidth={1.75} aria-hidden="true" />;
  if (source === "whatsapp") return <MessageCircle className={className} strokeWidth={1.75} aria-hidden="true" />;
  return <Globe className={className} strokeWidth={1.75} aria-hidden="true" />;
}

function Dato({ icono, etiqueta, children, className }: { readonly icono: React.ReactNode; readonly etiqueta: string; readonly children: React.ReactNode; readonly className?: string }) {
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icono}</span>
      <div className="min-w-0">
        <p className="truncate text-foreground">{children}</p>
        <p className="text-eyebrow text-muted-foreground">{etiqueta}</p>
      </div>
    </div>
  );
}

export interface PedidoDetalleProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orderId: string;
  readonly repartidores: readonly RepartidorMember[] | null;
  readonly onVolver: () => void;
  readonly onSelect: (orderId: string) => void;
  readonly onHistorial: (order: OrderSummary) => void;
}

export function PedidoDetalle({ apiBaseUrl, token, propertyId, orderId, repartidores, onVolver, onSelect, onHistorial }: PedidoDetalleProps) {
  const [detalle, setDetalle] = useState<OrderSummary | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorDetalle, setErrorDetalle] = useState<string | null>(null);
  const [reintento, setReintento] = useState(0);
  const [recientes, setRecientes] = useState<readonly OrderSummary[]>([]);
  const [cargandoRecientes, setCargandoRecientes] = useState(true);

  useEffect(() => {
    let cancelado = false;
    setCargando(true);
    setDetalle(null);
    setErrorDetalle(null);
    fetchOrder(fetch, apiBaseUrl, token, propertyId, orderId)
      .then((o) => !cancelado && setDetalle(o))
      .catch((err: unknown) => !cancelado && setErrorDetalle(err instanceof Error ? err.message : "No fue posible consultar el pedido."))
      .finally(() => !cancelado && setCargando(false));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, orderId, reintento]);

  // «Pedidos recientes»: los ultimos de la sucursal, sin el actual. Un fallo aqui nunca tumba el detalle.
  useEffect(() => {
    let cancelado = false;
    setCargandoRecientes(true);
    fetchOrders(fetch, apiBaseUrl, token, propertyId, { limit: 9 })
      .then((p) => !cancelado && setRecientes(p.orders.filter((o) => o.id !== orderId).slice(0, 8)))
      .catch(() => !cancelado && setRecientes([]))
      .finally(() => !cancelado && setCargandoRecientes(false));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, orderId]);

  const repartidor = detalle?.assignedRepartidorId ? repartidores?.find((r) => r.id === detalle.assignedRepartidorId) : undefined;

  return (
    <div className="w-full min-w-0 space-y-4" data-testid="pedido-detalle">
      <Button type="button" variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={onVolver}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        Volver
      </Button>

      {cargando ? (
        <div className="flex justify-center py-16" role="status" aria-busy="true" aria-label="Cargando el pedido">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : errorDetalle || !detalle ? (
        <div role="alert" className="w-full rounded-2xl border border-destructive/30 bg-card p-5 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">No se pudo cargar el pedido</p>
          <p className="mt-1 text-xs text-muted-foreground">{errorDetalle ?? "Pedido no encontrado."}</p>
          <Button className="mt-4" variant="outline" onClick={() => setReintento((v) => v + 1)}>
            Volver a intentar
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="font-display text-2xl font-semibold text-foreground">{etiquetaVenta(detalle)}</h2>
                <StatusBadge tone={statusTone(ORDER_STATUS_TONES, detalle.status)} className={cn(detalle.status === "problema" && "pedido-incidencia-chip")}>
                  {ORDER_STATUS_LABELS[detalle.status]}
                </StatusBadge>
                <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => onHistorial(detalle)}>
                  <History className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  Historial
                </Button>
              </div>
              <p className="mt-1 text-pill text-muted-foreground">
                {fechaAnioHoraEsMx(detalle.createdAt)}
                {detalle.branch ? ` · ${detalle.branch}` : ""}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 text-ui min-[420px]:grid-cols-2 sm:grid-cols-3">
              <Dato icono={<User className="h-4 w-4" aria-hidden="true" />} etiqueta="Cliente">
                {detalle.customerName}
              </Dato>
              <Dato icono={<Phone className="h-4 w-4" aria-hidden="true" />} etiqueta="Teléfono">
                {detalle.customerPhone}
              </Dato>
              <Dato icono={<IconoFuente source={detalle.source} className="h-4 w-4" />} etiqueta="Canal">
                {ETIQUETA_FUENTE[detalle.source]}
              </Dato>
              {detalle.customerAddress && (
                <Dato icono={<MapPin className="h-4 w-4" aria-hidden="true" />} etiqueta="Dirección de entrega" className="min-[420px]:col-span-2">
                  {detalle.customerAddress}
                </Dato>
              )}
              <Dato
                icono={detalle.paymentMethod === "tarjeta" ? <CreditCard className="h-4 w-4" aria-hidden="true" /> : detalle.paymentMethod === "efectivo" ? <Banknote className="h-4 w-4" aria-hidden="true" /> : <Wallet className="h-4 w-4" aria-hidden="true" />}
                etiqueta="Forma de pago"
              >
                <span className="capitalize">{detalle.paymentMethod ?? "No registrada"}</span>
              </Dato>
              {detalle.canal && (
                <Dato icono={<Truck className="h-4 w-4" aria-hidden="true" />} etiqueta="Entrega">
                  {detalle.canal === "recoger" ? "Recoger en sucursal" : "Domicilio"}
                </Dato>
              )}
              {detalle.assignedRepartidorId && (
                <Dato icono={<Bike className="h-4 w-4" aria-hidden="true" />} etiqueta="Repartidor">
                  {repartidor?.fullName || repartidor?.email || "Repartidor asignado"}
                </Dato>
              )}
              {detalle.estimatedDeliveryAt && (
                <Dato icono={<Clock className="h-4 w-4" aria-hidden="true" />} etiqueta="Llegada estimada">
                  {hora24EsMx(detalle.estimatedDeliveryAt)}
                </Dato>
              )}
              {detalle.horaRecogida && (
                <Dato icono={<Clock className="h-4 w-4" aria-hidden="true" />} etiqueta="Recoge a las">
                  {hora24EsMx(detalle.horaRecogida)}
                </Dato>
              )}
              {detalle.programadoPara && (
                <Dato icono={<Clock className="h-4 w-4" aria-hidden="true" />} etiqueta="Programado para">
                  {fechaCortaHoraEsMx(detalle.programadoPara)}
                </Dato>
              )}
            </div>

            <div className="overflow-hidden rounded-xl border border-border">
              <DataTable<OrderItem>
                etiqueta="Productos del pedido"
                filas={detalle.items}
                obtenerId={(it) => it.id}
                paginacion={false}
                vista="tabla"
                vacio={{ mensaje: "Este pedido no tiene productos registrados." }}
                columnas={[
                  { id: "producto", encabezado: "Producto", principal: true, celda: (it) => (
                    <span className="text-foreground">
                      {it.name}
                      {it.tortilla ? <span className="text-muted-foreground"> · {it.tortilla}</span> : null}
                    </span>
                  ) },
                  { id: "cantidad", encabezado: "Cant.", alinear: "right", celda: (it) => <span className="tabular-nums text-foreground">{it.quantity}</span> },
                  { id: "unitario", encabezado: "P. unit.", alinear: "right", celda: (it) => <span className="tabular-nums text-muted-foreground">{dinero(Number(it.price))}</span> },
                  { id: "subtotal", encabezado: "Subtotal", alinear: "right", celda: (it) => <span className="font-medium tabular-nums text-foreground">{dinero(Number(it.price) * it.quantity)}</span> },
                ]}
              />
              <div className="divide-y divide-dashed divide-border border-t border-border bg-muted/40">
                {detalle.propina != null && (
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="font-mono text-eyebrow uppercase tracking-wide text-muted-foreground">Propina (no incluida en el total)</span>
                    <span className="tabular-nums text-muted-foreground">{dinero(detalle.propina)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="font-mono text-eyebrow uppercase tracking-wide text-muted-foreground">Total</span>
                  <span className="font-display text-base font-semibold tabular-nums text-foreground" data-testid="detalle-total">
                    {dinero(Number(detalle.total))}
                  </span>
                </div>
              </div>
            </div>

            {detalle.notes && (
              <div className="flex items-start gap-2 rounded-xl border border-border p-3">
                <StickyNote className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-ui text-foreground">{detalle.notes}</p>
                  <p className="text-eyebrow text-muted-foreground">Instrucciones especiales</p>
                </div>
              </div>
            )}

            {detalle.status === "problema" && detalle.incidentNote && (
              <div className="pedido-incidencia-aviso flex items-start gap-2 rounded-xl border p-3">
                <AlertTriangle className="pedido-incidencia-texto mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-ui text-foreground">{detalle.incidentNote}</p>
                  <p className="pedido-incidencia-texto text-eyebrow">Incidencia reportada</p>
                </div>
              </div>
            )}

            {detalle.deliveredAt && <p className="text-pill text-muted-foreground">Entregado el {fechaAnioHoraEsMx(detalle.deliveredAt)}</p>}
          </div>

          <div className="space-y-2">
            <p className="px-1 font-mono text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">Pedidos recientes</p>
            {cargandoRecientes ? (
              <div className="flex justify-center py-8" role="status" aria-busy="true" aria-label="Cargando pedidos recientes">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
              </div>
            ) : recientes.length === 0 ? (
              <p className="px-1 text-pill text-muted-foreground">No hay más pedidos recientes.</p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-border bg-card">
                {recientes.map((r) => (
                  <button key={r.id} type="button" onClick={() => onSelect(r.id)} className="flex w-full items-center justify-between gap-3 border-b border-dashed border-border p-3 text-left transition-colors last:border-0 hover:bg-muted/40">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
                        {r.source === "voice" || r.source === "whatsapp" ? <IconoFuente source={r.source} className="h-4 w-4 text-primary" /> : <ShoppingCart className="h-4 w-4 text-primary" strokeWidth={1.75} aria-hidden="true" />}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-ui font-medium text-foreground">{r.customerName}</p>
                        <p className="flex items-center gap-1 truncate text-eyebrow text-muted-foreground">
                          {etiquetaVenta(r)}
                          {r.branch && (
                            <>
                              <Store className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                              {r.branch}
                            </>
                          )}
                          {` · ${fechaCortaHoraEsMx(r.createdAt)}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <p className="font-display text-ui font-semibold tabular-nums text-foreground">{dinero(Number(r.total))}</p>
                      <StatusBadge tone={statusTone(ORDER_STATUS_TONES, r.status)} dot={false} className="text-2xs">
                        {ORDER_STATUS_LABELS[r.status]}
                      </StatusBadge>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

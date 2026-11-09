// Detalle de un pedido a PAGINA COMPLETA (replica PedidoDetalleSection del repo suelto): «Venta 1001», estado, cliente, canal, direccion, pago,
// tabla de productos, notas, incidencia, entrega y «Pedidos recientes». Autosuficiente (pide el pedido y los recientes por su cuenta) y se monta
// EN VEZ de la lista mientras haya un pedido abierto; «Volver» regresa a la lista. Lo propio del monorepo: el estado real, el repartidor
// asignado, la propina, la hora de recogida / programacion y el boton «Historial» (bitacora de transiciones).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowLeft, Banknote, Bike, Clock, CreditCard, Globe, History, MapPin, MessageCircle, Mic, Phone, ShoppingCart, StickyNote, Store, Truck, User, Wallet } from "lucide-react";
import { Button, DataTable, RegionCargando, StatusBadge, cn, formatMoney, statusTone, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { restaurantesPedidos } from "@atiende/ui/i18n/restaurantes/pedidos";
import { fechaAnioHoraEsMx, fechaCortaHoraEsMx, hora24EsMx } from "../../../../lib/formato-fecha.ts";
import { etiquetaVenta, fetchOrder, fetchOrders, ORDER_STATUS_LABELS } from "../../lib/orders-client.ts";
import type { OrderItem, OrderSummary } from "../../lib/orders-client.ts";
import type { RepartidorMember } from "../../lib/staff-client.ts";
import { ORDER_STATUS_TONES } from "../../lib/status-tones.ts";
import "./mapa-entrega.css";

const dinero = (n: number): string => `$${formatMoney(n)}`;

const ETIQUETA_FUENTE: Record<OrderSummary["source"], Clave> = {
  voice: "restaurantes.fuente.voice",
  whatsapp: "restaurantes.fuente.whatsapp",
  web: "restaurantes.fuente.web",
  admin: "restaurantes.fuente.admin",
};
/** Formas de pago conocidas: se traducen; otra (dato libre) se muestra tal cual. */
const ETIQUETA_PAGO: Readonly<Record<string, Clave>> = { efectivo: "restaurantes.pago.efectivo", tarjeta: "restaurantes.pago.tarjeta", transferencia: "restaurantes.pago.transferencia" };

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
  const t = useT(restaurantesComun, restaurantesPedidos);
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
      .catch((err: unknown) => !cancelado && setErrorDetalle(err instanceof Error ? err.message : t("restaurantes.pedidos.detalle.errorConsulta")))
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

  // Foco: al abrir el detalle pasa al contenedor (no queda en <body>) y, cuando carga, al encabezado del pedido.
  const raiz = useRef<HTMLDivElement>(null);
  const encabezado = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    raiz.current?.focus({ preventScroll: true });
  }, [orderId]);
  const detalleId = detalle?.id;
  useEffect(() => {
    if (detalleId) encabezado.current?.focus({ preventScroll: true });
  }, [detalleId]);

  const repartidor = detalle?.assignedRepartidorId ? repartidores?.find((r) => r.id === detalle.assignedRepartidorId) : undefined;

  return (
    <div ref={raiz} tabIndex={-1} className="w-full min-w-0 space-y-4 outline-none" data-testid="pedido-detalle">
      <Button type="button" variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={onVolver}>
        <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
        {t("restaurantes.volver")}
      </Button>

      {cargando ? (
        <RegionCargando ocupado etiqueta={t("restaurantes.pedidos.detalle.cargando")} className="flex justify-center py-16" claseDs3="min-h-40" giro="h-6 w-6 text-muted-foreground" />
      ) : errorDetalle || !detalle ? (
        <div role="alert" className="w-full rounded-2xl border border-destructive/30 bg-card p-5 text-center">
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
          <p className="text-sm font-medium text-foreground">{t("restaurantes.pedidos.detalle.noCargo")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{errorDetalle ?? t("restaurantes.pedidos.detalle.noEncontrado")}</p>
          <Button className="mt-4" variant="outline" onClick={() => setReintento((v) => v + 1)}>
            {t("restaurantes.reintentar")}
          </Button>
        </div>
      ) : (
        <>
          <div className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 ref={encabezado} tabIndex={-1} className="font-display text-2xl font-semibold text-foreground outline-none">{etiquetaVenta(detalle)}</h2>
                <StatusBadge tone={statusTone(ORDER_STATUS_TONES, detalle.status)} className={cn(detalle.status === "problema" && "pedido-incidencia-chip")}>
                  {ORDER_STATUS_LABELS[detalle.status]}
                </StatusBadge>
                <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => onHistorial(detalle)}>
                  <History className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                  {t("restaurantes.historial")}
                </Button>
              </div>
              <p className="mt-1 text-pill text-muted-foreground">
                {fechaAnioHoraEsMx(detalle.createdAt)}
                {detalle.branch ? ` · ${detalle.branch}` : ""}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 text-ui min-[420px]:grid-cols-2 sm:grid-cols-3">
              <Dato icono={<User className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.cliente")}>
                {detalle.customerName}
              </Dato>
              <Dato icono={<Phone className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.telefono")}>
                {detalle.customerPhone}
              </Dato>
              <Dato icono={<IconoFuente source={detalle.source} className="h-4 w-4" />} etiqueta={t("restaurantes.pedidos.detalle.canal")}>
                {t(ETIQUETA_FUENTE[detalle.source])}
              </Dato>
              {detalle.customerAddress && (
                <Dato icono={<MapPin className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.direccion")} className="min-[420px]:col-span-2">
                  {detalle.customerAddress}
                </Dato>
              )}
              <Dato
                icono={detalle.paymentMethod === "tarjeta" ? <CreditCard className="h-4 w-4" aria-hidden="true" /> : detalle.paymentMethod === "efectivo" ? <Banknote className="h-4 w-4" aria-hidden="true" /> : <Wallet className="h-4 w-4" aria-hidden="true" />}
                etiqueta={t("restaurantes.pedidos.detalle.formaPago")}
              >
                <span className="capitalize">{detalle.paymentMethod ? (ETIQUETA_PAGO[detalle.paymentMethod] ? t(ETIQUETA_PAGO[detalle.paymentMethod] as Clave) : detalle.paymentMethod) : t("restaurantes.pedidos.detalle.pagoNoRegistrado")}</span>
              </Dato>
              {detalle.canal && (
                <Dato icono={<Truck className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.entrega")}>
                  {t(detalle.canal === "recoger" ? "restaurantes.canal.recogerEnSucursal" : "restaurantes.canal.domicilio")}
                </Dato>
              )}
              {detalle.assignedRepartidorId && (
                <Dato icono={<Bike className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.repartidor")}>
                  {repartidor?.fullName || repartidor?.email || t("restaurantes.repartidorAsignado")}
                </Dato>
              )}
              {detalle.estimatedDeliveryAt && (
                <Dato icono={<Clock className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.llegadaEstimada")}>
                  {hora24EsMx(detalle.estimatedDeliveryAt)}
                </Dato>
              )}
              {detalle.horaRecogida && (
                <Dato icono={<Clock className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.recogeA")}>
                  {hora24EsMx(detalle.horaRecogida)}
                </Dato>
              )}
              {detalle.programadoPara && (
                <Dato icono={<Clock className="h-4 w-4" aria-hidden="true" />} etiqueta={t("restaurantes.pedidos.detalle.programadoPara")}>
                  {fechaCortaHoraEsMx(detalle.programadoPara)}
                </Dato>
              )}
            </div>

            <div className="overflow-hidden rounded-xl border border-border">
              <DataTable<OrderItem>
                etiqueta={t("restaurantes.pedidos.detalle.productos")}
                filas={detalle.items}
                obtenerId={(it) => it.id}
                paginacion={false}
                vista="tabla"
                vacio={{ mensaje: t("restaurantes.pedidos.detalle.sinProductos") }}
                columnas={[
                  { id: "producto", encabezado: t("restaurantes.pedidos.detalle.producto"), principal: true, celda: (it) => (
                    <span className="text-foreground">
                      {it.name}
                      {it.tortilla ? <span className="text-muted-foreground"> · {it.tortilla}</span> : null}
                    </span>
                  ) },
                  { id: "cantidad", encabezado: t("restaurantes.pedidos.detalle.cantidad"), alinear: "right", celda: (it) => <span className="tabular-nums text-foreground">{it.quantity}</span> },
                  { id: "unitario", encabezado: t("restaurantes.pedidos.detalle.unitario"), alinear: "right", celda: (it) => <span className="tabular-nums text-muted-foreground">{dinero(Number(it.price))}</span> },
                  { id: "subtotal", encabezado: t("restaurantes.pedidos.detalle.subtotal"), alinear: "right", celda: (it) => <span className="font-medium tabular-nums text-foreground">{dinero(Number(it.price) * it.quantity)}</span> },
                ]}
              />
              <div className="divide-y divide-dashed divide-border border-t border-border bg-muted/40">
                {detalle.propina != null && (
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <span className="font-mono text-eyebrow uppercase tracking-wide text-muted-foreground">{t("restaurantes.pedidos.detalle.propina")}</span>
                    <span className="tabular-nums text-muted-foreground">{dinero(detalle.propina)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <span className="font-mono text-eyebrow uppercase tracking-wide text-muted-foreground">{t("restaurantes.pedidos.detalle.total")}</span>
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
                  <p className="text-eyebrow text-muted-foreground">{t("restaurantes.pedidos.detalle.instrucciones")}</p>
                </div>
              </div>
            )}

            {detalle.status === "problema" && detalle.incidentNote && (
              <div className="pedido-incidencia-aviso flex items-start gap-2 rounded-xl border p-3">
                <AlertTriangle className="pedido-incidencia-texto mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-ui text-foreground">{detalle.incidentNote}</p>
                  <p className="pedido-incidencia-texto text-eyebrow">{t("restaurantes.pedidos.detalle.incidencia")}</p>
                </div>
              </div>
            )}

            {detalle.deliveredAt && <p className="text-pill text-muted-foreground">{t("restaurantes.pedidos.detalle.entregadoEl", { fecha: fechaAnioHoraEsMx(detalle.deliveredAt) })}</p>}
          </div>

          <div className="space-y-2">
            <p className="px-1 font-mono text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">{t("restaurantes.pedidos.detalle.recientes")}</p>
            {cargandoRecientes ? (
              <RegionCargando ocupado etiqueta={t("restaurantes.pedidos.detalle.cargandoRecientes")} className="flex justify-center py-8" claseDs3="min-h-24" giro="h-5 w-5 text-muted-foreground" />
            ) : recientes.length === 0 ? (
              <p className="px-1 text-pill text-muted-foreground">{t("restaurantes.pedidos.detalle.sinRecientes")}</p>

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

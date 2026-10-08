// Fila de pedido del tablero (Recibidas / Enviadas): replica la fila del repo suelto (avatar, nombre, «PEDIDO #ID · VENTA nnnn», direccion,
// sucursal, monto y fecha a la derecha, y los botones de despacho). Los estados reales del monorepo que el original no tiene (Preparando,
// Listo para recoger, No recogido, Incidencia) se ven como chip y con sus botones «Marcar …»; nada de la funcion se pierde.
import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Bike, CheckCircle2, Clock, Eye, History, MapPin, Printer, ShoppingCart, Store, Truck, X } from "lucide-react";
import { Button, Checkbox, NativeSelect, StatusBadge, cn, statusTone } from "@atiende/ui";
import { fechaCortaHoraEsMx, hora24EsMx } from "../../../../lib/formato-fecha.ts";
import { idCortoPedido, nextStatusesForCanal, ORDER_STATUS_LABELS } from "../../lib/orders-client.ts";
import type { OrderStatus, OrderSummary, RepartidorSugerido } from "../../lib/orders-client.ts";
import { ETIQUETA_ESTADO_COMANDA, TONO_ESTADO_COMANDA, etiquetaInsigniaPedido } from "../../lib/pos-comandas-client.ts";
import type { EstadoComandaWire } from "../../lib/pos-comandas-client.ts";
import type { RepartidorMember } from "../../lib/staff-client.ts";
import { ORDER_STATUS_TONES } from "../../lib/status-tones.ts";
import { montoFila } from "./formato.ts";
import "./mapa-entrega.css";

/** Un pedido en camino esta «demorado» cuando ya paso su hora estimada de llegada (no es un estado guardado: se calcula). */
export function esDemorado(order: Pick<OrderSummary, "status" | "estimatedDeliveryAt">, ahoraMs: number): boolean {
  return order.status === "en_camino" && !!order.estimatedDeliveryAt && Date.parse(order.estimatedDeliveryAt) < ahoraMs;
}

const BOTON_PILDORA = "h-7 rounded-full px-3 text-eyebrow";
const BOTON_ICONO = "h-7 w-7 rounded-full p-0";

export interface FilaPedidoProps {
  readonly order: OrderSummary;
  readonly vista: "recibidas" | "enviadas";
  readonly seleccionado: boolean;
  readonly ahoraMs: number;
  readonly orgSlug: string;
  readonly repartidores: readonly RepartidorMember[] | null;
  readonly sugerido?: RepartidorSugerido | undefined;
  readonly comandaEstado?: EstadoComandaWire | undefined;
  readonly impreso: boolean;
  /** Hay una llamada en curso sobre este pedido (cambio de estado o asignacion). */
  readonly ocupado: boolean;
  readonly sinAviso: boolean;
  readonly onSinAviso: (sinAviso: boolean) => void;
  readonly onAbrir: (order: OrderSummary) => void;
  readonly onMarcar: (order: OrderSummary, status: OrderStatus) => void;
  readonly onIncidencia: (order: OrderSummary) => void;
  readonly onCancelar: (order: OrderSummary) => void;
  /** Elige repartidor: en `preparando` asigna Y pasa a en camino (Confirmar envio); en `pending` solo asigna. */
  readonly onDespachar: (order: OrderSummary, repartidorId: string) => Promise<boolean>;
  readonly onImprimir: (order: OrderSummary) => void;
  readonly onVistaPrevia: (order: OrderSummary) => void;
  readonly onHistorial: (order: OrderSummary) => void;
}

export function FilaPedido(props: FilaPedidoProps) {
  const { order, vista, seleccionado, ahoraMs, repartidores, sugerido, comandaEstado, ocupado } = props;
  const [asignando, setAsignando] = useState(false);
  const [elegido, setElegido] = useState("");
  const proximos = nextStatusesForCanal(order.status, order.canal);
  const puedeDespachar = order.canal !== "recoger" && (order.status === "pending" || order.status === "preparando");
  // Transiciones que NO son despacho, incidencia ni cancelacion (esas tienen su propio boton): «Marcar Preparando», «Marcar Listo para recoger»…
  const marcas = proximos.filter((s) => s !== "en_camino" && s !== "cancelado" && s !== "problema");
  const repartidor = order.assignedRepartidorId ? repartidores?.find((r) => r.id === order.assignedRepartidorId) : undefined;
  const demorado = esDemorado(order, ahoraMs);
  const etiquetaConfirmar = order.status === "preparando" ? "Confirmar envío" : "Asignar";

  const alAsignar = (): void => {
    setElegido(order.assignedRepartidorId ?? sugerido?.repartidorId ?? "");
    setAsignando(true);
  };
  const alConfirmar = async (): Promise<void> => {
    if (!elegido) return;
    if (await props.onDespachar(order, elegido)) setAsignando(false);
  };
  const detener = (e: { stopPropagation: () => void }): void => e.stopPropagation();

  const chips: React.ReactNode[] = [];
  if (order.canal) chips.push(<StatusBadge key="canal" tone="neutral" dot={false} className="text-2xs" data-testid={`canal-${order.id}`}>{order.canal === "recoger" ? "Recoger" : "Domicilio"}</StatusBadge>);
  if (comandaEstado) {
    chips.push(
      <Link key="pos" to={`/restaurantes/${props.orgSlug}/comandas-pos`} onClick={detener} className="no-underline" title={`Comanda al POS: ${ETIQUETA_ESTADO_COMANDA[comandaEstado]}. Ver la cola.`} data-testid={`comanda-pos-${order.id}`}>
        <StatusBadge tone={TONO_ESTADO_COMANDA[comandaEstado]} dot={false} className="text-2xs">{etiquetaInsigniaPedido(comandaEstado)}</StatusBadge>
      </Link>,
    );
  }
  if (order.status !== "pending") {
    chips.push(
      <StatusBadge key="estado" tone={statusTone(ORDER_STATUS_TONES, order.status)} className={cn("text-2xs", order.status === "problema" && "pedido-incidencia-chip")} data-testid={`estado-${order.id}`}>
        {ORDER_STATUS_LABELS[order.status]}
      </StatusBadge>,
    );
  }

  return (
    <div
      onClick={() => props.onAbrir(order)}
      data-testid={`pedido-${order.id}`}
      data-seleccionado={seleccionado ? "true" : "false"}
      className={cn("cursor-pointer border-b border-dashed border-border p-3 transition-colors last:border-0", seleccionado ? "bg-primary/5" : "hover:bg-muted/40")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <ShoppingCart className="h-5 w-5 text-primary" strokeWidth={1.75} aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-0.5">
            <button type="button" onClick={(e) => { detener(e); props.onAbrir(order); }} className="block max-w-full truncate rounded text-left text-ui font-medium text-foreground" aria-label={`Abrir el pedido de ${order.customerName}`}>
              {order.customerName}
            </button>
            <p className="font-mono text-eyebrow uppercase tracking-[0.06em] text-muted-foreground">
              Pedido #{idCortoPedido(order.id)}
              {order.orderNumber != null && (
                <>
                  {" "}· Venta <span className="tabular-nums">{String(order.orderNumber).padStart(4, "0")}</span>
                </>
              )}
            </p>
            {order.customerAddress && (
              <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                <span className="truncate">{order.customerAddress}</span>
              </p>
            )}
            {order.branch && (
              <p className="flex items-center gap-1 text-eyebrow text-muted-foreground">
                <Store className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> {order.branch}
              </p>
            )}
          </div>
        </div>
        <div className="shrink-0 space-y-1 text-right">
          <p className="font-display text-ui font-semibold tabular-nums text-foreground">{montoFila(order.total)}</p>
          <p className="text-eyebrow text-muted-foreground">{fechaCortaHoraEsMx(order.createdAt)}</p>
        </div>
      </div>

      {(chips.length > 0 || order.horaRecogida) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:ml-[52px]">
          {chips}
          {order.horaRecogida && (
            <span className="text-eyebrow text-muted-foreground" data-testid={`recoger-${order.id}`}>
              Recoge a las {hora24EsMx(order.horaRecogida)}
            </span>
          )}
        </div>
      )}
      {order.incidentNote && (
        <p className="mt-1.5 flex items-center gap-1 text-xs text-destructive sm:ml-[52px]">
          <AlertTriangle className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          {order.incidentNote}
        </p>
      )}

      {vista === "enviadas" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 sm:ml-[52px]">
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground">
            <Bike className="h-3.5 w-3.5 text-primary" strokeWidth={1.75} aria-hidden="true" />
            {repartidor?.fullName || repartidor?.email || "Repartidor"}
          </span>
          {order.estimatedDeliveryAt && (
            <span className={cn("inline-flex items-center gap-1.5 text-xs", demorado ? "font-medium text-destructive" : "text-muted-foreground")} data-testid={`eta-${order.id}`}>
              <Clock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
              {demorado ? "Demorado — debía llegar " : "Llega "}
              {hora24EsMx(order.estimatedDeliveryAt)}
            </span>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-1.5" onClick={detener}>
            {proximos.includes("problema") && (
              <Button type="button" size="sm" variant="outline" className={cn(BOTON_PILDORA, "pedido-incidencia-boton")} onClick={() => props.onIncidencia(order)}>
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                Incidencia
              </Button>
            )}
            {proximos.includes("entregado") && (
              <Button type="button" size="sm" variant="outline" className={BOTON_PILDORA} loading={ocupado} disabled={ocupado} onClick={() => props.onMarcar(order, "entregado")}>
                {!ocupado && <CheckCircle2 className="h-3 w-3" aria-hidden="true" />}
                Marcar entregado
              </Button>
            )}
            <AccionesTicket {...props} />
          </div>
        </div>
      )}

      {vista === "recibidas" && (
        <div className="mt-2.5 sm:ml-[52px]" onClick={detener}>
          {asignando ? (
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                id={`repartidor-${order.id}`}
                aria-label="Elegir repartidor"
                size="sm"
                value={elegido}
                disabled={ocupado || !repartidores || repartidores.length === 0}
                onChange={(e) => setElegido(e.target.value)}
                wrapperClassName="w-full max-w-[220px]"
              >
                <option value="">{repartidores && repartidores.length === 0 ? "Sin repartidores registrados" : "Elegir repartidor"}</option>
                {repartidores?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName || r.email}
                  </option>
                ))}
              </NativeSelect>
              <Button type="button" size="sm" className="h-8 rounded-full px-3 text-xs" loading={ocupado} disabled={ocupado || !elegido} onClick={() => void alConfirmar()}>
                {!ocupado && <Truck className="h-3 w-3" aria-hidden="true" />}
                {etiquetaConfirmar}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-8 rounded-full px-2 text-xs" disabled={ocupado} onClick={() => setAsignando(false)}>
                Cancelar
              </Button>
              {sugerido && !order.assignedRepartidorId && (
                <span className="text-eyebrow text-muted-foreground" data-testid={`sugerido-${order.id}`}>
                  Sugerido: {sugerido.nombre}
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {proximos.includes("listo_para_recoger") && (
                <Checkbox checked={!props.sinAviso} onChange={(e) => props.onSinAviso(!e.target.checked)} label="Avisar al cliente por WhatsApp cuando esté listo" wrapperClassName="text-eyebrow" />
              )}
              {marcas.map((s) => (
                <Button key={s} type="button" size="sm" variant="outline" className={BOTON_PILDORA} loading={ocupado} disabled={ocupado} onClick={() => props.onMarcar(order, s)}>
                  Marcar {ORDER_STATUS_LABELS[s]}
                </Button>
              ))}
              {puedeDespachar && (
                <Button type="button" size="sm" variant="outline" className={BOTON_PILDORA} disabled={ocupado} onClick={alAsignar}>
                  <Bike className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  Asignar repartidor
                </Button>
              )}
              {proximos.includes("problema") && (
                <Button type="button" size="sm" variant="outline" className={cn(BOTON_PILDORA, "pedido-incidencia-boton")} onClick={() => props.onIncidencia(order)}>
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Incidencia
                </Button>
              )}
              {proximos.includes("cancelado") && (
                <Button type="button" size="sm" variant="danger-outline" className={BOTON_PILDORA} disabled={ocupado} onClick={() => props.onCancelar(order)}>
                  <X className="h-3 w-3" aria-hidden="true" />
                  Cancelar pedido
                </Button>
              )}
              <AccionesTicket {...props} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Funciones del monorepo que el original no tiene, compactas como botones de icono: ticket de cocina, vista previa e historial del pedido. */
function AccionesTicket({ order, impreso, onImprimir, onVistaPrevia, onHistorial }: FilaPedidoProps) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <Button type="button" size="sm" variant="ghost" className={BOTON_ICONO} aria-label={impreso ? "Reimprimir ticket" : "Imprimir ticket"} title={impreso ? "Reimprimir ticket" : "Imprimir ticket"} onClick={() => onImprimir(order)}>
        <Printer className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <Button type="button" size="sm" variant="ghost" className={BOTON_ICONO} aria-label="Vista previa" title="Vista previa del ticket" onClick={() => onVistaPrevia(order)}>
        <Eye className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      </Button>
      <Button type="button" size="sm" variant="ghost" className={BOTON_ICONO} aria-label="Historial" title="Historial del pedido" onClick={() => onHistorial(order)}>
        <History className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
      </Button>
    </span>
  );
}

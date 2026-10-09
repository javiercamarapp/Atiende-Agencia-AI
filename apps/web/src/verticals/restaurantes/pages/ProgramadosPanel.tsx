// Vista «Órdenes programadas» (R-11 + UNI-R1): pedidos que el cliente dejo para una hora futura, a pantalla completa y sin mapa, como el repo
// suelto. Siguen fuera de cocina hasta que se promueven solos a «Recibido» ANTICIPACION_PROMOCION_MIN antes de su hora (la promocion la hace el
// servidor al consultar; aqui, ademas, la fila sale de la vista en cuanto llega su hora de promocion, igual que el original). Desde aqui el
// staff puede ADELANTAR el pedido a cocina o CANCELARLO (la cancelacion pide motivo en Pedidos.tsx).
import { CalendarClock, MapPin, Store } from "lucide-react";
import { Button, StatusBadge, cn, statusTone } from "@atiende/ui";
import { montoFila } from "../components/pedidos/formato.ts";
import { fechaCortaHoraEsMx, hora24EsMx } from "../../../lib/formato-fecha.ts";
import { faltaPara } from "../lib/sondeo-pedidos.ts";
import { idCortoPedido, ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";
import type { OrderSummary } from "../lib/orders-client.ts";

/** Minutos antes de la hora en que el servidor lo promueve a cocina (espejo de ANTICIPACION_PROMOCION_MIN del dominio). */
export const ANTICIPACION_PROMOCION_MIN = 30;

/** `true` mientras el pedido sigue esperando su hora (aun no le toca entrar a cocina). */
export function sigueProgramado(order: Pick<OrderSummary, "programadoPara">, ahoraMs: number): boolean {
  if (!order.programadoPara) return true;
  const objetivo = Date.parse(order.programadoPara) - ANTICIPACION_PROMOCION_MIN * 60_000;
  return Number.isNaN(objetivo) || ahoraMs < objetivo;
}

export function ProgramadosPanel({
  orders,
  disponible,
  ahoraMs,
  changingId,
  onAbrir,
  onAdelantar,
  onCancelar,
}: {
  readonly orders: readonly OrderSummary[];
  /** `false` = la base aun no tiene la migracion de pedidos programados. */
  readonly disponible: boolean;
  readonly ahoraMs: number;
  readonly changingId: string | null;
  readonly onAbrir: (order: OrderSummary) => void;
  readonly onAdelantar: (order: OrderSummary) => void;
  readonly onCancelar: (order: OrderSummary) => void;
}) {
  const visibles = orders
    .filter((o) => sigueProgramado(o, ahoraMs))
    .slice()
    .sort((a, b) => Date.parse(a.programadoPara ?? "") - Date.parse(b.programadoPara ?? ""));
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4" data-testid="programados-lista">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <p className="font-mono text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">Se promueven a Recibidas automáticamente {ANTICIPACION_PROMOCION_MIN} min antes de su hora</p>
      </div>

      {!disponible ? (
        <div className="py-16 text-center" role="status">
          <CalendarClock className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-ui text-muted-foreground">Los pedidos programados todavía no están disponibles en esta cuenta (falta aplicar la actualización de base de datos).</p>
        </div>
      ) : visibles.length === 0 ? (
        <div className="py-16 text-center" role="status">
          <CalendarClock className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-ui text-muted-foreground">No hay pedidos programados</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {visibles.map((o) => (
            <div key={o.id} onClick={() => onAbrir(o)} data-testid={`programado-${o.id}`} className="cursor-pointer border-b border-dashed border-border p-3 transition-colors last:border-0 hover:bg-muted/40">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <CalendarClock className="h-5 w-5 text-primary" strokeWidth={1.75} aria-hidden="true" />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <button type="button" onClick={(e) => { e.stopPropagation(); onAbrir(o); }} className="block max-w-full truncate rounded text-left text-ui font-medium text-foreground" aria-label={`Abrir el pedido de ${o.customerName}`}>
                      {o.customerName}
                    </button>
                    <p className="font-mono text-eyebrow uppercase tracking-[0.06em] text-muted-foreground">
                      Pedido #{idCortoPedido(o.id)}
                      {o.orderNumber != null && (
                        <>
                          {" "}· Venta <span className="tabular-nums">{String(o.orderNumber).padStart(4, "0")}</span>
                        </>
                      )}
                    </p>
                    {o.customerAddress && (
                      <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                        <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> <span className="truncate">{o.customerAddress}</span>
                      </p>
                    )}
                    {o.branch && (
                      <p className="flex items-center gap-1 text-eyebrow text-muted-foreground">
                        <Store className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> {o.branch}
                      </p>
                    )}
                  </div>
                </div>
                <div className="shrink-0 space-y-1 text-right">
                  <p className="font-display text-ui font-semibold tabular-nums text-foreground">{montoFila(o.total)}</p>
                  {o.programadoPara && (
                    <>
                      <p className="text-pill font-medium tabular-nums text-primary" data-testid={`programado-para-${o.id}`}>
                        {fechaCortaHoraEsMx(o.programadoPara)}
                      </p>
                      <p className="text-eyebrow text-muted-foreground">{faltaPara(o.programadoPara, ahoraMs)}</p>
                      <p className="text-eyebrow text-muted-foreground">entra a cocina a las {hora24EsMx(new Date(Date.parse(o.programadoPara) - ANTICIPACION_PROMOCION_MIN * 60_000))}</p>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:ml-[52px]">
                {o.canal && (
                  <StatusBadge tone="neutral" dot={false} className="text-2xs">
                    {o.canal === "recoger" ? "Recoger" : "Domicilio"}
                  </StatusBadge>
                )}
                <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)} className="text-2xs">
                  {ORDER_STATUS_LABELS[o.status]}
                </StatusBadge>
              </div>
              <div className={cn("mt-2.5 flex flex-wrap items-center gap-1.5 sm:ml-[52px]")} onClick={(e) => e.stopPropagation()}>
                <Button type="button" size="sm" variant="outline" className="h-7 rounded-full px-3 text-eyebrow" loading={changingId === o.id} disabled={changingId === o.id} onClick={() => onAdelantar(o)}>
                  Enviar a cocina ahora
                </Button>
                <Button type="button" size="sm" variant="danger-outline" className="h-7 rounded-full px-3 text-eyebrow" disabled={changingId === o.id} onClick={() => onCancelar(o)}>
                  Cancelar pedido
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

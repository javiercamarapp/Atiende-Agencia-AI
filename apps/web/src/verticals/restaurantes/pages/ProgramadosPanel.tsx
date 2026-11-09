// Vista «Órdenes programadas» (R-11 + UNI-R1): pedidos que el cliente dejo para una hora futura, a pantalla completa y sin mapa, como el repo
// suelto. Siguen fuera de cocina hasta que se promueven solos a «Recibido» ANTICIPACION_PROMOCION_MIN antes de su hora (la promocion la hace el
// servidor al consultar; aqui, ademas, la fila sale de la vista en cuanto llega su hora de promocion, igual que el original). Desde aqui el
// staff puede ADELANTAR el pedido a cocina o CANCELARLO (la cancelacion pide motivo en Pedidos.tsx).
import { CalendarClock, MapPin, Store } from "lucide-react";
import { Button, StatusBadge, cn, statusTone, useT } from "@atiende/ui";
import { restaurantesAutopiloto } from "@atiende/ui/i18n/restaurantes/autopiloto";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { restaurantesPedidos } from "@atiende/ui/i18n/restaurantes/pedidos";
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
  const t = useT(restaurantesComun, restaurantesPedidos, restaurantesAutopiloto);
  const visibles = orders
    .filter((o) => sigueProgramado(o, ahoraMs))
    .slice()
    .sort((a, b) => Date.parse(a.programadoPara ?? "") - Date.parse(b.programadoPara ?? ""));
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4" data-testid="programados-lista">
      <div className="flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
        <p className="font-mono text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">{t("restaurantes.autopiloto.prog.promueven", { min: ANTICIPACION_PROMOCION_MIN })}</p>
      </div>

      {!disponible ? (
        <div className="py-16 text-center" role="status">
          <CalendarClock className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-ui text-muted-foreground">{t("restaurantes.autopiloto.prog.noDisponible")}</p>
        </div>
      ) : visibles.length === 0 ? (
        <div className="py-16 text-center" role="status">
          <CalendarClock className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-ui text-muted-foreground">{t("restaurantes.autopiloto.prog.vacio")}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          {visibles.map((o) => (
            // La fila entera abre el pedido con un <button> real (Tab, Enter y Espacio nativos, anillo de foco global de @atiende/ui).
            // Las acciones «Enviar a cocina ahora» y «Cancelar pedido» quedan FUERA del boton: no se anidan controles (HTML valido, sin
            // nested-interactive). Dentro del boton solo hay contenido de frase (span), por eso los bloques son <span className="block">.
            <div key={o.id} data-testid={`programado-${o.id}`} className="border-b border-dashed border-border p-3 transition-colors last:border-0 hover:bg-muted/40">
              <button type="button" onClick={() => onAbrir(o)} className="block w-full cursor-pointer rounded-lg text-left" aria-label={t("restaurantes.pedidos.fila.abrir", { cliente: o.customerName })} data-testid={`programado-abrir-${o.id}`}>
                <span className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <CalendarClock className="h-5 w-5 text-primary" strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <span className="block min-w-0 space-y-0.5">
                      <span className="block max-w-full truncate text-ui font-medium text-foreground">{o.customerName}</span>
                      <span className="block font-mono text-eyebrow uppercase tracking-[0.06em] text-muted-foreground">
                        {t("restaurantes.pedidos.fila.pedido", { id: idCortoPedido(o.id) })}
                        {o.orderNumber != null && (
                          <>
                            {" "}· {t("restaurantes.pedidos.fila.venta")} <span className="tabular-nums">{String(o.orderNumber).padStart(4, "0")}</span>
                          </>
                        )}
                      </span>
                      {o.customerAddress && (
                        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                          <MapPin className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> <span className="truncate">{o.customerAddress}</span>
                        </span>
                      )}
                      {o.branch && (
                        <span className="flex items-center gap-1 text-eyebrow text-muted-foreground">
                          <Store className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" /> {o.branch}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="block shrink-0 space-y-1 text-right">
                    <span className="block font-display text-ui font-semibold tabular-nums text-foreground">{montoFila(o.total)}</span>
                    {o.programadoPara && (
                      <>
                        <span className="block text-pill font-medium tabular-nums text-primary" data-testid={`programado-para-${o.id}`}>
                          {fechaCortaHoraEsMx(o.programadoPara)}
                        </span>
                        <span className="block text-eyebrow text-muted-foreground">{faltaPara(o.programadoPara, ahoraMs)}</span>
                        <span className="block text-eyebrow text-muted-foreground">{t("restaurantes.autopiloto.prog.entraCocina", { hora: hora24EsMx(new Date(Date.parse(o.programadoPara) - ANTICIPACION_PROMOCION_MIN * 60_000)) })}</span>
                      </>
                    )}
                  </span>
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-1.5 sm:ml-[52px]">
                  {o.canal && (
                    <StatusBadge tone="neutral" dot={false} className="text-2xs">
                      {t(o.canal === "recoger" ? "restaurantes.canal.recoger" : "restaurantes.canal.domicilio")}
                    </StatusBadge>
                  )}
                  <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)} className="text-2xs">
                    {ORDER_STATUS_LABELS[o.status]}
                  </StatusBadge>
                </span>
              </button>
              <div className={cn("mt-2.5 flex flex-wrap items-center gap-1.5 sm:ml-[52px]")}>
                <Button type="button" size="sm" variant="outline" className="h-7 rounded-full px-3 text-eyebrow" loading={changingId === o.id} disabled={changingId === o.id} onClick={() => onAdelantar(o)}>
                  {t("restaurantes.autopiloto.prog.enviarCocina")}
                </Button>
                <Button type="button" size="sm" variant="danger" className="h-7 rounded-full px-3 text-eyebrow" disabled={changingId === o.id} onClick={() => onCancelar(o)}>
                  {t("restaurantes.pedidos.fila.cancelarPedido")}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

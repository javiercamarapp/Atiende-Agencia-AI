// Pestana "Programados" (R-11): pedidos que el cliente dejo para una hora futura. Siguen fuera de cocina hasta
// que se promueven solos a "Recibido" (30 min antes de la hora; la promocion la hace el servidor al consultar).
// Desde aqui el staff puede ADELANTARLO a cocina o CANCELARLO (la cancelacion pide confirmacion en Pedidos.tsx).
import { Badge, Button, Card, CardContent, EstadoVacio, StatusBadge, formatMoney, statusTone } from "@atiende/ui";
import { CalendarClock } from "lucide-react";
import { faltaPara } from "../lib/sondeo-pedidos.ts";
import { ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import type { OrderSummary } from "../lib/orders-client.ts";
import { ORDER_STATUS_TONES } from "../lib/status-tones.ts";

/** Minutos antes de la hora en que el servidor lo promueve a cocina (espejo de ANTICIPACION_PROMOCION_MIN del dominio). */
export const ANTICIPACION_PROMOCION_MIN = 30;

function formatoHora(iso: string): string {
  return new Date(iso).toLocaleString("es-MX", { weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatoSoloHora(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export function ProgramadosPanel({
  orders,
  disponible,
  ahoraMs,
  changingId,
  onAdelantar,
  onCancelar,
}: {
  readonly orders: readonly OrderSummary[];
  /** `false` = la base aun no tiene la migracion de pedidos programados. */
  readonly disponible: boolean;
  readonly ahoraMs: number;
  readonly changingId: string | null;
  readonly onAdelantar: (order: OrderSummary) => void;
  readonly onCancelar: (order: OrderSummary) => void;
}) {
  if (!disponible) {
    return <EstadoVacio mensaje="Los pedidos programados todavía no están disponibles en esta cuenta (falta aplicar la actualización de base de datos)." />;
  }
  if (orders.length === 0) return <EstadoVacio mensaje="No hay pedidos programados." />;
  return (
    <div className="flex flex-col gap-2.5" data-testid="programados-lista">
      {orders.map((o) => {
        const entraACocina = o.programadoPara ? formatoSoloHora(new Date(Date.parse(o.programadoPara) - ANTICIPACION_PROMOCION_MIN * 60_000).toISOString()) : null;
        return (
          <Card key={o.id}>
            <CardContent className="p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <div>
                  <p className="m-0 font-semibold text-foreground">
                    {o.customerName} · ${formatMoney(o.total)}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {o.customerPhone} · {o.branch ?? "sin sucursal"}
                  </p>
                </div>
                <div className="flex flex-wrap items-start gap-1.5 self-start">
                  {o.canal && <Badge variant="outline">{o.canal === "recoger" ? "Recoger" : "Domicilio"}</Badge>}
                  <StatusBadge tone={statusTone(ORDER_STATUS_TONES, o.status)}>{ORDER_STATUS_LABELS[o.status]}</StatusBadge>
                </div>
              </div>
              {o.programadoPara && (
                <p className="mt-2 inline-flex flex-wrap items-center gap-1.5 text-sm text-foreground" data-testid={`programado-para-${o.id}`}>
                  <CalendarClock className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                  <span className="font-medium capitalize">{formatoHora(o.programadoPara)}</span>
                  <span className="text-xs text-muted-foreground">
                    ({faltaPara(o.programadoPara, ahoraMs)}) · entra a cocina a las {entraACocina}
                  </span>
                </p>
              )}
              <p className="mt-2 text-sm text-foreground">{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                <Button type="button" size="sm" variant="outline" className="h-9 text-xs" disabled={changingId === o.id} onClick={() => onAdelantar(o)}>
                  {changingId === o.id ? "…" : "Enviar a cocina ahora"}
                </Button>
                <Button type="button" size="sm" variant="destructive" className="h-9 text-xs" disabled={changingId === o.id} onClick={() => onCancelar(o)}>
                  Cancelar pedido
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

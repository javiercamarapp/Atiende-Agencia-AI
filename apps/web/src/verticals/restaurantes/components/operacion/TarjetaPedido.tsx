// Tarjeta de un pedido de la cola movil del encargado (PLAN-PANEL-OPERADOR §5.4-A). Presentacional: no hace red; recibe la accion ya
// resuelta por el servidor (`accionesDisponibles`). Boton grande >= 56 dp (h-14), desactivado tras el primer toque.
import { Button, Card, CardContent, StatusBadge, cn, formatMoney } from "@atiende/ui";
import type { TarjetaPedido as TarjetaPedidoDato } from "@atiende/domain-restaurantes/operacion";
import { BellOff, Home, MessageSquareOff, Store } from "lucide-react";
import { Link } from "react-router-dom";
import { horaEsMx } from "../../../../lib/formato-fecha.ts";
import { ETIQUETA_ACCION, accionPrincipal, etiquetaOrigen } from "../../lib/operacion-presentacion.ts";
import { semaforoPedido } from "../../lib/semaforo.ts";
import { SemaforoMinutos } from "./SemaforoMinutos.tsx";

export interface TarjetaPedidoProps {
  readonly pedido: TarjetaPedidoDato;
  /** Minutos ya ajustados al reloj de este telefono. */
  readonly minutos: number;
  readonly ocupado: boolean;
  /** Pedido nuevo que aun no se ha tocado (suena la alerta): borde fijo, sin parpadeo. */
  readonly sinReconocer: boolean;
  readonly alAccion: (pedido: TarjetaPedidoDato, accion: "aceptar" | "listo" | "entregar") => void;
  readonly alReconocer: (pedido: TarjetaPedidoDato) => void;
  /** Ruta de Viajes para los domicilios listos (el despacho se hace alli, con chofer). */
  readonly rutaViajes: string;
}

export function TarjetaPedido({ pedido, minutos, ocupado, sinReconocer, alAccion, alReconocer, rutaViajes }: TarjetaPedidoProps) {
  const semaforo = semaforoPedido(pedido.estado, pedido.canal, minutos);
  const accion = accionPrincipal(pedido);
  const listoDomicilio = pedido.canal === "domicilio" && pedido.estado === "preparando" && pedido.listoAt !== null;
  const domicilio = pedido.canal === "domicilio";
  const Canal = domicilio ? Home : Store;
  return (
    <Card
      data-testid={`tarjeta-pedido-${pedido.numero}`}
      data-semaforo={semaforo}
      className={cn("border-2", sinReconocer ? "border-primary" : "border-border")}
      onClick={sinReconocer ? () => alReconocer(pedido) : undefined}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xl font-bold text-foreground">#{pedido.numero}</h3>
          <span className="text-sm text-muted-foreground">{horaEsMx(pedido.creadoEn)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="neutral" dot={false} className="text-sm">
            <Canal className="size-4" aria-hidden="true" />
            {domicilio ? "Domicilio" : "Recoger"}
          </StatusBadge>
          <StatusBadge tone="neutral" dot={false} className="text-sm">
            {etiquetaOrigen(pedido.origen)}
          </StatusBadge>
          {pedido.sinAviso && (
            <StatusBadge tone="warning" dot={false} className="text-sm">
              <MessageSquareOff className="size-4" aria-hidden="true" />
              Sin aviso al cliente: llamar
            </StatusBadge>
          )}
        </div>
        <div className="space-y-0.5">
          <p className="text-base font-medium text-foreground">{pedido.clienteNombre}</p>
          <p className="text-base text-muted-foreground">{pedido.resumenItems}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xl font-bold text-foreground">${formatMoney(pedido.total)}</p>
          <SemaforoMinutos semaforo={semaforo} minutos={minutos} prefijo={pedido.estado === "pending" ? "Esperando" : pedido.estado === "en_camino" ? "En camino" : undefined} />
        </div>
        {accion && accion !== "salio" && (
          <Button
            type="button"
            className="h-14 w-full text-lg"
            disabled={ocupado}
            loading={ocupado}
            aria-label={`${ETIQUETA_ACCION[accion]} pedido #${pedido.numero}`}
            onClick={(e) => {
              e.stopPropagation();
              alAccion(pedido, accion);
            }}
          >
            {ETIQUETA_ACCION[accion]}
          </Button>
        )}
        {(accion === "salio" || listoDomicilio) && (
          <Button asChild className="h-14 w-full text-lg" variant="outline">
            <Link to={rutaViajes} aria-label={`Despachar pedido #${pedido.numero} en Viajes`}>
              Despachar en Viajes
            </Link>
          </Button>
        )}
        {sinReconocer && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <BellOff className="size-4" aria-hidden="true" />
            Toca la tarjeta para detener el aviso.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

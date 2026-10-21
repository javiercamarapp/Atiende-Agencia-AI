// Tarjeta grande de una entrega del chofer (PLAN-PANEL-OPERADOR §5.4 boceto E). Solo pinta y avisa: la logica (red, cola, confirmaciones) vive
// en `MisEntregas.tsx`. Botones de 56 dp (`h-14`), el telefono NUNCA aparece (el boton «Llamar» lo pide al servidor, auditado), y todo boton queda
// desactivado en cuanto hay una accion en curso sobre ESTE pedido (un solo toque, sin dobles envios).
import { Card, CardContent, StatusBadge, Button, formatMoney } from "@atiende/ui";
import type { EntregaChofer } from "@atiende/domain-restaurantes/operacion";
import { AlertTriangle, Check, MapPin, Navigation, Phone, Undo2 } from "lucide-react";
import { cambioDe, minutosEnCamino, segundosParaDeshacer, TONO_SEMAFORO, urlNavegar } from "../../lib/chofer-entregas.ts";

export type AccionEnCurso = "entregar" | "deshacer" | "problema" | "llamar";

export interface TarjetaEntregaProps {
  readonly entrega: EntregaChofer;
  readonly ahoraMs: number;
  /** Accion que ya se disparo sobre este pedido (desactiva todos sus botones). */
  readonly enCurso: AccionEnCurso | null;
  /** «Entregado» guardado en el celular por falta de senal, aun sin enviar al servidor. */
  readonly pendienteDeEnvio: boolean;
  readonly onEntregar: (e: EntregaChofer) => void;
  readonly onProblema: (e: EntregaChofer) => void;
  readonly onLlamar: (e: EntregaChofer) => void;
  readonly onDeshacer: (e: EntregaChofer) => void;
}

function etiquetaPago(e: EntregaChofer): string {
  if (e.pago.forma === "efectivo") return "Efectivo";
  if (e.pago.forma === "tarjeta") return "Tarjeta (lleva terminal)";
  return "Forma de pago sin registrar";
}

export function TarjetaEntrega({ entrega: e, ahoraMs, enCurso, pendienteDeEnvio, onEntregar, onProblema, onLlamar, onDeshacer }: TarjetaEntregaProps) {
  const ocupado = enCurso !== null;
  const activa = e.estado === "en_camino";
  const mapa = urlNavegar(e.direccion);
  const cambio = e.pago.forma === "efectivo" ? cambioDe(e.total, e.pago.pagaCon) : null;
  const minutos = minutosEnCamino(e, ahoraMs);
  const segundos = e.estado === "entregado" ? segundosParaDeshacer(e.puedeDeshacerHasta, ahoraMs) : null;
  const direccion = [e.direccion.texto, e.direccion.colonia].filter((p): p is string => Boolean(p)).join(", ");

  return (
    <Card>
      <CardContent className="p-4">
        <article aria-label={`Pedido ${e.numero}`} className="flex flex-col gap-3">
          <header className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="m-0 font-display text-xl font-semibold text-foreground">
              #{e.numero} · {e.clienteNombre}
            </h2>
            {activa && <StatusBadge tone={TONO_SEMAFORO[e.semaforo]}>{minutos} min</StatusBadge>}
            {e.estado === "entregado" && <StatusBadge tone="success">{pendienteDeEnvio ? "Entregado · por enviar" : "Entregado"}</StatusBadge>}
            {e.estado === "problema" && <StatusBadge tone="danger">Problema reportado</StatusBadge>}
          </header>

          <p className="m-0 flex items-start gap-1.5 text-base text-foreground">
            <MapPin className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span>{direccion || "Sin dirección registrada"}</span>
          </p>
          {e.indicaciones && <p className="m-0 text-base text-muted-foreground">Indicaciones: {e.indicaciones}</p>}

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="m-0 font-display text-xl font-semibold tabular-nums text-foreground">Total ${formatMoney(e.total)}</p>
            <StatusBadge tone={e.pago.forma === "efectivo" ? "warning" : e.pago.forma === "tarjeta" ? "info" : "neutral"} dot={false}>
              {etiquetaPago(e)}
            </StatusBadge>
          </div>
          {e.pago.forma === "efectivo" && e.pago.pagaCon !== null && (
            <p className="m-0 text-base text-foreground tabular-nums">
              Paga con ${formatMoney(e.pago.pagaCon)}
              {cambio !== null && <> · cambio ${formatMoney(cambio)}</>}
            </p>
          )}
          <p className="m-0 text-sm text-muted-foreground">
            {e.totalPiezas} {e.totalPiezas === 1 ? "pieza" : "piezas"} · {e.resumenItems}
          </p>

          {activa && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {mapa && !ocupado ? (
                  <Button asChild variant="outline" className="h-14 w-full">
                    <a href={mapa} target="_blank" rel="noreferrer" aria-label={`Navegar al pedido ${e.numero}`}>
                      <Navigation />
                      Navegar
                    </a>
                  </Button>
                ) : (
                  <Button type="button" variant="outline" className="h-14 w-full" disabled>
                    <Navigation />
                    {mapa ? "Navegar" : "Sin mapa"}
                  </Button>
                )}
                <Button type="button" variant="outline" className="h-14 w-full" disabled={ocupado} loading={enCurso === "llamar"} aria-label={`Llamar al cliente del pedido ${e.numero}`} onClick={() => onLlamar(e)}>
                  <Phone />
                  Llamar
                </Button>
              </div>
              <Button type="button" className="h-14 w-full text-base" disabled={ocupado} loading={enCurso === "entregar"} aria-label={`Entregado, pedido ${e.numero}`} onClick={() => onEntregar(e)}>
                <Check />
                Entregado
              </Button>
              <Button type="button" variant="danger-outline" className="h-14 w-full" disabled={ocupado} aria-label={`No pude entregar el pedido ${e.numero}`} onClick={() => onProblema(e)}>
                <AlertTriangle />
                No pude entregar
              </Button>
            </>
          )}

          {e.estado === "entregado" && segundos !== null && segundos > 0 && (
            <Button type="button" variant="outline" className="h-14 w-full" disabled={ocupado} loading={enCurso === "deshacer"} aria-label={`Deshacer la entrega del pedido ${e.numero}`} onClick={() => onDeshacer(e)}>
              <Undo2 />
              Deshacer ({segundos} s)
            </Button>
          )}
        </article>
      </CardContent>
    </Card>
  );
}

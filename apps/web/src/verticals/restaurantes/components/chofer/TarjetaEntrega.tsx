// Tarjeta grande de una entrega del chofer (PLAN-PANEL-OPERADOR §5.4 boceto E). Solo pinta y avisa: la logica (red, cola, confirmaciones) vive
// en `MisEntregas.tsx`. Botones de 56 dp (`h-14`), el telefono NUNCA aparece (el boton «Llamar» lo pide al servidor, auditado), y todo boton queda
// desactivado en cuanto hay una accion en curso sobre ESTE pedido (un solo toque, sin dobles envios).
import { Card, CardContent, StatusBadge, Button, formatMoney, useT } from "@atiende/ui";
import type { Traductor } from "@atiende/ui";
import { restaurantesChofer } from "@atiende/ui/i18n/restaurantes/chofer";
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

function etiquetaPago(e: EntregaChofer, t: Traductor): string {
  if (e.pago.forma === "efectivo") return t("restaurantes.chofer.tarjeta.pago.efectivo");
  if (e.pago.forma === "tarjeta") return t("restaurantes.chofer.tarjeta.pago.tarjeta");
  return t("restaurantes.chofer.tarjeta.pago.sinRegistrar");
}

export function TarjetaEntrega({ entrega: e, ahoraMs, enCurso, pendienteDeEnvio, onEntregar, onProblema, onLlamar, onDeshacer }: TarjetaEntregaProps) {
  const t = useT(restaurantesChofer);
  const ocupado = enCurso !== null;
  const numero = String(e.numero);
  const activa = e.estado === "en_camino";
  const mapa = urlNavegar(e.direccion);
  const cambio = e.pago.forma === "efectivo" ? cambioDe(e.total, e.pago.pagaCon) : null;
  const minutos = minutosEnCamino(e, ahoraMs);
  const segundos = e.estado === "entregado" ? segundosParaDeshacer(e.puedeDeshacerHasta, ahoraMs) : null;
  const direccion = [e.direccion.texto, e.direccion.colonia].filter((p): p is string => Boolean(p)).join(", ");

  return (
    <Card>
      <CardContent className="p-4">
        <article aria-label={t("restaurantes.chofer.tarjeta.aria", { numero })} className="flex flex-col gap-3">
          <header className="flex flex-wrap items-start justify-between gap-2">
            <h2 className="m-0 font-display text-xl font-semibold text-foreground">
              #{e.numero} · {e.clienteNombre}
            </h2>
            {activa && <StatusBadge tone={TONO_SEMAFORO[e.semaforo]}>{t("restaurantes.chofer.tarjeta.minutos", { min: minutos })}</StatusBadge>}
            {e.estado === "entregado" && <StatusBadge tone="success">{pendienteDeEnvio ? t("restaurantes.chofer.tarjeta.porEnviar") : t("restaurantes.chofer.tarjeta.entregado")}</StatusBadge>}
            {e.estado === "problema" && <StatusBadge tone="danger">{t("restaurantes.chofer.tarjeta.problema")}</StatusBadge>}
          </header>

          <p className="m-0 flex items-start gap-1.5 text-base text-foreground">
            <MapPin className="mt-1 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
            <span>{direccion || t("restaurantes.chofer.tarjeta.sinDireccion")}</span>
          </p>
          {e.indicaciones && <p className="m-0 text-base text-muted-foreground">{t("restaurantes.chofer.tarjeta.indicaciones", { texto: e.indicaciones })}</p>}

          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="m-0 font-display text-xl font-semibold tabular-nums text-foreground">{t("restaurantes.chofer.tarjeta.total", { total: formatMoney(e.total) })}</p>
            <StatusBadge tone={e.pago.forma === "efectivo" ? "warning" : e.pago.forma === "tarjeta" ? "info" : "neutral"} dot={false}>
              {etiquetaPago(e, t)}
            </StatusBadge>
          </div>
          {e.pago.forma === "efectivo" && e.pago.pagaCon !== null && (
            <p className="m-0 text-base text-foreground tabular-nums">
              {t("restaurantes.chofer.tarjeta.pagaCon", { monto: formatMoney(e.pago.pagaCon) })}
              {cambio !== null && t("restaurantes.chofer.tarjeta.cambio", { monto: formatMoney(cambio) })}
            </p>
          )}
          <p className="m-0 text-sm text-muted-foreground">
            {t("restaurantes.chofer.tarjeta.piezas", { count: e.totalPiezas })} · {e.resumenItems}
          </p>

          {activa && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {mapa && !ocupado ? (
                  <Button asChild variant="outline" className="h-14 w-full">
                    <a href={mapa} target="_blank" rel="noreferrer" aria-label={t("restaurantes.chofer.tarjeta.navegarAria", { numero })}>
                      <Navigation />
                      {t("restaurantes.chofer.tarjeta.navegar")}
                    </a>
                  </Button>
                ) : (
                  <Button type="button" variant="outline" className="h-14 w-full" disabled>
                    <Navigation />
                    {mapa ? t("restaurantes.chofer.tarjeta.navegar") : t("restaurantes.chofer.tarjeta.sinMapa")}
                  </Button>
                )}
                <Button type="button" variant="outline" className="h-14 w-full" disabled={ocupado} loading={enCurso === "llamar"} aria-label={t("restaurantes.chofer.tarjeta.llamarAria", { numero })} onClick={() => onLlamar(e)}>
                  <Phone />
                  {t("restaurantes.chofer.llamar")}
                </Button>
              </div>
              <Button type="button" className="h-14 w-full text-base" disabled={ocupado} loading={enCurso === "entregar"} aria-label={t("restaurantes.chofer.tarjeta.entregadoAria", { numero })} onClick={() => onEntregar(e)}>
                <Check />
                {t("restaurantes.chofer.tarjeta.entregado")}
              </Button>
              <Button type="button" variant="danger-outline" className="h-14 w-full" disabled={ocupado} aria-label={t("restaurantes.chofer.tarjeta.noPudeAria", { numero })} onClick={() => onProblema(e)}>
                <AlertTriangle />
                {t("restaurantes.chofer.tarjeta.noPude")}
              </Button>
            </>
          )}

          {e.estado === "entregado" && segundos !== null && segundos > 0 && (
            <Button type="button" variant="outline" className="h-14 w-full" disabled={ocupado} loading={enCurso === "deshacer"} aria-label={t("restaurantes.chofer.tarjeta.deshacerAria", { numero })} onClick={() => onDeshacer(e)}>
              <Undo2 />
              {t("restaurantes.chofer.tarjeta.deshacer", { s: segundos })}
            </Button>
          )}
        </article>
      </CardContent>
    </Card>
  );
}

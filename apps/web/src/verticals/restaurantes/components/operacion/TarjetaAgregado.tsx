// Tarjeta de un agregado por validar (panel movil del operador): pedido original + lo que el cliente quiere agregar + cronometro con color + Aceptar / Rechazar.
// Presentacional: no hace red. Botones >= 56 dp (h-14), desactivados mientras se procesa. El color del cronometro nunca es la unica senal (icono + texto).
import { Button, Card, CardContent, StatusBadge, cn, formatMoney } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import type { TarjetaAgregado as TarjetaAgregadoDato } from "@atiende/domain-restaurantes/operacion";
import { AlertTriangle, CheckCircle2, Clock, MessageCircle, PhoneCall, Store } from "lucide-react";
import { horaEsMx } from "../../../../lib/formato-fecha.ts";
import { ETIQUETA_ESTADO, ETIQUETA_ESTADO_PEDIDO, ETIQUETA_MOTIVO, TEXTO_NIVEL, colorCronometro, enlaceLlamar, enlaceWhatsapp, nivelDeSegundos, textoCronometro } from "../../lib/agregados-presentacion.ts";

const TONO_COLOR: Readonly<Record<ReturnType<typeof colorCronometro>, StatusTone>> = { verde: "success", ambar: "warning", rojo: "danger" };
const ICONO_COLOR = { verde: CheckCircle2, ambar: Clock, rojo: AlertTriangle } as const;
const TONO_ESTADO: Readonly<Record<TarjetaAgregadoDato["estado"], StatusTone>> = { pendiente: "warning", aceptado: "success", rechazado: "danger", vencido: "danger", cancelado_por_cliente: "neutral", no_aplicable: "neutral" };

export interface TarjetaAgregadoProps {
  readonly tarjeta: TarjetaAgregadoDato;
  /** Segundos de espera ya ajustados al reloj de este telefono. */
  readonly segundos: number;
  readonly ocupado: boolean;
  readonly alAceptar: (t: TarjetaAgregadoDato) => void;
  readonly alRechazar: (t: TarjetaAgregadoDato) => void;
}

export function TarjetaAgregado({ tarjeta: t, segundos, ocupado, alAceptar, alRechazar }: TarjetaAgregadoProps) {
  const abierta = t.estado === "pendiente";
  const color = colorCronometro(segundos);
  const nivel = nivelDeSegundos(segundos);
  const Icono = ICONO_COLOR[color];
  const llamar = enlaceLlamar(t.cliente.telefono);
  const whatsapp = enlaceWhatsapp(t.cliente.telefono);
  const folio = t.pedido.numero !== null ? `#${t.pedido.numero}` : "";
  return (
    <Card data-testid={`tarjeta-agregado-${t.id}`} data-estado={t.estado} data-color={abierta ? color : undefined} className={cn("border-2", abierta ? (color === "rojo" ? "border-danger" : color === "ambar" ? "border-warning" : "border-primary") : "border-border")}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-xl font-bold text-foreground">Pedido {folio}</h3>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Store className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{t.sucursal ?? "Sucursal"}</span>
              <span aria-hidden="true">·</span>
              <span>{t.canal === "llamada" ? "Llamada" : "WhatsApp"}</span>
            </p>
          </div>
          {abierta ? (
            <StatusBadge tone={TONO_COLOR[color]} dot={false} data-testid="cronometro" data-nivel={nivel} className="text-base">
              <Icono className="size-4" aria-hidden="true" />
              <span>{textoCronometro(segundos)}</span>
            </StatusBadge>
          ) : (
            <StatusBadge tone={TONO_ESTADO[t.estado]} dot={false} className="text-sm">
              {ETIQUETA_ESTADO[t.estado]}
            </StatusBadge>
          )}
        </div>

        {abierta && nivel !== "en_tiempo" && (
          <p role="status" className={cn("rounded-md border p-2 text-sm font-medium", nivel === "vencido" ? "border-danger text-danger" : "border-warning text-warning")}>
            {TEXTO_NIVEL[nivel]}
          </p>
        )}

        <section aria-label="Pedido original" className="space-y-1 rounded-md bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Pedido original</h4>
            <StatusBadge tone="neutral" dot={false} className="text-sm">
              {ETIQUETA_ESTADO_PEDIDO[t.pedido.estado] ?? t.pedido.estado} · {horaEsMx(t.pedido.creadoEn)}
            </StatusBadge>
          </div>
          <p className="text-base text-foreground">{t.pedido.renglones.map((r) => `${r.cantidad}× ${r.nombre}`).join(", ") || "Sin renglones"}</p>
          <p className="text-base font-medium text-foreground">Total ${formatMoney(t.pedido.total)}</p>
          {abierta && t.pedido.yaEnCocina && (
            <p role="note" className="rounded-md border border-warning p-2 text-sm text-warning">
              Este pedido ya está en cocina: el agregado puede no alcanzar a salir junto con él.
            </p>
          )}
        </section>

        <section aria-label="Lo que quiere agregar" className="space-y-1 rounded-md border-2 border-primary p-3">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-primary">Lo que quiere agregar</h4>
          <ul className="space-y-0.5">
            {t.agregado.renglones.map((r, i) => (
              <li key={`${r.nombre}-${i}`} className="flex items-baseline justify-between gap-2 text-base text-foreground">
                <span>
                  {r.cantidad}× {r.nombre}
                </span>
                <span className="tabular-nums">${formatMoney(r.subtotal)}</span>
              </li>
            ))}
          </ul>
          {t.agregado.nota && <p className="text-sm text-muted-foreground">Nota del cliente: {t.agregado.nota}</p>}
          <p className="text-lg font-bold text-foreground">
            Nuevo total: ${formatMoney(t.agregado.nuevoTotal)} <span className="text-sm font-normal text-muted-foreground">(antes ${formatMoney(t.agregado.nuevoTotal - t.agregado.total)})</span>
          </p>
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-base font-medium text-foreground">{t.cliente.nombre}</p>
          {abierta && (llamar || whatsapp) && (
            <div className="flex gap-2">
              {llamar && (
                <Button asChild variant="outline" className="h-12">
                  <a href={llamar} aria-label={`Llamar a ${t.cliente.nombre}`}>
                    <PhoneCall className="mr-1.5 size-4" aria-hidden="true" />
                    Llamar
                  </a>
                </Button>
              )}
              {whatsapp && (
                <Button asChild variant="outline" className="h-12">
                  <a href={whatsapp} target="_blank" rel="noopener noreferrer" aria-label={`Escribir por WhatsApp a ${t.cliente.nombre}`}>
                    <MessageCircle className="mr-1.5 size-4" aria-hidden="true" />
                    WhatsApp
                  </a>
                </Button>
              )}
            </div>
          )}
        </div>

        {abierta ? (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" className="h-14 text-lg" loading={ocupado} disabled={ocupado} aria-label={`Aceptar agregado al pedido ${folio}`} onClick={() => alAceptar(t)}>
              Aceptar agregado
            </Button>
            <Button type="button" variant="danger" className="h-14 text-lg" disabled={ocupado} aria-label={`Rechazar agregado al pedido ${folio}`} onClick={() => alRechazar(t)}>
              Rechazar
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="resolucion">
            {ETIQUETA_ESTADO[t.estado]}
            {t.motivoRechazo ? `: ${ETIQUETA_MOTIVO[t.motivoRechazo]}${t.notaRechazo ? ` (${t.notaRechazo})` : ""}` : ""}
            {t.resueltoPor ? ` · ${t.resueltoPor}` : ""}
            {t.resueltoEn ? ` · ${horaEsMx(t.resueltoEn)}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

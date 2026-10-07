// Historial de transiciones de un pedido (A-03): quien lo movio (equipo, agente, POS o sistema), de que estado a cual, cuando y con que motivo.
// Lee `order_status_events` (append-only, una fila por transicion). Base sin migrar: estado honesto, sin lista.
import { useEffect, useState } from "react";
import { Button, EstadoCargando, EstadoError, EstadoVacio, FormDialog } from "@atiende/ui";
import { MOTIVO_CANCELACION_ETIQUETAS, etiquetaActor, fetchHistorialPedido } from "../lib/autopiloto-client.ts";
import type { EventoEstado, MotivoCancelacion } from "../lib/autopiloto-client.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";
import { ORDER_STATUS_LABELS } from "../lib/orders-client.ts";

export function HistorialPedidoDialogo({
  orderId,
  titulo,
  onClose,
  apiBaseUrl,
  token,
  propertyId,
}: {
  /** `null` = cerrado. */
  readonly orderId: string | null;
  readonly titulo: string;
  readonly onClose: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
}) {
  const [datos, setDatos] = useState<{ readonly disponible: boolean; readonly eventos: readonly EventoEstado[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orderId) return;
    let cancelado = false;
    setDatos(null);
    setError(null);
    fetchHistorialPedido(fetch, apiBaseUrl, token, propertyId, orderId)
      .then((r) => !cancelado && setDatos(r))
      .catch((err) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar el historial."));
    return () => {
      cancelado = true;
    };
  }, [orderId, apiBaseUrl, token, propertyId]);

  return (
    <FormDialog
      open={orderId !== null}
      onOpenChange={(o) => !o && onClose()}
      titulo="Historial del pedido"
      subtitulo={titulo}
      anchoClase="max-w-2xl"
      footer={
        <Button type="button" variant="outline" onClick={onClose}>
          Cerrar
        </Button>
      }
    >
      {error ? (
        <EstadoError mensaje={error} />
      ) : datos === null ? (
        <EstadoCargando etiqueta="Cargando historial…" />
      ) : !datos.disponible ? (
        <EstadoVacio mensaje="El historial todavía no está disponible en esta cuenta (falta aplicar la actualización de base de datos)." />
      ) : datos.eventos.length === 0 ? (
        <EstadoVacio mensaje="Este pedido no tiene transiciones registradas (es anterior al historial)." />
      ) : (
        <ol className="m-0 grid list-none gap-2 p-0" data-testid="historial-pedido">
          {datos.eventos.map((e, i) => (
            <li key={`${e.at}-${i}`} className="text-sm text-foreground">
              <span className="font-medium">
                {e.desde ? `${ORDER_STATUS_LABELS[e.desde]} → ` : "Creado como "}
                {ORDER_STATUS_LABELS[e.hacia]}
              </span>
              <span className="block text-xs text-muted-foreground">
                {etiquetaActor(e.actor)} · {fechaHoraEsMx(e.at)}
                {e.motivo ? ` · ${MOTIVO_CANCELACION_ETIQUETAS[e.motivo as MotivoCancelacion] ?? e.motivo.replace(/_/g, " ")}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
    </FormDialog>
  );
}

// «Reportar incidencia» (repo suelto: ModalFormularioLateral -> aqui FormDialog): la nota es OBLIGATORIA. El pedido pasa a «Incidencia»
// con esa nota (PATCH .../status con status:"problema" e incidentNote); el servidor avisa al staff igual que con una cancelacion.
import { useEffect, useState } from "react";
import { Button, FormDialog, FormField, Textarea, cn, useT } from "@atiende/ui";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { restaurantesPedidos } from "@atiende/ui/i18n/restaurantes/pedidos";
import type { OrderSummary } from "../../lib/orders-client.ts";
import { etiquetaFolio } from "../../lib/orders-client.ts";
import "./mapa-entrega.css";

export function IncidenciaDialogo({
  order,
  enCurso,
  error,
  onCerrar,
  onConfirmar,
}: {
  readonly order: OrderSummary | null;
  readonly enCurso: boolean;
  /** Error de la ultima llamada al servidor (el dialogo queda abierto para reintentar). */
  readonly error?: string | null;
  readonly onCerrar: () => void;
  readonly onConfirmar: (order: OrderSummary, nota: string) => void;
}) {
  const t = useT(restaurantesComun, restaurantesPedidos);
  const [nota, setNota] = useState("");
  const [intentoVacio, setIntentoVacio] = useState(false);
  useEffect(() => {
    if (order) {
      setNota("");
      setIntentoVacio(false);
    }
  }, [order?.id]);
  const falta = intentoVacio && nota.trim() === "";
  const enviar = (): void => {
    if (!order) return;
    if (nota.trim() === "") {
      setIntentoVacio(true);
      return;
    }
    onConfirmar(order, nota.trim());
  };
  return (
    <FormDialog
      open={order !== null}
      onOpenChange={(abierto) => !abierto && onCerrar()}
      titulo={t("restaurantes.pedidos.incidencia.titulo")}
      subtitulo={order ? `${etiquetaFolio(order)} — ${order.customerName}` : undefined}
      anchoClase="max-w-5xl"
      bloquearCierre={enCurso}
      footer={
        <div className="flex w-full gap-2">
          <Button type="button" variant="outline" className="flex-1 rounded-full" onClick={onCerrar} disabled={enCurso}>
            {t("restaurantes.cancelar")}
          </Button>
          <Button type="button" className={cn("pedido-incidencia-confirmar flex-1 rounded-full")} onClick={enviar} loading={enCurso} disabled={enCurso}>
            {t(enCurso ? "restaurantes.pedidos.incidencia.reportando" : "restaurantes.pedidos.incidencia.titulo")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        {error && (
          <p role="alert" className="m-0 text-xs text-destructive">
            {error}
          </p>
        )}
        <FormField label={t("restaurantes.pedidos.incidencia.quePaso")} required error={falta ? t("restaurantes.pedidos.incidencia.falta") : undefined}>
          <Textarea placeholder={t("restaurantes.pedidos.incidencia.ejemplo")} value={nota} onChange={(e) => setNota(e.target.value)} rows={4} />
        </FormField>
      </div>
    </FormDialog>
  );
}

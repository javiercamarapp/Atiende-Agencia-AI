// Dialogo de motivo de la lista CERRADA (cancelar un pedido, rechazar un pedido grande): sin texto libre. El servidor rechaza cualquier valor
// fuera de la lista; aqui solo se ofrece lo valido y el boton queda deshabilitado hasta elegir.
import { useEffect, useState } from "react";
import { Button, Callout, FormDialog, FormField, Selector } from "@atiende/ui";
import { MOTIVOS_CANCELACION, MOTIVO_CANCELACION_ETIQUETAS } from "../lib/autopiloto-client.ts";
import type { MotivoCancelacion } from "../lib/autopiloto-client.ts";

export function MotivoDialogo({
  open,
  onOpenChange,
  titulo,
  subtitulo,
  textoConfirmar,
  tonoPeligro = false,
  error,
  enCurso,
  onConfirmar,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly titulo: string;
  readonly subtitulo?: string;
  readonly textoConfirmar: string;
  readonly tonoPeligro?: boolean;
  /** Error de la ultima llamada al servidor (el dialogo queda abierto para reintentar). */
  readonly error?: string | null;
  readonly enCurso: boolean;
  readonly onConfirmar: (motivo: MotivoCancelacion) => void;
}) {
  const [motivo, setMotivo] = useState<MotivoCancelacion | "">("");
  useEffect(() => {
    if (open) setMotivo("");
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      titulo={titulo}
      subtitulo={subtitulo}
      anchoClase="max-w-2xl"
      bloquearCierre={enCurso}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={enCurso}>
            Volver
          </Button>
          <Button type="button" variant={tonoPeligro ? "danger" : "default"} loading={enCurso} disabled={enCurso || motivo === ""} onClick={() => motivo !== "" && onConfirmar(motivo)}>
            {textoConfirmar}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <Callout tone="danger">{error}</Callout>}
        <FormField label="Motivo" required hint="Queda en el historial del pedido y alimenta la precisión del agente.">
          <Selector value={motivo} onChange={(e) => setMotivo(e.target.value as MotivoCancelacion | "")}>
            <option value="">Elige un motivo…</option>
            {MOTIVOS_CANCELACION.map((m) => (
              <option key={m} value={m}>
                {MOTIVO_CANCELACION_ETIQUETAS[m]}
              </option>
            ))}
          </Selector>
        </FormField>
      </div>
    </FormDialog>
  );
}

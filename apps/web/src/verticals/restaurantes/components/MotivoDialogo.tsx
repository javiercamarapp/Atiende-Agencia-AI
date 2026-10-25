// Dialogo de motivo de lista CERRADA (cancelar un pedido, rechazar un pedido grande, rechazar un agregado): el servidor rechaza cualquier valor fuera de la lista;
// aqui solo se ofrece lo valido y el boton queda deshabilitado hasta elegir. Por omision usa los motivos de cancelacion; `opciones` permite otra lista cerrada
// (agregados) y `notaObligatoriaCon` pide una nota breve cuando el motivo es «otro».
import { useEffect, useState } from "react";
import { Button, Callout, FormDialog, FormField, Selector, Textarea } from "@atiende/ui";
import { MOTIVOS_CANCELACION, MOTIVO_CANCELACION_ETIQUETAS } from "../lib/autopiloto-client.ts";
import type { MotivoCancelacion } from "../lib/autopiloto-client.ts";

export interface OpcionMotivo<M extends string> {
  readonly valor: M;
  readonly etiqueta: string;
}

const OPCIONES_CANCELACION: readonly OpcionMotivo<MotivoCancelacion>[] = MOTIVOS_CANCELACION.map((m) => ({ valor: m, etiqueta: MOTIVO_CANCELACION_ETIQUETAS[m] }));

export function MotivoDialogo<M extends string = MotivoCancelacion>({
  open,
  onOpenChange,
  titulo,
  subtitulo,
  textoConfirmar,
  tonoPeligro = false,
  error,
  enCurso,
  opciones,
  notaObligatoriaCon,
  notaMax = 300,
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
  /** Lista cerrada de motivos; por omision, los de cancelacion de pedidos. */
  readonly opciones?: readonly OpcionMotivo<M>[];
  /** Con este motivo se pide una nota breve (obligatoria). Sin valor no hay campo de nota. */
  readonly notaObligatoriaCon?: M;
  readonly notaMax?: number;
  readonly onConfirmar: (motivo: M, nota: string) => void;
}) {
  const lista = (opciones ?? OPCIONES_CANCELACION) as readonly OpcionMotivo<M>[];
  const [motivo, setMotivo] = useState<M | "">("");
  const [nota, setNota] = useState("");
  useEffect(() => {
    if (open) {
      setMotivo("");
      setNota("");
    }
  }, [open]);
  const pideNota = notaObligatoriaCon !== undefined && motivo === notaObligatoriaCon;
  const faltaNota = pideNota && nota.trim().length === 0;
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
          <Button type="button" variant={tonoPeligro ? "danger" : "default"} loading={enCurso} disabled={enCurso || motivo === "" || faltaNota} onClick={() => motivo !== "" && onConfirmar(motivo, nota.trim())}>
            {textoConfirmar}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <Callout tone="danger">{error}</Callout>}
        <FormField label="Motivo" required hint="Queda en el historial del pedido y alimenta la precisión del agente.">
          <Selector value={motivo} placeholder="Elige un motivo…" onValueChange={(v) => setMotivo(v as M | "")}>
            {lista.map((m) => (
              <option key={m.valor} value={m.valor}>
                {m.etiqueta}
              </option>
            ))}
          </Selector>
        </FormField>
        {pideNota && (
          <FormField label="Nota" required hint={`Una frase breve para quien devuelve la llamada (máx. ${notaMax} caracteres).`}>
            <Textarea value={nota} maxLength={notaMax} rows={3} onChange={(e) => setNota(e.target.value)} />
          </FormField>
        )}
      </div>
    </FormDialog>
  );
}

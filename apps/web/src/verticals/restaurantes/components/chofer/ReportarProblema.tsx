// «No pude entregar» (PLAN-PANEL-OPERADOR §2.3): el motivo es de lista cerrada (no encontre la direccion, el cliente no contesta, rechazo, otro);
// la nota es opcional salvo en «Otro motivo», donde se pide una breve para que el encargado sepa que paso. Hoja inferior en el celular.
import { useEffect, useState } from "react";
import { Button, FormDialog, FormField, RadioSegmentado, Textarea } from "@atiende/ui";
import { MOTIVOS_PROBLEMA_CHOFER } from "@atiende/domain-restaurantes/operacion";
import type { EntregaChofer, MotivoProblemaChofer, ProblemaEntrada } from "@atiende/domain-restaurantes/operacion";
import { ETIQUETA_MOTIVO_PROBLEMA } from "../../lib/chofer-entregas.ts";

const OPCIONES = MOTIVOS_PROBLEMA_CHOFER.map((id) => ({ id, rotulo: ETIQUETA_MOTIVO_PROBLEMA[id] }));
export const NOTA_OTRO_MIN = 3;

export interface ReportarProblemaProps {
  readonly entrega: EntregaChofer | null;
  readonly onCerrar: () => void;
  readonly onConfirmar: (entrega: EntregaChofer, entrada: ProblemaEntrada) => Promise<void>;
}

export function ReportarProblema({ entrega, onCerrar, onConfirmar }: ReportarProblemaProps) {
  const [motivo, setMotivo] = useState<MotivoProblemaChofer>("no_contesto");
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    setMotivo("no_contesto");
    setNota("");
    setEnviando(false);
  }, [entrega?.id]);

  const notaLimpia = nota.trim();
  const faltaNota = motivo === "otro" && notaLimpia.length < NOTA_OTRO_MIN;

  async function enviar() {
    if (!entrega || enviando || faltaNota) return;
    setEnviando(true);
    try {
      await onConfirmar(entrega, notaLimpia ? { motivo, nota: notaLimpia } : { motivo });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <FormDialog
      open={entrega !== null}
      onOpenChange={(abierto) => {
        if (!abierto && !enviando) onCerrar();
      }}
      titulo={entrega ? `No pude entregar el pedido #${entrega.numero}` : "No pude entregar"}
      subtitulo="Elige qué pasó. El encargado lo ve de inmediato."
      anchoClase="max-w-lg"
      bloquearCierre={enviando}
      footer={
        <>
          <Button type="button" className="h-14 w-full md:w-auto" variant="danger" loading={enviando} disabled={enviando || faltaNota} onClick={() => void enviar()}>
            Reportar problema
          </Button>
          <Button type="button" className="h-14 w-full md:w-auto" variant="outline" disabled={enviando} onClick={onCerrar}>
            Volver
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <RadioSegmentado name="motivo-problema" label="Motivo" opciones={OPCIONES} value={motivo} onChange={setMotivo} disabled={enviando} className="flex-col items-stretch" />
        <FormField label={motivo === "otro" ? "¿Qué pasó?" : "Nota (opcional)"} required={motivo === "otro"} error={faltaNota && nota.length > 0 ? `Escribe al menos ${NOTA_OTRO_MIN} caracteres.` : undefined}>
          <Textarea rows={3} maxLength={500} value={nota} onChange={(ev) => setNota(ev.target.value)} disabled={enviando} />
        </FormField>
      </div>
    </FormDialog>
  );
}

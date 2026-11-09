// «No pude entregar» (PLAN-PANEL-OPERADOR §2.3): el motivo es de lista cerrada (no encontre la direccion, el cliente no contesta, rechazo, otro);
// la nota es opcional salvo en «Otro motivo», donde se pide una breve para que el encargado sepa que paso. Hoja inferior en el celular.
import { useEffect, useMemo, useState } from "react";
import { Button, FormDialog, FormField, RadioSegmentado, Textarea, useT } from "@atiende/ui";
import { restaurantesChofer } from "@atiende/ui/i18n/restaurantes/chofer";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { MOTIVOS_PROBLEMA_CHOFER } from "@atiende/domain-restaurantes/operacion";
import type { EntregaChofer, MotivoProblemaChofer, ProblemaEntrada } from "@atiende/domain-restaurantes/operacion";
import { ETIQUETA_MOTIVO_PROBLEMA } from "../../lib/chofer-entregas.ts";

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
  const t = useT(restaurantesComun, restaurantesChofer);
  // Se arma en cada cambio de idioma (las etiquetas de ETIQUETA_MOTIVO_PROBLEMA siguen al idioma activo al leerlas).
  const opciones = useMemo(() => MOTIVOS_PROBLEMA_CHOFER.map((id) => ({ id, rotulo: ETIQUETA_MOTIVO_PROBLEMA[id] })), [t]);

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
      titulo={entrega ? t("restaurantes.chofer.problema.titulo", { numero: String(entrega.numero) }) : t("restaurantes.chofer.tarjeta.noPude")}
      subtitulo={t("restaurantes.chofer.problema.subtitulo")}
      anchoClase="max-w-lg"
      bloquearCierre={enviando}
      footer={
        <>
          <Button type="button" className="h-14 w-full md:w-auto" variant="danger" loading={enviando} disabled={enviando || faltaNota} onClick={() => void enviar()}>
            {t("restaurantes.chofer.problema.reportar")}
          </Button>
          <Button type="button" className="h-14 w-full md:w-auto" variant="outline" disabled={enviando} onClick={onCerrar}>
            {t("restaurantes.volver")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <RadioSegmentado name="motivo-problema" label={t("restaurantes.chofer.problema.motivo")} opciones={opciones} value={motivo} onChange={setMotivo} disabled={enviando} className="flex-col items-stretch" />
        <FormField
          label={motivo === "otro" ? t("restaurantes.chofer.problema.quePaso") : t("restaurantes.chofer.problema.nota")}
          required={motivo === "otro"}
          error={faltaNota && nota.length > 0 ? t("restaurantes.chofer.problema.notaCorta", { n: NOTA_OTRO_MIN }) : undefined}
        >
          <Textarea rows={3} maxLength={500} value={nota} onChange={(ev) => setNota(ev.target.value)} disabled={enviando} />
        </FormField>
      </div>
    </FormDialog>
  );
}

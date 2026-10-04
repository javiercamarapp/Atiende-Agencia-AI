// Piezas compartidas de CFDI de hospedaje (UNI-C gestion): la tabla de comprobantes y el dialogo de cancelacion que
// usan CfdiListado (nivel hotel) y Cfdi (nivel folio). Antes cada pagina duplicaba tarjetas y formulario inline.
// Cero logica de red aqui: las paginas pasan los handlers que ya tenian.
import { Link } from "react-router-dom";
import { Button, Callout, DataTable, FormDialog, FormField, Input, NativeSelect, StatusBadge, statusTone } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { MOTIVO_CANCELACION_LABELS } from "../lib/cfdi-client.ts";
import type { CfdiEmisionSummary, MotivoCancelacionSat } from "../lib/cfdi-client.ts";
import { dineroMx } from "../lib/dinero.ts";
import { CFDI_ESTADO_TONES } from "../lib/status-tones.ts";
import { fechaHoraEsMx } from "../../../lib/formato-fecha.ts";

export const CFDI_ESTADO_LABELS: Record<CfdiEmisionSummary["estado"], string> = {
  pendiente: "Pendiente",
  timbrado: "Timbrado",
  en_proceso_cancelacion: "Cancelación en proceso",
  cancelado: "Cancelado",
  rechazado: "Rechazado",
};

export const CFDI_MOTIVOS: readonly MotivoCancelacionSat[] = ["01", "02", "03", "04"];

export interface CfdiTablaProps {
  readonly cfdis: readonly CfdiEmisionSummary[] | null;
  readonly error: string | null;
  readonly onReintentar: () => void;
  readonly vacio: string;
  readonly busy: boolean;
  readonly onCancelar: (cfdiId: string) => void;
  /** Con esto se muestra la columna "Folio" (listado del hotel): enlaza al CFDI del folio. */
  readonly orgSlug?: string;
  /** Solo en la pagina del folio: consulta el estado real ante el PAC de una cancelacion en proceso. */
  readonly onConsultarEstado?: (cfdiId: string) => void;
}

export function CfdiTabla({ cfdis, error, onReintentar, vacio, busy, onCancelar, orgSlug, onConsultarEstado }: CfdiTablaProps) {
  const columnas: DataTableColumna<CfdiEmisionSummary>[] = [
    {
      id: "comprobante",
      encabezado: "Comprobante",
      etiqueta: "Comprobante",
      principal: true,
      celda: (c) => (
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {c.tipo === "hospedaje" ? "Hospedaje" : "Complemento de pago"} · {c.uuidFiscal ?? "sin UUID"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            RFC {c.rfcReceptor} · Uso {c.usoCfdi} · {c.metodoPago} {c.pac ? `· PAC: ${c.pac}` : ""}
          </p>
        </div>
      ),
    },
  ];
  if (orgSlug !== undefined) {
    columnas.push({
      id: "folio",
      encabezado: "Folio",
      celda: (c) => (
        <Link to={`/hoteles/${orgSlug}/folios/${c.folioId}/cfdi`} className="text-primary hover:underline underline-offset-2">
          {c.folioId}
        </Link>
      ),
    });
  }
  columnas.push(
    { id: "subtotal", encabezado: "Subtotal", alinear: "right", celda: (c) => <span className="tabular-nums">{dineroMx(c.subtotal)}</span> },
    { id: "iva", encabezado: "IVA", alinear: "right", celda: (c) => <span className="tabular-nums">{dineroMx(c.iva)}</span> },
    {
      id: "locales",
      encabezado: "ISH / DSA",
      alinear: "right",
      celda: (c) => {
        const partes = [c.impuestosLocales.ishMonto > 0 ? `ISH ${dineroMx(c.impuestosLocales.ishMonto)}` : "", c.impuestosLocales.dsaMonto > 0 ? `DSA ${dineroMx(c.impuestosLocales.dsaMonto)}` : ""].filter(Boolean);
        return <span className="tabular-nums">{partes.length > 0 ? partes.join(" · ") : "—"}</span>;
      },
    },
    { id: "total", encabezado: "Total", alinear: "right", celda: (c) => <strong className="tabular-nums">{dineroMx(c.total)}</strong> },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (c) => <StatusBadge tone={statusTone(CFDI_ESTADO_TONES, c.estado)}>{CFDI_ESTADO_LABELS[c.estado]}</StatusBadge>,
    },
    { id: "emitido", encabezado: "Emitido", celda: (c) => <span className="text-xs text-muted-foreground">{fechaHoraEsMx(c.creadoEn)}</span> },
    {
      id: "acciones",
      encabezado: "Acciones",
      alinear: "right",
      celda: (c) => {
        if (c.estado === "timbrado") {
          return (
            <Button type="button" variant="outline" size="sm" className="text-destructive border-destructive/40 hover:border-destructive" onClick={() => onCancelar(c.id)} disabled={busy}>
              Cancelar CFDI
            </Button>
          );
        }
        if (c.estado === "en_proceso_cancelacion" && onConsultarEstado) {
          return (
            <div className="flex flex-col items-end gap-1.5">
              <Button type="button" variant="outline" size="sm" onClick={() => onConsultarEstado(c.id)} disabled={busy}>
                Consultar estado real ante el PAC
              </Button>
              <p className="max-w-xs text-xs text-muted-foreground text-right">
                El SAT todavía no confirma si esta cancelación fue aceptada o rechazada. Este botón vuelve a preguntarle al PAC; el estado solo se actualiza aquí si ya confirmó "cancelado".
              </p>
            </div>
          );
        }
        return null;
      },
    },
  );

  return (
    <DataTable
      etiqueta="CFDI"
      columnas={columnas}
      filas={cfdis ?? []}
      obtenerId={(c) => c.id}
      estado={error ? "error" : !cfdis ? "loading" : cfdis.length === 0 ? "empty" : "ok"}
      error={{ titulo: "Ocurrió un problema", mensaje: error ?? undefined, onReintentar }}
      vacio={{ mensaje: vacio }}
    />
  );
}

export interface CfdiCancelarDialogProps {
  readonly open: boolean;
  /** Cerrar (boton, Escape o clic fuera) nunca cancela el CFDI: solo cierra. */
  readonly onClose: () => void;
  readonly busy: boolean;
  readonly error: string | null;
  readonly motivo: MotivoCancelacionSat;
  readonly onMotivoChange: (m: MotivoCancelacionSat) => void;
  readonly folioSustitucion: string;
  readonly onFolioSustitucionChange: (v: string) => void;
  readonly onConfirmar: () => void;
}

export function CfdiCancelarDialog({ open, onClose, busy, error, motivo, onMotivoChange, folioSustitucion, onFolioSustitucionChange, onConfirmar }: CfdiCancelarDialogProps) {
  return (
    <FormDialog
      open={open}
      onOpenChange={(abierto) => {
        if (!abierto && !busy) onClose();
      }}
      titulo="Cancelar CFDI"
      subtitulo="La cancelación se envía al PAC y al SAT; no se puede deshacer."
      anchoClase="max-w-2xl"
      bloquearCierre={busy}
      onGuardar={onConfirmar}
      guardando={busy}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cerrar
          </Button>
          <Button type="submit" variant="destructive" loading={busy} loadingText="Cancelando…">
            Confirmar cancelación
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <Callout tone="danger">{error}</Callout>}
        <FormField label="Motivo de cancelación (SAT)">
          <NativeSelect value={motivo} onChange={(e) => onMotivoChange(e.target.value as MotivoCancelacionSat)}>
            {CFDI_MOTIVOS.map((m) => (
              <option key={m} value={m}>
                {MOTIVO_CANCELACION_LABELS[m]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {motivo === "01" && (
          <FormField label="Folio fiscal del CFDI que lo sustituye (UUID)">
            <Input placeholder="Folio fiscal del CFDI que lo sustituye (UUID)" value={folioSustitucion} onChange={(e) => onFolioSustitucionChange(e.target.value)} />
          </FormField>
        )}
      </div>
    </FormDialog>
  );
}

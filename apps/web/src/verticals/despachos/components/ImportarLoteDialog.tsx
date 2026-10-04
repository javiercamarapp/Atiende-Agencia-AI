// D-13: "Importar ZIP o varios XML" (pagina CFDI). Dialogo con el flujo REAL de la carga masiva: elegir archivos -> (ZIP se descomprime en
// el navegador) -> tandas de <= 50 XML a `POST .../cfdi/importar-lote` -> barra de progreso -> resumen con la tabla de resultados por archivo.
// Cancelar detiene las tandas PENDIENTES; las ya importadas no se revierten y el resumen lo dice. Toda la logica (descompresion, tandas,
// cancelacion) vive en ../lib/cfdi-lote.ts; aqui solo hay presentacion y estado.
import { useRef, useState } from "react";
import { FileStack, Upload } from "lucide-react";
import { Button, DataTable, FormDialog, Label, StatusBadge, notify } from "@atiende/ui";
import { armarTandas, descomprimirZip, ejecutarImportacion, importarLote, MAX_BYTES_XML, ZipNavegadorError } from "../lib/cfdi-lote.ts";
import type { ArchivoParaLote, EstadoArchivoLote, ProgresoLote, ResultadoArchivoLote, ResumenImportacion } from "../lib/cfdi-lote.ts";

const ESTADO_ETIQUETA: Record<EstadoArchivoLote, string> = { ingerido: "Ingerido", en_revision: "En revisión", duplicado: "Ya existía", rechazado: "Rechazado" };
const ESTADO_TONO: Record<EstadoArchivoLote, "success" | "warning" | "neutral" | "danger"> = { ingerido: "success", en_revision: "warning", duplicado: "neutral", rechazado: "danger" };

export interface ImportarLoteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Se llama al terminar (o cancelar) una importacion que pudo haber guardado algo: la pagina recarga su lista y la cola de revision. */
  readonly onTerminado: () => void;
}

function esZip(f: File): boolean {
  return /\.zip$/i.test(f.name) || /zip/i.test(f.type);
}

export function ImportarLoteDialog({ open, onOpenChange, apiBaseUrl, token, propertyId, onTerminado }: ImportarLoteDialogProps) {
  const [seleccion, setSeleccion] = useState<readonly File[]>([]);
  const [corriendo, setCorriendo] = useState(false);
  const [progreso, setProgreso] = useState<ProgresoLote | null>(null);
  const [resumen, setResumen] = useState<ResumenImportacion | null>(null);
  const [omitidos, setOmitidos] = useState<{ noXml: number; ignorados: number }>({ noXml: 0, ignorados: 0 });
  const [error, setError] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState(false);
  const canceladoRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function reiniciar() {
    setSeleccion([]);
    setProgreso(null);
    setResumen(null);
    setOmitidos({ noXml: 0, ignorados: 0 });
    setError(null);
    setCancelando(false);
    canceladoRef.current = false;
    if (inputRef.current) inputRef.current.value = "";
  }

  async function importar() {
    setError(null);
    setResumen(null);
    canceladoRef.current = false;
    setCancelando(false);
    setCorriendo(true);
    try {
      const archivos: ArchivoParaLote[] = [];
      const previos: ResultadoArchivoLote[] = [];
      let noXml = 0;
      let ignorados = 0;
      for (const f of seleccion) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (esZip(f)) {
          const z = descomprimirZip(bytes);
          archivos.push(...z.xml);
          noXml += z.noXml.length;
          ignorados += z.ignorados;
        } else if (!/\.xml$/i.test(f.name)) {
          noXml += 1;
        } else if (bytes.byteLength > MAX_BYTES_XML) {
          previos.push({ archivo: f.name, estado: "rechazado", clase: null, folioFiscal: null, motivo: `El XML excede ${MAX_BYTES_XML / 1024} KB.` });
        } else {
          archivos.push({ nombre: f.name, bytes });
        }
      }
      setOmitidos({ noXml, ignorados });
      if (archivos.length === 0 && previos.length === 0) {
        setError("No hay archivos XML para importar.");
        return;
      }
      const r = await ejecutarImportacion(
        armarTandas(archivos),
        (tanda) => importarLote(fetch, apiBaseUrl, token, propertyId, tanda),
        () => canceladoRef.current,
        setProgreso,
      );
      const conPrevios: ResumenImportacion = previos.length === 0 ? r : { ...r, resultados: [...previos, ...r.resultados], totales: { ...r.totales, recibidos: r.totales.recibidos + previos.length, rechazados: r.totales.rechazados + previos.length } };
      setResumen(conPrevios);
      const nuevos = conPrevios.totales.ingeridos + conPrevios.totales.enRevision;
      if (conPrevios.error) notify.error(`La importación se detuvo: ${conPrevios.error}`);
      else if (conPrevios.cancelada) notify.warning(`Importación cancelada. Ya se importaron ${nuevos} CFDI; no se revierten.`);
      else if (conPrevios.totales.rechazados > 0) notify.warning(`Importación terminada: ${nuevos} CFDI nuevos y ${conPrevios.totales.rechazados} rechazados.`);
      else notify.success(`Importación terminada: ${nuevos} CFDI nuevos, ${conPrevios.totales.duplicados} ya existían.`);
      if (r.totales.recibidos > 0) onTerminado();
    } catch (err) {
      setError(err instanceof ZipNavegadorError || err instanceof Error ? err.message : "No se pudo importar.");
    } finally {
      setCorriendo(false);
      setCancelando(false);
    }
  }

  function cancelar() {
    canceladoRef.current = true;
    setCancelando(true);
  }

  const pct = progreso && progreso.archivosTotal > 0 ? Math.round((progreso.archivosEnviados / progreso.archivosTotal) * 100) : 0;
  const t = resumen?.totales;

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !corriendo) reiniciar();
        onOpenChange(o);
      }}
      titulo="Importar ZIP o varios XML"
      subtitulo="Carga los CFDI de la descarga del SAT: cada XML pasa por las mismas validaciones que la carga individual."
      anchoClase="max-w-3xl"
      bloquearCierre={corriendo}
      footer={
        corriendo ? (
          <Button type="button" variant="outline" className="rounded-full px-6" onClick={cancelar} disabled={cancelando}>
            {cancelando ? "Cancelando…" : "Cancelar importación"}
          </Button>
        ) : resumen ? (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={reiniciar}>
              Importar otro lote
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => void importar()} disabled={seleccion.length === 0}>
              <Upload />
              Importar
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {!corriendo && !resumen && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cfdi-lote-archivos">Archivos (.zip o .xml)</Label>
            <input
              id="cfdi-lote-archivos"
              ref={inputRef}
              type="file"
              multiple
              accept=".zip,.xml,application/zip,application/xml,text/xml"
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border file:border-border file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium"
              onChange={(e) => setSeleccion([...(e.target.files ?? [])])}
            />
            <p className="text-xs text-muted-foreground">
              Un ZIP se descomprime en tu navegador y se envía en tandas de hasta 50 XML (máximo 512 KB por XML). Los complementos de pago (REP) se registran como pagos; los recibos de nómina se rechazan.
            </p>
            {seleccion.length > 0 && <p className="text-xs text-muted-foreground">{seleccion.length} archivo(s) seleccionado(s).</p>}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {progreso && corriendo && (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Tanda {Math.min(progreso.tandasHechas + 1, progreso.tandasTotal)} de {progreso.tandasTotal}
              </span>
              <span className="tabular-nums">
                {progreso.archivosEnviados} de {progreso.archivosTotal} archivos
              </span>
            </div>
            <progress aria-label="Avance de la importación" role="progressbar" max={100} value={pct} className="h-1.5 w-full overflow-hidden rounded-full accent-primary [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-canvas [&::-webkit-progress-value]:bg-primary" />
          </div>
        )}

        {resumen && t && (
          <div className="flex flex-col gap-3">
            {resumen.cancelada && (
              <p role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                Importación cancelada: se importaron {t.ingeridos + t.enRevision} CFDI y quedaron {resumen.sinProcesar} archivo(s) sin enviar. Lo ya importado NO se revierte; puedes volver a cargar el mismo lote (lo que ya existe se reporta como «Ya existía»).
              </p>
            )}
            {resumen.error && (
              <p role="alert" className="text-sm text-destructive">
                La importación se detuvo: {resumen.error} Quedaron {resumen.sinProcesar} archivo(s) sin enviar; lo ya importado no se revierte. Si vuelves a cargar el mismo lote, lo ya importado se reporta como duplicado y se completa lo pendiente.
              </p>
            )}
            <p className="flex flex-wrap items-center gap-2 text-sm" role="status">
              <FileStack className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="tabular-nums">{t.recibidos} archivo(s):</span>
              <StatusBadge tone="success">{t.ingeridos} ingeridos</StatusBadge>
              <StatusBadge tone="warning">{t.enRevision} en revisión</StatusBadge>
              <StatusBadge tone="neutral">{t.duplicados} ya existían</StatusBadge>
              <StatusBadge tone="danger">{t.rechazados} rechazados</StatusBadge>
              {t.reps > 0 && <span className="text-xs text-muted-foreground">({t.reps} complemento(s) de pago)</span>}
            </p>
            {(omitidos.noXml > 0 || omitidos.ignorados > 0) && (
              <p className="text-xs text-muted-foreground">
                {omitidos.noXml > 0 ? `${omitidos.noXml} archivo(s) que no son XML se omitieron. ` : ""}
                {omitidos.ignorados > 0 ? `${omitidos.ignorados} carpeta(s) o archivo(s) de sistema se ignoraron.` : ""}
              </p>
            )}
            {resumen.resultados.length > 0 && (
              <DataTable
                etiqueta="Resultados de la importación"
                obtenerId={(r) => String(r.fila)}
                filas={resumen.resultados.map((r, i) => ({ ...r, fila: i }))}
                paginacion={false}
                columnas={[
                  { id: "archivo", encabezado: "Archivo", principal: true, celda: (r) => <span className="font-mono text-xs">{r.archivo}</span> },
                  { id: "estado", encabezado: "Resultado", celda: (r) => <StatusBadge tone={ESTADO_TONO[r.estado]}>{ESTADO_ETIQUETA[r.estado]}</StatusBadge> },
                  { id: "tipo", encabezado: "Tipo", celda: (r) => <span className="text-muted-foreground">{r.clase === "rep" ? "Complemento de pago" : r.clase === "cfdi" ? "CFDI" : "—"}</span> },
                  { id: "motivo", encabezado: "Detalle", celda: (r) => <span className="text-xs text-muted-foreground">{r.motivo ?? "—"}</span> },
                ]}
              />
            )}
          </div>
        )}
      </div>
    </FormDialog>
  );
}

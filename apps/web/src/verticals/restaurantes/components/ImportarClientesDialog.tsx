// Importar cartera de clientes (CSV o Excel): elegir archivo -> mapeo asistido de columnas -> vista previa con errores por renglon ->
// importar. Todo es real: la vista previa y la importacion llaman a POST .../admin/customers/import[/preview] (normalizacion de
// telefonos, tope de 5,000 renglones, huella del archivo para no duplicar, bitacora). No crea pedidos ni manda mensajes a nadie.
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button, Callout, Checkbox, FormDialog, FormField, Label, NativeSelect, notify } from "@atiende/ui";
import {
  ArchivoImportacionError,
  CAMPOS_IMPORTACION,
  ETIQUETA_CAMPO,
  IMPORTACION_MAX_FILAS,
  construirFilas,
  huellaConMapeo,
  leerArchivoClientes,
  sugerirMapeo,
} from "../lib/clientes-importacion.ts";
import type { ArchivoLeido, CampoImportacion, MapeoColumnas } from "../lib/clientes-importacion.ts";
import { importarClientes, vistaPreviaImportacionClientes } from "../lib/customers-client.ts";
import type { ResultadoImportacionWire, VistaPreviaImportacionWire } from "../lib/customers-client.ts";

export interface ImportarClientesDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Se llama al terminar una importacion que pudo haber guardado clientes: la pagina recarga su lista y sus KPIs. */
  readonly onTerminado: () => void;
}

const SIN_MAPEO: MapeoColumnas = { telefono: null, nombre: null, direccion: null, colonia: null, notas: null };

function mensaje(err: unknown, porDefecto: string): string {
  return err instanceof Error ? err.message : porDefecto;
}

export function ImportarClientesDialog({ open, onOpenChange, apiBaseUrl, token, propertyId, onTerminado }: ImportarClientesDialogProps) {
  const [archivo, setArchivo] = useState<ArchivoLeido | null>(null);
  const [conEncabezado, setConEncabezado] = useState(true);
  const [mapeo, setMapeo] = useState<MapeoColumnas>(SIN_MAPEO);
  const [vista, setVista] = useState<VistaPreviaImportacionWire | null>(null);
  const [resultado, setResultado] = useState<ResultadoImportacionWire | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function reiniciar() {
    setArchivo(null);
    setConEncabezado(true);
    setMapeo(SIN_MAPEO);
    setVista(null);
    setResultado(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const columnas = archivo ? Math.max(0, ...archivo.filas.map((f) => f.length)) : 0;
  const encabezados = archivo ? (conEncabezado ? archivo.filas[0] ?? [] : []) : [];
  const nombreColumna = (i: number) => (conEncabezado && encabezados[i]?.trim() ? `Columna ${i + 1}: ${encabezados[i]!.trim()}` : `Columna ${i + 1}`);
  const filasDatos = archivo ? (conEncabezado ? archivo.filas.slice(1) : archivo.filas) : [];
  const excedeTope = filasDatos.length > IMPORTACION_MAX_FILAS;

  async function elegirArchivo(file: File | undefined) {
    reiniciarSoloResultado();
    if (!file) return;
    setLeyendo(true);
    try {
      const leido = await leerArchivoClientes(file);
      setArchivo(leido);
      setMapeo(sugerirMapeo(leido.filas[0] ?? []));
    } catch (err) {
      setArchivo(null);
      setError(err instanceof ArchivoImportacionError ? err.message : mensaje(err, "No se pudo leer el archivo."));
    } finally {
      setLeyendo(false);
    }
  }

  function reiniciarSoloResultado() {
    setVista(null);
    setResultado(null);
    setError(null);
  }

  function cambiarEncabezado(valor: boolean) {
    setConEncabezado(valor);
    setVista(null);
    if (archivo) setMapeo(valor ? sugerirMapeo(archivo.filas[0] ?? []) : SIN_MAPEO);
  }

  function cambiarMapeo(campo: CampoImportacion, valor: string) {
    setVista(null);
    setMapeo((m) => ({ ...m, [campo]: valor === "" ? null : Number(valor) }));
  }

  async function revisar() {
    if (!archivo) return;
    setError(null);
    setTrabajando(true);
    try {
      setVista(await vistaPreviaImportacionClientes(fetch, apiBaseUrl, token, propertyId, await huellaConMapeo(archivo.huella, mapeo), construirFilas(filasDatos, mapeo)));
    } catch (err) {
      setVista(null);
      setError(mensaje(err, "No se pudo revisar el archivo."));
    } finally {
      setTrabajando(false);
    }
  }

  async function importar() {
    if (!archivo) return;
    setError(null);
    setTrabajando(true);
    try {
      const r = await importarClientes(fetch, apiBaseUrl, token, propertyId, await huellaConMapeo(archivo.huella, mapeo), construirFilas(filasDatos, mapeo));
      setResultado(r);
      if (r.yaImportado) notify.info("Este archivo con estas mismas columnas ya se había importado: no se volvió a escribir nada.");
      else notify.success(`Importación terminada: ${r.creados} clientes nuevos.`);
      onTerminado();
    } catch (err) {
      setError(mensaje(err, "No se pudo importar."));
    } finally {
      setTrabajando(false);
    }
  }

  const sinTelefono = mapeo.telefono === null;

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !trabajando) reiniciar();
        onOpenChange(o);
      }}
      titulo="Importar clientes"
      subtitulo="Sube tu cartera en CSV o Excel (.xlsx). Se agregan clientes nuevos y se completan datos vacíos; nunca se pisa un nombre que ya conocemos."
      anchoClase="max-w-3xl"
      bloquearCierre={trabajando}
      footer={
        resultado ? (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={reiniciar}>
              Importar otro archivo
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={trabajando}>
              Cancelar
            </Button>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => void revisar()} disabled={!archivo || sinTelefono || excedeTope || trabajando} loading={trabajando && !vista}>
              Revisar vista previa
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => void importar()} disabled={!vista || vista.validos === 0 || trabajando} loading={trabajando && !!vista}>
              <Upload />
              {vista ? `Importar ${vista.validos} ${vista.validos === 1 ? "cliente" : "clientes"}` : "Importar clientes"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Callout tone="neutral">Importar no crea pedidos ni manda mensajes a nadie. La reactivación de clientes es otra función y exige su consentimiento.</Callout>

        {!resultado && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clientes-import-archivo">Archivo (.csv o .xlsx, hasta {IMPORTACION_MAX_FILAS} renglones)</Label>
            <input
              id="clientes-import-archivo"
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.tsv,.xlsx,text/csv"
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border file:border-border file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium"
              onChange={(e) => void elegirArchivo(e.target.files?.[0])}
              disabled={trabajando}
            />
            {leyendo && <p className="text-xs text-muted-foreground">Leyendo el archivo…</p>}
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {archivo && !resultado && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              {archivo.nombre}: {filasDatos.length} {filasDatos.length === 1 ? "renglón" : "renglones"} de datos.
            </p>
            {excedeTope && (
              <p role="alert" className="text-sm text-destructive">
                El archivo tiene más de {IMPORTACION_MAX_FILAS} renglones: divídelo en partes.
              </p>
            )}
            <Checkbox checked={conEncabezado} onChange={(e) => cambiarEncabezado(e.target.checked)} label="La primera fila trae los nombres de las columnas" wrapperClassName="text-sm" />
            <div className="grid gap-3 sm:grid-cols-2">
              {CAMPOS_IMPORTACION.map((campo) => (
                <FormField key={campo} label={ETIQUETA_CAMPO[campo]} required={campo === "telefono"} hint={campo === "telefono" ? "10 dígitos; +52 y 521 se aceptan." : undefined}>
                  <NativeSelect id={`clientes-import-${campo}`} size="sm" value={mapeo[campo] === null ? "" : String(mapeo[campo])} onChange={(e) => cambiarMapeo(campo, e.target.value)}>
                    <option value="">{campo === "telefono" ? "Elige la columna…" : "No importar"}</option>
                    {Array.from({ length: columnas }, (_, i) => (
                      <option key={i} value={i}>
                        {nombreColumna(i)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              ))}
            </div>
          </div>
        )}

        {vista && !resultado && (
          <div className="flex flex-col gap-2" data-testid="importar-vista-previa">
            <p className="m-0 text-sm text-foreground">
              {vista.validos} de {vista.total} renglones son válidos
              {vista.duplicadosEnArchivo > 0 ? ` (${vista.duplicadosEnArchivo} repiten un teléfono del mismo archivo: gana el primero)` : ""}.
            </p>
            {vista.totalErrores > 0 && (
              <div className="flex flex-col gap-1">
                <p className="m-0 text-sm font-semibold text-destructive">
                  {vista.totalErrores} {vista.totalErrores === 1 ? "renglón" : "renglones"} con error (no se importan)
                </p>
                <ul className="m-0 max-h-40 list-disc overflow-auto pl-5 text-xs text-foreground">
                  {vista.errores.map((e) => (
                    <li key={e.renglon}>
                      Renglón {e.renglon}: {e.motivo}
                    </li>
                  ))}
                </ul>
                {vista.totalErrores > vista.errores.length && <p className="m-0 text-xs text-muted-foreground">Se muestran los primeros {vista.errores.length}.</p>}
              </div>
            )}
            {vista.muestra.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Ejemplo:{" "}
                {vista.muestra.map((m, i) => (
                  <span key={i}>
                    {i > 0 ? " · " : ""}
                    {m.nombre ?? "Sin nombre"} ({m.telefonoEnmascarado})
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {resultado && (
          <div className="flex flex-col gap-2" data-testid="importar-resultado">
            {resultado.yaImportado && <Callout tone="info">Este archivo con estas mismas columnas ya se había importado antes: no se volvió a escribir nada. Estas son las cifras de la primera vez.</Callout>}
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Clientes nuevos</dt>
              <dd className="m-0 font-semibold text-foreground">{resultado.creados}</dd>
              <dt className="text-muted-foreground">Completados (datos que faltaban)</dt>
              <dd className="m-0 text-foreground">{resultado.actualizados}</dd>
              <dt className="text-muted-foreground">Sin cambios (ya existían)</dt>
              <dd className="m-0 text-foreground">{resultado.sinCambios}</dd>
              <dt className="text-muted-foreground">Rechazados</dt>
              <dd className="m-0 text-foreground">{resultado.rechazados}</dd>
            </dl>
          </div>
        )}
      </div>
    </FormDialog>
  );
}

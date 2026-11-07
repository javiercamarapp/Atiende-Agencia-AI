// Importar cartera de clientes (CSV o Excel): elegir archivo -> mapeo asistido de columnas -> vista previa con errores por renglon ->
// importar. Todo es real: la vista previa y la importacion llaman a POST .../admin/customers/import[/preview] (normalizacion de
// telefonos, tope de 5,000 renglones, huella del archivo para no duplicar, bitacora). No crea pedidos ni manda mensajes a nadie.
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button, Callout, Checkbox, FormDialog, FormField, Label, Selector, notify, useT } from "@atiende/ui";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { restaurantesClientes } from "@atiende/ui/i18n/restaurantes/clientes";
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
  const t = useT(restaurantesComun, restaurantesClientes);
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
  const nombreColumna = (i: number) =>
    conEncabezado && encabezados[i]?.trim() ? t("restaurantes.clientes.imp.columnaCon", { n: i + 1, nombre: encabezados[i]!.trim() }) : t("restaurantes.clientes.imp.columna", { n: i + 1 });
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
      setError(err instanceof ArchivoImportacionError ? err.message : mensaje(err, t("restaurantes.clientes.imp.errorLeer")));
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
      setError(mensaje(err, t("restaurantes.clientes.imp.errorRevisar")));
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
      if (r.yaImportado) notify.info(t("restaurantes.clientes.imp.yaImportado"));
      else notify.success(t("restaurantes.clientes.imp.terminada", { n: r.creados }));
      onTerminado();
    } catch (err) {
      setError(mensaje(err, t("restaurantes.clientes.imp.errorImportar")));
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
      titulo={t("restaurantes.clientes.importar")}
      subtitulo={t("restaurantes.clientes.imp.subtitulo")}
      anchoClase="max-w-3xl"
      bloquearCierre={trabajando}
      footer={
        resultado ? (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={reiniciar}>
              {t("restaurantes.clientes.imp.otro")}
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => onOpenChange(false)}>
              {t("restaurantes.clientes.imp.cerrar")}
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => onOpenChange(false)} disabled={trabajando}>
              {t("restaurantes.cancelar")}
            </Button>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => void revisar()} disabled={!archivo || sinTelefono || excedeTope || trabajando} loading={trabajando && !vista}>
              {t("restaurantes.clientes.imp.revisar")}
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => void importar()} disabled={!vista || vista.validos === 0 || trabajando} loading={trabajando && !!vista}>
              <Upload />
              {vista ? t("restaurantes.clientes.imp.importarN", { count: vista.validos }) : t("restaurantes.clientes.importar")}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <Callout tone="neutral">{t("restaurantes.clientes.imp.aviso")}</Callout>

        {!resultado && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="clientes-import-archivo">{t("restaurantes.clientes.imp.archivo", { max: IMPORTACION_MAX_FILAS })}</Label>
            <input
              id="clientes-import-archivo"
              ref={inputRef}
              type="file"
              accept=".csv,.txt,.tsv,.xlsx,text/csv"
              className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border file:border-border file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium"
              onChange={(e) => void elegirArchivo(e.target.files?.[0])}
              disabled={trabajando}
            />
            {leyendo && <p className="text-xs text-muted-foreground">{t("restaurantes.clientes.imp.leyendo")}</p>}
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
              {t("restaurantes.clientes.imp.renglonesDatos", { archivo: archivo.nombre, count: filasDatos.length })}
            </p>
            {excedeTope && (
              <p role="alert" className="text-sm text-destructive">
                {t("restaurantes.clientes.imp.excede", { max: IMPORTACION_MAX_FILAS })}
              </p>
            )}
            <Checkbox checked={conEncabezado} onChange={(e) => cambiarEncabezado(e.target.checked)} label={t("restaurantes.clientes.imp.encabezado")} wrapperClassName="text-sm" />
            <div className="grid gap-3 sm:grid-cols-2">
              {CAMPOS_IMPORTACION.map((campo) => (
                <FormField key={campo} label={ETIQUETA_CAMPO[campo]} required={campo === "telefono"} hint={campo === "telefono" ? t("restaurantes.clientes.imp.telefonoAyuda") : undefined}>
                  <Selector id={`clientes-import-${campo}`} size="sm" value={mapeo[campo] === null ? "" : String(mapeo[campo])} onChange={(e) => cambiarMapeo(campo, e.target.value)}>
                    <option value="">{t(campo === "telefono" ? "restaurantes.clientes.imp.eligeColumna" : "restaurantes.clientes.imp.noImportar")}</option>
                    {Array.from({ length: columnas }, (_, i) => (
                      <option key={i} value={i}>
                        {nombreColumna(i)}
                      </option>
                    ))}
                  </Selector>
                </FormField>
              ))}
            </div>
          </div>
        )}

        {vista && !resultado && (
          <div className="flex flex-col gap-2" data-testid="importar-vista-previa">
            <p className="m-0 text-sm text-foreground">
              {t("restaurantes.clientes.imp.validos", { validos: vista.validos, total: vista.total })}
              {vista.duplicadosEnArchivo > 0 ? t("restaurantes.clientes.imp.duplicados", { n: vista.duplicadosEnArchivo }) : ""}.
            </p>
            {vista.totalErrores > 0 && (
              <div className="flex flex-col gap-1">
                <p className="m-0 text-sm font-semibold text-destructive">
                  {t("restaurantes.clientes.imp.conError", { count: vista.totalErrores })}
                </p>
                <ul className="m-0 max-h-40 list-disc overflow-auto pl-5 text-xs text-foreground">
                  {vista.errores.map((e) => (
                    <li key={e.renglon}>
                      {t("restaurantes.clientes.imp.renglon", { n: e.renglon, motivo: e.motivo })}
                    </li>
                  ))}
                </ul>
                {vista.totalErrores > vista.errores.length && <p className="m-0 text-xs text-muted-foreground">{t("restaurantes.clientes.imp.primeros", { n: vista.errores.length })}</p>}
              </div>
            )}
            {vista.muestra.length > 0 && (
              <div className="text-xs text-muted-foreground">
                {t("restaurantes.clientes.imp.ejemplo")}{" "}
                {vista.muestra.map((m, i) => (
                  <span key={i}>
                    {i > 0 ? " · " : ""}
                    {m.nombre ?? t("restaurantes.clientes.sinNombre")} ({m.telefonoEnmascarado})
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {resultado && (
          <div className="flex flex-col gap-2" data-testid="importar-resultado">
            {resultado.yaImportado && <Callout tone="info">{t("restaurantes.clientes.imp.yaImportadoAntes")}</Callout>}
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("restaurantes.clientes.imp.nuevos")}</dt>
              <dd className="m-0 font-semibold text-foreground">{resultado.creados}</dd>
              <dt className="text-muted-foreground">{t("restaurantes.clientes.imp.completados")}</dt>
              <dd className="m-0 text-foreground">{resultado.actualizados}</dd>
              <dt className="text-muted-foreground">{t("restaurantes.clientes.imp.sinCambios")}</dt>
              <dd className="m-0 text-foreground">{resultado.sinCambios}</dd>
              <dt className="text-muted-foreground">{t("restaurantes.clientes.imp.rechazados")}</dt>

              <dd className="m-0 text-foreground">{resultado.rechazados}</dd>
            </dl>
          </div>
        )}
      </div>
    </FormDialog>
  );
}

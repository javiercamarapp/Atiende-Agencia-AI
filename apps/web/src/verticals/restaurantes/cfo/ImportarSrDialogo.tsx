// CFO-08 · «Importar reporte de SoftRestaurant»: sucursal -> tipo de reporte -> archivo (.csv o .xlsx, máx. 5 MB) -> mapeo asistido -> vista previa
// (aceptados, rechazados y errores por renglón, sin escribir nada) -> confirmar. La importación es idempotente: el mismo archivo con el mismo mapeo responde
// «Este archivo ya estaba cargado». Las columnas de cliente NO se suben (se excluyen en el navegador y el servidor las vuelve a rechazar).
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { MAX_RENGLONES_SR } from "@atiende/domain-restaurantes/cfo";
import type { AlcanceVista, ImportacionSrVista, TipoLayoutSr, VistaPreviaSr } from "@atiende/domain-restaurantes/cfo";
import { Button, Callout, DataTable, FormDialog, FormField, Label, NativeSelect, notify } from "@atiende/ui";
import { importarSr, vistaPreviaSr, type ContextoCfo, type CuerpoImportarSr } from "./cfo-client.ts";
import { MapeoColumnasSr } from "./MapeoColumnasSr.tsx";
import {
  ArchivoImportacionError,
  IMPORTACION_MAX_BYTES,
  TIPOS_REPORTE_SR,
  camposFaltantes,
  camposRepetidos,
  columnasPersonales,
  nombresPersonales,
  valorPersonalEnMapeo,
  MENSAJE_VALOR_PERSONAL,
  construirTablaSr,
  detectarFilaEncabezado,
  leerArchivoSr,
  sugerirMapeoSr,
  sugerirTipo,
  type ArchivoSrLeido,
  type MapeoSr,
} from "./sr-importacion-navegador.ts";
import { entero } from "./formato.ts";

export const MENSAJE_YA_CARGADO = "Este archivo ya estaba cargado";

export interface ImportarSrDialogoProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly api: ContextoCfo;
  readonly sucursales: AlcanceVista["sucursales"];
  /** Se llama tras una importación (nueva o repetida): la pestaña recarga lotes y cuadre. */
  readonly onTerminado: () => void;
}

const mensajeDe = (err: unknown, porDefecto: string): string => (err instanceof Error ? err.message : porDefecto);
const MB = IMPORTACION_MAX_BYTES / (1024 * 1024);

export function ImportarSrDialogo({ abierto, onCerrar, api, sucursales, onTerminado }: ImportarSrDialogoProps) {
  const [propertyId, setPropertyId] = useState<string>(sucursales.length === 1 ? sucursales[0]!.propertyId : "");
  const [tipo, setTipo] = useState<TipoLayoutSr>("resumen_servicio");
  const [archivo, setArchivo] = useState<ArchivoSrLeido | null>(null);
  const [filaEnc, setFilaEnc] = useState(0);
  const [mapeo, setMapeo] = useState<MapeoSr>({});
  const [vista, setVista] = useState<VistaPreviaSr | null>(null);
  const [resultado, setResultado] = useState<ImportacionSrVista | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function reiniciar() {
    setArchivo(null);
    setFilaEnc(0);
    setMapeo({});
    setVista(null);
    setResultado(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  const encabezados = archivo ? (archivo.filas[filaEnc] ?? []) : [];
  const nombresPers = archivo ? nombresPersonales(archivo.filas, filaEnc) : new Map<number, string>();
  const personales = new Set(nombresPers.keys());
  const excluidas = [...nombresPers.values()];
  const valorPersonal = archivo ? valorPersonalEnMapeo(archivo.filas, filaEnc, tipo, mapeo) : null;
  const filasDatos = archivo ? Math.max(0, archivo.filas.length - filaEnc - 1) : 0;
  const maximo = MAX_RENGLONES_SR[tipo];
  const excedeTope = filasDatos > maximo;
  const mapeoListo = archivo !== null && camposFaltantes(tipo, mapeo).length === 0 && camposRepetidos(mapeo).length === 0;
  const puedeRevisar = propertyId !== "" && mapeoListo && !excedeTope && !trabajando && valorPersonal === null;

  function sugerir(filas: readonly (readonly string[])[], f: number, t: TipoLayoutSr) {
    setMapeo(sugerirMapeoSr(filas[f] ?? [], t, new Set(columnasPersonales(filas, f))));
    setVista(null);
  }

  async function elegirArchivo(file: File | undefined) {
    setVista(null);
    setResultado(null);
    setError(null);
    if (!file) {
      setArchivo(null);
      return;
    }
    setLeyendo(true);
    try {
      const leido = await leerArchivoSr(file);
      const f = detectarFilaEncabezado(leido.filas);
      const t = sugerirTipo(leido.filas[f] ?? []);
      setArchivo(leido);
      setFilaEnc(f);
      setTipo(t);
      sugerir(leido.filas, f, t);
    } catch (err) {
      setArchivo(null);
      setError(err instanceof ArchivoImportacionError ? err.message : mensajeDe(err, "No se pudo leer el archivo."));
    } finally {
      setLeyendo(false);
    }
  }

  function cuerpo(): CuerpoImportarSr {
    const { tabla } = construirTablaSr(archivo!.filas, filaEnc, tipo, mapeo);
    return { propertyId, nombreArchivo: archivo!.nombre.replace(/[/\\]/g, "_").slice(0, 120), tabla, tipo };
  }

  async function revisar() {
    if (!archivo) return;
    setError(null);
    setTrabajando(true);
    try {
      setVista(await vistaPreviaSr(api, cuerpo()));
    } catch (err) {
      setVista(null);
      setError(mensajeDe(err, "No se pudo revisar el archivo."));
    } finally {
      setTrabajando(false);
    }
  }

  async function confirmar() {
    if (!archivo || !vista) return;
    setError(null);
    setTrabajando(true);
    try {
      const r = await importarSr(api, cuerpo());
      setResultado(r);
      if (r.creado) notify.success(`Reporte importado: ${entero(r.aceptados)} renglones aceptados.`);
      else notify.info(`${MENSAJE_YA_CARGADO}: no se volvió a escribir nada.`);
      onTerminado();
    } catch (err) {
      setError(mensajeDe(err, "No se pudo importar el reporte."));
    } finally {
      setTrabajando(false);
    }
  }

  const cerrar = () => {
    if (trabajando) return;
    reiniciar();
    onCerrar();
  };

  return (
    <FormDialog
      open={abierto}
      onOpenChange={(o) => {
        if (!o) cerrar();
      }}
      titulo="Importar reporte de SoftRestaurant"
      subtitulo="Sube el reporte que exportas de SoftRestaurant para ver cuánto vendes en mostrador y cuadrar tus pedidos a domicilio. No se manda nada a SoftRestaurant."
      anchoClase="max-w-3xl"
      bloquearCierre={trabajando}
      footer={
        resultado ? (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={reiniciar}>
              Importar otro archivo
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={cerrar}>
              Cerrar
            </Button>
          </>
        ) : (
          <>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={cerrar} disabled={trabajando}>
              Cancelar
            </Button>
            <Button type="button" variant="outline" className="rounded-full px-6" onClick={() => void revisar()} disabled={!puedeRevisar} loading={trabajando && !vista}>
              Revisar vista previa
            </Button>
            <Button type="button" className="rounded-full px-6" onClick={() => void confirmar()} disabled={!vista || vista.aceptados === 0 || trabajando} loading={trabajando && vista !== null}>
              <Upload />
              {vista ? `Importar ${entero(vista.aceptados)} ${vista.aceptados === 1 ? "renglón" : "renglones"}` : "Importar reporte"}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3" data-testid="importar-sr">
        {!resultado && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Sucursal del reporte" required hint="Un archivo corresponde a una sola sucursal.">
                <NativeSelect
                  id="sr-sucursal"
                  size="sm"
                  value={propertyId}
                  onChange={(e) => {
                    setPropertyId(e.target.value);
                    setVista(null);
                  }}
                  data-testid="sr-sucursal"
                >
                  <option value="">Elige la sucursal…</option>
                  {sucursales.map((s) => (
                    <option key={s.propertyId} value={s.propertyId}>
                      {s.nombre}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField label="Tipo de reporte" required hint={TIPOS_REPORTE_SR.find((t) => t.valor === tipo)?.ayuda}>
                <NativeSelect
                  id="sr-tipo"
                  size="sm"
                  value={tipo}
                  onChange={(e) => {
                    const t = e.target.value as TipoLayoutSr;
                    setTipo(t);
                    if (archivo) sugerir(archivo.filas, filaEnc, t);
                  }}
                  data-testid="sr-tipo"
                >
                  {TIPOS_REPORTE_SR.map((t) => (
                    <option key={t.valor} value={t.valor}>
                      {t.etiqueta}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sr-archivo">Archivo (.csv o .xlsx, hasta {MB} MB)</Label>
              <input
                id="sr-archivo"
                ref={inputRef}
                type="file"
                accept=".csv,.txt,.tsv,.xlsx,text/csv"
                className="block w-full text-sm text-foreground file:mr-3 file:rounded-full file:border file:border-border file:bg-canvas file:px-3 file:py-1.5 file:text-xs file:font-medium"
                onChange={(e) => void elegirArchivo(e.target.files?.[0])}
                disabled={trabajando}
              />
              {leyendo && <p className="m-0 text-xs text-muted-foreground">Leyendo el archivo…</p>}
            </div>
          </>
        )}

        {error && (
          <p role="alert" className="m-0 text-sm text-destructive" data-testid="sr-error">
            {error}
          </p>
        )}

        {archivo && !resultado && (
          <div className="flex flex-col gap-3">
            <p className="m-0 text-xs text-muted-foreground">
              {archivo.nombre}: {entero(filasDatos)} {filasDatos === 1 ? "renglón" : "renglones"} de datos.
            </p>
            {valorPersonal && (
              <p role="alert" className="m-0 text-sm text-destructive" data-testid="sr-valor-personal">
                {MENSAJE_VALOR_PERSONAL(valorPersonal)}
              </p>
            )}
            {excedeTope && (
              <p role="alert" className="m-0 text-sm text-destructive">
                El archivo tiene más de {entero(maximo)} renglones: divídelo por periodos e impórtalo en partes.
              </p>
            )}
            <FormField label="Renglón de los encabezados" hint="Es la fila con los nombres de las columnas; el reporte puede traer títulos arriba.">
              <NativeSelect
                id="sr-fila-encabezado"
                size="sm"
                value={String(filaEnc)}
                onChange={(e) => {
                  const f = Number(e.target.value);
                  setFilaEnc(f);
                  sugerir(archivo.filas, f, tipo);
                }}
              >
                {archivo.filas.slice(0, 15).map((f, i) => (
                  <option key={i} value={i}>
                    {`Renglón ${i + 1}: ${f.filter((c) => c.trim() !== "").slice(0, 3).join(" · ").slice(0, 60) || "(vacío)"}`}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <MapeoColumnasSr
              tipo={tipo}
              encabezados={encabezados}
              personales={personales}
              excluidas={excluidas}
              mapeo={mapeo}
              onCambiar={(campo, indice) => {
                setMapeo((m) => ({ ...m, [campo]: indice }));
                setVista(null);
              }}
              {...(vista ? { avisoAlias: vista.avisoAlias } : {})}
            />
          </div>
        )}

        {vista && !resultado && (
          <div className="flex flex-col gap-2" data-testid="sr-vista-previa">
            <p className="m-0 text-sm text-foreground">
              <strong>{entero(vista.aceptados)}</strong> {vista.aceptados === 1 ? "renglón aceptado" : "renglones aceptados"} y <strong>{entero(vista.rechazados)}</strong> {vista.rechazados === 1 ? "rechazado" : "rechazados"}
              {vista.omitidos > 0 ? ` (${entero(vista.omitidos)} renglones de totales se omiten)` : ""}
              {vista.fechaMin && vista.fechaMax ? `, del ${vista.fechaMin} al ${vista.fechaMax}` : ""}.
            </p>
            <p className="m-0 text-xs text-muted-foreground">{vista.avisoAlias} Huella del contenido: {vista.huella.slice(0, 12)}…</p>
            {vista.advertencias.length > 0 && (
              <Callout tone="warning">
                <ul className="m-0 list-disc pl-4">
                  {vista.advertencias.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {vista.errores.length > 0 && (
              <div className="flex flex-col gap-1" data-testid="sr-errores">
                <p className="m-0 text-sm font-semibold text-destructive">
                  {entero(vista.errores.length)} {vista.errores.length === 1 ? "error" : "errores"} por renglón (esos renglones no se importan)
                </p>
                <ul className="m-0 max-h-40 list-disc overflow-auto pl-5 text-xs text-foreground">
                  {vista.errores.map((e, i) => (
                    <li key={`${e.renglon}-${e.campo}-${i}`}>
                      Renglón {e.renglon}, {e.campo}: {e.motivo}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {vista.aceptados === 0 && <p className="m-0 text-sm text-destructive">Ningún renglón es válido: revisa el mapeo de columnas.</p>}
            {vista.muestra.length > 0 && (
              <div data-testid="sr-muestra">
                <DataTable<Readonly<Record<string, string | number | boolean | null>>>
                  etiqueta="Primeros renglones normalizados (sin datos de clientes)"
                  filas={vista.muestra.slice(0, 5)}
                  obtenerId={(f) => JSON.stringify(f)}
                  paginacion={false}
                  vista="tabla"
                  columnas={Object.keys(vista.muestra[0]!).map((k, i) => ({ id: k, encabezado: k, ...(i === 0 ? { principal: true } : {}), className: "tabular-nums", celda: (f) => (f[k] === null || f[k] === undefined ? "—" : String(f[k])) }))}
                />
              </div>
            )}
          </div>
        )}

        {resultado && (
          <div className="flex flex-col gap-2" data-testid="sr-resultado">
            {resultado.creado ? (
              <Callout tone="success" titulo="Reporte importado">
                Se aceptaron {entero(resultado.aceptados)} renglones y se rechazaron {entero(resultado.rechazados)}. Ya puedes ver el cuadre de tus pedidos a domicilio.
              </Callout>
            ) : (
              <Callout tone="info" titulo={MENSAJE_YA_CARGADO} data-testid="sr-ya-cargado">
                Es el mismo contenido con el mismo mapeo de una importación anterior: no se volvió a escribir nada. Estas son las cifras de la primera vez ({entero(resultado.aceptados)} aceptados,{" "}
                {entero(resultado.rechazados)} rechazados).
              </Callout>
            )}
            {resultado.errores.length > 0 && (
              <ul className="m-0 max-h-32 list-disc overflow-auto pl-5 text-xs">
                {resultado.errores.map((e, i) => (
                  <li key={`${e.renglon}-${i}`}>
                    Renglón {e.renglon}, {e.campo}: {e.motivo}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </FormDialog>
  );
}

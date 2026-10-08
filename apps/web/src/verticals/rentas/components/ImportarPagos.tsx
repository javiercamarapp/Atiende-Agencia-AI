// Rn-P3-06/07 -- seccion de Finanzas "Pagos de la OTA": importar el reporte de pagos (CSV) con vista previa y confirmacion, cola de lineas
// pendientes, indicador de reservas sin movimiento del mes y movimientos en revision. Todo llama a endpoints reales
// (apps/api/.../rentas/finanzas-importacion.ts); si la base no tiene la migracion 035 muestra un estado honesto "no disponible aun".
// Cancelar o cerrar NUNCA llama al servidor: solo "Confirmar importacion" (tras useConfirm) escribe.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { FileUp, Info } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoVacio, FormDialog, Input, Label, NativeSelect, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, useConfirm } from "@atiende/ui";
import type { StatusTone } from "@atiende/ui";
import {
  CANALES_REPORTE_CSV,
  centavosAPesos,
  fetchColaImportacion,
  fetchMovimientosEnRevision,
  fetchSinMovimiento,
  importarReportePagos,
  marcarMovimientoRevisado,
  MAX_BYTES_REPORTE_CSV,
  periodoActual,
  porcentajeABasisPoints,
} from "../lib/finanzas-client.ts";
import type { BaseComisionGestor, LineaColaImportacion, ListadoDisponible, MovimientoEnRevision, ResultadoImportacionPagos, ResultadoLineaImportacion, SinMovimientoPeriodo } from "../lib/finanzas-client.ts";

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";
const NOTA_CLASES = "m-0 rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground";

const RESULTADO_LABELS: Record<ResultadoLineaImportacion, string> = { creada: "Movimiento creado", conciliada: "Conciliada", discrepancia: "Discrepancia", pendiente: "Pendiente", ya_importada: "Ya importada" };
const RESULTADO_TONES: Record<ResultadoLineaImportacion, StatusTone> = { creada: "success", conciliada: "success", discrepancia: "danger", pendiente: "warning", ya_importada: "neutral" };
const MOTIVO_LABELS: Record<string, string> = {
  reserva_modificada: "La reserva cambió de fechas",
  reserva_cancelada: "La reserva se canceló",
  comision_gestor_pendiente: "Falta confirmar la comisión del gestor",
  discrepancia_importacion: "La comisión del reporte no coincide con la regla",
};
const NO_DISPONIBLE = "No disponible aún en este ambiente: falta aplicar una actualización de base de datos (migración 035 de rentas).";

interface Props {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly puedeEscribir: boolean;
}

export function ImportarPagosSection({ apiBaseUrl, token, propertyId, puedeEscribir }: Props) {
  const periodo = periodoActual();
  const { confirmar, dialogo } = useConfirm();
  const [sinMovimiento, setSinMovimiento] = useState<SinMovimientoPeriodo | null>(null);
  const [cola, setCola] = useState<ListadoDisponible<LineaColaImportacion> | null>(null);
  const [revision, setRevision] = useState<ListadoDisponible<MovimientoEnRevision> | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [verSinMovimiento, setVerSinMovimiento] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const [marcando, setMarcando] = useState<string | null>(null);
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setErrorCarga(null);
    try {
      const [s, c, r] = await Promise.all([
        fetchSinMovimiento(fetch, apiBaseUrl, token, propertyId, periodo),
        fetchColaImportacion(fetch, apiBaseUrl, token, propertyId),
        fetchMovimientosEnRevision(fetch, apiBaseUrl, token, propertyId),
      ]);
      setSinMovimiento(s);
      setCola(c);
      setRevision(r);
    } catch (err) {
      setErrorCarga(err instanceof Error ? err.message : "No se pudo cargar el estado de los pagos.");
    }
  }, [apiBaseUrl, token, propertyId, periodo]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function revisar(m: MovimientoEnRevision) {
    const ok = await confirmar({ titulo: "Marcar el movimiento como revisado", descripcion: "Confirmas que revisaste este movimiento tras el cambio de la reserva. El monto no se recalcula.", confirmar: "Marcar como revisado", cancelar: "Cancelar" });
    if (!ok) return;
    setMarcando(m.ocupacionId);
    setErrorAccion(null);
    try {
      await marcarMovimientoRevisado(fetch, apiBaseUrl, token, propertyId, m.ocupacionId);
      await cargar();
    } catch (err) {
      setErrorAccion(err instanceof Error ? err.message : "No se pudo marcar el movimiento.");
    } finally {
      setMarcando(null);
    }
  }

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base font-semibold">Pagos de la OTA (reporte CSV)</CardTitle>
        <CardDescription className="text-xs">
          Sube el reporte de pagos del canal: el sistema crea el movimiento de cada reserva y la concilia. Lo que no cuadra queda en la cola de revisión.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0 flex flex-col gap-3">
        {errorCarga && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {errorCarga}
          </p>
        )}
        {!sinMovimiento && !errorCarga && <EstadoCargando variante="bloque" />}

        <div className="flex gap-2.5 flex-wrap items-center">
          {puedeEscribir && (
            <Button type="button" size="sm" onClick={() => setAbierto(true)}>
              <FileUp className="w-4 h-4" strokeWidth={1.75} />
              Importar reporte de pagos (CSV)
            </Button>
          )}
          {sinMovimiento && (
            <p className="m-0 text-sm text-foreground" data-testid="indicador-sin-movimiento">
              <strong>{sinMovimiento.total}</strong> {sinMovimiento.total === 1 ? "reserva sin movimiento" : "reservas sin movimiento"} este mes ({sinMovimiento.periodo})
              {sinMovimiento.total > 0 && (
                <>
                  {" · "}
                  <button type="button" className="underline text-foreground bg-transparent border-0 p-0 cursor-pointer text-sm" onClick={() => setVerSinMovimiento((v) => !v)}>
                    {verSinMovimiento ? "Ocultar lista" : "Ver lista"}
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        {verSinMovimiento && sinMovimiento && sinMovimiento.items.length > 0 && (
          <div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-2 text-xs">Check-in</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Check-out</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Canal</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sinMovimiento.items.map((r) => (
                  <TableRow key={r.ocupacionId}>
                    <TableCell className="p-2 text-xs">{r.inicio}</TableCell>
                    <TableCell className="p-2 text-xs">{r.fin}</TableCell>
                    <TableCell className="p-2 text-xs">{r.canalCodigo ?? "—"}</TableCell>
                    <TableCell className="p-2 text-xs font-mono">{r.ocupacionId}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {sinMovimiento.total > sinMovimiento.items.length && <p className="m-0 mt-1 text-xs text-muted-foreground">Mostrando {sinMovimiento.items.length} de {sinMovimiento.total}.</p>}
            <p className="m-0 mt-1 text-xs text-muted-foreground">Registra su movimiento en la sección «Movimiento financiero por reserva» con el id de la reserva, o importa el reporte de pagos del canal.</p>
          </div>
        )}

        <div className="border-t border-border pt-2.5">
          <p className="m-0 mb-1.5 text-sm font-medium text-foreground">Movimientos en revisión</p>
          {revision && !revision.disponible && <p className={NOTA_CLASES}>{NO_DISPONIBLE}</p>}
          {revision?.disponible && revision.items.length === 0 && <EstadoVacio compacto titulo="Nada por revisar" mensaje="Ningún movimiento cambió después de registrarse." />}
          {revision?.disponible && revision.items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-2 text-xs">Reserva</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Motivo</TableHead>
                  <TableHead className="h-8 px-2 text-xs text-right">Neto</TableHead>
                  {puedeEscribir && <TableHead className="h-8 px-2 text-xs" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {revision.items.map((m) => (
                  <TableRow key={m.ocupacionId}>
                    <TableCell className="p-2 text-xs font-mono">{m.ocupacionId}</TableCell>
                    <TableCell className="p-2 text-xs">{MOTIVO_LABELS[m.motivo] ?? m.motivo}</TableCell>
                    <TableCell className="p-2 text-xs text-right tabular-nums">
                      {centavosAPesos(m.netoCentavos)} {m.moneda}
                    </TableCell>
                    {puedeEscribir && (
                      <TableCell className="p-2 text-xs text-right">
                        <Button type="button" variant="outline" size="sm" disabled={marcando === m.ocupacionId} onClick={() => void revisar(m)}>
                          {marcando === m.ocupacionId ? "Marcando…" : "Marcar revisado"}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {errorAccion && (
            <p role="alert" className="m-0 mt-1 text-sm text-destructive">
              {errorAccion}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-2.5">
          <p className="m-0 mb-1.5 text-sm font-medium text-foreground">Cola de líneas por resolver</p>
          {cola && !cola.disponible && <p className={NOTA_CLASES}>{NO_DISPONIBLE}</p>}
          {cola?.disponible && cola.items.length === 0 && <EstadoVacio compacto titulo="Cola vacía" mensaje="No hay líneas importadas pendientes ni con discrepancia." />}
          {cola?.disponible && cola.items.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-8 px-2 text-xs">Código</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Canal</TableHead>
                  <TableHead className="h-8 px-2 text-xs text-right">Monto</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Estado</TableHead>
                  <TableHead className="h-8 px-2 text-xs">Qué falta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cola.items.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="p-2 text-xs">{l.codigoConfirmacion ?? "—"}</TableCell>
                    <TableCell className="p-2 text-xs">{l.canalCodigo}</TableCell>
                    <TableCell className="p-2 text-xs text-right tabular-nums">
                      {centavosAPesos(l.montoNetoCentavos)} {l.moneda}
                    </TableCell>
                    <TableCell className="p-2 text-xs">
                      <StatusBadge tone={RESULTADO_TONES[l.resultado]}>{RESULTADO_LABELS[l.resultado]}</StatusBadge>
                    </TableCell>
                    <TableCell className="p-2 text-xs">{l.nota ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </CardContent>
      {dialogo}
      {puedeEscribir && <DialogoImportar abierto={abierto} onCerrar={() => setAbierto(false)} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} onImportado={cargar} />}
    </Card>
  );
}

interface DialogoProps {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly onImportado: () => Promise<void>;
}

function DialogoImportar({ abierto, onCerrar, apiBaseUrl, token, propertyId, onImportado }: DialogoProps) {
  const { confirmar, dialogo } = useConfirm();
  const [canalCodigo, setCanalCodigo] = useState("airbnb");
  const [archivo, setArchivo] = useState<{ nombre: string; texto: string } | null>(null);
  const [comisionPct, setComisionPct] = useState("");
  const [comisionBase, setComisionBase] = useState<BaseComisionGestor>("neto_de_canal");
  const [previa, setPrevia] = useState<ResultadoImportacionPagos | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultadoFinal, setResultadoFinal] = useState<string | null>(null);
  const entradaArchivo = useRef<HTMLInputElement | null>(null);

  function reiniciarPrevia() {
    setPrevia(null);
    setResultadoFinal(null);
    setError(null);
  }

  async function alElegirArchivo(e: ChangeEvent<HTMLInputElement>) {
    reiniciarPrevia();
    const f = e.target.files?.[0];
    if (!f) return setArchivo(null);
    if (f.size > MAX_BYTES_REPORTE_CSV) {
      setArchivo(null);
      return setError("El archivo excede 2 MB: sube solo el reporte del periodo que quieres importar.");
    }
    try {
      setArchivo({ nombre: f.name, texto: await f.text() });
    } catch {
      setArchivo(null);
      setError("No se pudo leer el archivo.");
    }
  }

  function parametros(): { bp: number } | null {
    const pct = Number(comisionPct);
    if (!archivo) {
      setError("Elige el archivo CSV del reporte de pagos.");
      return null;
    }
    if (comisionPct.trim() === "" || Number.isNaN(pct) || pct < 0 || pct > 100) {
      setError("Comisión de gestor: 0 a 100 %.");
      return null;
    }
    return { bp: porcentajeABasisPoints(pct) };
  }

  async function vistaPrevia() {
    setError(null);
    setResultadoFinal(null);
    const p = parametros();
    if (!p || !archivo) return;
    setCargando(true);
    try {
      setPrevia(await importarReportePagos(fetch, apiBaseUrl, token, propertyId, { canalCodigo, contenidoCsv: archivo.texto, aplicar: false, comisionGestorBasisPoints: p.bp, comisionGestorBase: comisionBase }));
    } catch (err) {
      setPrevia(null);
      setError(err instanceof Error ? err.message : "No se pudo generar la vista previa.");
    } finally {
      setCargando(false);
    }
  }

  async function confirmarImportacion() {
    const p = parametros();
    if (!p || !archivo || !previa) return;
    const ok = await confirmar({
      titulo: "Confirmar la importación",
      descripcion: `Se crearán ${previa.resumen.creadas} movimientos y se conciliarán ${previa.resumen.conciliadas}; ${previa.resumen.pendientes} quedan pendientes y ${previa.resumen.discrepancias} con discrepancia. Volver a subir el mismo archivo no duplica nada.`,
      confirmar: "Importar",
      cancelar: "Cancelar",
    });
    if (!ok) return;
    setCargando(true);
    setError(null);
    try {
      const r = await importarReportePagos(fetch, apiBaseUrl, token, propertyId, { canalCodigo, contenidoCsv: archivo.texto, aplicar: true, comisionGestorBasisPoints: p.bp, comisionGestorBase: comisionBase });
      setResultadoFinal(`Importación registrada: ${r.resumen.creadas} movimientos creados · ${r.resumen.conciliadas} conciliadas · ${r.resumen.discrepancias} con discrepancia · ${r.resumen.pendientes} pendientes · ${r.resumen.yaImportadas} ya importadas.`);
      setPrevia(null);
      await onImportado();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar el reporte.");
    } finally {
      setCargando(false);
    }
  }

  function cerrar() {
    if (cargando) return;
    setArchivo(null);
    setPrevia(null);
    setResultadoFinal(null);
    setError(null);
    setComisionPct("");
    if (entradaArchivo.current) entradaArchivo.current.value = "";
    onCerrar();
  }

  const hayErrores = (previa?.errores.length ?? 0) > 0;
  const nada = previa && previa.resumen.creadas + previa.resumen.conciliadas + previa.resumen.discrepancias + previa.resumen.pendientes === 0;

  return (
    <>
      <FormDialog
        open={abierto}
        onOpenChange={(o) => {
          if (!o) cerrar();
        }}
        titulo="Importar reporte de pagos"
        subtitulo="Primero una vista previa: nada se guarda hasta que confirmes."
        anchoClase="max-w-3xl"
        bloquearCierre={cargando}
        footer={
          <>
            <Button type="button" variant="outline" size="sm" onClick={cerrar} disabled={cargando}>
              Cancelar
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void vistaPrevia()} disabled={cargando || !archivo}>
              {cargando && !previa ? "Calculando…" : "Vista previa"}
            </Button>
            <Button type="button" size="sm" onClick={() => void confirmarImportacion()} disabled={cargando || !previa || hayErrores || !!nada}>
              Confirmar importación
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex gap-2.5 flex-wrap">
            <Label className={`${LABEL_CLASES} flex-1 min-w-[180px]`}>
              Canal
              <NativeSelect
                value={canalCodigo}
                onChange={(e) => {
                  setCanalCodigo(e.target.value);
                  reiniciarPrevia();
                }}
              >
                {CANALES_REPORTE_CSV.map((c) => (
                  <option key={c.codigo} value={c.codigo} disabled={!c.soportado}>
                    {c.soportado ? c.nombre : `${c.nombre} — formato no soportado todavía`}
                  </option>
                ))}
              </NativeSelect>
            </Label>
            <Label className={`${LABEL_CLASES} w-[150px]`}>
              Comisión de gestor (%)
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={comisionPct}
                onChange={(e) => {
                  setComisionPct(e.target.value);
                  reiniciarPrevia();
                }}
                placeholder="10"
              />
            </Label>
            <Label className={`${LABEL_CLASES} flex-1 min-w-[160px]`}>
              Base de la comisión
              <NativeSelect
                value={comisionBase}
                onChange={(e) => {
                  setComisionBase(e.target.value as BaseComisionGestor);
                  reiniciarPrevia();
                }}
              >
                <option value="neto_de_canal">Neto de canal</option>
                <option value="bruto">Bruto</option>
              </NativeSelect>
            </Label>
          </div>
          <Label className={LABEL_CLASES}>
            Archivo CSV del reporte (máx. 2 MB)
            <Input ref={entradaArchivo} type="file" accept=".csv,text/csv" onChange={(e) => void alElegirArchivo(e)} />
          </Label>
          {archivo && <p className={NOTA_CLASES}>Archivo cargado: {archivo.nombre}</p>}

          {error && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          )}
          {resultadoFinal && <p className={NOTA_CLASES}>{resultadoFinal}</p>}
          {cargando && !previa && <EstadoCargando variante="bloque" />}

          {previa && (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-sm text-foreground flex items-center gap-1.5">
                <Info className="w-4 h-4" strokeWidth={1.75} />
                {previa.resumen.totalLineas} líneas: {previa.resumen.creadas} por crear · {previa.resumen.conciliadas} por conciliar · {previa.resumen.discrepancias} discrepancias · {previa.resumen.pendientes} pendientes · {previa.resumen.yaImportadas} ya importadas · {previa.resumen.ignoradas} filas informativas
              </p>
              {hayErrores && (
                <div role="alert" className="rounded-lg border border-destructive px-2.5 py-1.5 text-xs text-destructive">
                  El archivo tiene filas con error; corrígelo para poder confirmar:
                  <ul className="m-0 mt-1 pl-4">
                    {previa.errores.slice(0, 10).map((e) => (
                      <li key={e.fila}>
                        Fila {e.fila}: {e.motivo}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {nada && !hayErrores && <p className={NOTA_CLASES}>El archivo no trae líneas de reserva ni ajustes que importar.</p>}
              <div className="max-h-72 overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="h-8 px-2 text-xs">Fila</TableHead>
                      <TableHead className="h-8 px-2 text-xs">Código</TableHead>
                      <TableHead className="h-8 px-2 text-xs text-right">Monto recibido</TableHead>
                      <TableHead className="h-8 px-2 text-xs">Resultado</TableHead>
                      <TableHead className="h-8 px-2 text-xs">Detalle</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previa.lineas.map((l) => (
                      <TableRow key={l.fila}>
                        <TableCell className="p-2 text-xs">{l.fila}</TableCell>
                        <TableCell className="p-2 text-xs">{l.codigoConfirmacion ?? "—"}</TableCell>
                        <TableCell className="p-2 text-xs text-right tabular-nums">
                          {centavosAPesos(l.montoNetoCentavos)} {l.moneda}
                        </TableCell>
                        <TableCell className="p-2 text-xs">
                          <StatusBadge tone={RESULTADO_TONES[l.resultado]}>{RESULTADO_LABELS[l.resultado]}</StatusBadge>
                        </TableCell>
                        <TableCell className="p-2 text-xs">{l.nota ?? (l.tipoLinea === "ajuste" ? "Ajuste" : "—")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      </FormDialog>
      {dialogo}
    </>
  );
}

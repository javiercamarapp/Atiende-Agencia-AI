// Importación de estado de cuenta bancario (D-03): el contador sube el CSV u OFX que
// descarga de su banco (BBVA, Banorte, Santander, HSBC, Scotiabank, Citibanamex, Inbursa),
// revisa la VISTA PREVIA -- movimientos normalizados (fecha, concepto, cargo/abono, saldo,
// referencia), errores por renglón, avisos de posibles duplicados y la conciliación contra
// los CFDI ya ingeridos (con la cuenta por cobrar pendiente sugerida) -- y corrige el
// archivo si hace falta. Es de solo lectura: este flujo todavía NO guarda los movimientos
// (la persistencia con control de duplicados por hash llega con su migración), y la pantalla
// lo dice con todas sus letras en vez de aparentar un "Importar" que no existe.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, FileUp, Search } from "lucide-react";
import { Badge, Button, Callout, Card, CardContent, CardHeader, CardTitle, EstadoVacio, Input, Label, NativeSelect, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@atiende/ui";
import { BANCOS_ESTADO_CUENTA, decodificarArchivoEstadoCuenta, formatoPorNombreArchivo, previsualizarEstadoCuenta } from "../lib/estado-cuenta-client.ts";
import type { BancoEstadoCuenta, CoincidenciaImportacion, VistaPreviaImportacion } from "../lib/estado-cuenta-client.ts";
import { formatMoney } from "../lib/format.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que CONCILIACION_ROLES (@atiende/domain-despachos/roles.ts). Cosmético:
// el servidor rechaza a cualquier otro rol igual.
const CONCILIACION_ROLES = new Set(["admin", "contador"]);

/** Tope de archivo en el navegador (el servidor acepta 2 MB de JSON): avisa antes de subir. */
const MAX_BYTES_ARCHIVO = 1_500_000;
/** Renglones de la tabla de vista previa; el resto se resume (el archivo completo sí se valida). */
const MAX_FILAS_VISTA = 200;

const NIVEL_LABELS: Record<string, string> = { exacto: "Exacto", fuzzy: "Aproximado", multi_linea: "Varias facturas", llm: "Asistido por IA", manual: "Manual" };

function etiquetaBanco(id: string): string {
  return BANCOS_ESTADO_CUENTA.find((b) => b.id === id)?.nombre ?? id;
}

export function ImportarEstadoCuentaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const puedeGestionar = CONCILIACION_ROLES.has(role);
  const archivoRef = useRef<HTMLInputElement | null>(null);
  const [banco, setBanco] = useState<"" | BancoEstadoCuenta>("");
  const [cuenta, setCuenta] = useState("");
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<VistaPreviaImportacion | null>(null);

  async function handleArchivo(file: File) {
    setError(null);
    setVista(null);
    setNombreArchivo(file.name);
    if (file.size > MAX_BYTES_ARCHIVO) {
      setError("El archivo pesa más de 1.5 MB. Descarga el estado de cuenta por periodos más cortos (p. ej. un mes) y vuelve a intentar.");
      return;
    }
    setCargando(true);
    try {
      const contenido = decodificarArchivoEstadoCuenta(await file.arrayBuffer());
      const formato = formatoPorNombreArchivo(file.name);
      const resultado = await previsualizarEstadoCuenta(fetch, apiBaseUrl, token, propertyId, {
        contenido,
        ...(formato ? { formato } : {}),
        ...(banco ? { banco } : {}),
        ...(cuenta.trim() ? { cuenta: cuenta.trim() } : {}),
      });
      setVista(resultado);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el estado de cuenta.");
    } finally {
      setCargando(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <div className="flex flex-col gap-2 px-1">
        <h1 className="font-display text-xl font-semibold text-foreground">Importar estado de cuenta</h1>
        <p role="alert" className="text-destructive text-sm">
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede importar estados de cuenta -- el servidor lo rechazaría igual.
        </p>
      </div>
    );
  }

  const coincidenciaPorHash = new Map<string, CoincidenciaImportacion>((vista?.coincidencias ?? []).map((c) => [c.hash, c]));
  const yaImportados = new Set(vista?.yaImportados ?? []);
  const parseo = vista?.parseo;

  return (
    <div className="flex flex-col gap-5 px-1">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Importar estado de cuenta</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Sube el archivo CSV u OFX que descargas de tu banco. Revisas la vista previa y los errores por renglón antes de usarlo; nada se guarda todavía.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/despachos/${orgSlug}/conciliacion`}>Volver a conciliación</Link>
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-[15px]">1. Archivo del banco</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex w-56 flex-col gap-1.5">
              <Label htmlFor="estado-banco">Banco (opcional)</Label>
              <NativeSelect id="estado-banco" value={banco} onChange={(e) => setBanco(e.target.value as "" | BancoEstadoCuenta)}>
                <option value="">Detectar automáticamente</option>
                {BANCOS_ESTADO_CUENTA.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.nombre}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex w-64 flex-col gap-1.5">
              <Label htmlFor="estado-cuenta">CLABE o número de cuenta (opcional)</Label>
              <Input id="estado-cuenta" type="text" inputMode="numeric" maxLength={34} value={cuenta} onChange={(e) => setCuenta(e.target.value)} placeholder="18 dígitos" />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={archivoRef}
              id="estado-archivo"
              type="file"
              accept=".csv,.txt,.ofx,.qfx,text/csv,text/plain"
              className="sr-only"
              aria-label="Archivo de estado de cuenta"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleArchivo(file);
                e.target.value = "";
              }}
            />
            <Button type="button" size="sm" onClick={() => archivoRef.current?.click()} disabled={cargando}>
              <FileUp />
              {cargando ? "Leyendo…" : "Elegir archivo CSV u OFX"}
            </Button>
            {nombreArchivo && <span className="text-xs text-muted-foreground">{nombreArchivo}</span>}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Se reconocen los encabezados habituales de BBVA, Banorte, Santander, HSBC, Scotiabank, Citibanamex e Inbursa (Fecha, Concepto/Descripción, Referencia, Cargo/Retiro, Abono/Depósito, Importe, Saldo) con fechas dd/mm/aaaa. Los bancos cambian sus layouts: si el tuyo no se reconoce, el detalle del error por renglón te dice qué corregir.
          </p>
        </CardContent>
      </Card>

      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {!vista && !error && !cargando && <EstadoVacio icon={Search} titulo="Sin archivo todavía" mensaje="Elige un estado de cuenta para ver la vista previa de sus movimientos." />}

      {vista && parseo && (
        <>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-[15px]">2. Resumen</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-foreground">
                <span>
                  <strong>Banco:</strong> {etiquetaBanco(parseo.banco)}
                  {parseo.bancoDetectado ? " (detectado)" : ""}
                </span>
                <span>
                  <strong>Formato:</strong> {parseo.formato.toUpperCase()}
                </span>
                <span>
                  <strong>Cuenta:</strong> {parseo.cuenta ?? "—"}
                </span>
                <span>
                  <strong>Periodo:</strong> {parseo.periodo ? `${parseo.periodo.desde} a ${parseo.periodo.hasta}` : "—"}
                </span>
                <span>
                  <strong>Movimientos válidos:</strong> {parseo.movimientos.length} de {parseo.renglonesLeidos} renglones
                </span>
                <span>
                  <strong>Cargos:</strong> {formatMoney(parseo.totalCargos)}
                </span>
                <span>
                  <strong>Abonos:</strong> {formatMoney(parseo.totalAbonos)}
                </span>
                {parseo.saldoFinal !== null && (
                  <span>
                    <strong>Saldo final:</strong> {formatMoney(parseo.saldoFinal)}
                  </span>
                )}
              </div>
              {parseo.errores.length > 0 && (
                <Callout tone="danger" titulo={`${parseo.errores.length} renglón(es) con error: no se importarían`}>
                  Corrige esos renglones en el archivo (o descárgalo de nuevo del banco) y vuelve a subirlo.
                </Callout>
              )}
              {vista.yaImportados.length > 0 && (
                <Callout tone="info" titulo={`${vista.yaImportados.length} movimiento(s) ya se habían importado`}>
                  Se reconocen por su huella (cuenta, fecha, importe y concepto), así que no se duplican aunque los periodos se traslapen.
                </Callout>
              )}
              <Callout tone="neutral" titulo="Vista previa de solo lectura">
                Esta pantalla valida y concilia el archivo, pero todavía no guarda los movimientos ni marca cuentas por cobrar como pagadas.
              </Callout>
            </CardContent>
          </Card>

          {parseo.errores.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-[15px]">Errores por renglón ({parseo.errores.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table className="text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-9">Renglón</TableHead>
                        <TableHead className="h-9">Campo</TableHead>
                        <TableHead className="h-9">Problema</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseo.errores.map((e, i) => (
                        <TableRow key={`${e.renglon}-${i}`}>
                          <TableCell className="p-2 tabular-nums">{e.renglon}</TableCell>
                          <TableCell className="p-2">{e.campo ?? "—"}</TableCell>
                          <TableCell className="p-2">{e.mensaje}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          )}

          {parseo.advertencias.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-1.5 text-[15px]">
                  <AlertTriangle className="h-4 w-4 text-warning" strokeWidth={1.75} />
                  Avisos ({parseo.advertencias.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-[13px] text-foreground">
                  {parseo.advertencias.map((a, i) => (
                    <li key={`${a.codigo}-${a.renglon ?? "g"}-${i}`}>{a.mensaje}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-[15px]">3. Movimientos y conciliación</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {vista.conciliacion && (
                <p className="text-[13px] text-foreground">
                  <strong>Conciliados con CFDI:</strong> {vista.conciliacion.totalMatched} de {vista.conciliacion.totalMovements} movimientos nuevos ({Math.round(vista.conciliacion.matchRate)}%).
                </p>
              )}
              {vista.conciliacionOmitida && <p className="text-[13px] text-muted-foreground">{vista.conciliacionOmitida}</p>}
              {!vista.cobranzaDisponible && vista.conciliacion && <p className="text-[13px] text-muted-foreground">Cobranza no disponible todavía en esta base: se concilia solo contra CFDI.</p>}

              {parseo.movimientos.length === 0 ? (
                <EstadoVacio compacto titulo="Sin movimientos válidos" mensaje="Revisa los errores por renglón de arriba." />
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table className="min-w-[760px] text-xs">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-9">Renglón</TableHead>
                        <TableHead className="h-9">Fecha</TableHead>
                        <TableHead className="h-9">Concepto</TableHead>
                        <TableHead className="h-9">Referencia</TableHead>
                        <TableHead className="h-9 text-right">Cargo</TableHead>
                        <TableHead className="h-9 text-right">Abono</TableHead>
                        <TableHead className="h-9 text-right">Saldo</TableHead>
                        <TableHead className="h-9">Estado</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseo.movimientos.slice(0, MAX_FILAS_VISTA).map((m) => {
                        const coincidencia = coincidenciaPorHash.get(m.hash);
                        return (
                          <TableRow key={m.hash}>
                            <TableCell className="p-2 tabular-nums">{m.renglon}</TableCell>
                            <TableCell className="p-2">{m.fecha}</TableCell>
                            <TableCell className="p-2">{m.descripcion || "—"}</TableCell>
                            <TableCell className="p-2 font-mono text-[11px]">{m.referencia ?? "—"}</TableCell>
                            <TableCell className="p-2 text-right tabular-nums">{m.cargo !== null ? formatMoney(m.cargo) : ""}</TableCell>
                            <TableCell className="p-2 text-right tabular-nums">{m.abono !== null ? formatMoney(m.abono) : ""}</TableCell>
                            <TableCell className="p-2 text-right tabular-nums">{m.saldo !== null ? formatMoney(m.saldo) : ""}</TableCell>
                            <TableCell className="p-2">
                              {yaImportados.has(m.hash) ? (
                                <Badge variant="secondary">Ya importado</Badge>
                              ) : coincidencia ? (
                                <div className="flex flex-col gap-0.5">
                                  <Badge variant="outline" className="w-fit border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400">
                                    CFDI {NIVEL_LABELS[coincidencia.nivel] ?? coincidencia.nivel}
                                  </Badge>
                                  {coincidencia.cobranzaPendienteIds.length > 0 && <span className="text-[11px] text-muted-foreground">Cuenta por cobrar pendiente: revisa si ya se pagó</span>}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">Sin conciliar</span>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {parseo.movimientos.length > MAX_FILAS_VISTA && (
                <p className="text-[11px] text-muted-foreground">
                  Se muestran los primeros {MAX_FILAS_VISTA} de {parseo.movimientos.length} movimientos; el archivo completo se validó y concilió.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

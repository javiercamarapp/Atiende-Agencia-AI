// Importación de estado de cuenta bancario (D-03): el contador sube el CSV u OFX que
// descarga de su banco (BBVA, Banorte, Santander, HSBC, Scotiabank, Citibanamex, Inbursa),
// revisa la VISTA PREVIA -- movimientos normalizados (fecha, concepto, cargo/abono, saldo,
// referencia), errores por renglón, avisos de posibles duplicados y la conciliación contra
// los CFDI ya ingeridos (con la cuenta por cobrar pendiente sugerida) -- y corrige el
// archivo si hace falta. Solo entonces pulsa "Guardar en el libro": el servidor vuelve a
// parsear el archivo y guarda de forma idempotente por huella (re-subir el mismo archivo o
// uno traslapado no duplica). Guardar NO marca cuentas por cobrar como pagadas ni concilia.
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, FileUp, Search } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  EstadoVacio,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  StatusBadge,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { BANCOS_ESTADO_CUENTA, decodificarArchivoEstadoCuenta, formatoPorNombreArchivo, guardarEstadoCuenta, previsualizarEstadoCuenta } from "../lib/estado-cuenta-client.ts";
import type { BancoEstadoCuenta, CoincidenciaImportacion, EntradaImportacion, ErrorRenglonEstado, MovimientoImportado, ResultadoGuardadoEstadoCuenta, VistaPreviaImportacion } from "../lib/estado-cuenta-client.ts";
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

const COLUMNAS_ERRORES: DataTableColumna<ErrorRenglonEstado & { clave: string }>[] = [
  { id: "renglon", encabezado: "Renglón", principal: true, alinear: "right", valorOrden: (e) => e.renglon, celda: (e) => <span className="tabular-nums">{e.renglon}</span> },
  { id: "campo", encabezado: "Campo", valorOrden: (e) => e.campo ?? "", celda: (e) => e.campo ?? "—" },
  { id: "problema", encabezado: "Problema", celda: (e) => e.mensaje },
];

export function ImportarEstadoCuentaPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const puedeGestionar = CONCILIACION_ROLES.has(role);
  const archivoRef = useRef<HTMLInputElement | null>(null);
  const [banco, setBanco] = useState<"" | BancoEstadoCuenta>("");
  const [cuenta, setCuenta] = useState("");
  const [nombreArchivo, setNombreArchivo] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vista, setVista] = useState<VistaPreviaImportacion | null>(null);
  // Lo que se mandó a la vista previa: "Guardar" reenvía EXACTAMENTE el mismo archivo.
  const [entrada, setEntrada] = useState<EntradaImportacion | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [guardado, setGuardado] = useState<ResultadoGuardadoEstadoCuenta | null>(null);

  async function handleArchivo(file: File) {
    setError(null);
    setVista(null);
    setEntrada(null);
    setGuardado(null);
    setNombreArchivo(file.name);
    if (file.size > MAX_BYTES_ARCHIVO) {
      setError("El archivo pesa más de 1.5 MB. Descarga el estado de cuenta por periodos más cortos (p. ej. un mes) y vuelve a intentar.");
      return;
    }
    setCargando(true);
    try {
      const contenido = decodificarArchivoEstadoCuenta(await file.arrayBuffer());
      const formato = formatoPorNombreArchivo(file.name);
      const nueva: EntradaImportacion = {
        contenido,
        ...(formato ? { formato } : {}),
        ...(banco ? { banco } : {}),
        ...(cuenta.trim() ? { cuenta: cuenta.trim() } : {}),
      };
      const resultado = await previsualizarEstadoCuenta(fetch, apiBaseUrl, token, propertyId, nueva);
      setEntrada(nueva);
      setVista(resultado);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo leer el estado de cuenta.");
    } finally {
      setCargando(false);
    }
  }

  async function handleGuardar() {
    if (!entrada) return;
    setError(null);
    setGuardando(true);
    try {
      setGuardado(await guardarEstadoCuenta(fetch, apiBaseUrl, token, propertyId, entrada));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el estado de cuenta.");
    } finally {
      setGuardando(false);
    }
  }

  if (!puedeGestionar) {
    return (
      <PageContainer padding="none" className="gap-2 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground">Importar estado de cuenta</h1>
        <p role="alert" className="text-destructive text-sm">
          Esta función requiere rol admin o contador. Tu rol actual ({role}) no puede importar estados de cuenta -- el servidor lo rechazaría igual.
        </p>
      </PageContainer>
    );
  }

  const coincidenciaPorHash = new Map<string, CoincidenciaImportacion>((vista?.coincidencias ?? []).map((c) => [c.hash, c]));
  const yaImportados = new Set(vista?.yaImportados ?? []);
  const parseo = vista?.parseo;

  const columnasMovimientos: DataTableColumna<MovimientoImportado>[] = [
    { id: "renglon", encabezado: "Renglón", principal: true, alinear: "right", valorOrden: (m) => m.renglon, celda: (m) => <span className="tabular-nums">{m.renglon}</span> },
    { id: "fecha", encabezado: "Fecha", valorOrden: (m) => m.fecha, celda: (m) => m.fecha },
    { id: "concepto", encabezado: "Concepto", valorOrden: (m) => m.descripcion, celda: (m) => m.descripcion || "—" },
    { id: "referencia", encabezado: "Referencia", celda: (m) => <span className="font-mono text-xs">{m.referencia ?? "—"}</span> },
    { id: "cargo", encabezado: "Cargo", alinear: "right", valorOrden: (m) => m.cargo, celda: (m) => <span className="tabular-nums">{m.cargo !== null ? formatMoney(m.cargo) : ""}</span> },
    { id: "abono", encabezado: "Abono", alinear: "right", valorOrden: (m) => m.abono, celda: (m) => <span className="tabular-nums">{m.abono !== null ? formatMoney(m.abono) : ""}</span> },
    { id: "saldo", encabezado: "Saldo", alinear: "right", valorOrden: (m) => m.saldo, celda: (m) => <span className="tabular-nums">{m.saldo !== null ? formatMoney(m.saldo) : ""}</span> },
    {
      id: "estado",
      encabezado: "Estado",
      celda: (m) => {
        const coincidencia = coincidenciaPorHash.get(m.hash);
        return yaImportados.has(m.hash) ? (
          <StatusBadge tone="neutral">Ya importado</StatusBadge>
        ) : coincidencia ? (
          <div className="flex flex-col gap-0.5">
            <StatusBadge tone="success" className="w-fit">
              CFDI {NIVEL_LABELS[coincidencia.nivel] ?? coincidencia.nivel}
            </StatusBadge>
            {coincidencia.cobranzaPendienteIds.length > 0 && <span className="text-xs text-muted-foreground">Cuenta por cobrar pendiente: revisa si ya se pagó</span>}
          </div>
        ) : (
          <span className="text-muted-foreground">Sin conciliar</span>
        );
      },
    },
  ];

  return (
    <PageContainer padding="none" className="gap-5 [&>*]:min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Importar estado de cuenta</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sube el archivo CSV u OFX que descargas de tu banco. Revisas la vista previa y los errores por renglón; solo se guarda cuando tú lo confirmas.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/despachos/${orgSlug}/conciliacion`}>Volver a conciliación</Link>
        </Button>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Archivo del banco</CardTitle>
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
          <p className="text-xs text-muted-foreground">
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
              <CardTitle className="text-base">2. Resumen</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-foreground">
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
              {guardado ? (
                <Callout tone="success" titulo={guardado.insertados > 0 ? `${guardado.insertados} movimiento(s) guardados` : "Nada nuevo que guardar"}>
                  {guardado.yaExistentes > 0 ? `${guardado.yaExistentes} ya estaban guardados y no se duplicaron. ` : ""}
                  Guardar no marca cuentas por cobrar como pagadas ni concilia por sí solo.
                </Callout>
              ) : !vista.libroDisponible ? (
                <Callout tone="warning" titulo="Guardar aún no está disponible en esta base">
                  Falta aplicar la migración 015 (libro de movimientos importados). Mientras tanto la pantalla solo valida y concilia; no se puede saber qué ya se importó.
                </Callout>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" size="sm" onClick={() => void handleGuardar()} disabled={guardando || parseo.errores.length > 0 || vista.nuevos === 0}>
                    {guardando ? "Guardando…" : `Guardar ${vista.nuevos} movimiento(s) nuevos en el libro`}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {parseo.errores.length > 0 ? "Corrige los renglones con error para poder guardar (se guarda todo o nada)." : vista.nuevos === 0 ? "Todo el archivo ya estaba guardado." : "Guardar no marca cuentas por cobrar como pagadas ni concilia por sí solo."}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          {parseo.errores.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Errores por renglón ({parseo.errores.length})</CardTitle>
              </CardHeader>
              <CardContent>
                <DataTable etiqueta="Errores por renglón del estado de cuenta" columnas={COLUMNAS_ERRORES} filas={parseo.errores.map((e, i) => ({ ...e, clave: `${e.renglon}-${i}` }))} obtenerId={(e) => e.clave} />
              </CardContent>
            </Card>
          )}

          {parseo.advertencias.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-1.5 text-base">
                  <AlertTriangle className="h-4 w-4 text-warning" strokeWidth={1.75} />
                  Avisos ({parseo.advertencias.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-1 text-sm text-foreground">
                  {parseo.advertencias.map((a, i) => (
                    <li key={`${a.codigo}-${a.renglon ?? "g"}-${i}`}>{a.mensaje}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">3. Movimientos y conciliación</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {vista.conciliacion && (
                <p className="text-sm text-foreground">
                  <strong>Conciliados con CFDI:</strong> {vista.conciliacion.totalMatched} de {vista.conciliacion.totalMovements} movimientos nuevos ({Math.round(vista.conciliacion.matchRate)}%).
                </p>
              )}
              {vista.conciliacionOmitida && <p className="text-sm text-muted-foreground">{vista.conciliacionOmitida}</p>}
              {!vista.cobranzaDisponible && vista.conciliacion && <p className="text-sm text-muted-foreground">Cobranza no disponible todavía en esta base: se concilia solo contra CFDI.</p>}

              {parseo.movimientos.length === 0 ? (
                <EstadoVacio compacto titulo="Sin movimientos válidos" mensaje="Revisa los errores por renglón de arriba." />
              ) : (
                <DataTable etiqueta="Movimientos del estado de cuenta" columnas={columnasMovimientos} filas={parseo.movimientos.slice(0, MAX_FILAS_VISTA)} obtenerId={(m) => m.hash} />
              )}
              {parseo.movimientos.length > MAX_FILAS_VISTA && (
                <p className="text-xs text-muted-foreground">
                  Se muestran los primeros {MAX_FILAS_VISTA} de {parseo.movimientos.length} movimientos; el archivo completo se validó y concilió.
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

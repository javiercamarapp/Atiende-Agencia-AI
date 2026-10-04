// Panel de conciliación bancaria -- hallazgo de auditoría (severidad ALTA, "Siete
// módulos con ruta HTTP real y sin UI", porción "conciliación bancaria" tras
// vencimientos/declaraciones/nómina): conciliacion.ts expone POST
// /conciliacion/matching (motor determinista de niveles 1-3 contra los CFDI ya
// ingeridos de esta property), POST /conciliacion/alertas (aging/comisiones/
// duplicados/discrepancia de ingresos, Art. 91 LISR), POST
// /conciliacion/clasificar-deposito (CFF Art. 59 fr. III) y POST
// /conciliacion/verificar-spei (matching por clave de rastreo o RFC), pero ningún
// cliente web ni página los usaba. Esta página cierra el gap.
//
// El parsing de CSV/OFX del banco vive en la pantalla "Importar estado de cuenta"
// (ImportarEstadoCuenta.tsx, D-03); el servidor de matching espera los movimientos YA
// parseados. Esta UI los captura en una tabla editable (una fila por movimiento -- mismo
// patrón exacto que la tabla de empleados de Nomina.tsx) y reusa ese mismo lote
// para correr matching, ver alertas y verificar SPEI/proveedor -- son 3 vistas
// distintas sobre el mismo lote, nunca 3 capturas separadas. La clasificación de
// depósito es la única acción que no depende del lote (opera sobre un solo
// depósito suelto).
//
// Presentación (ronda de design system): los objetos de estilo inline
// (inputStyle/labelStyle/sectionStyle/buttonPrimary/buttonSecondary) se
// sustituyeron por Card/Input/Label/Button/Badge/Table de @atiende/ui. Las 5
// secciones siguen apiladas (NO son pestañas): 2, 3 y 5 dependen del lote
// capturado en la 1 y el contador las corre en secuencia sobre el mismo lote,
// así que esconderlas detrás de un switcher rompería el flujo real.
import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ListChecks, Plus, Search, ShieldCheck, Trash2 } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Input,
  Label,
  PageContainer,
  StatusBadge,
  statusTone,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import {
  clasificarDepositoConciliacion,
  correrMatchingConciliacion,
  fetchAlertasConciliacion,
  verificarSpeiConciliacion,
} from "../lib/conciliacion-client.ts";
import type {
  AlertaConciliacion,
  CoincidenciaConciliacion,
  ClasificacionDeposito,
  MovimientoBancario,
  MovimientoBancarioInput,
  NivelCoincidencia,
  ResultadoClasificacionDeposito,
  RegistroConciliable,
  ResultadoConciliacion,
  ResultadoVerificacionSpei,
  SeveridadAlerta,
} from "../lib/conciliacion-client.ts";
import { formatMoney } from "../lib/format.ts";
import { NIVEL_COINCIDENCIA_TONES, SEVERIDAD_ALERTA_TONES } from "../lib/status-tones.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";
import { SesionesConciliacion } from "./ConciliacionSesiones.tsx";

// Mismo conjunto que CONCILIACION_ROLES (@atiende/domain-despachos/roles.ts) -- las rutas de
// matching/alertas/clasificar/SPEI y toda escritura de la conciliación guardada exigen este rol.
// auditor/readonly SÍ ven las sesiones guardadas (VER_CONCILIACION_ROLES) pero en solo lectura.
// Cosmético -- nunca la única barrera.
const CONCILIACION_ROLES = new Set(["admin", "contador"]);

interface MovimientoFila {
  readonly key: string;
  fecha: string;
  descripcion: string;
  referencia: string;
  cargo: string;
  abono: string;
  banco: string;
}

let filaSeq = 0;
function nuevaFila(): MovimientoFila {
  filaSeq += 1;
  return { key: `mov-${filaSeq}`, fecha: "", descripcion: "", referencia: "", cargo: "", abono: "", banco: "" };
}

function filaAInput(f: MovimientoFila): MovimientoBancarioInput | null {
  const fecha = f.fecha.trim();
  if (!fecha) return null;
  const cargoNum = f.cargo.trim() ? Number(f.cargo) : undefined;
  const abonoNum = f.abono.trim() ? Number(f.abono) : undefined;
  return {
    fecha,
    descripcion: f.descripcion.trim() || undefined,
    referencia: f.referencia.trim() || undefined,
    cargo: cargoNum !== undefined && Number.isFinite(cargoNum) ? cargoNum : undefined,
    abono: abonoNum !== undefined && Number.isFinite(abonoNum) ? abonoNum : undefined,
    banco: f.banco.trim() || undefined,
  };
}

const NIVEL_LABELS: Record<NivelCoincidencia, string> = { exacto: "Exacto", fuzzy: "Fuzzy", multi_linea: "Multi-línea", llm: "Asistido por IA", manual: "Manual" };

const CLASIFICACION_LABELS: Record<ClasificacionDeposito, string> = {
  ingreso: "Ingreso gravable",
  financiamiento: "Financiamiento",
  aportacion_socio: "Aportación de socio",
  garantia: "Garantía",
  otro_no_gravable: "Otro no gravable",
};

function NivelBadge({ level }: { level: NivelCoincidencia }) {
  return <StatusBadge tone={statusTone(NIVEL_COINCIDENCIA_TONES, level)}>{NIVEL_LABELS[level]}</StatusBadge>;
}

function SeveridadBadge({ severity }: { severity: SeveridadAlerta }) {
  const label = severity === "info" ? "Info" : severity === "warning" ? "Atención" : "Crítica";
  return <StatusBadge tone={statusTone(SEVERIDAD_ALERTA_TONES, severity)}>{label}</StatusBadge>;
}

function MovimientosEditor({ filas, setFilas }: { filas: readonly MovimientoFila[]; setFilas: (f: readonly MovimientoFila[]) => void }) {
  function actualizarFila(key: string, campo: keyof MovimientoFila, valor: string) {
    setFilas(filas.map((f) => (f.key === key ? { ...f, [campo]: valor } : f)));
  }
  function eliminarFila(key: string) {
    setFilas(filas.filter((f) => f.key !== key));
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto">
        <Table className="min-w-[720px] text-xs">
          <TableCaption className="sr-only">Captura de movimientos bancarios del lote</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 bg-canvas h-9">Fecha *</TableHead>
              <TableHead className="h-9">Descripción</TableHead>
              <TableHead className="h-9">Referencia</TableHead>
              <TableHead className="h-9">Cargo</TableHead>
              <TableHead className="h-9">Abono</TableHead>
              <TableHead className="h-9">Banco</TableHead>
              <TableHead className="h-9" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="sticky left-0 z-10 bg-card p-1.5">
                  <Label htmlFor={`mov-fecha-${f.key}`} className="sr-only">
                    Fecha
                  </Label>
                  <Input id={`mov-fecha-${f.key}`} type="date" value={f.fecha} onChange={(e) => actualizarFila(f.key, "fecha", e.target.value)} className="h-9 w-32 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-desc-${f.key}`} className="sr-only">
                    Descripción
                  </Label>
                  <Input
                    id={`mov-desc-${f.key}`}
                    type="text"
                    value={f.descripcion}
                    onChange={(e) => actualizarFila(f.key, "descripcion", e.target.value)}
                    placeholder="p.ej. PAGO PROVEEDOR"
                    className="h-9 w-52 text-xs"
                  />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-ref-${f.key}`} className="sr-only">
                    Referencia
                  </Label>
                  <Input id={`mov-ref-${f.key}`} type="text" value={f.referencia} onChange={(e) => actualizarFila(f.key, "referencia", e.target.value)} className="h-9 w-32 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-cargo-${f.key}`} className="sr-only">
                    Cargo
                  </Label>
                  <Input id={`mov-cargo-${f.key}`} type="number" step="0.01" value={f.cargo} onChange={(e) => actualizarFila(f.key, "cargo", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-abono-${f.key}`} className="sr-only">
                    Abono
                  </Label>
                  <Input id={`mov-abono-${f.key}`} type="number" step="0.01" value={f.abono} onChange={(e) => actualizarFila(f.key, "abono", e.target.value)} className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-banco-${f.key}`} className="sr-only">
                    Banco
                  </Label>
                  <Input id={`mov-banco-${f.key}`} type="text" value={f.banco} onChange={(e) => actualizarFila(f.key, "banco", e.target.value)} placeholder="generic" className="h-9 w-24 text-xs" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button type="button" variant="outline" size="sm" className="h-9 border-destructive/40 px-3 text-xs text-destructive hover:border-destructive" onClick={() => eliminarFila(f.key)}>
                    <Trash2 />
                    Quitar
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => setFilas([...filas, nuevaFila()])}>
          <Plus />
          Agregar movimiento
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Captura los movimientos del estado de cuenta ya identificados (cargo = salida, abono = entrada). Este lote se usa para las 3 acciones de abajo (matching, alertas y verificación SPEI/proveedor).
      </p>
    </div>
  );
}

type ConIndice<T> = T & { readonly _i: number };

const COLUMNAS_COINCIDENCIAS: DataTableColumna<ConIndice<CoincidenciaConciliacion>>[] = [
  { id: "nivel", encabezado: "Nivel", principal: true, valorOrden: (m) => m.score, celda: (m) => <NivelBadge level={m.level} /> },
  { id: "score", encabezado: "Score", alinear: "right", valorOrden: (m) => m.score, celda: (m) => <span className="tabular-nums">{m.score.toFixed(0)}</span> },
  { id: "montoBanco", encabezado: "Monto banco", alinear: "right", valorOrden: (m) => m.montoBanco, celda: (m) => <span className="tabular-nums">{formatMoney(m.montoBanco)}</span> },
  { id: "montoCfdi", encabezado: "Monto CFDI", alinear: "right", valorOrden: (m) => m.montoRegistro, celda: (m) => <span className="tabular-nums">{formatMoney(m.montoRegistro)}</span> },
  { id: "fechaBanco", encabezado: "Fecha banco", valorOrden: (m) => m.fechaBanco, celda: (m) => m.fechaBanco },
  { id: "fechaCfdi", encabezado: "Fecha CFDI", valorOrden: (m) => m.fechaRegistro, celda: (m) => m.fechaRegistro },
  { id: "detalle", encabezado: "Detalle", celda: (m) => <span className="text-muted-foreground">{m.detail}</span> },
];

const COLUMNAS_BANCO_SIN_CONCILIAR: DataTableColumna<ConIndice<MovimientoBancario>>[] = [
  { id: "fecha", encabezado: "Fecha", principal: true, valorOrden: (m) => m.fecha, celda: (m) => m.fecha },
  { id: "descripcion", encabezado: "Descripción", valorOrden: (m) => m.descripcion ?? "", celda: (m) => m.descripcion || "—" },
  { id: "monto", encabezado: "Monto", alinear: "right", valorOrden: (m) => m.monto, celda: (m) => <span className="tabular-nums">{formatMoney(m.monto)}</span> },
];

const COLUMNAS_CFDI_SIN_CONCILIAR: DataTableColumna<ConIndice<RegistroConciliable>>[] = [
  { id: "fecha", encabezado: "Fecha", principal: true, valorOrden: (r) => r.fecha, celda: (r) => r.fecha },
  { id: "emisor", encabezado: "Emisor", valorOrden: (r) => r.descripcion ?? "", celda: (r) => r.descripcion ?? "—" },
  { id: "folio", encabezado: "Folio fiscal", celda: (r) => <span className="font-mono text-xs">{r.folioFiscal ?? "—"}</span> },
  {
    id: "total",
    encabezado: "Total",
    alinear: "right",
    valorOrden: (r) => (typeof r.total === "number" ? r.total : null),
    celda: (r) => <span className="tabular-nums">{typeof r.total === "number" ? formatMoney(r.total) : (r.total ?? "—")}</span>,
  },
];

function ResultadoMatching({ resultado }: { resultado: ResultadoConciliacion }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-6 text-sm text-foreground">
        <span>
          <strong>Confianza:</strong> {(resultado.confidence * 100).toFixed(0)}%
        </span>
        <span>
          <strong>Conciliados:</strong> {resultado.totalMatched} / {resultado.totalMovements} movimientos ({(resultado.matchRate * 100).toFixed(0)}%)
        </span>
        <span>
          <strong>Monto conciliado:</strong> {formatMoney(resultado.montoMatched)}
        </span>
        <span>
          <strong>Sin conciliar (banco):</strong> {formatMoney(resultado.montoUnmatchedBank)}
        </span>
        <span>
          <strong>Sin conciliar (CFDI):</strong> {formatMoney(resultado.montoUnmatchedBooks)}
        </span>
      </div>

      {resultado.matched.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Coincidencias ({resultado.matched.length})</p>
          <DataTable etiqueta="Coincidencias de conciliación" columnas={COLUMNAS_COINCIDENCIAS} filas={resultado.matched.map((m, i) => ({ ...m, _i: i }))} obtenerId={(m) => String(m._i)} />
        </div>
      )}

      {resultado.unmatchedBank.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">Movimientos bancarios sin conciliar ({resultado.unmatchedBank.length})</p>
          <DataTable etiqueta="Movimientos bancarios sin conciliar" columnas={COLUMNAS_BANCO_SIN_CONCILIAR} filas={resultado.unmatchedBank.map((m, i) => ({ ...m, _i: i }))} obtenerId={(m) => String(m._i)} />
        </div>
      )}

      {resultado.unmatchedBooks.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-semibold text-foreground">CFDI sin conciliar ({resultado.unmatchedBooks.length})</p>
          <DataTable etiqueta="CFDI sin conciliar" columnas={COLUMNAS_CFDI_SIN_CONCILIAR} filas={resultado.unmatchedBooks.map((r, i) => ({ ...r, _i: i }))} obtenerId={(r) => String(r._i)} />
        </div>
      )}
    </div>
  );
}

export function ConciliacionPage({ apiBaseUrl, token, propertyId, orgSlug, role }: DespachosShellContext) {
  const puedeGestionar = CONCILIACION_ROLES.has(role);

  const [filas, setFilas] = useState<readonly MovimientoFila[]>([nuevaFila()]);
  const movimientosLote = filas.map(filaAInput).filter((m): m is MovimientoBancarioInput => m !== null);

  // -- Matching --------------------------------------------------------------
  const [dateToleranceDays, setDateToleranceDays] = useState("3");
  const [montoTolerancePct, setMontoTolerancePct] = useState("5");
  const [fuzzyThreshold, setFuzzyThreshold] = useState("80");
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [matchResultado, setMatchResultado] = useState<ResultadoConciliacion | null>(null);

  async function handleMatching() {
    setMatchError(null);
    if (movimientosLote.length === 0) {
      setMatchError("Captura al menos un movimiento con fecha.");
      return;
    }
    setMatchLoading(true);
    try {
      const resultado = await correrMatchingConciliacion(fetch, apiBaseUrl, token, propertyId, movimientosLote, {
        dateToleranceDays: dateToleranceDays.trim() ? Number(dateToleranceDays) : undefined,
        montoTolerancePct: montoTolerancePct.trim() ? Number(montoTolerancePct) : undefined,
        fuzzyThreshold: fuzzyThreshold.trim() ? Number(fuzzyThreshold) : undefined,
      });
      setMatchResultado(resultado);
    } catch (err) {
      setMatchError(err instanceof Error ? err.message : "No se pudo correr el matching.");
    } finally {
      setMatchLoading(false);
    }
  }

  // -- Alertas -----------------------------------------------------------
  const [declaredIncome, setDeclaredIncome] = useState("");
  const [alertasLoading, setAlertasLoading] = useState(false);
  const [alertasError, setAlertasError] = useState<string | null>(null);
  const [alertas, setAlertas] = useState<readonly AlertaConciliacion[] | null>(null);

  async function handleAlertas() {
    setAlertasError(null);
    if (movimientosLote.length === 0) {
      setAlertasError("Captura al menos un movimiento con fecha.");
      return;
    }
    setAlertasLoading(true);
    try {
      const income = declaredIncome.trim() ? Number(declaredIncome) : undefined;
      const { alertas: result } = await fetchAlertasConciliacion(fetch, apiBaseUrl, token, propertyId, movimientosLote, income);
      setAlertas(result);
    } catch (err) {
      setAlertasError(err instanceof Error ? err.message : "No se pudieron obtener las alertas.");
    } finally {
      setAlertasLoading(false);
    }
  }

  // -- Clasificar depósito -----------------------------------------------
  const [clasifDescripcion, setClasifDescripcion] = useState("");
  const [clasifReferencia, setClasifReferencia] = useState("");
  const [clasifLoading, setClasifLoading] = useState(false);
  const [clasifError, setClasifError] = useState<string | null>(null);
  const [clasifResultado, setClasifResultado] = useState<ResultadoClasificacionDeposito | null>(null);

  async function handleClasificar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setClasifError(null);
    setClasifLoading(true);
    try {
      const resultado = await clasificarDepositoConciliacion(fetch, apiBaseUrl, token, propertyId, clasifDescripcion.trim(), clasifReferencia.trim() || null);
      setClasifResultado(resultado);
    } catch (err) {
      setClasifError(err instanceof Error ? err.message : "No se pudo clasificar el depósito.");
    } finally {
      setClasifLoading(false);
    }
  }

  // -- Verificar SPEI / proveedor ------------------------------------------
  const [speiModo, setSpeiModo] = useState<"clave" | "rfc">("clave");
  const [speiClave, setSpeiClave] = useState("");
  const [speiRfc, setSpeiRfc] = useState("");
  const [speiMonto, setSpeiMonto] = useState("");
  const [speiFecha, setSpeiFecha] = useState("");
  const [speiTolerancia, setSpeiTolerancia] = useState("3");
  const [speiLoading, setSpeiLoading] = useState(false);
  const [speiError, setSpeiError] = useState<string | null>(null);
  const [speiResultado, setSpeiResultado] = useState<ResultadoVerificacionSpei | null>(null);

  async function handleVerificarSpei(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSpeiError(null);
    if (movimientosLote.length === 0) {
      setSpeiError("Captura al menos un movimiento con fecha.");
      return;
    }
    const monto = Number(speiMonto);
    if (!Number.isFinite(monto)) {
      setSpeiError("Monto inválido.");
      return;
    }
    setSpeiLoading(true);
    try {
      const resultado = await verificarSpeiConciliacion(fetch, apiBaseUrl, token, propertyId, {
        movimientos: movimientosLote,
        claveRastreo: speiModo === "clave" ? speiClave.trim() : undefined,
        rfc: speiModo === "rfc" ? speiRfc.trim() : undefined,
        monto,
        fecha: speiFecha,
        dateToleranceDays: speiTolerancia.trim() ? Number(speiTolerancia) : undefined,
      });
      setSpeiResultado(resultado);
    } catch (err) {
      setSpeiError(err instanceof Error ? err.message : "No se pudo verificar el pago.");
    } finally {
      setSpeiLoading(false);
    }
  }

  if (!puedeGestionar) {
    // Solo lectura (auditor/readonly): ven las sesiones guardadas y sus conciliaciones; matching, alertas y verificaciones siguen siendo de admin/contador.
    return (
      <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
        <header>
          <h1 className="font-display text-xl font-semibold text-foreground">Conciliación bancaria</h1>
          <p className="mt-1 text-sm text-muted-foreground">Consulta de las sesiones de conciliación guardadas. Tu rol ({role}) no puede confirmar, deshacer ni correr matching, alertas o verificaciones.</p>
        </header>
        <SesionesConciliacion apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeGestionar={false} />
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" className="gap-5 [&>*]:min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">Conciliación bancaria</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Corre el matching determinista contra los CFDI ya ingeridos, revisa alertas de antigüedad/comisión/duplicados, clasifica depósitos (CFF Art. 59 fr. III) y verifica pagos SPEI/proveedor.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/despachos/${orgSlug}/conciliacion/importar`}>Importar estado de cuenta</Link>
        </Button>
      </header>

      <SesionesConciliacion apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeGestionar esAdmin={role === "admin"} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">1. Movimientos bancarios</CardTitle>
        </CardHeader>
        <CardContent>
          <MovimientosEditor filas={filas} setFilas={setFilas} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">2. Matching contra CFDI</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="match-tol-fecha">Tolerancia de fecha (días)</Label>
              <Input id="match-tol-fecha" type="number" value={dateToleranceDays} onChange={(e) => setDateToleranceDays(e.target.value)} />
            </div>
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="match-tol-monto">Tolerancia de monto (%)</Label>
              <Input id="match-tol-monto" type="number" step="0.1" value={montoTolerancePct} onChange={(e) => setMontoTolerancePct(e.target.value)} />
            </div>
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="match-fuzzy">Umbral fuzzy (0-100)</Label>
              <Input id="match-fuzzy" type="number" value={fuzzyThreshold} onChange={(e) => setFuzzyThreshold(e.target.value)} />
            </div>
          </div>
          {matchError && (
            <p role="alert" className="text-destructive text-sm">
              {matchError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleMatching()} disabled={matchLoading}>
              <ListChecks />
              {matchLoading ? "Corriendo…" : "Correr matching"}
            </Button>
          </div>
          {matchResultado && <ResultadoMatching resultado={matchResultado} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">3. Alertas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex w-60 flex-col gap-1.5">
            <Label htmlFor="alertas-ingreso">Ingreso declarado del periodo (opcional, Art. 91 LISR)</Label>
            <Input id="alertas-ingreso" type="number" step="0.01" value={declaredIncome} onChange={(e) => setDeclaredIncome(e.target.value)} />
          </div>
          {alertasError && (
            <p role="alert" className="text-destructive text-sm">
              {alertasError}
            </p>
          )}
          <div>
            <Button type="button" onClick={() => void handleAlertas()} disabled={alertasLoading}>
              <AlertTriangle />
              {alertasLoading ? "Revisando…" : "Ver alertas"}
            </Button>
          </div>
          {alertas && alertas.length === 0 && (
            <p role="status" className="text-sm text-muted-foreground">
              Sin alertas para este lote.
            </p>
          )}
          {alertas && alertas.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {alertas.map((a, i) => (
                <div key={i} className="flex items-start gap-2 border-b border-border pb-1.5">
                  <SeveridadBadge severity={a.severity} />
                  <div className="text-sm text-foreground">
                    <div>{a.message}</div>
                    <div className="text-xs text-muted-foreground">
                      regla: {a.rule} {a.fecha && `· ${a.fecha}`} {a.daysUnreconciled > 0 && `· ${a.daysUnreconciled}d sin conciliar`}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Clasificar depósito (CFF Art. 59 fr. III)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={handleClasificar} className="flex max-w-md flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clasif-descripcion">Descripción del depósito *</Label>
              <Input
                id="clasif-descripcion"
                type="text"
                value={clasifDescripcion}
                onChange={(e) => setClasifDescripcion(e.target.value)}
                required
                placeholder="p.ej. APORTACION SOCIO CAPITAL"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="clasif-referencia">Referencia (opcional)</Label>
              <Input id="clasif-referencia" type="text" value={clasifReferencia} onChange={(e) => setClasifReferencia(e.target.value)} />
            </div>
            {clasifError && (
              <p role="alert" className="text-destructive text-sm">
                {clasifError}
              </p>
            )}
            <div>
              <Button type="submit" disabled={clasifLoading}>
                <Search />
                {clasifLoading ? "Clasificando…" : "Clasificar"}
              </Button>
            </div>
          </form>
          {clasifResultado && (
            <div className="flex flex-col gap-1 text-sm text-foreground">
              <div>
                <strong>Clasificación:</strong> {CLASIFICACION_LABELS[clasifResultado.clasificacion]} ({(clasifResultado.confidence * 100).toFixed(0)}% confianza)
              </div>
              {clasifResultado.articuloCff && <div className="text-muted-foreground">{clasifResultado.articuloCff}</div>}
              {clasifResultado.requiresHumanReview && (
                <Callout tone="warning" role="alert">
                  Requiere revisión humana antes de persistirse -- confianza baja o clasificación no trivial.
                </Callout>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Verificar pago SPEI / proveedor</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">Busca, dentro del lote de movimientos capturado arriba, el que mejor coincida con la clave de rastreo (o el RFC del proveedor) más monto y fecha.</p>
          <form onSubmit={handleVerificarSpei} className="flex max-w-md flex-col gap-3">
            <div className="flex gap-4 text-sm text-foreground">
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={speiModo === "clave"} onChange={() => setSpeiModo("clave")} className="h-4 w-4 accent-primary" /> Clave de rastreo SPEI
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" checked={speiModo === "rfc"} onChange={() => setSpeiModo("rfc")} className="h-4 w-4 accent-primary" /> RFC de proveedor
              </label>
            </div>
            {speiModo === "clave" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="spei-clave">Clave de rastreo *</Label>
                <Input id="spei-clave" type="text" value={speiClave} onChange={(e) => setSpeiClave(e.target.value)} required />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="spei-rfc">RFC del proveedor *</Label>
                <Input id="spei-rfc" type="text" value={speiRfc} onChange={(e) => setSpeiRfc(e.target.value.toUpperCase())} required />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spei-monto">Monto *</Label>
              <Input id="spei-monto" type="number" step="0.01" value={speiMonto} onChange={(e) => setSpeiMonto(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spei-fecha">Fecha del pago *</Label>
              <Input id="spei-fecha" type="date" value={speiFecha} onChange={(e) => setSpeiFecha(e.target.value)} required />
            </div>
            <div className="flex w-40 flex-col gap-1.5">
              <Label htmlFor="spei-tolerancia">Tolerancia de fecha (días)</Label>
              <Input id="spei-tolerancia" type="number" value={speiTolerancia} onChange={(e) => setSpeiTolerancia(e.target.value)} />
            </div>
            {speiError && (
              <p role="alert" className="text-destructive text-sm">
                {speiError}
              </p>
            )}
            <div>
              <Button type="submit" disabled={speiLoading}>
                <ShieldCheck />
                {speiLoading ? "Verificando…" : "Verificar"}
              </Button>
            </div>
          </form>
          {speiResultado && (
            <div className="flex flex-col gap-1 text-sm text-foreground">
              <div>
                <strong>{speiResultado.verified ? "Verificado" : "No verificado"}</strong> -- score {speiResultado.bestScore.toFixed(0)}
              </div>
              {speiResultado.movementIdx !== null && movimientosLote[speiResultado.movementIdx] && (
                <div className="text-muted-foreground">
                  Mejor coincidencia: {movimientosLote[speiResultado.movementIdx]!.fecha} -- {movimientosLote[speiResultado.movementIdx]!.descripcion || "(sin descripción)"}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

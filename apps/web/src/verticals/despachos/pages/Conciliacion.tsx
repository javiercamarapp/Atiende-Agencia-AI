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
  EstadoVacio,
  FormField,
  Input,
  Label,
  PageContainer,
  PageHeader,
  RadioSegmentado,
  StatusBadge,
  statusTone,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import {
  clasificarDepositoConciliacion,
  correrMatchingConciliacion,
  fetchAlertasConciliacion,
  verificarSpeiConciliacion,
} from "../lib/conciliacion-client.ts";
import type {
  AlertaConciliacion,
  ClasificacionDeposito,
  MovimientoBancarioInput,
  NivelCoincidencia,
  ResultadoClasificacionDeposito,
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
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow>
              <TableHead>Fecha *</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Referencia</TableHead>
              <TableHead>Cargo</TableHead>
              <TableHead>Abono</TableHead>
              <TableHead>Banco</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((f) => (
              <TableRow key={f.key}>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-fecha-${f.key}`} className="sr-only">
                    Fecha
                  </Label>
                  <Input id={`mov-fecha-${f.key}`} type="date" value={f.fecha} onChange={(e) => actualizarFila(f.key, "fecha", e.target.value)} className="w-32" />
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
                    className="w-52"
                  />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-ref-${f.key}`} className="sr-only">
                    Referencia
                  </Label>
                  <Input id={`mov-ref-${f.key}`} type="text" value={f.referencia} onChange={(e) => actualizarFila(f.key, "referencia", e.target.value)} className="w-32" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-cargo-${f.key}`} className="sr-only">
                    Cargo
                  </Label>
                  <Input id={`mov-cargo-${f.key}`} type="number" step="0.01" value={f.cargo} onChange={(e) => actualizarFila(f.key, "cargo", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-abono-${f.key}`} className="sr-only">
                    Abono
                  </Label>
                  <Input id={`mov-abono-${f.key}`} type="number" step="0.01" value={f.abono} onChange={(e) => actualizarFila(f.key, "abono", e.target.value)} className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Label htmlFor={`mov-banco-${f.key}`} className="sr-only">
                    Banco
                  </Label>
                  <Input id={`mov-banco-${f.key}`} type="text" value={f.banco} onChange={(e) => actualizarFila(f.key, "banco", e.target.value)} placeholder="generic" className="w-24" />
                </TableCell>
                <TableCell className="p-1.5">
                  <Button type="button" variant="destructive" onClick={() => eliminarFila(f.key)}>
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
          <p className="mb-1 text-xs font-medium text-foreground">Coincidencias ({resultado.matched.length})</p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nivel</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Monto banco</TableHead>
                  <TableHead>Monto CFDI</TableHead>
                  <TableHead>Fecha banco</TableHead>
                  <TableHead>Fecha CFDI</TableHead>
                  <TableHead>Detalle</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultado.matched.map((m, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-2">
                      <NivelBadge level={m.level} />
                    </TableCell>
                    <TableCell className="p-2 tabular-nums">{m.score.toFixed(0)}</TableCell>
                    <TableCell className="p-2 tabular-nums">{formatMoney(m.montoBanco)}</TableCell>
                    <TableCell className="p-2 tabular-nums">{formatMoney(m.montoRegistro)}</TableCell>
                    <TableCell className="p-2">{m.fechaBanco}</TableCell>
                    <TableCell className="p-2">{m.fechaRegistro}</TableCell>
                    <TableCell className="p-2 text-muted-foreground">{m.detail}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {resultado.unmatchedBank.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground">Movimientos bancarios sin conciliar ({resultado.unmatchedBank.length})</p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Monto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultado.unmatchedBank.map((m, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-2">{m.fecha}</TableCell>
                    <TableCell className="p-2">{m.descripcion || "—"}</TableCell>
                    <TableCell className="p-2 tabular-nums">{formatMoney(m.monto)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {resultado.unmatchedBooks.length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground">CFDI sin conciliar ({resultado.unmatchedBooks.length})</p>
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Emisor</TableHead>
                  <TableHead>Folio fiscal</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {resultado.unmatchedBooks.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="p-2">{r.fecha}</TableCell>
                    <TableCell className="p-2">{r.descripcion ?? "—"}</TableCell>
                    <TableCell className="p-2 font-mono text-xs">{r.folioFiscal ?? "—"}</TableCell>
                    <TableCell className="p-2 tabular-nums">{typeof r.total === "number" ? formatMoney(r.total) : (r.total ?? "—")}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
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
      setMatchError(err instanceof Error ? err.message : "No se pudo buscar las coincidencias.");
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
    // Solo lectura (auditor/readonly): ven las sesiones guardadas y sus conciliaciones; las coincidencias, alertas y verificaciones siguen siendo de admin/contador.
    return (
      <PageContainer className="[&>*]:min-w-0">
        <PageHeader titulo="Conciliación bancaria" descripcion={`Consulta de las sesiones de conciliación guardadas. Tu rol (${role}) no puede confirmar, deshacer ni buscar coincidencias, alertas o verificaciones.`} />
        <SesionesConciliacion apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeGestionar={false} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader
        titulo="Conciliación bancaria"
        descripcion="Busca coincidencias contra los CFDI ya ingeridos, revisa alertas de antigüedad/comisión/duplicados, clasifica depósitos (CFF Art. 59 fr. III) y verifica pagos SPEI/proveedor."
        acciones={
          <Button asChild variant="outline" size="sm">
            <Link to={`/despachos/${orgSlug}/conciliacion/importar`}>Importar estado de cuenta</Link>
          </Button>
        }
      />

      <SesionesConciliacion apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} puedeGestionar />

      <Card>
        <CardHeader>
          <CardTitle>1. Movimientos bancarios</CardTitle>
        </CardHeader>
        <CardContent>
          <MovimientosEditor filas={filas} setFilas={setFilas} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Coincidencias contra CFDI</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <FormField label="Tolerancia de fecha (días)" className="w-40">
              <Input id="match-tol-fecha" type="number" value={dateToleranceDays} onChange={(e) => setDateToleranceDays(e.target.value)} />
            </FormField>
            <FormField label="Tolerancia de monto (%)" className="w-40">
              <Input id="match-tol-monto" type="number" step="0.1" value={montoTolerancePct} onChange={(e) => setMontoTolerancePct(e.target.value)} />
            </FormField>
            <FormField label="Umbral fuzzy (0-100)" className="w-40">
              <Input id="match-fuzzy" type="number" value={fuzzyThreshold} onChange={(e) => setFuzzyThreshold(e.target.value)} />
            </FormField>
          </div>
          {matchError && <Callout tone="danger">{matchError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleMatching()} loading={matchLoading}>
              <ListChecks />
              Buscar coincidencias
            </Button>
          </div>
          {matchResultado && <ResultadoMatching resultado={matchResultado} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Alertas</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <FormField label="Ingreso declarado del periodo (opcional, Art. 91 LISR)" className="w-72">
            <Input id="alertas-ingreso" type="number" step="0.01" value={declaredIncome} onChange={(e) => setDeclaredIncome(e.target.value)} />
          </FormField>
          {alertasError && <Callout tone="danger">{alertasError}</Callout>}
          <div>
            <Button type="button" onClick={() => void handleAlertas()} loading={alertasLoading}>
              <AlertTriangle />
              Ver alertas
            </Button>
          </div>
          {alertas && alertas.length === 0 && <EstadoVacio compacto mensaje="Sin alertas para este lote." />}
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
        <CardHeader>
          <CardTitle>Clasificar depósito (CFF Art. 59 fr. III)</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <form onSubmit={handleClasificar} className="flex max-w-md flex-col gap-3">
            <FormField label="Descripción del depósito" required>
              <Input id="clasif-descripcion" type="text" value={clasifDescripcion} onChange={(e) => setClasifDescripcion(e.target.value)} required placeholder="p.ej. APORTACION SOCIO CAPITAL" />
            </FormField>
            <FormField label="Referencia (opcional)">
              <Input id="clasif-referencia" type="text" value={clasifReferencia} onChange={(e) => setClasifReferencia(e.target.value)} />
            </FormField>
            {clasifError && <Callout tone="danger">{clasifError}</Callout>}
            <div>
              <Button type="submit" loading={clasifLoading}>
                <Search />
                Clasificar
              </Button>
            </div>
          </form>
          {clasifResultado && (
            <div className="flex flex-col gap-1 text-sm text-foreground">
              <div>
                <strong>Clasificación:</strong> {CLASIFICACION_LABELS[clasifResultado.clasificacion]} ({(clasifResultado.confidence * 100).toFixed(0)}% confianza)
              </div>
              {clasifResultado.articuloCff && <div className="text-muted-foreground">{clasifResultado.articuloCff}</div>}
              {clasifResultado.requiresHumanReview && <Callout tone="warning">Requiere revisión humana antes de persistirse -- confianza baja o clasificación no trivial.</Callout>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Verificar pago SPEI / proveedor</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">Busca, dentro del lote de movimientos capturado arriba, el que mejor coincida con la clave de rastreo (o el RFC del proveedor) más monto y fecha.</p>
          <form onSubmit={handleVerificarSpei} className="flex max-w-md flex-col gap-3">
            <RadioSegmentado
              name="spei-modo"
              label="Cómo identificar el pago"
              value={speiModo}
              onChange={setSpeiModo}
              opciones={[
                { id: "clave", rotulo: "Clave de rastreo SPEI" },
                { id: "rfc", rotulo: "RFC de proveedor" },
              ]}
            />
            {speiModo === "clave" ? (
              <FormField label="Clave de rastreo" required>
                <Input id="spei-clave" type="text" value={speiClave} onChange={(e) => setSpeiClave(e.target.value)} required />
              </FormField>
            ) : (
              <FormField label="RFC del proveedor" required>
                <Input id="spei-rfc" type="text" value={speiRfc} onChange={(e) => setSpeiRfc(e.target.value.toUpperCase())} required />
              </FormField>
            )}
            <FormField label="Monto" required>
              <Input id="spei-monto" type="number" step="0.01" value={speiMonto} onChange={(e) => setSpeiMonto(e.target.value)} required />
            </FormField>
            <FormField label="Fecha del pago" required>
              <Input id="spei-fecha" type="date" value={speiFecha} onChange={(e) => setSpeiFecha(e.target.value)} required />
            </FormField>
            <FormField label="Tolerancia de fecha (días)" className="w-40">
              <Input id="spei-tolerancia" type="number" value={speiTolerancia} onChange={(e) => setSpeiTolerancia(e.target.value)} />
            </FormField>
            {speiError && <Callout tone="danger">{speiError}</Callout>}
            <div>
              <Button type="submit" loading={speiLoading}>
                <ShieldCheck />
                Verificar
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

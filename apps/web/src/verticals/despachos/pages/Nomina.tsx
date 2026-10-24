// Panel de nómina -- hallazgo de auditoría (severidad ALTA, "Siete módulos con
// ruta HTTP real y sin UI", porción "nómina" tras vencimientos y declaraciones):
// nomina.ts expone POST /nomina/calcular y POST /nomina/generar-xml (motor
// determinista y verificado contra el intérprete Python real, ver
// @atiende/domain-despachos/nomina/payroll-engine.ts y xml-nomina.ts), pero
// ningún cliente web ni página los usaba. Esta página cierra el gap: formulario
// de cálculo de nómina de un periodo con una fila por empleado, el desglose de
// impuestos resultante (ISR/IMSS obrero/IMSS patronal/Infonavit/neto) y, a
// partir de ese mismo periodo ya calculado, la generación del XML del
// complemento Nómina 1.2 por empleado.
//
// Ambos cálculos son PUROS sin persistencia (ver comentario de nomina.ts en
// apps/api): esta página nunca "guarda" un periodo de nómina como entidad
// propia -- muestra el desglose y el XML para que el contador los use donde
// corresponda. `generar-xml` reusa internamente el MISMO motor que `calcular`
// (nunca acepta cifras ya calculadas desde el cliente para el XML fiscal), así
// que aquí también se recalcula el periodo completo al generar el XML -- nunca
// se manda un `taxes` capturado en el navegador.
import { useState } from "react";
import type { FormEvent } from "react";
import { Calculator, Copy, FileCode2, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  NativeSelect,
  PageContainer,
  Separator,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { calcularNomina, generarXmlNomina } from "../lib/nomina-client.ts";
import type { ComprobanteNomina, EmployeePayroll, EmployeePayrollInputBody, GenerarXmlNominaInput, Periodicidad, PayrollPeriodResultado, TipoNomina } from "../lib/nomina-client.ts";
import { formatMoney, formatPeriodo } from "../lib/format.ts";
import { hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que NOMINA_ROLES (@atiende/domain-despachos/roles.ts) --
// cosmético, el servidor aplica exactamente el mismo filtro vía
// assertVerticalRole en las dos rutas de nomina.ts. Nunca la única barrera.
const NOMINA_ROLES = new Set(["admin", "contador"]);

interface EmpleadoFila {
  readonly key: string;
  employeeId: string;
  nombre: string;
  salarioBruto: string;
  percepciones: string;
  salarioDiario: string;
  // Prestaciones y datos de seguridad social que cambian el cálculo (todos opcionales).
  fechaInicioRelLaboral: string;
  antiguedadAnios: string;
  sbc: string;
  /** Prima de riesgo de trabajo en % (0.54355 = clase I). */
  primaRtPct: string;
  aguinaldo: string;
  primaVacacional: string;
  ptu: string;
  // Solo necesarios para /generar-xml -- opcionales mientras solo se calcula.
  rfcReceptor: string;
  nombreReceptor: string;
  domicilioFiscalReceptor: string;
  regimenFiscalReceptor: string;
  folio: string;
  // nomina12:Receptor (XSD real, obligatorio para /generar-xml) -- ver corrección
  // hallazgo "XML de nómina 1.2 no valida contra el XSD real del SAT".
  curp: string;
  numEmpleado: string;
  tipoContrato: string;
  tipoRegimen: string;
  periodicidadPago: string;
  claveEntFed: string;
  numSeguridadSocial: string;
  riesgoPuesto: string;
}

let filaSeq = 0;
function nuevaFila(): EmpleadoFila {
  filaSeq += 1;
  return {
    key: `fila-${filaSeq}`,
    employeeId: "",
    nombre: "",
    salarioBruto: "",
    percepciones: "",
    salarioDiario: "",
    fechaInicioRelLaboral: "",
    antiguedadAnios: "",
    sbc: "",
    primaRtPct: "",
    aguinaldo: "",
    primaVacacional: "",
    ptu: "",
    rfcReceptor: "",
    nombreReceptor: "",
    domicilioFiscalReceptor: "",
    regimenFiscalReceptor: "",
    folio: "",
    curp: "",
    numEmpleado: "",
    tipoContrato: "",
    tipoRegimen: "",
    periodicidadPago: "",
    claveEntFed: "",
    numSeguridadSocial: "",
    riesgoPuesto: "",
  };
}

/** Cuerpo de un empleado para el cálculo: solo manda lo que el usuario capturó. */
function empleadoInput(f: EmpleadoFila): EmployeePayrollInputBody {
  const aguinaldo = toNumberOrUndefined(f.aguinaldo);
  const primaVacacional = toNumberOrUndefined(f.primaVacacional);
  const ptu = toNumberOrUndefined(f.ptu);
  const primaRtPct = toNumberOrUndefined(f.primaRtPct);
  return {
    employeeId: f.employeeId.trim() || undefined,
    nombre: f.nombre.trim() || undefined,
    salarioBruto: toNumberOrUndefined(f.salarioBruto),
    percepciones: toNumberOrUndefined(f.percepciones),
    salarioDiario: toNumberOrUndefined(f.salarioDiario),
    fechaInicioRelLaboral: f.fechaInicioRelLaboral.trim() || undefined,
    antiguedadAnios: toNumberOrUndefined(f.antiguedadAnios),
    sbc: toNumberOrUndefined(f.sbc),
    primaRt: primaRtPct === undefined ? undefined : primaRtPct / 100,
    conceptos: aguinaldo === undefined && primaVacacional === undefined && ptu === undefined ? undefined : { aguinaldo, primaVacacional, ptu },
  };
}

function toNumberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

const RAMAS: ReadonlyArray<{ readonly etiqueta: string; readonly obrero?: keyof EmployeePayroll["taxes"]["imss"]["obrero"]; readonly patronal?: keyof EmployeePayroll["taxes"]["imss"]["patronal"] }> = [
  { etiqueta: "Cuota fija", patronal: "cuotaFija" },
  { etiqueta: "Enfermedad y maternidad: excedente 3 UMA", obrero: "eymExcedente", patronal: "eymExcedente" },
  { etiqueta: "Prestaciones en dinero", obrero: "prestacionesDinero", patronal: "prestacionesDinero" },
  { etiqueta: "Gastos médicos de pensionados", obrero: "gmp", patronal: "gmp" },
  { etiqueta: "Invalidez y vida", obrero: "invalidezVida", patronal: "invalidezVida" },
  { etiqueta: "Riesgos de trabajo", patronal: "riesgoTrabajo" },
  { etiqueta: "Guarderías y prestaciones sociales", patronal: "guarderias" },
  { etiqueta: "Retiro", patronal: "retiro" },
  { etiqueta: "Cesantía y vejez", obrero: "ceav", patronal: "ceav" },
];

function DesgloseImss({ empleado }: { empleado: EmployeePayroll }) {
  const im = empleado.taxes.imss;
  return (
    <details className="rounded-md border border-border bg-card p-3 text-sm">
      <summary className="cursor-pointer font-medium text-foreground">
        IMSS por rama -- {empleado.nombre || empleado.employeeId || "empleado"} (SBC {formatMoney(im.sbcDiario)}
        {im.sbcTopado ? ", topado a 25 UMA" : ""}, UMA {formatMoney(im.umaDiaria)})
      </summary>
      <div role="table" aria-label={`Cuotas IMSS por rama de ${empleado.nombre || empleado.employeeId}`} className="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-6 gap-y-1 text-sm">
        <div role="row" className="contents text-xs font-medium text-muted-foreground">
          <span role="columnheader">Rama</span>
          <span role="columnheader" className="text-right">Obrero</span>
          <span role="columnheader" className="text-right">Patronal</span>
        </div>
        {RAMAS.map((r) => (
          <div role="row" className="contents" key={r.etiqueta}>
            <span role="cell">{r.etiqueta}</span>
            <span role="cell" className="text-right tabular-nums">{r.obrero ? formatMoney(im.obrero[r.obrero]) : "—"}</span>
            <span role="cell" className="text-right tabular-nums">{r.patronal ? formatMoney(im.patronal[r.patronal]) : "—"}</span>
          </div>
        ))}
        <div role="row" className="contents font-bold">
          <span role="cell">Total IMSS</span>
          <span role="cell" className="text-right tabular-nums">{formatMoney(im.obrero.total)}</span>
          <span role="cell" className="text-right tabular-nums">{formatMoney(im.patronal.total)}</span>
        </div>
        <div role="row" className="contents">
          <span role="cell">INFONAVIT (aportación patronal)</span>
          <span role="cell" className="text-right tabular-nums">—</span>
          <span role="cell" className="text-right tabular-nums">{formatMoney(im.infonavit)}</span>
        </div>
      </div>
    </details>
  );
}

function DesgloseTabla({ resultado }: { resultado: PayrollPeriodResultado }) {
  return (
    <div className="flex flex-col gap-3">
      {resultado.requiresHumanReview && (
        <Callout tone="warning" role="alert">
          Requiere revisión humana: {resultado.humanReviewReason}
        </Callout>
      )}
      <div className="flex flex-wrap gap-6 text-sm text-foreground">
        <span>
          <strong>Periodo:</strong> {formatPeriodo(resultado.year, resultado.month)}
        </span>
        <span>
          <strong>Total bruto:</strong> {formatMoney(resultado.totalBruto)}
        </span>
        <span>
          <strong>Total deducciones:</strong> {formatMoney(resultado.totalDeducciones)}
        </span>
        <span>
          <strong>Total neto:</strong> {formatMoney(resultado.totalNeto)}
        </span>
        <span>
          <strong>Total IMSS patronal:</strong> {formatMoney(resultado.totalImssPatronal)}
        </span>
        <span>
          <strong>Subsidio causado:</strong> {formatMoney(resultado.totalSubsidioCausado)}
        </span>
        <span>
          <strong>Fecha de pago:</strong> {resultado.fechaPago}
        </span>
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableCaption className="sr-only">Resultado del cálculo de nómina por empleado</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-canvas">Empleado</TableHead>
                <TableHead className="text-right">Bruto</TableHead>
                <TableHead className="text-right">Percepciones</TableHead>
                <TableHead className="text-right">SBC diario</TableHead>
                <TableHead className="text-right">Subsidio</TableHead>
                <TableHead className="text-right">ISR</TableHead>
                <TableHead className="text-right">IMSS obrero</TableHead>
                <TableHead className="text-right">IMSS patronal</TableHead>
                <TableHead className="text-right">Infonavit</TableHead>
                <TableHead className="text-right">Deducciones</TableHead>
                <TableHead className="text-right">Neto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resultado.employees.map((e: EmployeePayroll) => (
                <TableRow key={e.employeeId || e.nombre}>
                  <TableCell className="sticky left-0 z-10 bg-card">{e.nombre || e.employeeId || "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.salarioBruto)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.percepciones)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.sbcDiario)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.taxes.subsidioCausado)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.taxes.isr)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.taxes.imssObrero)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.taxes.imssPatronal)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.taxes.infonavit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(e.deducciones)}</TableCell>
                  <TableCell className="text-right font-bold tabular-nums">{formatMoney(e.neto)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {resultado.employees.map((e: EmployeePayroll) => (
        <DesgloseImss key={`imss-${e.employeeId || e.nombre}`} empleado={e} />
      ))}
      <p className="text-xs text-muted-foreground">
        {resultado.referenciaLegal} -- Cálculo sin persistencia. Clave de idempotencia: <code className="rounded bg-muted px-1 py-0.5 font-mono">{resultado.idempotencyKey}</code>
      </p>
    </div>
  );
}

function ComprobanteXml({ comprobante }: { comprobante: ComprobanteNomina }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(comprobante.xml);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1500);
    } catch {
      setCopiado(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-foreground">
            <strong>Folio {comprobante.folio}</strong> -- empleado {comprobante.employeeId}
          </span>
          <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={copiar}>
            <Copy />
            {copiado ? "Copiado" : "Copiar XML"}
          </Button>
        </div>
        <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 font-mono text-xs text-foreground">{comprobante.xml}</pre>
      </CardContent>
    </Card>
  );
}

export function NominaPage(ctx: DespachosShellContext) {
  const puedeUsar = NOMINA_ROLES.has(ctx.role);

  // Bug real (hallazgo de auditoría a4, dimensión web-contrato, severidad baja,
  // mismo patrón exacto que Vencimientos.tsx): precargar con
  // `new Date().getUTCMonth()`/`getUTCFullYear()` usa el día UTC del navegador, no
  // el día de calendario del negocio -- el último día del mes por la tarde/noche
  // CDMX precargaba el MES SIGUIENTE (y el 31-dic el AÑO siguiente). `hoyFechaSolo()`
  // (apps/web/src/lib/formato-fecha.ts) da el día de calendario en
  // America/Mexico_City -- mismo helper que Dashboard.tsx/Pl.tsx/Vencimientos.tsx.
  // Inicializador lazy: solo se usa como valor inicial de useState, así que no
  // hace falta recalcular `hoyFechaSolo()` (construye un Intl.DateTimeFormat) en
  // cada render.
  const [month, setMonth] = useState(() => String(Number(hoyFechaSolo().slice(5, 7))));
  const [year, setYear] = useState(() => String(Number(hoyFechaSolo().slice(0, 4))));
  const [diasPagados, setDiasPagados] = useState("30");
  const [periodicidad, setPeriodicidad] = useState<Periodicidad>("mensual");
  const [fechaPago, setFechaPago] = useState("");
  const [fechaInicialPago, setFechaInicialPago] = useState("");
  const [fechaFinalPago, setFechaFinalPago] = useState("");
  const [salarioDiarioDefault, setSalarioDiarioDefault] = useState("");
  const [empleados, setEmpleados] = useState<readonly EmpleadoFila[]>([nuevaFila()]);

  const [resultado, setResultado] = useState<PayrollPeriodResultado | null>(null);
  const [errorCalculo, setErrorCalculo] = useState<string | null>(null);
  const [calculando, setCalculando] = useState(false);

  const [tipoNomina, setTipoNomina] = useState<TipoNomina>("O");
  const [serie, setSerie] = useState("");
  const [emisorRfc, setEmisorRfc] = useState("");
  const [emisorNombre, setEmisorNombre] = useState("");
  const [emisorRegimenFiscal, setEmisorRegimenFiscal] = useState("");
  const [emisorLugarExpedicion, setEmisorLugarExpedicion] = useState("");
  const [emisorNoCertificado, setEmisorNoCertificado] = useState("");
  const [emisorRegistroPatronal, setEmisorRegistroPatronal] = useState("");
  const [xmlResultado, setXmlResultado] = useState<readonly ComprobanteNomina[] | null>(null);
  const [errorXml, setErrorXml] = useState<string | null>(null);
  const [generandoXml, setGenerandoXml] = useState(false);

  if (!puedeUsar) {
    return (
      <PageContainer padding="none" className="[&>*]:min-w-0">
        <h1 className="mb-2 font-display text-xl font-semibold text-foreground">Nómina</h1>
        <p role="alert" className="text-destructive text-sm">
          Tu rol ({ctx.role}) no tiene acceso a nómina. Solo admin/contador.
        </p>
      </PageContainer>
    );
  }

  function actualizarFila(key: string, cambios: Partial<EmpleadoFila>) {
    setEmpleados((prev) => prev.map((f) => (f.key === key ? { ...f, ...cambios } : f)));
  }

  function agregarFila() {
    setEmpleados((prev) => [...prev, nuevaFila()]);
  }

  function quitarFila(key: string) {
    setEmpleados((prev) => (prev.length <= 1 ? prev : prev.filter((f) => f.key !== key)));
  }

  async function handleCalcular(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCalculo(null);
    setResultado(null);
    setXmlResultado(null);
    setErrorXml(null);

    const monthNum = toNumberOrUndefined(month);
    const yearNum = toNumberOrUndefined(year);
    const diasPagadosNum = toNumberOrUndefined(diasPagados);
    const salarioDiarioDefaultNum = toNumberOrUndefined(salarioDiarioDefault);

    setCalculando(true);
    try {
      const r = await calcularNomina(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        period: { month: monthNum, year: yearNum, diasPagados: diasPagadosNum, salarioDiarioDefault: salarioDiarioDefaultNum, periodicidad, fechaPago: fechaPago.trim() || undefined },
        employees: empleados.map(empleadoInput),
      });
      setResultado(r);
    } catch (err) {
      setErrorCalculo(err instanceof Error ? err.message : "No se pudo calcular la nómina.");
    } finally {
      setCalculando(false);
    }
  }

  async function handleGenerarXml(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorXml(null);
    setXmlResultado(null);

    if (!emisorRfc.trim() || !emisorNombre.trim() || !emisorRegimenFiscal.trim() || !emisorLugarExpedicion.trim()) {
      setErrorXml("Completa los datos fiscales del emisor (RFC, nombre, régimen fiscal y lugar de expedición).");
      return;
    }
    const faltante = empleados.find(
      (f) =>
        !f.rfcReceptor.trim() ||
        !f.domicilioFiscalReceptor.trim() ||
        !f.folio.trim() ||
        !f.curp.trim() ||
        !f.numEmpleado.trim() ||
        !f.tipoContrato.trim() ||
        !f.tipoRegimen.trim() ||
        !f.periodicidadPago.trim() ||
        !f.claveEntFed.trim(),
    );
    if (faltante) {
      setErrorXml(
        `Falta un dato obligatorio del empleado "${faltante.nombre || faltante.employeeId || "sin nombre"}" (RFC receptor, domicilio fiscal, folio, CURP, número de empleado, tipo de contrato, tipo de régimen, periodicidad de pago o entidad federativa).`,
      );
      return;
    }

    const monthNum = toNumberOrUndefined(month);
    const yearNum = toNumberOrUndefined(year);
    const diasPagadosNum = toNumberOrUndefined(diasPagados);
    const salarioDiarioDefaultNum = toNumberOrUndefined(salarioDiarioDefault);

    const input: GenerarXmlNominaInput = {
      period: { month: monthNum, year: yearNum, diasPagados: diasPagadosNum, salarioDiarioDefault: salarioDiarioDefaultNum, periodicidad, fechaPago: fechaPago.trim() || undefined, tipoNomina, serie: serie.trim() || undefined, fechaInicialPago: fechaInicialPago.trim() || undefined, fechaFinalPago: fechaFinalPago.trim() || undefined },
      employees: empleados.map((f) => ({
        ...empleadoInput(f),
        rfcReceptor: f.rfcReceptor.trim(),
        nombreReceptor: f.nombreReceptor.trim() || undefined,
        domicilioFiscalReceptor: f.domicilioFiscalReceptor.trim(),
        regimenFiscalReceptor: f.regimenFiscalReceptor.trim() || undefined,
        folio: f.folio.trim(),
        curp: f.curp.trim().toUpperCase(),
        numEmpleado: f.numEmpleado.trim(),
        tipoContrato: f.tipoContrato.trim(),
        tipoRegimen: f.tipoRegimen.trim(),
        periodicidadPago: f.periodicidadPago.trim(),
        claveEntFed: f.claveEntFed.trim().toUpperCase(),
        numSeguridadSocial: f.numSeguridadSocial.trim() || undefined,
        riesgoPuesto: f.riesgoPuesto.trim() || undefined,
      })),
      emisor: {
        rfc: emisorRfc.trim(),
        nombre: emisorNombre.trim(),
        regimenFiscal: emisorRegimenFiscal.trim(),
        lugarExpedicion: emisorLugarExpedicion.trim(),
        noCertificado: emisorNoCertificado.trim() || undefined,
        registroPatronal: emisorRegistroPatronal.trim() || undefined,
      },
    };

    setGenerandoXml(true);
    try {
      const r = await generarXmlNomina(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, input);
      setXmlResultado(r.comprobantes);
    } catch (err) {
      setErrorXml(err instanceof Error ? err.message : "No se pudo generar el XML de nómina.");
    } finally {
      setGenerandoXml(false);
    }
  }

  return (
    <PageContainer padding="none" className="gap-7 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Nómina</h1>
        <p className="mt-1 text-sm text-muted-foreground">El sueldo bruto es el importe del periodo que se paga (el mes, o la quincena si eliges Quincenal). Calcula ISR, subsidio, IMSS por rama e Infonavit de un periodo y genera el XML del complemento Nómina 1.2 (sin timbrar).</p>
        <Callout tone="warning" className="mt-3">
          Las tasas IMSS, el subsidio como porcentaje de la UMA y los exentos de 2026 están pendientes de validación del fiscalista. Úsalos como borrador, no como cifra para declarar.
        </Callout>
      </header>

      <section className="flex flex-col gap-3.5">
        <h2 className="font-display text-base font-semibold text-foreground">Periodo y empleados</h2>
        <form onSubmit={handleCalcular} className="flex flex-col gap-4">
          <Card>
            <CardContent className="flex flex-wrap gap-3 p-4">
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="nomina-mes">Mes</Label>
                <Input id="nomina-mes" type="number" min={1} max={12} value={month} onChange={(e) => setMonth(e.target.value)} />
              </div>
              <div className="flex w-24 flex-col gap-1.5">
                <Label htmlFor="nomina-anio">Año</Label>
                <Input id="nomina-anio" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
              </div>
              <div className="flex w-32 flex-col gap-1.5">
                <Label htmlFor="nomina-dias">Días pagados</Label>
                <Input id="nomina-dias" type="number" value={diasPagados} onChange={(e) => setDiasPagados(e.target.value)} />
              </div>
              <div className="flex w-36 flex-col gap-1.5">
                <Label htmlFor="nomina-periodicidad">Periodicidad</Label>
                <NativeSelect
                  id="nomina-periodicidad"
                  value={periodicidad}
                  onChange={(e) => {
                    const p = e.target.value as Periodicidad;
                    setPeriodicidad(p);
                    // Quincena = 15 días y mensual = 30, salvo que el usuario ya haya escrito otro valor.
                    if (diasPagados === "30" || diasPagados === "15") setDiasPagados(p === "quincenal" ? "15" : "30");
                  }}
                >
                  <option value="mensual">Mensual</option>
                  <option value="quincenal">Quincenal</option>
                </NativeSelect>
              </div>
              <div className="flex w-44 flex-col gap-1.5">
                <Label htmlFor="nomina-fecha-pago">Fecha de pago</Label>
                <Input id="nomina-fecha-pago" type="date" value={fechaPago} onChange={(e) => setFechaPago(e.target.value)} />
              </div>
              <div className="flex w-44 flex-col gap-1.5">
                <Label htmlFor="nomina-fecha-inicial">Inicio del periodo (XML)</Label>
                <Input id="nomina-fecha-inicial" type="date" value={fechaInicialPago} onChange={(e) => setFechaInicialPago(e.target.value)} />
              </div>
              <div className="flex w-44 flex-col gap-1.5">
                <Label htmlFor="nomina-fecha-final">Fin del periodo (XML)</Label>
                <Input id="nomina-fecha-final" type="date" value={fechaFinalPago} onChange={(e) => setFechaFinalPago(e.target.value)} />
              </div>
              <div className="flex w-52 flex-col gap-1.5">
                <Label htmlFor="nomina-salario-default">Salario diario por defecto</Label>
                <Input id="nomina-salario-default" type="number" step="0.01" value={salarioDiarioDefault} onChange={(e) => setSalarioDiarioDefault(e.target.value)} placeholder="Opcional" />
              </div>
            </CardContent>
          </Card>

          <div className="overflow-x-auto">
            <Table className="min-w-[1280px]">
              <TableCaption className="sr-only">Captura de percepciones y deducciones de nómina</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-canvas h-9">ID empleado</TableHead>
                  <TableHead className="h-9">Nombre</TableHead>
                  <TableHead className="h-9">Sueldo del periodo</TableHead>
                  <TableHead className="h-9">Percepciones</TableHead>
                  <TableHead className="h-9">Salario diario</TableHead>
                  <TableHead className="h-9">Inicio de relación laboral</TableHead>
                  <TableHead className="h-9">Antigüedad (años)</TableHead>
                  <TableHead className="h-9">SBC diario</TableHead>
                  <TableHead className="h-9">Prima RT (%)</TableHead>
                  <TableHead className="h-9">Aguinaldo</TableHead>
                  <TableHead className="h-9">Prima vacacional</TableHead>
                  <TableHead className="h-9">PTU</TableHead>
                  <TableHead className="h-9" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {empleados.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="sticky left-0 z-10 bg-card p-1.5">
                      <Label htmlFor={`nomina-id-${f.key}`} className="sr-only">
                        ID empleado
                      </Label>
                      <Input id={`nomina-id-${f.key}`} value={f.employeeId} onChange={(e) => actualizarFila(f.key, { employeeId: e.target.value })} className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-nombre-${f.key}`} className="sr-only">
                        Nombre
                      </Label>
                      <Input id={`nomina-nombre-${f.key}`} value={f.nombre} onChange={(e) => actualizarFila(f.key, { nombre: e.target.value })} className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-bruto-${f.key}`} className="sr-only">
                        Sueldo bruto del periodo (mes o quincena)
                      </Label>
                      <Input id={`nomina-bruto-${f.key}`} type="number" step="0.01" value={f.salarioBruto} onChange={(e) => actualizarFila(f.key, { salarioBruto: e.target.value })} className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-percepciones-${f.key}`} className="sr-only">
                        Percepciones
                      </Label>
                      <Input id={`nomina-percepciones-${f.key}`} type="number" step="0.01" value={f.percepciones} onChange={(e) => actualizarFila(f.key, { percepciones: e.target.value })} placeholder="0" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-diario-${f.key}`} className="sr-only">
                        Salario diario
                      </Label>
                      <Input id={`nomina-diario-${f.key}`} type="number" step="0.01" value={f.salarioDiario} onChange={(e) => actualizarFila(f.key, { salarioDiario: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-inicio-${f.key}`} className="sr-only">
                        Inicio de relación laboral
                      </Label>
                      <Input id={`nomina-inicio-${f.key}`} type="date" value={f.fechaInicioRelLaboral} onChange={(e) => actualizarFila(f.key, { fechaInicioRelLaboral: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-antig-${f.key}`} className="sr-only">
                        Antigüedad (años)
                      </Label>
                      <Input id={`nomina-antig-${f.key}`} type="number" step="0.01" value={f.antiguedadAnios} onChange={(e) => actualizarFila(f.key, { antiguedadAnios: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-sbc-${f.key}`} className="sr-only">
                        SBC diario
                      </Label>
                      <Input id={`nomina-sbc-${f.key}`} type="number" step="0.01" value={f.sbc} onChange={(e) => actualizarFila(f.key, { sbc: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-rt-${f.key}`} className="sr-only">
                        Prima RT (%)
                      </Label>
                      <Input id={`nomina-rt-${f.key}`} type="number" step="0.01" value={f.primaRtPct} onChange={(e) => actualizarFila(f.key, { primaRtPct: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-aguinaldo-${f.key}`} className="sr-only">
                        Aguinaldo
                      </Label>
                      <Input id={`nomina-aguinaldo-${f.key}`} type="number" step="0.01" value={f.aguinaldo} onChange={(e) => actualizarFila(f.key, { aguinaldo: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-primavac-${f.key}`} className="sr-only">
                        Prima vacacional
                      </Label>
                      <Input id={`nomina-primavac-${f.key}`} type="number" step="0.01" value={f.primaVacacional} onChange={(e) => actualizarFila(f.key, { primaVacacional: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-ptu-${f.key}`} className="sr-only">
                        PTU
                      </Label>
                      <Input id={`nomina-ptu-${f.key}`} type="number" step="0.01" value={f.ptu} onChange={(e) => actualizarFila(f.key, { ptu: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Button type="button" variant="ghost" size="sm" className="h-9 px-3 text-xs text-destructive hover:text-destructive" onClick={() => quitarFila(f.key)} disabled={empleados.length <= 1}>
                        <Trash2 />
                        Quitar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground">
            Antigüedad define las vacaciones y el factor de integración del SBC (si no capturas el SBC). La prima RT por omisión es clase I (0.54355 %). Aguinaldo, prima vacacional y PTU se separan en exento y gravado (art. 93 LISR).
          </p>
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={agregarFila}>
            <Plus />
            Agregar empleado
          </Button>

          {errorCalculo && (
            <p role="alert" className="text-destructive text-sm">
              {errorCalculo}
            </p>
          )}
          <Button type="submit" disabled={calculando} className="self-start">
            <Calculator />
            {calculando ? "Calculando…" : "Calcular nómina"}
          </Button>
        </form>

        {resultado && <DesgloseTabla resultado={resultado} />}
      </section>

      {resultado && (
        <section className="flex flex-col gap-3.5">
          <Separator />
          <h2 className="font-display text-base font-semibold text-foreground">Generar XML del complemento Nómina 1.2</h2>
          <p className="text-xs text-muted-foreground">Genera el XML SIN sellar para cada empleado del periodo de arriba. El sellado con la FIEL/CSD real y el timbrado ante el PAC quedan fuera de esta página.</p>
          <form onSubmit={handleGenerarXml} className="flex flex-col gap-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Datos fiscales del emisor</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                <div className="flex w-44 flex-col gap-1.5">
                  <Label htmlFor="emisor-rfc">RFC emisor *</Label>
                  <Input id="emisor-rfc" value={emisorRfc} onChange={(e) => setEmisorRfc(e.target.value)} />
                </div>
                <div className="flex w-64 flex-col gap-1.5">
                  <Label htmlFor="emisor-nombre">Nombre / razón social emisor *</Label>
                  <Input id="emisor-nombre" value={emisorNombre} onChange={(e) => setEmisorNombre(e.target.value)} />
                </div>
                <div className="flex w-40 flex-col gap-1.5">
                  <Label htmlFor="emisor-regimen">Régimen fiscal *</Label>
                  <Input id="emisor-regimen" value={emisorRegimenFiscal} onChange={(e) => setEmisorRegimenFiscal(e.target.value)} placeholder="601" />
                </div>
                <div className="flex w-40 flex-col gap-1.5">
                  <Label htmlFor="emisor-lugar">Lugar de expedición (CP) *</Label>
                  <Input id="emisor-lugar" value={emisorLugarExpedicion} onChange={(e) => setEmisorLugarExpedicion(e.target.value)} />
                </div>
                <div className="flex w-52 flex-col gap-1.5">
                  <Label htmlFor="emisor-certificado">No. certificado</Label>
                  <Input id="emisor-certificado" value={emisorNoCertificado} onChange={(e) => setEmisorNoCertificado(e.target.value)} placeholder="Opcional" />
                </div>
                <div className="flex w-48 flex-col gap-1.5">
                  <Label htmlFor="emisor-registro-patronal">Registro patronal IMSS</Label>
                  <Input id="emisor-registro-patronal" value={emisorRegistroPatronal} onChange={(e) => setEmisorRegistroPatronal(e.target.value)} placeholder="Opcional" maxLength={20} />
                </div>
                <div className="flex w-36 flex-col gap-1.5">
                  <Label htmlFor="emisor-tipo-nomina">Tipo de nómina</Label>
                  <NativeSelect
                    id="emisor-tipo-nomina"
                    value={tipoNomina}
                    onChange={(e) => setTipoNomina(e.target.value as TipoNomina)}
                  >
                    <option value="O">O -- Ordinaria</option>
                    <option value="E">E -- Extraordinaria</option>
                  </NativeSelect>
                </div>
                <div className="flex w-32 flex-col gap-1.5">
                  <Label htmlFor="emisor-serie">Serie</Label>
                  <Input id="emisor-serie" value={serie} onChange={(e) => setSerie(e.target.value)} placeholder="Opcional" />
                </div>
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground">
              Tipo contrato/régimen/periodicidad usan los catálogos c_TipoContrato, c_TipoRegimen y c_PeriodicidadPago del Anexo 20 del SAT (p. ej. tipo contrato "01" = tiempo indeterminado, régimen "02" =
              Sueldos, periodicidad "05" = Mensual, "04" = Quincenal). Entidad federativa usa el catálogo c_Estado (p. ej. "CMX", "JAL", "NLE").
            </p>
            <div className="overflow-x-auto">
              <Table className="min-w-[1300px]">
                <TableCaption className="sr-only">Captura de datos del CFDI de nómina por empleado</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky left-0 z-10 bg-canvas h-9">Empleado</TableHead>
                    <TableHead className="h-9">RFC receptor *</TableHead>
                    <TableHead className="h-9">Nombre receptor</TableHead>
                    <TableHead className="h-9">CP fiscal receptor *</TableHead>
                    <TableHead className="h-9">Régimen fiscal receptor</TableHead>
                    <TableHead className="h-9">Folio *</TableHead>
                    <TableHead className="h-9">CURP *</TableHead>
                    <TableHead className="h-9">No. empleado *</TableHead>
                    <TableHead className="h-9">Tipo contrato *</TableHead>
                    <TableHead className="h-9">Tipo régimen *</TableHead>
                    <TableHead className="h-9">Periodicidad *</TableHead>
                    <TableHead className="h-9">Ent. federativa *</TableHead>
                    <TableHead className="h-9">NSS</TableHead>
                    <TableHead className="h-9">Riesgo de puesto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {empleados.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell className="sticky left-0 z-10 bg-card p-1.5">{f.nombre || f.employeeId || "—"}</TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-rfc-${f.key}`} className="sr-only">
                          RFC receptor
                        </Label>
                        <Input id={`xml-rfc-${f.key}`} value={f.rfcReceptor} onChange={(e) => actualizarFila(f.key, { rfcReceptor: e.target.value })} className="h-9 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-nombre-rec-${f.key}`} className="sr-only">
                          Nombre receptor
                        </Label>
                        <Input id={`xml-nombre-rec-${f.key}`} value={f.nombreReceptor} onChange={(e) => actualizarFila(f.key, { nombreReceptor: e.target.value })} placeholder="= nombre de nómina" className="h-9 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-cp-${f.key}`} className="sr-only">
                          CP fiscal receptor
                        </Label>
                        <Input id={`xml-cp-${f.key}`} value={f.domicilioFiscalReceptor} onChange={(e) => actualizarFila(f.key, { domicilioFiscalReceptor: e.target.value })} className="h-9 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-regimen-rec-${f.key}`} className="sr-only">
                          Régimen fiscal receptor
                        </Label>
                        <Input id={`xml-regimen-rec-${f.key}`} value={f.regimenFiscalReceptor} onChange={(e) => actualizarFila(f.key, { regimenFiscalReceptor: e.target.value })} placeholder="Opcional" className="h-9 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-folio-${f.key}`} className="sr-only">
                          Folio
                        </Label>
                        <Input id={`xml-folio-${f.key}`} value={f.folio} onChange={(e) => actualizarFila(f.key, { folio: e.target.value })} className="h-9 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-curp-${f.key}`} className="sr-only">
                          CURP
                        </Label>
                        <Input id={`xml-curp-${f.key}`} value={f.curp} onChange={(e) => actualizarFila(f.key, { curp: e.target.value })} maxLength={18} className="h-9 w-44 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-num-${f.key}`} className="sr-only">
                          Número de empleado
                        </Label>
                        <Input id={`xml-num-${f.key}`} value={f.numEmpleado} onChange={(e) => actualizarFila(f.key, { numEmpleado: e.target.value })} className="h-9 w-28 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-contrato-${f.key}`} className="sr-only">
                          Tipo de contrato
                        </Label>
                        <Input id={`xml-contrato-${f.key}`} value={f.tipoContrato} onChange={(e) => actualizarFila(f.key, { tipoContrato: e.target.value })} placeholder="01" className="h-9 w-[70px] text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-regimen-${f.key}`} className="sr-only">
                          Tipo de régimen
                        </Label>
                        <Input id={`xml-regimen-${f.key}`} value={f.tipoRegimen} onChange={(e) => actualizarFila(f.key, { tipoRegimen: e.target.value })} placeholder="02" className="h-9 w-[70px] text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-periodicidad-${f.key}`} className="sr-only">
                          Periodicidad de pago
                        </Label>
                        <Input id={`xml-periodicidad-${f.key}`} value={f.periodicidadPago} onChange={(e) => actualizarFila(f.key, { periodicidadPago: e.target.value })} placeholder="05" className="h-9 w-[70px] text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-entfed-${f.key}`} className="sr-only">
                          Entidad federativa
                        </Label>
                        <Input id={`xml-entfed-${f.key}`} value={f.claveEntFed} onChange={(e) => actualizarFila(f.key, { claveEntFed: e.target.value })} placeholder="CMX" maxLength={3} className="h-9 w-[70px] text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-nss-${f.key}`} className="sr-only">
                          Número de seguridad social
                        </Label>
                        <Input id={`xml-nss-${f.key}`} value={f.numSeguridadSocial} onChange={(e) => actualizarFila(f.key, { numSeguridadSocial: e.target.value })} placeholder="Opcional" maxLength={15} className="h-9 w-36 text-sm" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-riesgo-${f.key}`} className="sr-only">
                          Riesgo de puesto
                        </Label>
                        <Input id={`xml-riesgo-${f.key}`} value={f.riesgoPuesto} onChange={(e) => actualizarFila(f.key, { riesgoPuesto: e.target.value })} placeholder="1" maxLength={2} className="h-9 w-[70px] text-sm" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {errorXml && (
              <p role="alert" className="text-destructive text-sm">
                {errorXml}
              </p>
            )}
            <Button type="submit" disabled={generandoXml} className="self-start">
              <FileCode2 />
              {generandoXml ? "Generando…" : "Generar XML"}
            </Button>
          </form>

          {xmlResultado && (
            <div className="flex flex-col gap-3">
              {xmlResultado.map((c) => (
                <ComprobanteXml key={`${c.employeeId}-${c.folio}`} comprobante={c} />
              ))}
            </div>
          )}
        </section>
      )}
    </PageContainer>
  );
}

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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@atiende/ui";
import { calcularNomina, generarXmlNomina } from "../lib/nomina-client.ts";
import type { ComprobanteNomina, EmployeePayroll, GenerarXmlNominaInput, PayrollPeriodResultado, TipoNomina } from "../lib/nomina-client.ts";
import { formatMoney, formatPeriodo } from "../lib/format.ts";
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
  };
}

function toNumberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function DesgloseTabla({ resultado }: { resultado: PayrollPeriodResultado }) {
  return (
    <div className="flex flex-col gap-3">
      {resultado.requiresHumanReview && (
        <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400">
          Requiere revisión humana: {resultado.humanReviewReason}
        </p>
      )}
      <div className="flex flex-wrap gap-6 text-[13px] text-foreground">
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
      </div>
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Empleado</TableHead>
                <TableHead>Bruto</TableHead>
                <TableHead>Percepciones</TableHead>
                <TableHead>ISR</TableHead>
                <TableHead>IMSS obrero</TableHead>
                <TableHead>IMSS patronal</TableHead>
                <TableHead>Infonavit</TableHead>
                <TableHead>Deducciones</TableHead>
                <TableHead>Neto</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resultado.employees.map((e: EmployeePayroll) => (
                <TableRow key={e.employeeId || e.nombre}>
                  <TableCell>{e.nombre || e.employeeId || "—"}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.salarioBruto)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.percepciones)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.taxes.isr)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.taxes.imssObrero)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.taxes.imssPatronal)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.taxes.infonavit)}</TableCell>
                  <TableCell className="tabular-nums">{formatMoney(e.deducciones)}</TableCell>
                  <TableCell className="font-bold tabular-nums">{formatMoney(e.neto)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <p className="text-[11px] text-muted-foreground">
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
          <span className="text-[13px] text-foreground">
            <strong>Folio {comprobante.folio}</strong> -- empleado {comprobante.employeeId}
          </span>
          <Button type="button" variant="outline" size="sm" className="h-9 px-3 text-xs" onClick={copiar}>
            <Copy />
            {copiado ? "Copiado" : "Copiar XML"}
          </Button>
        </div>
        <pre className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 font-mono text-[11px] text-foreground">{comprobante.xml}</pre>
      </CardContent>
    </Card>
  );
}

export function NominaPage(ctx: DespachosShellContext) {
  const puedeUsar = NOMINA_ROLES.has(ctx.role);

  const now = new Date();
  const [month, setMonth] = useState(String(now.getUTCMonth() + 1));
  const [year, setYear] = useState(String(now.getUTCFullYear()));
  const [diasPagados, setDiasPagados] = useState("30");
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
  const [xmlResultado, setXmlResultado] = useState<readonly ComprobanteNomina[] | null>(null);
  const [errorXml, setErrorXml] = useState<string | null>(null);
  const [generandoXml, setGenerandoXml] = useState(false);

  if (!puedeUsar) {
    return (
      <div className="px-1">
        <h1 className="mb-2 font-display text-xl font-semibold text-foreground">Nómina</h1>
        <p role="alert" className="text-destructive text-sm">
          Tu rol ({ctx.role}) no tiene acceso a nómina. Solo admin/contador.
        </p>
      </div>
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
        period: { month: monthNum, year: yearNum, diasPagados: diasPagadosNum, salarioDiarioDefault: salarioDiarioDefaultNum },
        employees: empleados.map((f) => ({
          employeeId: f.employeeId.trim() || undefined,
          nombre: f.nombre.trim() || undefined,
          salarioBruto: toNumberOrUndefined(f.salarioBruto),
          percepciones: toNumberOrUndefined(f.percepciones),
          salarioDiario: toNumberOrUndefined(f.salarioDiario),
        })),
        tenantId: null,
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
      period: { month: monthNum, year: yearNum, diasPagados: diasPagadosNum, salarioDiarioDefault: salarioDiarioDefaultNum, tipoNomina, serie: serie.trim() || undefined },
      employees: empleados.map((f) => ({
        employeeId: f.employeeId.trim() || undefined,
        nombre: f.nombre.trim() || undefined,
        salarioBruto: toNumberOrUndefined(f.salarioBruto),
        percepciones: toNumberOrUndefined(f.percepciones),
        salarioDiario: toNumberOrUndefined(f.salarioDiario),
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
      })),
      emisor: {
        rfc: emisorRfc.trim(),
        nombre: emisorNombre.trim(),
        regimenFiscal: emisorRegimenFiscal.trim(),
        lugarExpedicion: emisorLugarExpedicion.trim(),
        noCertificado: emisorNoCertificado.trim() || undefined,
      },
      tenantId: null,
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
    <div className="flex flex-col gap-7 px-1">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Nómina</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">Calcula ISR, IMSS e Infonavit de un periodo y genera el XML del complemento Nómina 1.2 (sin timbrar).</p>
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
              <div className="flex w-52 flex-col gap-1.5">
                <Label htmlFor="nomina-salario-default">Salario diario por defecto</Label>
                <Input id="nomina-salario-default" type="number" step="0.01" value={salarioDiarioDefault} onChange={(e) => setSalarioDiarioDefault(e.target.value)} placeholder="Opcional" />
              </div>
            </CardContent>
          </Card>

          <div className="overflow-x-auto">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="h-9">ID empleado</TableHead>
                  <TableHead className="h-9">Nombre</TableHead>
                  <TableHead className="h-9">Salario bruto</TableHead>
                  <TableHead className="h-9">Percepciones</TableHead>
                  <TableHead className="h-9">Salario diario</TableHead>
                  <TableHead className="h-9" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {empleados.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-id-${f.key}`} className="sr-only">
                        ID empleado
                      </Label>
                      <Input id={`nomina-id-${f.key}`} value={f.employeeId} onChange={(e) => actualizarFila(f.key, { employeeId: e.target.value })} className="h-9 text-[13px]" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-nombre-${f.key}`} className="sr-only">
                        Nombre
                      </Label>
                      <Input id={`nomina-nombre-${f.key}`} value={f.nombre} onChange={(e) => actualizarFila(f.key, { nombre: e.target.value })} className="h-9 text-[13px]" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-bruto-${f.key}`} className="sr-only">
                        Salario bruto
                      </Label>
                      <Input id={`nomina-bruto-${f.key}`} type="number" step="0.01" value={f.salarioBruto} onChange={(e) => actualizarFila(f.key, { salarioBruto: e.target.value })} className="h-9 text-[13px]" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-percepciones-${f.key}`} className="sr-only">
                        Percepciones
                      </Label>
                      <Input id={`nomina-percepciones-${f.key}`} type="number" step="0.01" value={f.percepciones} onChange={(e) => actualizarFila(f.key, { percepciones: e.target.value })} placeholder="0" className="h-9 text-[13px]" />
                    </TableCell>
                    <TableCell className="p-1.5">
                      <Label htmlFor={`nomina-diario-${f.key}`} className="sr-only">
                        Salario diario
                      </Label>
                      <Input id={`nomina-diario-${f.key}`} type="number" step="0.01" value={f.salarioDiario} onChange={(e) => actualizarFila(f.key, { salarioDiario: e.target.value })} placeholder="Opcional" className="h-9 text-[13px]" />
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
                <div className="flex w-36 flex-col gap-1.5">
                  <Label htmlFor="emisor-tipo-nomina">Tipo de nómina</Label>
                  <select
                    id="emisor-tipo-nomina"
                    value={tipoNomina}
                    onChange={(e) => setTipoNomina(e.target.value as TipoNomina)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="O">O -- Ordinaria</option>
                    <option value="E">E -- Extraordinaria</option>
                  </select>
                </div>
                <div className="flex w-32 flex-col gap-1.5">
                  <Label htmlFor="emisor-serie">Serie</Label>
                  <Input id="emisor-serie" value={serie} onChange={(e) => setSerie(e.target.value)} placeholder="Opcional" />
                </div>
              </CardContent>
            </Card>

            <p className="text-[11px] text-muted-foreground">
              Tipo contrato/régimen/periodicidad usan los catálogos c_TipoContrato, c_TipoRegimen y c_PeriodicidadPago del Anexo 20 del SAT (p. ej. tipo contrato "01" = tiempo indeterminado, régimen "02" =
              Sueldos, periodicidad "05" = Mensual, "04" = Quincenal). Entidad federativa usa el catálogo c_Estado (p. ej. "CMX", "JAL", "NLE").
            </p>
            <div className="overflow-x-auto">
              <Table className="min-w-[1100px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-9">Empleado</TableHead>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {empleados.map((f) => (
                    <TableRow key={f.key}>
                      <TableCell className="p-1.5">{f.nombre || f.employeeId || "—"}</TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-rfc-${f.key}`} className="sr-only">
                          RFC receptor
                        </Label>
                        <Input id={`xml-rfc-${f.key}`} value={f.rfcReceptor} onChange={(e) => actualizarFila(f.key, { rfcReceptor: e.target.value })} className="h-9 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-nombre-rec-${f.key}`} className="sr-only">
                          Nombre receptor
                        </Label>
                        <Input id={`xml-nombre-rec-${f.key}`} value={f.nombreReceptor} onChange={(e) => actualizarFila(f.key, { nombreReceptor: e.target.value })} placeholder="= nombre de nómina" className="h-9 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-cp-${f.key}`} className="sr-only">
                          CP fiscal receptor
                        </Label>
                        <Input id={`xml-cp-${f.key}`} value={f.domicilioFiscalReceptor} onChange={(e) => actualizarFila(f.key, { domicilioFiscalReceptor: e.target.value })} className="h-9 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-regimen-rec-${f.key}`} className="sr-only">
                          Régimen fiscal receptor
                        </Label>
                        <Input id={`xml-regimen-rec-${f.key}`} value={f.regimenFiscalReceptor} onChange={(e) => actualizarFila(f.key, { regimenFiscalReceptor: e.target.value })} placeholder="Opcional" className="h-9 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-folio-${f.key}`} className="sr-only">
                          Folio
                        </Label>
                        <Input id={`xml-folio-${f.key}`} value={f.folio} onChange={(e) => actualizarFila(f.key, { folio: e.target.value })} className="h-9 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-curp-${f.key}`} className="sr-only">
                          CURP
                        </Label>
                        <Input id={`xml-curp-${f.key}`} value={f.curp} onChange={(e) => actualizarFila(f.key, { curp: e.target.value })} maxLength={18} className="h-9 w-44 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-num-${f.key}`} className="sr-only">
                          Número de empleado
                        </Label>
                        <Input id={`xml-num-${f.key}`} value={f.numEmpleado} onChange={(e) => actualizarFila(f.key, { numEmpleado: e.target.value })} className="h-9 w-28 text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-contrato-${f.key}`} className="sr-only">
                          Tipo de contrato
                        </Label>
                        <Input id={`xml-contrato-${f.key}`} value={f.tipoContrato} onChange={(e) => actualizarFila(f.key, { tipoContrato: e.target.value })} placeholder="01" className="h-9 w-[70px] text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-regimen-${f.key}`} className="sr-only">
                          Tipo de régimen
                        </Label>
                        <Input id={`xml-regimen-${f.key}`} value={f.tipoRegimen} onChange={(e) => actualizarFila(f.key, { tipoRegimen: e.target.value })} placeholder="02" className="h-9 w-[70px] text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-periodicidad-${f.key}`} className="sr-only">
                          Periodicidad de pago
                        </Label>
                        <Input id={`xml-periodicidad-${f.key}`} value={f.periodicidadPago} onChange={(e) => actualizarFila(f.key, { periodicidadPago: e.target.value })} placeholder="05" className="h-9 w-[70px] text-[13px]" />
                      </TableCell>
                      <TableCell className="p-1.5">
                        <Label htmlFor={`xml-entfed-${f.key}`} className="sr-only">
                          Entidad federativa
                        </Label>
                        <Input id={`xml-entfed-${f.key}`} value={f.claveEntFed} onChange={(e) => actualizarFila(f.key, { claveEntFed: e.target.value })} placeholder="CMX" maxLength={3} className="h-9 w-[70px] text-[13px]" />
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
    </div>
  );
}

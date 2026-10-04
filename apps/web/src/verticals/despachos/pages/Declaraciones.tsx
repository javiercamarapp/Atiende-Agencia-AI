// Panel de declaraciones fiscales -- hallazgo de auditoría (severidad ALTA,
// "Siete módulos con ruta HTTP real y sin UI", porción "declaraciones" tras
// vencimientos): declaraciones.ts expone POST /declaraciones/isr/pf,
// /isr/pm, /isr/pm-resico y GET /declaraciones/diot/:periodo (motor 100%
// determinista y verificado contra el intérprete Python real, ver
// @atiende/domain-despachos/declaraciones/isr-engine.ts y diot-aggregate.ts),
// pero ningún cliente web ni página los usaba. Esta página cierra el gap:
// selector de tipo de declaración ISR (PF / PM / PM-RESICO), un formulario de
// cálculo por tipo, y la consulta de DIOT ya agregado por periodo.
//
// El cálculo de ISR es un endpoint PURO sin persistencia (ver comentario de
// declaraciones.ts en apps/api): esta página nunca "guarda" una declaración
// como entidad propia -- muestra el resultado para que el contador lo
// registre donde corresponda (ej. como comprobanteUrl de un vencimiento fiscal
// en Vencimientos.tsx). DIOT sí reconstruye datos reales ya persistidos
// (invoices con diot.proveedoresReportables), por eso es una consulta, no un
// formulario de captura.
//
// Presentación (ronda de design system): el selector de tipo de declaración
// -- que siempre fue un switcher de secciones, tres píldoras con estado
// mutuamente excluyente -- pasó a `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`
// de @atiende/ui, y el resto del markup inline a Card/Input/Label/Button/Table.
// El estado `tipo` y los tres formularios siguen siendo exactamente los mismos.
import { useState } from "react";
import type { FormEvent } from "react";
import { Calculator, Download, Lock, Search } from "lucide-react";
import {
  Button,
  Callout,
  Card,
  CardContent,
  Checkbox,
  EstadoVacio,
  FormField,
  Input,
  PageContainer,
  PageHeader,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico, fetchDiot, fetchDiotLayout } from "../lib/declaraciones-client.ts";
import type { DiotAgregado, DiotLayoutRespuesta, IsrResultado } from "../lib/declaraciones-client.ts";
import { formatDiotTipoOperacion, formatMoney, formatTablaAplicadaIsr } from "../lib/format.ts";
import { hoyFechaSolo } from "../../../lib/formato-fecha.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo conjunto que DECLARACIONES_ROLES (@atiende/domain-despachos/roles.ts) --
// cosmético, el servidor aplica exactamente el mismo filtro vía
// assertVerticalRole en las 4 rutas de declaraciones.ts. Nunca la única barrera.
const DECLARACIONES_ROLES = new Set(["admin", "contador"]);

type TipoDeclaracion = "pf" | "pm" | "pm-resico";

const TIPOS: ReadonlyArray<{ value: TipoDeclaracion; label: string }> = [
  { value: "pf", label: "ISR PF (honorarios / arrendamiento)" },
  { value: "pm", label: "ISR PM (30% sobre utilidad fiscal)" },
  { value: "pm-resico", label: "ISR PM RESICO" },
];

function ResultadoIsr({ resultado }: { resultado: IsrResultado }) {
  return (
    <Card className="max-w-md">
      <CardContent className="flex flex-col gap-2 p-4">
        <p className="font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          {formatTablaAplicadaIsr(resultado.tablaAplicada)} · {resultado.tipoContribuyente === "PF" ? "Persona física" : "Persona moral"}
        </p>
        <div className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">Base gravable</span>
          <span className="text-right tabular-nums text-foreground">{formatMoney(resultado.baseGravable)}</span>
          <span className="text-muted-foreground">ISR bruto</span>
          <span className="text-right tabular-nums text-foreground">{formatMoney(resultado.isrBruto)}</span>
          <span className="text-muted-foreground">Tasa efectiva</span>
          <span className="text-right tabular-nums text-foreground">{(resultado.tasaEfectiva * 100).toFixed(2)}%</span>
          <span className="text-muted-foreground">Pagos provisionales</span>
          <span className="text-right tabular-nums text-foreground">{formatMoney(resultado.pagosProvisionales)}</span>
          <span className="font-bold text-foreground">ISR neto a pagar</span>
          <span className="text-right font-bold tabular-nums text-foreground">{formatMoney(resultado.isrNeto)}</span>
        </div>
        <p className="text-xs text-muted-foreground">Cálculo sin persistencia -- copia el ISR neto donde corresponda (ej. comprobante de un vencimiento fiscal ya registrado).</p>
      </CardContent>
    </Card>
  );
}

function IsrPfForm({ ctx }: { ctx: DespachosShellContext }) {
  const [baseGravable, setBaseGravable] = useState("");
  const [annual, setAnnual] = useState(false);
  const [pagosProvisionales, setPagosProvisionales] = useState("");
  const [resultado, setResultado] = useState<IsrResultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const base = Number(baseGravable);
    if (!Number.isFinite(base)) {
      setError("Base gravable inválida.");
      return;
    }
    setLoading(true);
    try {
      const r = await calcularIsrPf(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        baseGravable: base,
        annual,
        pagosProvisionales: pagosProvisionales.trim() ? Number(pagosProvisionales) : undefined,
      });
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el ISR PF.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-6">
      <Card className="max-w-sm flex-1">
        <CardContent className="p-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <FormField label="Base gravable" required>
              <Input id="isr-pf-base" type="number" step="0.01" value={baseGravable} onChange={(e) => setBaseGravable(e.target.value)} required />
            </FormField>
            <Checkbox checked={annual} onChange={(e) => setAnnual(e.target.checked)} label="Declaración anual (si no, mensual)" />
            <FormField label="Pagos provisionales ya realizados">
              <Input id="isr-pf-pagos" type="number" step="0.01" value={pagosProvisionales} onChange={(e) => setPagosProvisionales(e.target.value)} placeholder="0" />
            </FormField>
            {error && <Callout tone="danger">{error}</Callout>}
            <Button type="submit" loading={loading} className="w-full">
              <Calculator />
              "Calcular ISR PF"
            </Button>
          </form>
        </CardContent>
      </Card>
      {resultado && <ResultadoIsr resultado={resultado} />}
    </div>
  );
}

function IsrPmForm({ ctx }: { ctx: DespachosShellContext }) {
  const [utilidadFiscal, setUtilidadFiscal] = useState("");
  const [pagosProvisionales, setPagosProvisionales] = useState("");
  const [resultado, setResultado] = useState<IsrResultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const utilidad = Number(utilidadFiscal);
    if (!Number.isFinite(utilidad)) {
      setError("Utilidad fiscal inválida.");
      return;
    }
    setLoading(true);
    try {
      const r = await calcularIsrPm(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        utilidadFiscal: utilidad,
        pagosProvisionales: pagosProvisionales.trim() ? Number(pagosProvisionales) : undefined,
      });
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el ISR PM.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-6">
      <Card className="max-w-sm flex-1">
        <CardContent className="p-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <FormField label="Utilidad fiscal" required>
              <Input id="isr-pm-utilidad" type="number" step="0.01" value={utilidadFiscal} onChange={(e) => setUtilidadFiscal(e.target.value)} required />
            </FormField>
            <FormField label="Pagos provisionales ya realizados">
              <Input id="isr-pm-pagos" type="number" step="0.01" value={pagosProvisionales} onChange={(e) => setPagosProvisionales(e.target.value)} placeholder="0" />
            </FormField>
            {error && <Callout tone="danger">{error}</Callout>}
            <Button type="submit" loading={loading} className="w-full">
              <Calculator />
              "Calcular ISR PM"
            </Button>
          </form>
        </CardContent>
      </Card>
      {resultado && <ResultadoIsr resultado={resultado} />}
    </div>
  );
}

function IsrPmResicoForm({ ctx }: { ctx: DespachosShellContext }) {
  const [ingresosCobrados, setIngresosCobrados] = useState("");
  const [deduccionesAutorizadas, setDeduccionesAutorizadas] = useState("");
  const [pagosProvisionales, setPagosProvisionales] = useState("");
  const [resultado, setResultado] = useState<IsrResultado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const ingreso = Number(ingresosCobrados);
    if (!Number.isFinite(ingreso)) {
      setError("Ingresos cobrados inválidos.");
      return;
    }
    setLoading(true);
    try {
      const r = await calcularIsrPmResico(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, {
        ingresosCobrados: ingreso,
        deduccionesAutorizadas: deduccionesAutorizadas.trim() ? Number(deduccionesAutorizadas) : undefined,
        pagosProvisionales: pagosProvisionales.trim() ? Number(pagosProvisionales) : undefined,
      });
      setResultado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo calcular el ISR PM RESICO.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-6">
      <Card className="max-w-sm flex-1">
        <CardContent className="p-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <FormField label="Ingresos efectivamente cobrados en el mes" required>
              <Input id="resico-ingresos" type="number" step="0.01" value={ingresosCobrados} onChange={(e) => setIngresosCobrados(e.target.value)} required />
            </FormField>
            <FormField label="Deducciones autorizadas efectivamente pagadas">
              <Input id="resico-deducciones" type="number" step="0.01" value={deduccionesAutorizadas} onChange={(e) => setDeduccionesAutorizadas(e.target.value)} placeholder="0" />
            </FormField>
            <FormField label="Pagos provisionales ya realizados">
              <Input id="resico-pagos" type="number" step="0.01" value={pagosProvisionales} onChange={(e) => setPagosProvisionales(e.target.value)} placeholder="0" />
            </FormField>
            <p className="text-xs text-muted-foreground">RESICO PM: tasa fija de 30% sobre flujo de efectivo (ingresos cobrados − deducciones pagadas), Art. 206/209 LISR.</p>
            {error && <Callout tone="danger">{error}</Callout>}
            <Button type="submit" loading={loading} className="w-full">
              <Calculator />
              "Calcular ISR PM RESICO"
            </Button>
          </form>
        </CardContent>
      </Card>
      {resultado && <ResultadoIsr resultado={resultado} />}
    </div>
  );
}

function DiotConsulta({ ctx }: { ctx: DespachosShellContext }) {
  // Bug real (hallazgo de auditoría a4, dimensión web-contrato, severidad baja,
  // mismo patrón exacto que Vencimientos.tsx/Nomina.tsx): precargar con
  // `new Date().getUTCFullYear()`/`getUTCMonth()` usa el día UTC del navegador, no
  // el día de calendario del negocio -- el último día del mes por la tarde/noche
  // CDMX precargaba el MES SIGUIENTE (y el 31-dic el AÑO siguiente). `hoyFechaSolo()`
  // (apps/web/src/lib/formato-fecha.ts, formato "YYYY-MM-DD") da el día de
  // calendario en America/Mexico_City -- mismo helper que Dashboard.tsx/Pl.tsx.
  // Inicializador lazy: solo se usa como valor inicial de useState, así que no
  // hace falta recalcular `hoyFechaSolo()` (construye un Intl.DateTimeFormat) en
  // cada render.
  const [periodo, setPeriodo] = useState(() => hoyFechaSolo().slice(0, 7));
  const [agregado, setAgregado] = useState<DiotAgregado | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [layoutAdvertencias, setLayoutAdvertencias] = useState<readonly string[]>([]);
  const [descargando, setDescargando] = useState<"txt" | "xml" | null>(null);

  // D-05: descarga el layout del periodo consultado (sin firma ni envio). El archivo se
  // arma en el servidor; aqui solo se guarda como Blob.
  async function descargarLayout(formato: "txt" | "xml") {
    setError(null);
    setDescargando(formato);
    try {
      const l: DiotLayoutRespuesta = await fetchDiotLayout(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, periodo);
      setLayoutAdvertencias(l.advertencias);
      const contenido = formato === "txt" ? l.txt : l.xml;
      if (contenido === "") {
        setError("No hay terceros reportables en este periodo: no se generó archivo.");
        return;
      }
      const blob = new Blob([contenido], { type: formato === "txt" ? "text/plain;charset=utf-8" : "application/xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `DIOT_${periodo}.${formato}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo generar el layout DIOT.");
    } finally {
      setDescargando(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLayoutAdvertencias([]);
    if (!/^\d{4}-\d{2}$/.test(periodo)) {
      setError("Periodo inválido -- usa el formato AAAA-MM.");
      return;
    }
    setLoading(true);
    try {
      const r = await fetchDiot(fetch, ctx.apiBaseUrl, ctx.token, ctx.propertyId, periodo);
      setAgregado(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo consultar la DIOT del periodo.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2.5">
        <FormField label="Periodo (AAAA-MM)" required>
          <Input id="diot-periodo" type="text" value={periodo} onChange={(e) => setPeriodo(e.target.value)} placeholder="2026-03" className="w-36" required />
        </FormField>
        <Button type="submit" loading={loading}>
          <Search />
          Consultar DIOT
        </Button>
      </form>
      {error && <Callout tone="danger">{error}</Callout>}
      {agregado && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-6 text-sm text-foreground">
            <span>
              <strong>Periodo:</strong> {agregado.periodo}
            </span>
            <span>
              <strong>RFC contribuyente:</strong> {agregado.rfcContribuyente ?? "—"}
            </span>
            <span>
              <strong>Total neto:</strong> {formatMoney(agregado.totalMontoNeto)}
            </span>
            <span>
              <strong>Total IVA trasladado:</strong> {formatMoney(agregado.totalIvaTrasladado)}
            </span>
            <span>
              <strong>Total IVA acreditable:</strong> {formatMoney(agregado.totalIvaAcreditable)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" loading={descargando === "txt"} disabled={descargando !== null || agregado.registros.length === 0} onClick={() => void descargarLayout("txt")}>
              <Download />
              Descargar layout TXT
            </Button>
            <Button type="button" variant="outline" size="sm" loading={descargando === "xml"} disabled={descargando !== null || agregado.registros.length === 0} onClick={() => void descargarLayout("xml")}>
              <Download />
              Descargar XML
            </Button>
            <span className="text-xs text-muted-foreground">Archivo para revisión: sin firma ni envío al SAT.</span>
          </div>
          {layoutAdvertencias.length > 0 && (
            <Callout tone="warning">
              <ul className="list-disc pl-5">
                {layoutAdvertencias.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Callout>
          )}
          {agregado.registros.length === 0 ? (
            <EstadoVacio compacto mensaje="Sin proveedores reportables en este periodo." />
          ) : (
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>RFC</TableHead>
                      <TableHead>Proveedor</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Monto neto</TableHead>
                      <TableHead>IVA 16%</TableHead>
                      <TableHead>IVA 0%</TableHead>
                      <TableHead>IVA exento</TableHead>
                      <TableHead>CFDIs</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agregado.registros.map((r) => (
                      <TableRow key={`${r.rfcTercero}-${r.tipoOperacion}`}>
                        <TableCell className="font-mono text-xs">{r.rfcTercero}</TableCell>
                        <TableCell>{r.nombre}</TableCell>
                        <TableCell>{formatDiotTipoOperacion(r.tipoOperacion)}</TableCell>
                        <TableCell className="tabular-nums">{formatMoney(r.montoNeto)}</TableCell>
                        <TableCell className="tabular-nums">{formatMoney(r.ivaTrasladado16)}</TableCell>
                        <TableCell className="tabular-nums">{formatMoney(r.ivaTrasladado0)}</TableCell>
                        <TableCell className="tabular-nums">{formatMoney(r.ivaExento)}</TableCell>
                        <TableCell className="tabular-nums">{r.count}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

export function DeclaracionesPage(ctx: DespachosShellContext) {
  const [tipo, setTipo] = useState<TipoDeclaracion>("pf");
  const puedeUsar = DECLARACIONES_ROLES.has(ctx.role);

  if (!puedeUsar) {
    return (
      <PageContainer className="[&>*]:min-w-0">
        <PageHeader titulo="Declaraciones fiscales" descripcion="ISR (PF / PM / PM RESICO) y consulta de DIOT." />
        <EstadoVacio icon={Lock} titulo="Sin permiso" mensaje={`Tu rol (${ctx.role}) no tiene acceso a declaraciones fiscales. Solo admin/contador.`} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader titulo="Declaraciones fiscales" descripcion="ISR (PF / PM / PM RESICO) y consulta de DIOT ya agregada desde los CFDI ya capturados." />

      <section className="flex flex-col gap-2.5">
        <h2 className="text-sm font-medium text-foreground">Cálculo de ISR</h2>
        <Tabs value={tipo} onValueChange={(v) => setTipo(v as TipoDeclaracion)} className="flex flex-col gap-2.5">
          <TabsList className="h-auto flex-wrap justify-start">
            {TIPOS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="pf" className="mt-0">
            <IsrPfForm ctx={ctx} />
          </TabsContent>
          <TabsContent value="pm" className="mt-0">
            <IsrPmForm ctx={ctx} />
          </TabsContent>
          <TabsContent value="pm-resico" className="mt-0">
            <IsrPmResicoForm ctx={ctx} />
          </TabsContent>
        </Tabs>
      </section>

      <section className="flex flex-col gap-2.5">
        <Separator />
        <h2 className="text-sm font-medium text-foreground">DIOT por periodo</h2>
        <DiotConsulta ctx={ctx} />
      </section>
    </PageContainer>
  );
}

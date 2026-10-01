// P&L por vertical y por cliente (SA-29) con comparativo mes contra mes, movimiento de MRR por
// vertical (SA-05), captura de la infraestructura compartida y exportacion CSV. Backend real:
// GET /superadmin/pyl, GET /superadmin/pyl/export.csv y PUT /superadmin/pyl/infra
// (apps/api/src/routes/superadmin-pyl.ts; formulas en packages/billing/src/pyl.ts).
//
// REGLA DE LA CASA: nunca una cifra inventada. Lo que no tiene fuente (ingreso de una organizacion
// sin plan o sin precio, costo sin tipo de cambio, margen bruto sin infra capturada, movimiento de
// MRR sin foto previa) se muestra como «—» con su razon, jamas como cero.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Download, Landmark, Percent, ReceiptText, Repeat, TrendingUp, Wallet } from "lucide-react";
import { Button, Card, CardContent, CardHeader, CardTitle, DataTable, EstadoCargando, EstadoError, Input, Label, StatCard, formatMoney } from "@atiende/ui";
import type { DataTableColumna } from "@atiende/ui";
import { fetchConStepUp } from "../lib/stepup.ts";

interface Cogs {
  readonly llm: number;
  readonly voz: number;
  readonly whatsapp: number;
  readonly telefonia: number;
  readonly otros: number;
}
interface Agregado {
  readonly clave: string;
  readonly organizaciones: number;
  readonly organizacionesConIngreso: number;
  readonly organizacionesSinIngreso: number;
  readonly ingresoMxn: number;
  readonly cogs: Cogs | null;
  readonly cogsDirectoMxn: number | null;
  readonly infraMxn: number | null;
  readonly costoSinIngresoMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
}
interface FilaCliente {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly ingresoMxn: number | null;
  readonly ingresoRazon: "sin_plan" | "precio_no_configurado" | "sin_foto_del_mes" | null;
  readonly cogs: Cogs | null;
  readonly cogsDirectoMxn: number | null;
  readonly infraMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
}
interface Variacion {
  readonly actual: number | null;
  readonly previo: number | null;
  readonly deltaMxn: number | null;
  readonly deltaPct: number | null;
}
interface ComparativoAgregado {
  readonly clave: string;
  readonly ingreso: Variacion;
  readonly cogsDirecto: Variacion;
  readonly contribucion: Variacion;
  readonly margenBruto: Variacion;
}
type Infra =
  | { readonly disponible: true; readonly totalMxn: number; readonly sinAsignarMxn: number; readonly conceptos: ReadonlyArray<{ readonly concepto: string; readonly montoMxn: number }> }
  | { readonly disponible: false; readonly razon: "sin_infra_capturada" };
interface Nrr {
  readonly disponible: boolean;
  readonly mrrInicialMxn?: number;
  readonly expansionMxn?: number;
  readonly contraccionMxn?: number;
  readonly churnMxn?: number;
  readonly nuevoMxn?: number;
  readonly nrrPct?: number | null;
  readonly razon?: string;
}
interface Respuesta {
  readonly disponible: boolean;
  readonly mes: string;
  readonly mesPrevio?: string;
  readonly mensaje?: string;
  readonly tipoCambio?: { readonly mxnPorUsd: number; readonly fecha: string | null; readonly fuente: string | null } | null;
  readonly infraCapturaDisponible?: boolean;
  readonly pyl?: { readonly infra: Infra; readonly total: Agregado; readonly porVertical: readonly Agregado[]; readonly porCliente: readonly FilaCliente[] };
  readonly comparativo?: { readonly total: ComparativoAgregado; readonly porVertical: readonly ComparativoAgregado[] };
  readonly movimientoMrr?: { readonly disponible: true; readonly porVertical: ReadonlyArray<{ readonly vertical: string; readonly nrr: Nrr }> } | { readonly disponible: false; readonly razon: string };
  readonly supuestos?: readonly string[];
}

const mxn = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `$${formatMoney(n)}`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toFixed(1)}%`);
const mesActual = () => new Date().toISOString().slice(0, 7);

const RAZON_INGRESO: Record<string, string> = {
  sin_plan: "sin plan asignado",
  precio_no_configurado: "plan sin precio",
  sin_foto_del_mes: "mes sin foto de ingreso",
};
const RAZON_MOVIMIENTO: Record<string, string> = {
  sin_foto_previa: "Aún no hay foto de ingreso del mes anterior (la guarda el cron de alertas CFO una vez al día).",
  sin_foto_del_mes: "Este mes ya cerró sin foto de ingreso guardada.",
};

function delta(v: Variacion): string {
  if (v.deltaMxn === null) return "—";
  const signo = v.deltaMxn > 0 ? "+" : "";
  return v.deltaPct === null ? `${signo}${mxn(v.deltaMxn)}` : `${signo}${mxn(v.deltaMxn)} (${signo}${v.deltaPct.toFixed(1)}%)`;
}

async function request(apiBaseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) };
  return fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
}

const columnasCogs = <T extends { readonly cogs: Cogs | null; readonly cogsDirectoMxn: number | null; readonly infraMxn: number | null; readonly contribucionMxn: number | null; readonly contribucionPct: number | null; readonly margenBrutoMxn: number | null; readonly margenBrutoPct: number | null }>(): DataTableColumna<T>[] => [
  { id: "llm", encabezado: "LLM", alinear: "right", celda: (f) => mxn(f.cogs?.llm), valorOrden: (f) => f.cogs?.llm ?? null },
  { id: "voz", encabezado: "Voz", alinear: "right", celda: (f) => mxn(f.cogs?.voz), valorOrden: (f) => f.cogs?.voz ?? null },
  { id: "wa", encabezado: "WhatsApp", alinear: "right", celda: (f) => mxn(f.cogs?.whatsapp), valorOrden: (f) => f.cogs?.whatsapp ?? null },
  { id: "tel", encabezado: "Telefonía", alinear: "right", celda: (f) => mxn(f.cogs?.telefonia), valorOrden: (f) => f.cogs?.telefonia ?? null },
  { id: "otros", encabezado: "Otros", alinear: "right", celda: (f) => mxn(f.cogs?.otros), valorOrden: (f) => f.cogs?.otros ?? null },
  { id: "cogs", encabezado: "COGS directo", alinear: "right", celda: (f) => mxn(f.cogsDirectoMxn), valorOrden: (f) => f.cogsDirectoMxn },
  { id: "infra", encabezado: "Infra prorrateada", alinear: "right", celda: (f) => mxn(f.infraMxn), valorOrden: (f) => f.infraMxn },
  { id: "contrib", encabezado: "Contribución", alinear: "right", celda: (f) => (f.contribucionMxn === null ? "—" : `${mxn(f.contribucionMxn)} (${pct(f.contribucionPct)})`), valorOrden: (f) => f.contribucionMxn },
  { id: "bruto", encabezado: "Margen bruto", alinear: "right", celda: (f) => (f.margenBrutoMxn === null ? "—" : `${mxn(f.margenBrutoMxn)} (${pct(f.margenBrutoPct)})`), valorOrden: (f) => f.margenBrutoMxn },
];

export function SuperAdminPylVerticalPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [mes, setMes] = useState(mesActual());
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);

  const [concepto, setConcepto] = useState("");
  const [monto, setMonto] = useState("");
  const [nota, setNota] = useState("");
  const [infraError, setInfraError] = useState<string | null>(null);
  const [infraEnviando, setInfraEnviando] = useState(false);

  async function cargar() {
    setError(null);
    try {
      const res = await request(apiBaseUrl, token, `/superadmin/pyl?mes=${encodeURIComponent(mes)}`);
      if (!res.ok) throw new Error("fallo");
      setDatos((await res.json()) as Respuesta);
    } catch {
      setError("No se pudo cargar el P&L.");
    }
  }

  useEffect(() => {
    setDatos(null);
    setAviso(null);
    void cargar();
  }, [apiBaseUrl, token, mes]);

  async function exportar(nivel: "vertical" | "cliente") {
    setAviso(null);
    setExportando(true);
    try {
      const res = await request(apiBaseUrl, token, `/superadmin/pyl/export.csv?mes=${encodeURIComponent(mes)}&nivel=${nivel}`);
      if (!res.ok) throw new Error("fallo");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `pyl-${nivel}-${mes}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setAviso("No se pudo exportar el CSV.");
    } finally {
      setExportando(false);
    }
  }

  async function guardarInfra(e: FormEvent) {
    e.preventDefault();
    const valor = Number(monto);
    if (concepto.trim().length < 2) return setInfraError("Indica el concepto (por ejemplo, Vercel).");
    if (monto.trim() === "" || !Number.isFinite(valor) || valor < 0) return setInfraError("Indica un monto en pesos mayor o igual a 0.");
    setInfraEnviando(true);
    setInfraError(null);
    try {
      const res = await request(apiBaseUrl, token, "/superadmin/pyl/infra", { method: "PUT", body: JSON.stringify({ mes, concepto: concepto.trim(), montoMxn: valor, ...(nota.trim() ? { nota: nota.trim() } : {}) }) });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "No se pudo guardar.");
      }
      setConcepto("");
      setMonto("");
      setNota("");
      setAviso("Infraestructura guardada.");
      await cargar();
    } catch (err) {
      setInfraError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setInfraEnviando(false);
    }
  }

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Armando el P&L…" />;

  const p = datos.pyl;
  const c = datos.comparativo;
  const colsVertical: DataTableColumna<Agregado>[] = [
    { id: "vertical", encabezado: "Vertical", principal: true, celda: (f) => <span className="font-medium">{f.clave}</span>, valorOrden: (f) => f.clave },
    { id: "orgs", encabezado: "Clientes", alinear: "right", celda: (f) => (f.organizacionesSinIngreso > 0 ? `${f.organizaciones} (${f.organizacionesSinIngreso} sin ingreso)` : String(f.organizaciones)), valorOrden: (f) => f.organizaciones },
    { id: "ingreso", encabezado: "Ingreso reconocido", alinear: "right", celda: (f) => (f.organizacionesConIngreso === 0 ? "—" : mxn(f.ingresoMxn)), valorOrden: (f) => (f.organizacionesConIngreso === 0 ? null : f.ingresoMxn) },
    ...columnasCogs<Agregado>(),
  ];
  const colsCliente: DataTableColumna<FilaCliente>[] = [
    {
      id: "cliente",
      encabezado: "Cliente",
      principal: true,
      celda: (f) => (
        <>
          <span className="font-medium">{f.nombre}</span>
          <div className="text-xs text-muted-foreground">{f.vertical}</div>
        </>
      ),
      valorOrden: (f) => f.nombre,
    },
    { id: "ingreso", encabezado: "Ingreso reconocido", alinear: "right", celda: (f) => (f.ingresoMxn === null ? `— ${f.ingresoRazon ? RAZON_INGRESO[f.ingresoRazon] : ""}` : mxn(f.ingresoMxn)), valorOrden: (f) => f.ingresoMxn },
    ...columnasCogs<FilaCliente>(),
  ];
  const colsComparativo: DataTableColumna<ComparativoAgregado>[] = [
    { id: "vertical", encabezado: "Vertical", principal: true, celda: (f) => <span className="font-medium">{f.clave === "total" ? "Total" : f.clave}</span> },
    { id: "ingreso", encabezado: "Ingreso vs. mes anterior", alinear: "right", celda: (f) => `${mxn(f.ingreso.actual)} / ${mxn(f.ingreso.previo)} · ${delta(f.ingreso)}` },
    { id: "cogs", encabezado: "COGS directo", alinear: "right", celda: (f) => `${mxn(f.cogsDirecto.actual)} / ${mxn(f.cogsDirecto.previo)} · ${delta(f.cogsDirecto)}` },
    { id: "contrib", encabezado: "Contribución", alinear: "right", celda: (f) => `${mxn(f.contribucion.actual)} / ${mxn(f.contribucion.previo)} · ${delta(f.contribucion)}` },
    { id: "bruto", encabezado: "Margen bruto", alinear: "right", celda: (f) => `${mxn(f.margenBruto.actual)} / ${mxn(f.margenBruto.previo)} · ${delta(f.margenBruto)}` },
  ];

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <ReceiptText className="w-5 h-5" strokeWidth={1.75} />
            P&amp;L por vertical y cliente
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Ingreso reconocido, COGS (LLM, voz, WhatsApp, telefonía e infraestructura prorrateada), margen de contribución y margen bruto. Lo que no tiene fuente se muestra como «—», nunca como cero.</p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pyl-mes">Mes</Label>
            <Input id="pyl-mes" type="month" value={mes} max={mesActual()} onChange={(e) => e.target.value && setMes(e.target.value)} />
          </div>
          {datos.disponible && (
            <>
              <Button variant="outline" className="rounded-full" disabled={exportando} onClick={() => void exportar("vertical")}>
                <Download className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                CSV por vertical
              </Button>
              <Button variant="outline" className="rounded-full" disabled={exportando} onClick={() => void exportar("cliente")}>
                <Download className="w-4 h-4 mr-1.5" strokeWidth={1.75} />
                CSV por cliente
              </Button>
            </>
          )}
        </div>
      </div>

      {aviso && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {aviso}
        </p>
      )}

      {!datos.disponible || !p || !c ? (
        <p role="alert" className="text-[13px] text-muted-foreground">
          {datos.mensaje ?? "El P&L todavía no está disponible en esta base (migración 0030 pendiente de aplicar)."}
        </p>
      ) : (
        <>
          {datos.tipoCambio === null && (
            <p role="alert" className="text-[13px] text-muted-foreground">
              No hay tipo de cambio configurado para este mes: el COGS en pesos y los márgenes no se calculan hasta capturar uno (Costos y margen).
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={TrendingUp} label="Ingreso reconocido" value={mxn(p.total.ingresoMxn)} nota={p.total.organizacionesSinIngreso > 0 ? `${p.total.organizacionesSinIngreso} cliente(s) sin ingreso conocido (no suman)` : `vs. mes anterior ${delta(c.total.ingreso)}`} />
            <StatCard icon={Wallet} label="COGS directo" value={mxn(p.total.cogsDirectoMxn)} nota={`vs. mes anterior ${delta(c.total.cogsDirecto)}`} sinDato={p.total.cogsDirectoMxn === null ? "Falta el tipo de cambio" : undefined} />
            <StatCard icon={Percent} label="Margen de contribución" value={pct(p.total.contribucionPct)} nota={p.total.contribucionMxn === null ? undefined : mxn(p.total.contribucionMxn)} sinDato={p.total.contribucionPct === null ? "Falta tipo de cambio o ingreso conocido" : undefined} />
            <StatCard icon={Landmark} label="Margen bruto" value={pct(p.total.margenBrutoPct)} nota={p.total.margenBrutoMxn === null ? undefined : mxn(p.total.margenBrutoMxn)} sinDato={p.total.margenBrutoPct === null ? (p.infra.disponible ? "Falta tipo de cambio o ingreso conocido" : "Falta capturar la infraestructura del mes") : undefined} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Comparativo contra {datos.mesPrevio}</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable<ComparativoAgregado> etiqueta="Comparativo mes contra mes por vertical" columnas={colsComparativo} filas={[c.total, ...c.porVertical]} obtenerId={(f) => f.clave} paginacion={false} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>P&amp;L por vertical — {datos.mes} (total en las tarjetas de arriba)</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable<Agregado> etiqueta="P&L por vertical" columnas={colsVertical} filas={p.porVertical} obtenerId={(f) => f.clave} paginacion={false} vacio={{ mensaje: "Todavía no hay organizaciones." }} />
              {p.total.costoSinIngresoMxn !== null && p.total.costoSinIngresoMxn > 0 && <p className="text-xs text-muted-foreground mt-2">Costo de clientes sin ingreso conocido, fuera de los márgenes: {mxn(p.total.costoSinIngresoMxn)}.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>P&amp;L por cliente — {datos.mes}</CardTitle>
            </CardHeader>
            <CardContent>
              <DataTable<FilaCliente> etiqueta="P&L por cliente" columnas={colsCliente} filas={p.porCliente} obtenerId={(f) => f.organizationId} paginacion={{ tamano: 15 }} vacio={{ mensaje: "Sin clientes con ingreso o costo en este mes." }} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Repeat className="w-4 h-4" strokeWidth={1.75} />
                Movimiento de MRR por vertical
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!datos.movimientoMrr || !datos.movimientoMrr.disponible ? (
                <p role="note" className="text-[13px] text-muted-foreground">
                  {datos.movimientoMrr ? (RAZON_MOVIMIENTO[datos.movimientoMrr.razon] ?? datos.movimientoMrr.razon) : "Sin datos."}
                </p>
              ) : (
                <DataTable<{ vertical: string; nrr: Nrr }>
                  etiqueta="Movimiento de MRR por vertical"
                  filas={datos.movimientoMrr.porVertical}
                  obtenerId={(f) => f.vertical}
                  paginacion={false}
                  columnas={[
                    { id: "vertical", encabezado: "Vertical", principal: true, celda: (f) => <span className="font-medium">{f.vertical}</span> },
                    { id: "nrr", encabezado: "NRR", alinear: "right", celda: (f) => (f.nrr.disponible ? pct(f.nrr.nrrPct) : "—") },
                    { id: "exp", encabezado: "Expansión", alinear: "right", celda: (f) => (f.nrr.disponible ? mxn(f.nrr.expansionMxn) : "—") },
                    { id: "con", encabezado: "Contracción", alinear: "right", celda: (f) => (f.nrr.disponible ? mxn(f.nrr.contraccionMxn) : "—") },
                    { id: "churn", encabezado: "Churn", alinear: "right", celda: (f) => (f.nrr.disponible ? mxn(f.nrr.churnMxn) : "—") },
                    { id: "nuevo", encabezado: "Nuevo", alinear: "right", celda: (f) => (f.nrr.disponible ? mxn(f.nrr.nuevoMxn) : "—") },
                  ]}
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Infraestructura compartida — {datos.mes}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {p.infra.disponible ? (
                <ul className="text-[13px] list-disc pl-5">
                  {p.infra.conceptos.map((i) => (
                    <li key={i.concepto}>
                      {i.concepto}: {mxn(i.montoMxn)}
                    </li>
                  ))}
                  <li className="font-medium list-none -ml-5">Total prorrateado: {mxn(p.infra.totalMxn)}</li>
                  {p.infra.sinAsignarMxn > 0 && <li className="list-none -ml-5 text-muted-foreground">Sin asignar (sin COGS directo que prorratear): {mxn(p.infra.sinAsignarMxn)}</li>}
                </ul>
              ) : (
                <p role="note" className="text-[13px] text-muted-foreground">
                  No hay infraestructura capturada para este mes: el margen bruto no se calcula (el de contribución sí).
                </p>
              )}
              {datos.infraCapturaDisponible === false ? (
                <p role="alert" className="text-[13px] text-muted-foreground">
                  La captura de infraestructura todavía no está disponible en esta base (migración 0032 pendiente de aplicar).
                </p>
              ) : (
                <form onSubmit={(e) => void guardarInfra(e)} className="flex items-end gap-3 flex-wrap">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pyl-concepto">Concepto</Label>
                    <Input id="pyl-concepto" value={concepto} maxLength={80} onChange={(e) => setConcepto(e.target.value)} placeholder="Vercel + Supabase" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pyl-monto">Monto del mes (MXN)</Label>
                    <Input id="pyl-monto" type="number" min="0" step="0.01" value={monto} onChange={(e) => setMonto(e.target.value)} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="pyl-nota">Nota (opcional)</Label>
                    <Input id="pyl-nota" value={nota} maxLength={300} onChange={(e) => setNota(e.target.value)} />
                  </div>
                  <Button type="submit" className="rounded-full" disabled={infraEnviando}>
                    Guardar
                  </Button>
                  {infraError && (
                    <p role="alert" className="text-[13px] text-destructive w-full">
                      {infraError}
                    </p>
                  )}
                </form>
              )}
              <p className="text-xs text-muted-foreground">Capturar el mismo concepto otra vez corrige su monto. Para quitar uno, captura 0. Pide verificación MFA.</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cómo se calcula</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc pl-5 text-[13px] text-muted-foreground flex flex-col gap-1">
                {(datos.supuestos ?? []).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

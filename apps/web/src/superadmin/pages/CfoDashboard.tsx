// Dashboard ejecutivo CFO (SA-01) con MRR/ARR por vertical y cliente y NRR (SA-05) y las alertas
// proactivas vigentes (SA-36). Una sola pantalla: ingreso recurrente, margen, caja, cobranza,
// riesgos y mejores/peores clientes. Backend real: GET /superadmin/cfo/dashboard
// (apps/api/src/routes/superadmin-cfo.ts).
//
// REGLA DE LA CASA: nunca una cifra inventada. Lo que no tiene fuente (caja, NRR sin foto del mes
// anterior, margen sin tipo de cambio, ingreso de una organización sin plan o con plan sin precio)
// se muestra como «—» con su razón, jamás como cero.
import { useEffect, useState } from "react";
import { AlertTriangle, Banknote, Landmark, LineChart, Percent, Repeat, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, PageContainer, StatCard, StatusBadge, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, formatMoney, statusTone } from "@atiende/ui";
import { SEVERIDAD_CFO_TONES } from "../lib/status-tones.ts";
import { fetchConStepUp } from "../lib/stepup.ts";

interface IngresoVertical {
  readonly vertical: string;
  readonly mrrMxn: number;
  readonly clientes: number;
  readonly sinPrecio: number;
}
interface IngresoCliente {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly mrrMxn: number;
  readonly participacionPct: number;
}
interface ClienteMargen {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly ingresoMxn: number;
  readonly costoMxn: number;
  readonly margenMxn: number;
  readonly margenPct: number | null;
}
type Nrr =
  | {
      readonly disponible: true;
      readonly mrrInicialMxn: number;
      readonly expansionMxn: number;
      readonly contraccionMxn: number;
      readonly churnMxn: number;
      readonly nuevoMxn: number;
      readonly nrrPct: number | null;
      readonly grrPct: number | null;
      readonly excluidasSinDato: number;
    }
  | { readonly disponible: false; readonly razon: "sin_foto_previa" | "sin_foto_del_mes" };
type Margen =
  | {
      readonly disponible: true;
      readonly resumen: { readonly margenPct: number | null; readonly margenMxn: number | null; readonly costoMxn: number | null };
      readonly umbralMargenPct: number;
      readonly clientesBajoUmbral: number;
      readonly clientesConMargen: number;
      readonly mejores: readonly ClienteMargen[];
      readonly peores: readonly ClienteMargen[];
    }
  | { readonly disponible: false; readonly razon: "sin_tipo_de_cambio" | "sin_ingreso_conocido" };
interface Alerta {
  readonly codigo: "margen_bajo" | "voz_sobre_tope" | "cobranza_vencida" | "cliente_en_riesgo";
  readonly severidad: "critica" | "alta" | "media";
  readonly titulo: string;
  readonly organizaciones: ReadonlyArray<{ readonly organizationId: string; readonly nombre: string; readonly dato: string }>;
}
interface Dashboard {
  readonly mes: string;
  readonly ingresos: {
    readonly mrrMxn: number;
    readonly arrMxn: number;
    readonly clientesConIngreso: number;
    readonly clientesSinPrecio: number;
    readonly porVertical: readonly IngresoVertical[];
    readonly topClientes: readonly IngresoCliente[];
    readonly concentracionTopPct: number | null;
  };
  readonly nrr: Nrr;
  readonly margen: Margen;
  readonly caja: { readonly disponible: false; readonly razon: string };
  readonly cobranza: { readonly pagoPendiente: number; readonly mrrEnRiesgoMxn: number | null };
  readonly alertas: readonly Alerta[];
}
interface Respuesta {
  readonly disponible: boolean;
  readonly mes: string;
  readonly mensaje?: string;
  readonly tipoCambio: { readonly mxnPorUsd: number; readonly fecha: string | null; readonly fuente: string | null } | null;
  readonly dashboard: Dashboard | null;
  readonly supuestos: readonly string[];
}

const mxn = (n: number | null) => (n === null ? "—" : `$${formatMoney(n)}`);

function mesActual(): string {
  return new Date().toISOString().slice(0, 7);
}

const RAZON_NRR: Record<string, string> = {
  sin_foto_previa: "Aún no hay foto de ingreso del mes anterior (se guarda una al día desde que corre el cron de alertas CFO).",
  sin_foto_del_mes: "Este mes ya cerró sin foto de ingreso guardada.",
};
const RAZON_MARGEN: Record<string, string> = {
  sin_tipo_de_cambio: "Falta capturar el tipo de cambio (Costos y margen).",
  sin_ingreso_conocido: "Ninguna organización activa tiene un plan con precio.",
};

async function fetchJson<T>(apiBaseUrl: string, token: string, path: string): Promise<T> {
  const res = await fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error("No se pudo completar la solicitud.");
  return res.json() as Promise<T>;
}

function badgeSeveridad(s: Alerta["severidad"]) {
  return <StatusBadge tone={statusTone(SEVERIDAD_CFO_TONES, s)}>{s === "critica" ? "Crítica" : s === "alta" ? "Alta" : "Media"}</StatusBadge>;
}

function TablaClientesMargen({ titulo, filas }: { readonly titulo: string; readonly filas: readonly ClienteMargen[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        {filas.length === 0 ? (
          <EstadoVacio mensaje="Sin clientes para mostrar." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Ingreso</TableHead>
                  <TableHead>Costo</TableHead>
                  <TableHead>Margen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filas.map((f) => (
                  <TableRow key={f.organizationId}>
                    <TableCell>
                      <span className="font-medium">{f.nombre}</span>
                      <div className="text-xs text-muted-foreground">{f.vertical}</div>
                    </TableCell>
                    <TableCell>{mxn(f.ingresoMxn)}</TableCell>
                    <TableCell>{mxn(f.costoMxn)}</TableCell>
                    <TableCell>{f.margenPct === null ? `— (${mxn(f.margenMxn)})` : `${f.margenPct.toFixed(1)}% (${mxn(f.margenMxn)})`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SuperAdminCfoDashboardPage({ apiBaseUrl, token }: { readonly apiBaseUrl: string; readonly token: string }) {
  const [mes, setMes] = useState(mesActual());
  const [datos, setDatos] = useState<Respuesta | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function cargar() {
    setError(null);
    try {
      setDatos(await fetchJson<Respuesta>(apiBaseUrl, token, `/superadmin/cfo/dashboard?mes=${encodeURIComponent(mes)}`));
    } catch {
      setError("No se pudo cargar el dashboard CFO.");
    }
  }

  useEffect(() => {
    setDatos(null);
    void cargar();
  }, [apiBaseUrl, token, mes]);

  if (error && !datos) return <EstadoError mensaje={error} onReintentar={() => void cargar()} />;
  if (!datos) return <EstadoCargando etiqueta="Armando el dashboard CFO…" />;

  const d = datos.dashboard;
  return (
    <PageContainer padding="none" className="[&>*]:min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
            <LineChart className="w-5 h-5" strokeWidth={1.75} />
            Dashboard ejecutivo (CFO)
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Ingreso recurrente, margen, cobranza y riesgos de toda la plataforma. Lo que no tiene fuente se muestra como «—», nunca como cero.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cfo-mes">Mes</Label>
          <Input id="cfo-mes" type="month" value={mes} max={mesActual()} onChange={(e) => e.target.value && setMes(e.target.value)} />
        </div>
      </div>

      {!datos.disponible || !d ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {datos.mensaje ?? "El dashboard CFO todavía no está disponible en esta base (migración 0030 pendiente de aplicar)."}
        </p>
      ) : (
        <>
          {d.alertas.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" strokeWidth={1.75} />
                  Riesgos y alertas vigentes
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-3">
                  {d.alertas.map((a) => (
                    <li key={a.codigo}>
                      <div className="flex items-center gap-2">
                        {badgeSeveridad(a.severidad)}
                        <span className="font-medium">
                          {a.titulo}: {a.organizaciones.length}
                        </span>
                      </div>
                      <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                        {a.organizaciones.map((o) => (
                          <li key={o.organizationId}>
                            {o.nombre} — {o.dato}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard icon={Repeat} label="MRR" value={mxn(d.ingresos.mrrMxn)} nota={d.ingresos.clientesSinPrecio > 0 ? `${d.ingresos.clientesConIngreso} clientes con precio · ${d.ingresos.clientesSinPrecio} sin precio (no suman)` : `${d.ingresos.clientesConIngreso} clientes con precio`} />
            <StatCard icon={TrendingUp} label="ARR" value={mxn(d.ingresos.arrMxn)} nota="MRR x 12" />
            {d.margen.disponible ? (
              <StatCard
                icon={Percent}
                label="Margen bruto"
                value={d.margen.resumen.margenPct === null ? "—" : `${d.margen.resumen.margenPct.toFixed(1)}%`}
                nota={`${d.margen.clientesBajoUmbral} de ${d.margen.clientesConMargen} clientes bajo el umbral de ${d.margen.umbralMargenPct}%`}
                sinDato={d.margen.resumen.margenPct === null ? "Sin ingreso comparable" : undefined}
              />
            ) : (
              <StatCard icon={Percent} label="Margen bruto" value="—" sinDato={RAZON_MARGEN[d.margen.razon]} />
            )}
            {d.nrr.disponible ? (
              <StatCard icon={Repeat} label="NRR" value={d.nrr.nrrPct === null ? "—" : `${d.nrr.nrrPct.toFixed(1)}%`} nota={`expansión ${mxn(d.nrr.expansionMxn)} · contracción ${mxn(d.nrr.contraccionMxn)} · churn ${mxn(d.nrr.churnMxn)}`} sinDato={d.nrr.nrrPct === null ? "El mes anterior no tuvo MRR" : undefined} />
            ) : (
              <StatCard icon={Repeat} label="NRR" value="—" sinDato={RAZON_NRR[d.nrr.razon]} />
            )}
            <StatCard icon={Landmark} label="Caja" value="—" sinDato={d.caja.razon} />
            <StatCard icon={Banknote} label="Cobranza vencida" value={String(d.cobranza.pagoPendiente)} nota={d.cobranza.mrrEnRiesgoMxn === null ? "clientes con pago pendiente" : `clientes con pago pendiente · ${mxn(d.cobranza.mrrEnRiesgoMxn)} de MRR`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>MRR por vertical — {d.mes}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Vertical</TableHead>
                        <TableHead>MRR</TableHead>
                        <TableHead>Clientes</TableHead>
                        <TableHead>Sin precio</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.ingresos.porVertical.map((v) => (
                        <TableRow key={v.vertical}>
                          <TableCell className="font-medium">{v.vertical}</TableCell>
                          <TableCell>{v.clientes === 0 ? "—" : mxn(v.mrrMxn)}</TableCell>
                          <TableCell>{v.clientes}</TableCell>
                          <TableCell className={v.sinPrecio > 0 ? "" : "text-muted-foreground"}>{v.sinPrecio}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Mayores clientes por MRR{d.ingresos.concentracionTopPct !== null ? ` · el mayor concentra ${d.ingresos.concentracionTopPct.toFixed(1)}%` : ""}</CardTitle>
              </CardHeader>
              <CardContent>
                {d.ingresos.topClientes.length === 0 ? (
                  <EstadoVacio mensaje="Todavía no hay clientes con ingreso conocido." />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Cliente</TableHead>
                          <TableHead>MRR</TableHead>
                          <TableHead>Participación</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {d.ingresos.topClientes.map((c) => (
                          <TableRow key={c.organizationId}>
                            <TableCell>
                              <span className="font-medium">{c.nombre}</span>
                              <div className="text-xs text-muted-foreground">{c.vertical}</div>
                            </TableCell>
                            <TableCell>{mxn(c.mrrMxn)}</TableCell>
                            <TableCell>{c.participacionPct.toFixed(1)}%</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {d.margen.disponible ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <TablaClientesMargen titulo="Mejores clientes por margen" filas={d.margen.mejores} />
              <TablaClientesMargen titulo="Clientes con menor margen" filas={d.margen.peores} />
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Mejores y peores clientes por margen: no disponible. {RAZON_MARGEN[d.margen.razon]}
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Supuestos de este dashboard</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc pl-5 text-sm text-muted-foreground flex flex-col gap-1">
                {datos.supuestos.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

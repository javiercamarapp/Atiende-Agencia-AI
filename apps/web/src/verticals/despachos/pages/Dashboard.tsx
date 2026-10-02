// Dashboard gerencial del despacho (D-01): cartera y cobranza, carga de trabajo, cierres
// pendientes y anomalías, consolidado de todos los clientes (contribuyentes) visibles para el
// staff y con detalle del cliente activo. Datos reales de `GET /v1/despachos/:orgSlug/dashboard`;
// un indicador sin fuente (base sin migrar, sin cartera registrada) se muestra "sin dato" con
// su razón, nunca como cero (mismo criterio que `StatCard.sinDato`). No hay carga por persona:
// el modelo no asigna responsables a revisiones/tareas, la carga es por cliente.
import { useEffect, useState } from "react";
import { DespachosFijadosCopiloto } from "./Copiloto.tsx";
import { AlertTriangle, CalendarCheck, CheckCircle2, ClipboardList, HandCoins, ShieldAlert, Users, Wallet } from "lucide-react";
import { Card, CardContent, DataTable, EstadoCargando, EstadoError, EstadoVacio, PageContainer, StatCard, StatusBadge, statusTone } from "@atiende/ui";
import { fetchDashboardDespacho } from "../lib/dashboard-client.ts";
import type { AnomaliaDashboard, DashboardDespacho, FuenteDashboard, KpisCliente, NivelAtencion, SeveridadAnomalia } from "../lib/dashboard-client.ts";
import { formatMoney, formatPeriodo } from "../lib/format.ts";
import { NIVEL_ATENCION_TONES, SEVERIDAD_ANOMALIA_TONES } from "../lib/status-tones.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

const NIVEL_ETIQUETA: Record<NivelAtencion, string> = { critico: "Crítico", atencion: "Atención", al_corriente: "Al corriente", sin_datos: "Sin datos" };
const SEVERIDAD_ETIQUETA: Record<SeveridadAnomalia, string> = { alta: "Alta", media: "Media", baja: "Baja" };
const FUENTE_ETIQUETA: Record<FuenteDashboard, string> = {
  cartera: "cartera y cobranza",
  revisiones: "revisiones de CFDI",
  vencimientos: "vencimientos fiscales",
  cierre: "cierre mensual",
  cfdi: "CFDI del mes",
};
const SIN_CARTERA = "Sin cartera disponible: aún no hay cuentas por cobrar registradas o la base no tiene ese módulo.";

export function NivelBadge({ nivel }: { nivel: NivelAtencion }) {
  return <StatusBadge tone={statusTone(NIVEL_ATENCION_TONES, nivel)}>{NIVEL_ETIQUETA[nivel]}</StatusBadge>;
}

function formatPct(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString("es-MX", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

function ResumenCards({ d }: { d: DashboardDespacho }) {
  const { cartera, cargaTrabajo, cierres } = d;
  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
      <StatCard icon={Users} label="Clientes" value={String(d.totalClientes)} nota={`${d.clientesPorNivel.critico} crítico(s) · ${d.clientesPorNivel.atencion} en atención`} />
      <StatCard
        icon={Wallet}
        label="Cartera pendiente"
        value={cartera ? formatMoney(cartera.montoPendiente) : ""}
        nota={cartera ? `${cartera.cuentasPendientes} cuenta(s)` : undefined}
        sinDato={cartera ? undefined : SIN_CARTERA}
      />
      <StatCard
        icon={AlertTriangle}
        label="Cartera vencida"
        value={cartera ? formatMoney(cartera.montoVencido) : ""}
        nota={cartera ? `${formatMoney(cartera.monto90Mas)} con más de 90 días` : undefined}
        sinDato={cartera ? undefined : SIN_CARTERA}
      />
      <StatCard
        icon={HandCoins}
        label="Tasa de cobranza"
        value={cartera ? formatPct(cartera.tasaCobranzaPct) : ""}
        nota={cartera ? `${formatMoney(cartera.montoCobrado)} cobrado` : undefined}
        sinDato={cartera?.tasaCobranzaPct === null || !cartera ? "Sin cartera registrada para calcular la tasa." : undefined}
      />
      <StatCard
        icon={ClipboardList}
        label="Pendientes de trabajo"
        value={cargaTrabajo ? String(cargaTrabajo.totalPendientes) : ""}
        nota={cargaTrabajo ? `${cargaTrabajo.revisionesPendientes} revisión(es) · ${cargaTrabajo.vencimientosAbiertos} vencimiento(s) · ${cargaTrabajo.tareasCierrePendientes} tarea(s) de cierre` : undefined}
        sinDato={cargaTrabajo ? undefined : "Ninguna fuente de trabajo disponible todavía."}
      />
      <StatCard
        icon={CalendarCheck}
        label="Cierres sin cerrar"
        value={cierres ? String(cierres.periodosSinCerrar) : ""}
        nota={cierres ? `${cierres.periodosVencidos} vencido(s) · ${cierres.clientesMesAnteriorSinCerrar} cliente(s) con el mes anterior abierto` : undefined}
        sinDato={cierres ? undefined : "Cierre mensual no disponible todavía."}
      />
      <StatCard
        icon={ShieldAlert}
        label="Anomalías"
        value={String(d.anomaliasPorSeveridad.alta + d.anomaliasPorSeveridad.media + d.anomaliasPorSeveridad.baja)}
        nota={`${d.anomaliasPorSeveridad.alta} alta(s) · ${d.anomaliasPorSeveridad.media} media(s) · ${d.anomaliasPorSeveridad.baja} baja(s)`}
      />
    </div>
  );
}

function ListaAnomalias({ anomalias }: { anomalias: readonly AnomaliaDashboard[] }) {
  if (anomalias.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-success" strokeWidth={1.75} />
        Sin anomalías detectadas con los datos disponibles.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {anomalias.map((a) => (
        <li key={a.codigo} className="flex items-start gap-2 text-sm text-foreground">
          <StatusBadge tone={statusTone(SEVERIDAD_ANOMALIA_TONES, a.severidad)} className="shrink-0">
            {SEVERIDAD_ETIQUETA[a.severidad]}
          </StatusBadge>
          <span>
            {a.mensaje}
            {a.monto !== null ? ` (${formatMoney(a.monto)})` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DetalleCliente({ cliente }: { cliente: KpisCliente }) {
  const { cartera, cargaTrabajo, cierres, cfdiMes } = cliente;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold text-foreground">Cliente activo · {cliente.nombre}</h2>
          <NivelBadge nivel={cliente.nivelAtencion} />
        </div>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
          <StatCard
            icon={Wallet}
            label="Cartera pendiente"
            value={cartera ? formatMoney(cartera.montoPendiente) : ""}
            nota={cartera ? `${cartera.cuentasPendientes} cuenta(s) · score promedio ${cartera.scorePromedio ?? "—"}` : undefined}
            sinDato={cartera ? undefined : SIN_CARTERA}
          />
          <StatCard
            icon={ClipboardList}
            label="Carga de trabajo"
            value={cargaTrabajo ? String(cargaTrabajo.totalPendientes) : ""}
            nota={cargaTrabajo ? `${cargaTrabajo.vencimientosVencidos ?? 0} vencimiento(s) vencido(s)` : undefined}
            sinDato={cargaTrabajo ? undefined : "Sin fuentes de trabajo disponibles."}
          />
          <StatCard
            icon={CalendarCheck}
            label="Cierre del mes anterior"
            value={cierres ? { cerrado: "Cerrado", abierto: "Abierto", vencido: "Vencido", sin_periodo: "Sin período" }[cierres.mesAnterior.estado] : ""}
            nota={cierres ? formatPeriodo(cierres.mesAnterior.year, cierres.mesAnterior.month) : undefined}
            sinDato={cierres ? undefined : "Cierre mensual no disponible todavía."}
          />
          <StatCard
            icon={ClipboardList}
            label={`CFDI 4.0 de ${cfdiMes?.periodo ?? "el mes"}`}
            value={cfdiMes ? String(cfdiMes.total) : ""}
            nota={cfdiMes ? `${cfdiMes.invalidos} con hallazgos · ${cfdiMes.requierenRevision} por revisar` : undefined}
            sinDato={cfdiMes ? undefined : "CFDI del mes no disponibles."}
          />
        </div>
        <ListaAnomalias anomalias={cliente.anomalias} />
      </CardContent>
    </Card>
  );
}

export function DashboardPage({ apiBaseUrl, token, orgSlug, propertyId }: DespachosShellContext) {
  const [data, setData] = useState<DashboardDespacho | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDashboardDespacho(fetch, apiBaseUrl, token, orgSlug));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el dashboard del despacho.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, orgSlug]);

  const activo = data?.ranking.find((c) => c.propertyId === propertyId) ?? null;

  return (
    <PageContainer padding="none" className="gap-4 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Dashboard gerencial</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cartera y cobranza, carga de trabajo, cierres pendientes y anomalías de todos tus clientes, calculados con los CFDI 4.0, vencimientos del SAT y cierres ya registrados.
        </p>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {loading && !data && <EstadoCargando etiqueta="Cargando dashboard…" />}

      {data && data.totalClientes === 0 && <EstadoVacio mensaje="Todavía no hay clientes (contribuyentes) visibles para tu usuario." />}

      {data && data.totalClientes > 0 && (
        <>
          {data.fuentesNoDisponibles.length > 0 && (
            <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Algunos indicadores aún no están disponibles en esta base de datos ({data.fuentesNoDisponibles.map((f) => FUENTE_ETIQUETA[f]).join(", ")}); se muestran como «sin dato» en vez de cero.
            </p>
          )}
          {data.truncado && (
            <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Se consolidan los primeros {data.totalClientes} de {data.totalClientesVisibles} clientes visibles.
            </p>
          )}

          <ResumenCards d={data} />
          {activo && <DetalleCliente cliente={activo} />}

          <DataTable
            etiqueta="Clientes del despacho por nivel de atención"
            obtenerId={(c) => c.propertyId}
            filas={data.ranking}
            paginacion={false}
            columnas={[
              { id: "cliente", encabezado: "Cliente", principal: true, celda: (c) => <span className="font-medium">{c.nombre}</span> },
              { id: "atencion", encabezado: "Atención", celda: (c) => <NivelBadge nivel={c.nivelAtencion} /> },
              { id: "cartera", encabezado: "Cartera vencida", celda: (c) => <span className="tabular-nums text-muted-foreground">{c.cartera ? formatMoney(c.cartera.montoVencido) : "Sin dato"}</span> },
              { id: "cobranza", encabezado: "Cobranza", celda: (c) => <span className="tabular-nums text-muted-foreground">{c.cartera ? formatPct(c.cartera.tasaCobranzaPct) : "Sin dato"}</span> },
              { id: "pendientes", encabezado: "Pendientes", celda: (c) => <span className="tabular-nums text-muted-foreground">{c.cargaTrabajo ? c.cargaTrabajo.totalPendientes : "Sin dato"}</span> },
              {
                id: "cierre",
                encabezado: "Cierre mes anterior",
                celda: (c) => (
                  <span className="text-muted-foreground">
                    {c.cierres ? { cerrado: "Cerrado", abierto: "Abierto", vencido: "Vencido", sin_periodo: "Sin período" }[c.cierres.mesAnterior.estado] : "Sin dato"}
                  </span>
                ),
              },
              { id: "anomalias", encabezado: "Anomalías", className: "min-w-64", celda: (c) => <ListaAnomalias anomalias={c.anomalias} /> },
            ]}
          />
          <DespachosFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
        </>
      )}
    </PageContainer>
  );
}

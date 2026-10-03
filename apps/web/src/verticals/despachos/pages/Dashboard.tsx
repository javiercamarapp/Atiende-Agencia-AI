// Resumen del despacho (D-01 + UNI-RES-despachos): composición del Resumen de Likida con las piezas UNI-5 de @atiende/ui.
// Saludo (hora de México), destacado "Cartera pendiente", 7 KPI en orden (Clientes, Cartera vencida, Tasa de cobranza,
// Pendientes de trabajo, Cierres sin cerrar, Anomalías, CFDI del mes) que enlazan a su pantalla, píldoras "Ver cobranza" /
// "Ver cierre" y "Orquestación de agentes". Debajo se conservan el detalle del cliente activo y el ranking de clientes.
//
// TODA cifra sale de `GET /v1/despachos/:orgSlug/dashboard`; un indicador sin fuente (base sin migrar, sin cartera registrada)
// se muestra "—" con su razón (`StatCard.sinDato`), nunca como cero. "CFDI del mes" suma el `cfdiMes` de los clientes que lo
// reportan; si ninguno lo reporta es "—". No hay carga por persona: el modelo no asigna responsables, la carga es por cliente.
// "Última corrida": ningún endpoint del tenant expone los latidos (`withHeartbeat`) de los crons de despachos (core.agent_run
// solo lo lee la consola de plataforma y mezcla organizaciones), así que la sección dice honestamente que falta en vez de inventar.
import { useEffect, useState, type ReactNode } from "react";
import { COPILOTO_DESPACHOS_ROLES, DespachosFijadosCopiloto } from "./Copiloto.tsx";
import { Link } from "react-router-dom";
import { AlertTriangle, Bot, CalendarCheck, CheckCircle2, ClipboardList, FileText, HandCoins, Landmark, ShieldAlert, ShieldCheck, Sparkles, Users, Wallet } from "lucide-react";
import { Card, CardContent, DataTable, EstadoCargando, EstadoError, EstadoVacio, Odometro, PageContainer, PillLink, ResumenLayout, ResumenSeccion, StatCard, StatusBadge, TileLink, statusTone } from "@atiende/ui";
import { primerNombreOCorreo } from "../../../lib/greeting.ts";
import { saludoDespacho } from "../lib/saludo.ts";
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

/** Suma de CFDI del mes entre los clientes que lo reportan; `null` si ninguno (nunca 0 inventado). */
export function cfdiDelMes(ranking: readonly KpisCliente[]): { total: number; periodo: string; clientes: number } | null {
  const con = ranking.filter((c) => c.cfdiMes !== null);
  if (con.length === 0) return null;
  return { total: con.reduce((n, c) => n + c.cfdiMes!.total, 0), periodo: con[0]!.cfdiMes!.periodo, clientes: con.length };
}

function ligado(to: string, tarjeta: ReactNode) {
  return (
    <Link to={to} className="block min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {tarjeta}
    </Link>
  );
}

function kpisResumen(d: DashboardDespacho, base: string): ReactNode[] {
  const { cartera, cargaTrabajo, cierres } = d;
  const cfdi = cfdiDelMes(d.ranking);
  const total = d.anomaliasPorSeveridad.alta + d.anomaliasPorSeveridad.media + d.anomaliasPorSeveridad.baja;
  return [
    <div key="clientes" className="min-w-0">
      {ligado(`${base}/cartera`, <StatCard icon={Users} label="Clientes" value={String(d.totalClientes)} nota={`${d.clientesPorNivel.critico} crítico(s) · ${d.clientesPorNivel.atencion} en atención`} />)}
    </div>,
    <div key="vencida" className="min-w-0">
      {ligado(
        `${base}/cobranza`,
        <StatCard
          icon={AlertTriangle}
          label="Cartera vencida"
          value={cartera ? formatMoney(cartera.montoVencido) : ""}
          nota={cartera ? `${formatMoney(cartera.monto90Mas)} con más de 90 días` : undefined}
          sinDato={cartera ? undefined : SIN_CARTERA}
        />,
      )}
    </div>,
    <div key="tasa" className="min-w-0">
      {ligado(
        `${base}/cobranza`,
        <StatCard
          icon={HandCoins}
          label="Tasa de cobranza"
          value={cartera ? formatPct(cartera.tasaCobranzaPct) : ""}
          nota={cartera ? `${formatMoney(cartera.montoCobrado)} cobrado` : undefined}
          sinDato={cartera?.tasaCobranzaPct === null || !cartera ? "Sin cartera registrada para calcular la tasa." : undefined}
        />,
      )}
    </div>,
    <div key="pendientes" className="min-w-0">
      {ligado(
        `${base}/vencimientos`,
        <StatCard
          icon={ClipboardList}
          label="Pendientes de trabajo"
          value={cargaTrabajo ? String(cargaTrabajo.totalPendientes) : ""}
          nota={cargaTrabajo ? `${cargaTrabajo.revisionesPendientes} revisión(es) · ${cargaTrabajo.vencimientosAbiertos} vencimiento(s) · ${cargaTrabajo.tareasCierrePendientes} tarea(s) de cierre` : undefined}
          sinDato={cargaTrabajo ? undefined : "Ninguna fuente de trabajo disponible todavía."}
        />,
      )}
    </div>,
    <div key="cierres" className="min-w-0">
      {ligado(
        `${base}/cierre-mensual`,
        <StatCard
          icon={CalendarCheck}
          label="Cierres sin cerrar"
          value={cierres ? String(cierres.periodosSinCerrar) : ""}
          nota={cierres ? `${cierres.periodosVencidos} vencido(s) · ${cierres.clientesMesAnteriorSinCerrar} cliente(s) con el mes anterior abierto` : undefined}
          sinDato={cierres ? undefined : "Cierre mensual no disponible todavía."}
        />,
      )}
    </div>,
    <div key="anomalias" className="min-w-0">
      <StatCard icon={ShieldAlert} label="Anomalías" value={String(total)} nota={`${d.anomaliasPorSeveridad.alta} alta(s) · ${d.anomaliasPorSeveridad.media} media(s) · ${d.anomaliasPorSeveridad.baja} baja(s)`} />
    </div>,
    <div key="cfdi" className="min-w-0">
      {ligado(
        `${base}/cfdi`,
        <StatCard
          icon={FileText}
          label="CFDI del mes"
          value={cfdi ? String(cfdi.total) : ""}
          nota={cfdi ? `${formatPeriodo(Number(cfdi.periodo.slice(0, 4)), Number(cfdi.periodo.slice(5, 7)))} · ${cfdi.clientes} cliente(s)` : undefined}
          sinDato={cfdi ? undefined : "CFDI del mes no disponibles todavía."}
        />,
      )}
    </div>,
  ];
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

export function DashboardPage({ apiBaseUrl, token, orgSlug, propertyId, role, staffFullName, staffEmail }: DespachosShellContext) {
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

  const base = `/despachos/${orgSlug}`;
  const activo = data?.ranking.find((c) => c.propertyId === propertyId) ?? null;

  if (!data || data.totalClientes === 0) {
    return (
      <PageContainer padding="none" size="xl" className="gap-4 [&>*]:min-w-0">
        {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
        {loading && !data && <EstadoCargando etiqueta="Cargando dashboard…" />}
        {data && <EstadoVacio mensaje="Todavía no hay clientes (contribuyentes) visibles para tu usuario." />}
      </PageContainer>
    );
  }

  const cartera = data.cartera;
  const destacado = (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro
        valor={cartera ? Math.round(cartera.montoPendiente) : null}
        digitos={Math.max(5, cartera ? String(Math.round(cartera.montoPendiente)).length : 5)}
        prefijo="$"
        etiqueta="Cartera pendiente"
        sinDato="sin cartera registrada"
        tamano="md"
      />
      {/* El odómetro se oculta bajo `sm` (como en Likida): en móvil la cifra viaja en una línea. */}
      <p className="text-ui text-muted-foreground sm:hidden">
        Cartera pendiente <span className="font-medium tabular-nums text-foreground">{cartera ? formatMoney(cartera.montoPendiente) : "—"}</span>
      </p>
    </div>
  );

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludoDespacho()}
        nombre={primerNombreOCorreo(staffFullName, staffEmail)}
        subtitulo={`${data.organizacion.nombre} · ${data.totalClientes} cliente(s)`}
        destacado={destacado}
        kpis={kpisResumen(data, base)}
        acciones={
          <>
            <PillLink to={`${base}/cobranza`}>Ver cobranza</PillLink>
            <PillLink to={`${base}/cierre-mensual`}>Ver cierre</PillLink>
          </>
        }
      >
        {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
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

        <ResumenSeccion titulo="Orquestación de agentes">
          <TileLink
            to={`${base}/cola-cobranza`}
            icon={HandCoins}
            titulo="Recordatorios de cobranza"
            descripcion={cartera ? `${cartera.cuentasPendientes} cuenta(s) por cobrar pendientes` : undefined}
          />
          <TileLink to={`${base}/cfdi`} icon={ShieldCheck} titulo="Lista 69-B del SAT" />
          <TileLink to={`${base}/conciliacion`} icon={Landmark} titulo="Conciliación asistida" />
          {COPILOTO_DESPACHOS_ROLES.has(role) && <TileLink to={`${base}/copiloto`} icon={Sparkles} titulo="Copiloto" descripcion="Pregunta a tus datos del despacho." />}
        </ResumenSeccion>
        <ResumenSeccion titulo="Última corrida">
          <EstadoVacio
            icon={Bot}
            compacto
            className="col-span-full"
            titulo="Sin registro de corridas"
            mensaje="Falta un endpoint de lectura que exponga los latidos de los procesos automáticos del despacho; hasta entonces no se muestra ninguna corrida."
          />
        </ResumenSeccion>

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
      </ResumenLayout>
    </PageContainer>
  );
}

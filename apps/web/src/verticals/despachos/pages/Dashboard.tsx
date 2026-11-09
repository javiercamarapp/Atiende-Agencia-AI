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
import { Card, CardContent, DataTable, EstadoCargando, EstadoError, EstadoVacio, Odometro, PageContainer, PillLink, ResumenLayout, ResumenSeccion, StatCard, StatusBadge, TileLink, statusTone, traductorActivo, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { despachosResumen } from "@atiende/ui/i18n/despachos/resumen";
import { primerNombreOCorreo } from "../../../lib/greeting.ts";
import { saludoDespacho } from "../lib/saludo.ts";
import { fetchDashboardDespacho } from "../lib/dashboard-client.ts";
import type { AnomaliaDashboard, DashboardDespacho, FuenteDashboard, KpisCliente, NivelAtencion, SeveridadAnomalia } from "../lib/dashboard-client.ts";
import { formatMoney, formatPeriodo } from "../lib/format.ts";
import { NIVEL_ATENCION_TONES, SEVERIDAD_ANOMALIA_TONES } from "../lib/status-tones.ts";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Funciones de texto fuera del componente: traducen al idioma activo (la pagina consume el contexto con `useT`, asi que se repinta al cambiarlo).
const tr = traductorActivo(despachosResumen);

const NIVEL_CLAVE: Record<NivelAtencion, Clave> = {
  critico: "despachos.resumen.nivel.critico",
  atencion: "despachos.resumen.nivel.atencion",
  al_corriente: "despachos.resumen.nivel.alCorriente",
  sin_datos: "despachos.resumen.nivel.sinDatos",
};
const SEVERIDAD_CLAVE: Record<SeveridadAnomalia, Clave> = { alta: "despachos.resumen.severidad.alta", media: "despachos.resumen.severidad.media", baja: "despachos.resumen.severidad.baja" };
const FUENTE_CLAVE: Record<FuenteDashboard, Clave> = {
  cartera: "despachos.resumen.fuente.cartera",
  revisiones: "despachos.resumen.fuente.revisiones",
  vencimientos: "despachos.resumen.fuente.vencimientos",
  cierre: "despachos.resumen.fuente.cierre",
  cfdi: "despachos.resumen.fuente.cfdi",
};
const CIERRE_CLAVE: Record<"cerrado" | "abierto" | "vencido" | "sin_periodo", Clave> = {
  cerrado: "despachos.resumen.cierre.cerrado",
  abierto: "despachos.resumen.cierre.abierto",
  vencido: "despachos.resumen.cierre.vencido",
  sin_periodo: "despachos.resumen.cierre.sinPeriodo",
};
/** Saludo de la franja horaria de Mexico (`saludoDespacho`) en el idioma activo. */
const SALUDO_CLAVE: Record<ReturnType<typeof saludoDespacho>, Clave> = {
  "Buenos días": "despachos.resumen.saludo.manana",
  "Buenas tardes": "despachos.resumen.saludo.tarde",
  "Buenas noches": "despachos.resumen.saludo.noche",
};

export function NivelBadge({ nivel }: { nivel: NivelAtencion }) {
  return <StatusBadge tone={statusTone(NIVEL_ATENCION_TONES, nivel)}>{tr(NIVEL_CLAVE[nivel])}</StatusBadge>;
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
      {ligado(`${base}/cartera`, <StatCard icon={Users} label={tr("despachos.resumen.kpi.clientes")} value={String(d.totalClientes)} nota={tr("despachos.resumen.kpi.clientesNota", { criticos: d.clientesPorNivel.critico, atencion: d.clientesPorNivel.atencion })} />)}
    </div>,
    <div key="vencida" className="min-w-0">
      {ligado(
        `${base}/cobranza`,
        <StatCard
          icon={AlertTriangle}
          label={tr("despachos.resumen.kpi.vencida")}
          value={cartera ? formatMoney(cartera.montoVencido) : ""}
          nota={cartera ? tr("despachos.resumen.kpi.vencidaNota", { monto: formatMoney(cartera.monto90Mas) }) : undefined}
          sinDato={cartera ? undefined : tr("despachos.resumen.sinCartera")}
        />,
      )}
    </div>,
    <div key="tasa" className="min-w-0">
      {ligado(
        `${base}/cobranza`,
        <StatCard
          icon={HandCoins}
          label={tr("despachos.resumen.kpi.tasa")}
          value={cartera ? formatPct(cartera.tasaCobranzaPct) : ""}
          nota={cartera ? tr("despachos.resumen.kpi.tasaNota", { monto: formatMoney(cartera.montoCobrado) }) : undefined}
          sinDato={cartera?.tasaCobranzaPct === null || !cartera ? tr("despachos.resumen.kpi.tasaSinDato") : undefined}
        />,
      )}
    </div>,
    <div key="pendientes" className="min-w-0">
      {ligado(
        `${base}/vencimientos`,
        <StatCard
          icon={ClipboardList}
          label={tr("despachos.resumen.kpi.pendientes")}
          value={cargaTrabajo ? String(cargaTrabajo.totalPendientes) : ""}
          nota={cargaTrabajo ? tr("despachos.resumen.kpi.pendientesNota", { revisiones: cargaTrabajo.revisionesPendientes, vencimientos: cargaTrabajo.vencimientosAbiertos, tareas: cargaTrabajo.tareasCierrePendientes }) : undefined}
          sinDato={cargaTrabajo ? undefined : tr("despachos.resumen.kpi.pendientesSinDato")}
        />,
      )}
    </div>,
    <div key="cierres" className="min-w-0">
      {ligado(
        `${base}/cierre-mensual`,
        <StatCard
          icon={CalendarCheck}
          label={tr("despachos.resumen.kpi.cierres")}
          value={cierres ? String(cierres.periodosSinCerrar) : ""}
          nota={cierres ? tr("despachos.resumen.kpi.cierresNota", { vencidos: cierres.periodosVencidos, clientes: cierres.clientesMesAnteriorSinCerrar }) : undefined}
          sinDato={cierres ? undefined : tr("despachos.resumen.cierreNoDisponible")}
        />,
      )}
    </div>,
    <div key="anomalias" className="min-w-0">
      <StatCard icon={ShieldAlert} label={tr("despachos.resumen.kpi.anomalias")} value={String(total)} nota={tr("despachos.resumen.kpi.anomaliasNota", { alta: d.anomaliasPorSeveridad.alta, media: d.anomaliasPorSeveridad.media, baja: d.anomaliasPorSeveridad.baja })} />
    </div>,
    <div key="cfdi" className="min-w-0">
      {ligado(
        `${base}/cfdi`,
        <StatCard
          icon={FileText}
          label={tr("despachos.resumen.kpi.cfdi")}
          value={cfdi ? String(cfdi.total) : ""}
          nota={cfdi ? tr("despachos.resumen.kpi.cfdiNota", { periodo: formatPeriodo(Number(cfdi.periodo.slice(0, 4)), Number(cfdi.periodo.slice(5, 7))), clientes: cfdi.clientes }) : undefined}
          sinDato={cfdi ? undefined : tr("despachos.resumen.kpi.cfdiSinDato")}
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
        {tr("despachos.resumen.sinAnomalias")}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {anomalias.map((a) => (
        <li key={a.codigo} className="flex items-start gap-2 text-sm text-foreground">
          <StatusBadge tone={statusTone(SEVERIDAD_ANOMALIA_TONES, a.severidad)} className="shrink-0">
            {tr(SEVERIDAD_CLAVE[a.severidad])}
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
  const t = useT(despachosResumen);
  const { cartera, cargaTrabajo, cierres, cfdiMes } = cliente;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold text-foreground">{t("despachos.resumen.clienteActivo", { nombre: cliente.nombre })}</h2>
          <NivelBadge nivel={cliente.nivelAtencion} />
        </div>
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(190px,1fr))]">
          <StatCard
            icon={Wallet}
            label={t("despachos.resumen.carteraPendiente")}
            value={cartera ? formatMoney(cartera.montoPendiente) : ""}
            nota={cartera ? t("despachos.resumen.carteraPendienteNota", { cuentas: cartera.cuentasPendientes, score: cartera.scorePromedio ?? "—" }) : undefined}
            sinDato={cartera ? undefined : tr("despachos.resumen.sinCartera")}
          />
          <StatCard
            icon={ClipboardList}
            label={t("despachos.resumen.cargaTrabajo")}
            value={cargaTrabajo ? String(cargaTrabajo.totalPendientes) : ""}
            nota={cargaTrabajo ? t("despachos.resumen.cargaTrabajoNota", { n: cargaTrabajo.vencimientosVencidos ?? 0 }) : undefined}
            sinDato={cargaTrabajo ? undefined : t("despachos.resumen.cargaTrabajoSinDato")}
          />
          <StatCard
            icon={CalendarCheck}
            label={t("despachos.resumen.cierreMesAnterior")}
            value={cierres ? t(CIERRE_CLAVE[cierres.mesAnterior.estado]) : ""}
            nota={cierres ? formatPeriodo(cierres.mesAnterior.year, cierres.mesAnterior.month) : undefined}
            sinDato={cierres ? undefined : tr("despachos.resumen.cierreNoDisponible")}
          />
          <StatCard
            icon={ClipboardList}
            label={t("despachos.resumen.cfdiDe", { periodo: cfdiMes?.periodo ?? t("despachos.resumen.elMes") })}
            value={cfdiMes ? String(cfdiMes.total) : ""}
            nota={cfdiMes ? t("despachos.resumen.cfdiClienteNota", { invalidos: cfdiMes.invalidos, revisar: cfdiMes.requierenRevision }) : undefined}
            sinDato={cfdiMes ? undefined : t("despachos.resumen.cfdiClienteSinDato")}
          />
        </div>
        <ListaAnomalias anomalias={cliente.anomalias} />
      </CardContent>
    </Card>
  );
}

export function DashboardPage({ apiBaseUrl, token, orgSlug, propertyId, role, staffFullName, staffEmail }: DespachosShellContext) {
  const t = useT(despachosResumen);
  const [data, setData] = useState<DashboardDespacho | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchDashboardDespacho(fetch, apiBaseUrl, token, orgSlug));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("despachos.resumen.errorCarga"));
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
        {loading && !data && <EstadoCargando etiqueta={t("despachos.resumen.cargando")} />}
        {data && <EstadoVacio mensaje={t("despachos.resumen.vacio")} />}
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
        etiqueta={t("despachos.resumen.carteraPendiente")}
        sinDato={t("despachos.resumen.carteraSinDato")}
        tamano="md"
      />
      {/* El odómetro se oculta bajo `sm` (como en Likida): en móvil la cifra viaja en una línea. */}
      <p className="ds3-resumen-movil text-ui text-muted-foreground sm:hidden">
        {t("despachos.resumen.carteraPendiente")} <span className="font-medium tabular-nums text-foreground">{cartera ? formatMoney(cartera.montoPendiente) : "—"}</span>
      </p>
    </div>
  );

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={t(SALUDO_CLAVE[saludoDespacho()])}
        nombre={primerNombreOCorreo(staffFullName, staffEmail)}
        subtitulo={t("despachos.resumen.subtitulo", { organizacion: data.organizacion.nombre, n: data.totalClientes })}
        frase={
          cartera ? (
            <>
              {t("despachos.resumen.frase", { organizacion: data.organizacion.nombre, n: data.totalClientes })}<strong>{formatMoney(cartera.montoPendiente)}</strong>.
            </>
          ) : undefined
        }
        destacado={destacado}
        kpis={kpisResumen(data, base)}
        acciones={
          <>
            <PillLink to={`${base}/cobranza`}>{t("despachos.resumen.verCobranza")}</PillLink>
            <PillLink to={`${base}/cierre-mensual`}>{t("despachos.resumen.verCierre")}</PillLink>
          </>
        }
      >
        {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
        {data.fuentesNoDisponibles.length > 0 && (
          <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {t("despachos.resumen.fuentesNoDisponibles", { fuentes: data.fuentesNoDisponibles.map((f) => t(FUENTE_CLAVE[f])).join(", ") })}
          </p>
        )}
        {data.truncado && (
          <p role="status" className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {t("despachos.resumen.truncado", { n: data.totalClientes, total: data.totalClientesVisibles })}
          </p>
        )}

        <ResumenSeccion titulo={t("despachos.resumen.orquestacion")}>
          <TileLink
            to={`${base}/cola-cobranza`}
            icon={HandCoins}
            titulo={t("despachos.resumen.recordatorios")}
            descripcion={cartera ? t("despachos.resumen.recordatoriosNota", { n: cartera.cuentasPendientes }) : undefined}
          />
          <TileLink to={`${base}/cfdi`} icon={ShieldCheck} titulo={t("despachos.resumen.lista69b")} />
          <TileLink to={`${base}/conciliacion`} icon={Landmark} titulo={t("despachos.resumen.conciliacion")} />
          {COPILOTO_DESPACHOS_ROLES.has(role) && <TileLink to={`${base}/copiloto`} icon={Sparkles} titulo={t("despachos.resumen.copiloto")} descripcion={t("despachos.resumen.copilotoNota")} />}
        </ResumenSeccion>
        <ResumenSeccion titulo={t("despachos.resumen.ultimaCorrida")}>
          <EstadoVacio
            icon={Bot}
            compacto
            className="col-span-full"
            titulo={t("despachos.resumen.sinCorridas")}
            mensaje={t("despachos.resumen.sinCorridasMensaje")}
          />
        </ResumenSeccion>

        {activo && <DetalleCliente cliente={activo} />}

        <DataTable
          etiqueta={t("despachos.resumen.tabla.etiqueta")}
          obtenerId={(c) => c.propertyId}
          filas={data.ranking}
          paginacion={false}
          columnas={[
            { id: "cliente", encabezado: t("despachos.resumen.tabla.cliente"), principal: true, celda: (c) => <span className="font-medium">{c.nombre}</span> },
            { id: "atencion", encabezado: t("despachos.resumen.tabla.atencion"), celda: (c) => <NivelBadge nivel={c.nivelAtencion} /> },
            { id: "cartera", encabezado: t("despachos.resumen.tabla.cartera"), celda: (c) => <span className="tabular-nums text-muted-foreground">{c.cartera ? formatMoney(c.cartera.montoVencido) : t("despachos.resumen.sinDato")}</span> },
            { id: "cobranza", encabezado: t("despachos.resumen.tabla.cobranza"), celda: (c) => <span className="tabular-nums text-muted-foreground">{c.cartera ? formatPct(c.cartera.tasaCobranzaPct) : t("despachos.resumen.sinDato")}</span> },
            { id: "pendientes", encabezado: t("despachos.resumen.tabla.pendientes"), celda: (c) => <span className="tabular-nums text-muted-foreground">{c.cargaTrabajo ? c.cargaTrabajo.totalPendientes : t("despachos.resumen.sinDato")}</span> },
            {
              id: "cierre",
              encabezado: t("despachos.resumen.tabla.cierre"),
              celda: (c) => (
                <span className="text-muted-foreground">
                  {c.cierres ? t(CIERRE_CLAVE[c.cierres.mesAnterior.estado]) : t("despachos.resumen.sinDato")}
                </span>
              ),
            },
            { id: "anomalias", encabezado: t("despachos.resumen.tabla.anomalias"), className: "min-w-64", celda: (c) => <ListaAnomalias anomalias={c.anomalias} /> },
          ]}
        />
        <DespachosFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
      </ResumenLayout>
    </PageContainer>
  );
}

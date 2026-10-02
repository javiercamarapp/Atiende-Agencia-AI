// Resumen de restaurantes (landing del panel, ruta /restaurantes/:orgSlug): la composicion del Resumen de Likida con las
// piezas de @atiende/ui (ResumenLayout, StatCard de dos capas, PillLink, ResumenSeccion/TileLink, AgentRunCard).
// Vive DENTRO de RestaurantesShell: sesion y sucursal las resuelve el Shell; aqui solo se consume el contexto.
//
// TODO numero sale de un endpoint real: /admin/kpis/{sales,sales/trend,channels,customers} (los fetch de siempre, en
// dashboard-client.ts). Sin dato = "—"; el delta solo existe con periodo comparable ("sin periodo comparable" si no hay
// base, nunca un "0 %" inventado). Lo complementario (zona horaria de la sucursal, KPI de voz, bandeja de conversaciones)
// se pide aparte y es "best effort": si falla o la base aun no tiene esa migracion, el bloque se muestra sin metrica y el
// resto del Resumen no se afecta. "Horas de atencion ahorradas" NO se pinta: el endpoint la estima con un supuesto fijo
// (~5 min por pedido), no la mide, y un rotulo tiene que ser verdad.
// El rol repartidor no tiene Resumen: el Shell ya lo manda a /repartidor; aqui se repite como defensa en profundidad.
import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  AgentRunCard,
  Button,
  Card,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Odometro,
  PageContainer,
  PillLink,
  RadioSegmentado,
  ResumenLayout,
  ResumenSeccion,
  SectionLabel,
  StatCard,
  TileLink,
} from "@atiende/ui";
import {
  Bot,
  ClipboardList,
  DollarSign,
  HandHelping,
  MessageCircle,
  Mic,
  Receipt,
  RefreshCw,
  Repeat,
  Sparkles,
} from "lucide-react";
import {
  fetchDashboardData,
  formatInt,
  formatMoney,
  PERIOD_OPTIONS,
} from "../dashboard-client.ts";
import type { DashboardData, StatsPeriod } from "../dashboard-client.ts";
import { fetchBranchTimezone } from "../lib/config-client.ts";
import { fetchBandeja } from "../lib/conversaciones-client.ts";
import { fetchVozKpi } from "../lib/voz-kpi-client.ts";
import type { VozKpi } from "../lib/voz-kpi-client.ts";
import {
  actividadMasReciente,
  cuandoEnZona,
  deltaDe,
  saludoEnZona,
} from "../lib/resumen-formato.ts";
import { primerNombreOCorreo } from "../../../lib/greeting.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

/** Roles con Copiloto (= COPILOTO_ROLES del Shell): la pildora solo se pinta a quien el servidor deja entrar. */
const ROLES_COPILOTO: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "staff",
]);

/** Roles con la pantalla "Agente de voz" (= STAFF_NAV_ROLES del Shell): el tile solo se pinta a quien puede abrirla. */
const ROLES_VOZ: ReadonlySet<string> = new Set(["owner", "admin"]);

/** Datos complementarios (best effort): cada campo `null` = no disponible, el bloque se pinta sin metrica. */
interface Extras {
  readonly zona: string | null;
  readonly voz: VozKpi | null;
  readonly pendientes: number | null;
  readonly ultimaWhatsapp: string | null;
  readonly ultimaVoz: string | null;
}

const EXTRAS_VACIOS: Extras = {
  zona: null,
  voz: null,
  pendientes: null,
  ultimaWhatsapp: null,
  ultimaVoz: null,
};

async function cargarExtras(
  apiBaseUrl: string,
  token: string,
  propertyId: string,
): Promise<Extras> {
  const [tz, voz, pend, wa, vz] = await Promise.allSettled([
    fetchBranchTimezone(fetch, apiBaseUrl, token, propertyId),
    fetchVozKpi(fetch, apiBaseUrl, token, propertyId),
    fetchBandeja(fetch, apiBaseUrl, token, propertyId, { estado: "pendiente" }),
    fetchBandeja(fetch, apiBaseUrl, token, propertyId, { canal: "whatsapp" }),
    fetchBandeja(fetch, apiBaseUrl, token, propertyId, { canal: "voz" }),
  ]);
  const bandeja = (
    r: PromiseSettledResult<Awaited<ReturnType<typeof fetchBandeja>>>,
  ) =>
    r.status === "fulfilled" && r.value.disponible !== false ? r.value : null;
  const bPend = bandeja(pend);
  const bWa = bandeja(wa);
  const bVz = bandeja(vz);
  return {
    zona: tz.status === "fulfilled" ? tz.value.zonaHoraria : null,
    voz: voz.status === "fulfilled" ? voz.value : null,
    pendientes: bPend ? bPend.total : null,
    ultimaWhatsapp: bWa ? actividadMasReciente(bWa.items) : null,
    ultimaVoz: bVz ? actividadMasReciente(bVz.items) : null,
  };
}

/** Sparkline SVG inline simple: no se agrega una libreria de graficas solo para dos mini-graficas. */
function Sparkline({
  points,
  className,
}: {
  points: readonly number[];
  className: string;
}) {
  const width = 320;
  const height = 64;
  if (points.length === 0) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map(
    (v, i) =>
      `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`,
  );
  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Tendencia"
      className={className}
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        points={coords.join(" ")}
      />
    </svg>
  );
}

function plural(n: number, uno: string, varios: string): string {
  return `${formatInt(n)} ${n === 1 ? uno : varios}`;
}

export function RestaurantesDashboardPage({
  apiBaseUrl,
  token,
  propertyId,
  orgSlug,
  role,
  staffFullName,
  staffEmail,
}: RestaurantesShellContext) {
  const [period, setPeriod] = useState<StatsPeriod>("30");
  const [data, setData] = useState<DashboardData | null>(null);
  const [extras, setExtras] = useState<Extras>(EXTRAS_VACIOS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(
    async (p: StatsPeriod) => {
      setLoading(true);
      setError(null);
      try {
        const [result, ex] = await Promise.all([
          fetchDashboardData(fetch, apiBaseUrl, token, propertyId, p),
          cargarExtras(apiBaseUrl, token, propertyId),
        ]);
        setData(result);
        setExtras(ex);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "No se pudieron cargar los KPIs.",
        );
      } finally {
        setLoading(false);
      }
    },
    [apiBaseUrl, token, propertyId],
  );

  useEffect(() => {
    if (role === "repartidor") return;
    void cargar(period);
  }, [cargar, period, role]);

  const base = `/restaurantes/${orgSlug}`;
  // El repartidor no tiene Resumen (el Shell ya lo redirige): defensa en profundidad si se monta la pagina suelta.
  if (role === "repartidor")
    return <Navigate to={`${base}/repartidor`} replace />;

  const selector = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <RadioSegmentado
        name="resumen-periodo"
        label="Periodo"
        opciones={PERIOD_OPTIONS.map((o) => ({ id: o.id, rotulo: o.label }))}
        value={period}
        onChange={setPeriod}
        className="justify-end gap-1.5"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        loading={loading}
        onClick={() => void cargar(period)}
        iconLeft={<RefreshCw />}
      >
        Actualizar
      </Button>
    </div>
  );

  if (error !== null) {
    return (
      <PageContainer padding="none" size="xl" className="gap-2.5 [&>*]:min-w-0">
        <EstadoError mensaje={error} onReintentar={() => void cargar(period)} />
      </PageContainer>
    );
  }
  if (data === null) {
    return (
      <PageContainer padding="none" size="xl" className="gap-2.5 [&>*]:min-w-0">
        <EstadoCargando variante="tarjeta" etiqueta="Cargando panel…" />
      </PageContainer>
    );
  }

  const { sales, channels, customers, trend } = data;
  const historico = period === "historico";
  const nombre = primerNombreOCorreo(staffFullName, staffEmail);
  const periodoCanales = channels.periodo.etiqueta;
  const pedidosIa = channels.voice.orders + channels.whatsapp.orders;
  const ingresosIa = channels.voice.revenue + channels.whatsapp.revenue;
  const deltaNota = sales.periodLabel;

  const kpis = [
    <StatCard
      key="ordenes"
      variante="neutra"
      icon={ClipboardList}
      label="Número de órdenes"
      value={formatInt(sales.orders)}
      delta={historico ? undefined : deltaDe(sales.ordersChangePct)}
      deltaNota={deltaNota}
      nota={historico ? sales.periodLabel : undefined}
    />,
    <StatCard
      key="promedio"
      variante="neutra"
      icon={Receipt}
      label="Valor promedio"
      value={formatMoney(sales.averageOrder)}
      delta={historico ? undefined : deltaDe(sales.avgOrderChangePct)}
      deltaNota={deltaNota}
      nota={historico ? sales.periodLabel : undefined}
    />,
    <StatCard
      key="pedidos-ia"
      variante="neutra"
      icon={Bot}
      label="Pedidos por agentes IA"
      value={formatInt(pedidosIa)}
      nota={
        channels.aiAdoptionPct === null
          ? `Voz y WhatsApp · ${periodoCanales}`
          : `${channels.aiAdoptionPct.toFixed(0)}% de los pedidos · ${periodoCanales}`
      }
    />,
    <StatCard
      key="ingresos-ia"
      variante="neutra"
      icon={Sparkles}
      label="Ingresos por agentes IA"
      value={formatMoney(ingresosIa)}
      nota={`Voz y WhatsApp, sin cancelados · ${periodoCanales}`}
    />,
    <StatCard
      key="whatsapp"
      variante="neutra"
      icon={MessageCircle}
      label="Pedidos por WhatsApp"
      value={formatInt(channels.whatsapp.orders)}
      nota={periodoCanales}
    />,
    <StatCard
      key="voz"
      variante="neutra"
      icon={Mic}
      label="Pedidos por voz"
      value={formatInt(channels.voice.orders)}
      nota={periodoCanales}
    />,
    <StatCard
      key="recurrentes"
      variante="neutra"
      icon={Repeat}
      label="Clientes recurrentes"
      value={
        customers.recurringCustomerPct === null
          ? "—"
          : `${customers.recurringCustomerPct.toFixed(0)}%`
      }
      sinDato={
        customers.recurringCustomerPct === null
          ? "Aún no hay pedidos vinculados a clientes"
          : undefined
      }
      nota="de quienes ya pidieron al menos una vez"
    />,
  ];

  const saludo = saludoEnZona(new Date(), extras.zona);
  const destacado = (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro
        valor={sales.revenue}
        digitos={5}
        prefijo="$"
        etiqueta="Ventas netas"
        tamano="md"
      />
      <p className="text-ui text-muted-foreground sm:hidden">
        Ventas netas{" "}
        <span className="font-medium tabular-nums text-foreground">
          {formatMoney(sales.revenue)}
        </span>
      </p>
      {selector}
    </div>
  );

  const vozHoy = extras.voz?.diaDeHoy.llamadas;
  const ultimaWa = extras.ultimaWhatsapp
    ? cuandoEnZona(extras.ultimaWhatsapp, extras.zona)
    : null;
  const ultimaVz = extras.ultimaVoz
    ? cuandoEnZona(extras.ultimaVoz, extras.zona)
    : null;

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        saludo={saludo}
        nombre={nombre}
        subtitulo={`${orgSlug} · ${PERIOD_OPTIONS.find((o) => o.id === period)?.label ?? period}`}
        destacado={destacado}
        kpis={kpis}
        acciones={
          <>
            <PillLink to={`${base}/pedidos`}>Ver pedidos</PillLink>
            <PillLink to={`${base}/historial`}>Ver historial</PillLink>
            {ROLES_COPILOTO.has(role) && (
              <PillLink to={`${base}/copiloto`}>Pregunta a tus datos</PillLink>
            )}
          </>
        }
      >
        <ResumenSeccion titulo="Orquestación de agentes">
          <TileLink
            to={`${base}/conversaciones`}
            icon={MessageCircle}
            titulo="WhatsApp"
            descripcion={`${plural(channels.whatsappConversations.total, "conversación", "conversaciones")} · ${formatInt(channels.whatsappConversations.withOrder)} con pedido · ${periodoCanales}`}
          />
          {ROLES_VOZ.has(role) && (
            <TileLink
              to={`${base}/agente-voz`}
              icon={Mic}
              titulo="Voz"
              descripcion={
                vozHoy === undefined
                  ? "Atención por llamada"
                  : `${plural(vozHoy, "llamada", "llamadas")} hoy · ${plural(extras.voz!.mes.llamadas, "llamada", "llamadas")} en el mes`
              }
            />
          )}
          <TileLink
            to={`${base}/conversaciones`}
            icon={HandHelping}
            titulo="Toma humana"
            descripcion={
              extras.pendientes === null
                ? "Conversaciones que atiende una persona"
                : extras.pendientes === 0
                  ? "Ninguna conversación esperando a una persona"
                  : `${plural(extras.pendientes, "conversación espera", "conversaciones esperan")} a una persona`
            }
          />
        </ResumenSeccion>

        <Card
          className="p-3"
          role="region"
          aria-labelledby="resumen-ultima-corrida"
        >
          <SectionLabel id="resumen-ultima-corrida">
            Agentes — última corrida
          </SectionLabel>
          <div className="mt-2">
            {ultimaWa === null && ultimaVz === null ? (
              <EstadoVacio
                compacto
                titulo="Sin bitácora de corridas"
                mensaje="Aún no existe una bitácora de corridas de los agentes, ni hay conversaciones recientes que mostrar. Aparecerán aquí en cuanto el agente atienda una."
              />
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {ultimaWa !== null && (
                  <AgentRunCard
                    nombre="Agente de WhatsApp"
                    meta={`Última conversación: ${ultimaWa}`}
                    href={`${base}/conversaciones`}
                  />
                )}
                {ultimaVz !== null && (
                  <AgentRunCard
                    nombre="Agente de voz"
                    meta={`Última llamada: ${ultimaVz}`}
                    href={`${base}/conversaciones`}
                  />
                )}
              </div>
            )}
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
          <Card className="p-3">
            <SectionLabel>Ventas ($)</SectionLabel>
            <div className="mt-2">
              <Sparkline
                points={trend.map((p) => p.revenue)}
                className="text-foreground"
              />
            </div>
          </Card>
          <Card className="p-3">
            <SectionLabel>Órdenes</SectionLabel>
            <div className="mt-2">
              <Sparkline
                points={trend.map((p) => p.orders)}
                className="text-foreground"
              />
            </div>
          </Card>
        </div>
      </ResumenLayout>
    </PageContainer>
  );
}

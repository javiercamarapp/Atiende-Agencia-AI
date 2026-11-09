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
import { RestaurantesFijadosCopiloto } from "./Copiloto.tsx";
import { GraficaTendencia } from "../components/GraficaTendencia.tsx";
import { Navigate } from "react-router-dom";
import {
  AgentRunCard,
  Button,
  Card,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  FormDialog,
  FormField,
  Input,
  notify,
  Odometro,
  PageContainer,
  PillLink,
  RadioSegmentado,
  ResumenLayout,
  ResumenSeccion,
  type ResumenAtencionItem,
  type ResumenEstadoDato,
  SectionLabel,
  StatCard,
  TileLink,
  useI18n,
} from "@atiende/ui";
import { restaurantesResumen } from "@atiende/ui/i18n/restaurantes/resumen";
import {
  Bot,
  Clock,
  Settings2,
  ClipboardList,
  Package,
  Tag,
  Users,
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
import { fetchCategories, fetchProducts } from "../lib/catalog-client.ts";
import { fetchResumenConfig, guardarResumenConfig, horasAhorradas } from "../lib/resumen-config-client.ts";
import type { ResumenConfigVista } from "../lib/resumen-config-client.ts";
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

/** «Tu operacion»: conteos del catalogo de la ORGANIZACION (el catalogo es de toda la organizacion; la disponibilidad y el precio son por sucursal). `null` = no se pudo leer (el tile lo dice, no inventa un 0). Cada conteo falla por separado. */
interface ConteosCatalogo {
  readonly productos: number | null;
  readonly categorias: number | null;
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

/** Marca del eje Y: pesos enteros con separador de miles (sin centavos, el eje no los necesita). */
function formatMoneyCorto(v: number): string {
  return `$${formatInt(Math.round(v))}`;
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
  const { t, idioma } = useI18n(restaurantesResumen);
  const [period, setPeriod] = useState<StatsPeriod>("30");
  const [data, setData] = useState<DashboardData | null>(null);
  const [extras, setExtras] = useState<Extras>(EXTRAS_VACIOS);
  /** Configuracion del Resumen (096): `undefined` = cargando, `null` = no se pudo leer. Se lee UNA vez por montaje (no depende del periodo). */
  const [resumenCfg, setResumenCfg] = useState<ResumenConfigVista | null | undefined>(undefined);
  const [catalogo, setCatalogo] = useState<ConteosCatalogo | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [configAbierta, setConfigAbierta] = useState(false);
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
            : t("restaurantes.resumen.errorKpis"),
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

  // El catalogo se cuenta UNA vez por montaje (y si cambia la sucursal): `GET admin/products` resuelve el estado por producto y no tiene por que repetirse
  // en cada cambio de periodo ni en «Actualizar», que no lo afectan.
  useEffect(() => {
    if (role === "repartidor") return undefined;
    let vivo = true;
    void Promise.allSettled([fetchProducts(fetch, apiBaseUrl, token, propertyId), fetchCategories(fetch, apiBaseUrl, token, propertyId)]).then(([prods, cats]) => {
      if (!vivo) return;
      setCatalogo({
        productos: prods.status === "fulfilled" ? prods.value.length : null,
        categorias: cats.status === "fulfilled" ? cats.value.length : null,
      });
    });
    return () => {
      vivo = false;
    };
  }, [apiBaseUrl, token, propertyId, role]);

  // La configuracion de horas y metas es de toda la organizacion y no cambia con el periodo ni con «Actualizar»: se lee UNA vez por montaje (y si cambia la
  // sucursal), igual que el catalogo. «Reintentar» del tile la vuelve a pedir.
  const cargarCfg = useCallback(async () => {
    setResumenCfg(undefined);
    try {
      setResumenCfg(await fetchResumenConfig(fetch, apiBaseUrl, token, propertyId));
    } catch {
      setResumenCfg(null);
    }
  }, [apiBaseUrl, token, propertyId]);

  useEffect(() => {
    if (role === "repartidor") return;
    void cargarCfg();
  }, [cargarCfg, role]);

  const base = `/restaurantes/${orgSlug}`;
  // El repartidor no tiene Resumen (el Shell ya lo redirige): defensa en profundidad si se monta la pagina suelta.
  if (role === "repartidor")
    return <Navigate to={`${base}/repartidor`} replace />;

  const selector = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <RadioSegmentado
        name="resumen-periodo"
        label={t("restaurantes.resumen.periodo")}
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
        {t("restaurantes.resumen.actualizar")}
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
        <EstadoCargando variante="tarjeta" etiqueta={t("restaurantes.resumen.cargando")} />
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

  const metaPedidos = resumenCfg?.config.metaPedidosIaPct ?? null;
  const metaIngresos = resumenCfg?.config.metaIngresosIaPct ?? null;
  const minutos = resumenCfg?.config.minutosPorConversacion ?? null;
  const conversaciones = channels.whatsappConversations.total;
  const horas = horasAhorradas(conversaciones, minutos);
  const puedeConfigurar = ROLES_VOZ.has(role);

  const kpis = [
    <StatCard
      key="ordenes"
      variante="neutra"
      icon={ClipboardList}
      label={t("restaurantes.resumen.kpi.ordenes")}
      value={formatInt(sales.orders)}
      delta={historico ? undefined : deltaDe(sales.ordersChangePct)}
      deltaNota={deltaNota}
      nota={historico ? sales.periodLabel : undefined}
    />,
    <StatCard
      key="promedio"
      variante="neutra"
      icon={Receipt}
      label={t("restaurantes.resumen.kpi.promedio")}
      value={formatMoney(sales.averageOrder)}
      delta={historico ? undefined : deltaDe(sales.avgOrderChangePct)}
      deltaNota={deltaNota}
      nota={historico ? sales.periodLabel : undefined}
    />,
    <StatCard
      key="pedidos-ia"
      variante="neutra"
      icon={Bot}
      label={t("restaurantes.resumen.kpi.pedidosIa")}
      value={formatInt(pedidosIa)}
      nota={`${
        channels.aiAdoptionPct === null
          ? t("restaurantes.resumen.kpi.pedidosIaNotaSinPct", { periodo: periodoCanales })
          : t("restaurantes.resumen.kpi.pedidosIaNotaPct", { pct: channels.aiAdoptionPct.toFixed(0), periodo: periodoCanales })
      }${metaPedidos === null ? "" : t("restaurantes.resumen.kpi.tuMeta", { meta: metaPedidos })}`}
    />,
    <StatCard
      key="ingresos-ia"
      variante="neutra"
      icon={Sparkles}
      label={t("restaurantes.resumen.kpi.ingresosIa")}
      value={formatMoney(ingresosIa)}
      nota={`${t("restaurantes.resumen.kpi.ingresosIaNota", { periodo: periodoCanales })}${metaIngresos === null ? "" : t("restaurantes.resumen.kpi.tuMeta", { meta: metaIngresos })}`}
    />,
    <StatCard
      key="whatsapp"
      variante="neutra"
      icon={MessageCircle}
      label={t("restaurantes.resumen.kpi.whatsapp")}
      value={formatInt(channels.whatsapp.orders)}
      nota={periodoCanales}
    />,
    <StatCard
      key="voz"
      variante="neutra"
      icon={Mic}
      label={t("restaurantes.resumen.kpi.voz")}
      value={formatInt(channels.voice.orders)}
      nota={periodoCanales}
    />,
    <StatCard
      key="recurrentes"
      variante="neutra"
      icon={Repeat}
      label={t("restaurantes.resumen.kpi.recurrentes")}
      value={
        customers.recurringCustomerPct === null
          ? "—"
          : `${customers.recurringCustomerPct.toFixed(0)}%`
      }
      sinDato={
        customers.recurringCustomerPct === null
          ? t("restaurantes.resumen.kpi.recurrentesSinDato")
          : undefined
      }
      nota={t("restaurantes.resumen.kpi.recurrentesNota")}
    />,
  ];

  const saludo = saludoEnZona(new Date(), extras.zona);
  const destacado = (
    <div className="flex min-w-0 flex-col items-end gap-2.5">
      <Odometro
        valor={sales.revenue}
        digitos={5}
        prefijo="$"
        etiqueta={t("restaurantes.resumen.ventasNetas")}
        tamano="md"
      />
      <p className="ds3-resumen-movil text-ui text-muted-foreground sm:hidden">
        {t("restaurantes.resumen.ventasNetas")}{" "}
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

  const etiquetaPeriodo = PERIOD_OPTIONS.find((o) => o.id === period)?.label ?? period;
  // ds3: franja de estado de los datos (Rovaq «Fuentes con datos · Datos hasta»). Solo lo que la API ya devolvio; lo que no se pudo leer no
  // se pinta (nunca un valor inventado).
  const estadoDatos: ResumenEstadoDato[] = [
    { etiqueta: t("restaurantes.resumen.periodo"), valor: etiquetaPeriodo },
    ...(ultimaWa ? [{ etiqueta: t("restaurantes.resumen.estado.ultimoWhatsapp"), valor: ultimaWa }] : []),
    ...(ultimaVz ? [{ etiqueta: t("restaurantes.resumen.estado.ultimaLlamada"), valor: ultimaVz }] : []),
    ...(extras.zona ? [{ etiqueta: t("restaurantes.resumen.estado.zona"), valor: extras.zona }] : []),
  ];
  // ds3: «Requiere tu atención». Sin la bandeja (null) la pagina no sabe y el bloque no se pinta; con ella, 0 pendientes = «nada pendiente».
  const atencion: ResumenAtencionItem[] | undefined =
    extras.pendientes === null
      ? undefined
      : extras.pendientes === 0
        ? []
        : [
            {
              id: "toma-humana",
              titulo: t("restaurantes.resumen.tomaHumanaEsperan", { count: extras.pendientes, n: formatInt(extras.pendientes) }),
              detalle: t("restaurantes.resumen.atencion.tomaHumanaDetalle"),
              to: `${base}/conversaciones`,
              tono: "alto",
            },
          ];

  return (
    <PageContainer padding="none" size="xl" className="[&>*]:min-w-0">
      <ResumenLayout
        estadoDatos={estadoDatos}
        atencion={atencion}
        saludo={saludo}
        eyebrow={t("restaurantes.resumen.eyebrow")}
        nombre={nombre}
        subtitulo={`${orgSlug} · ${PERIOD_OPTIONS.find((o) => o.id === period)?.label ?? period}`}
        frase={
          <>
            {t("restaurantes.resumen.frase", { periodo: PERIOD_OPTIONS.find((o) => o.id === period)?.label ?? period })}<strong>{formatMoney(sales.revenue)}</strong>.
          </>
        }
        destacado={destacado}
        kpis={kpis}
        acciones={
          <>
            <PillLink to={`${base}/pedidos`}>{t("restaurantes.resumen.verPedidos")}</PillLink>
            <PillLink to={`${base}/historial`}>{t("restaurantes.resumen.verHistorial")}</PillLink>
          </>
        }
      >
        <Card className="p-3" role="region" aria-labelledby="resumen-tendencias">
          <SectionLabel id="resumen-tendencias">{t("restaurantes.resumen.tendencias")}</SectionLabel>
          <div className="mt-2 grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            <Card className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="size-3 rounded-full bg-primary" />
                <span className="text-ui font-medium text-foreground">{t("restaurantes.resumen.ventasSerie")}</span>
              </div>
              <GraficaTendencia
                puntos={trend.map((p) => ({ etiqueta: p.label, valor: p.revenue }))}
                etiquetaSerie={t("restaurantes.resumen.ventasSerie")}
                formatoValor={(v) => formatMoneyCorto(v)}
              />
            </Card>
            <Card className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="size-3 rounded-full bg-secondary" />
                <span className="text-ui font-medium text-foreground">{t("restaurantes.resumen.ordenesSerie")}</span>
              </div>
              <GraficaTendencia
                puntos={trend.map((p) => ({ etiqueta: p.label, valor: p.orders }))}
                etiquetaSerie={t("restaurantes.resumen.ordenesSerie")}
                formatoValor={(v) => formatInt(v)}
                tono="secondary"
              />
            </Card>
          </div>
        </Card>

        <ResumenSeccion titulo={t("restaurantes.resumen.impacto")}>
          {/* La formula la redacta el servidor en espanol: con la consola en ingles se usa la del catalogo. */}
          <div className="flex min-w-0 flex-col gap-1.5" title={(idioma === "es" ? resumenCfg?.formula : undefined) ?? t("restaurantes.resumen.formula")}>
            <StatCard
              variante="neutra"
              icon={Clock}
              label={t("restaurantes.resumen.horas")}
              value={horas === null ? "—" : t("restaurantes.resumen.horasValor", { h: horas.toFixed(1) })}
              nota={
                resumenCfg === undefined
                  ? t("restaurantes.resumen.cargandoConfig")
                  : resumenCfg === null
                  ? t("restaurantes.resumen.errorConfig")
                  : minutos === null
                    ? t("restaurantes.resumen.configuralo")
                    : t("restaurantes.resumen.horasNota", { conversaciones: formatInt(conversaciones), min: minutos })
              }
            />
            {resumenCfg === null && (
              <Button type="button" variant="outline" size="sm" className="self-start" iconLeft={<RefreshCw />} onClick={() => void cargarCfg()}>
                {t("restaurantes.resumen.reintentar")}
              </Button>
            )}
            {puedeConfigurar && resumenCfg != null && (
              <Button type="button" variant="outline" size="sm" className="self-start" iconLeft={<Settings2 />} onClick={() => setConfigAbierta(true)}>
                {t("restaurantes.resumen.configurar")}
              </Button>
            )}
          </div>
        </ResumenSeccion>

        <ResumenSeccion titulo={t("restaurantes.resumen.operacion")}>
          <TileLink
            to={`${base}/productos`}
            icon={Package}
            titulo={t("restaurantes.resumen.productos")}
            descripcion={catalogo === undefined ? t("restaurantes.resumen.cargandoCorto") : catalogo.productos === null ? t("restaurantes.resumen.errorCatalogo") : t("restaurantes.resumen.enCatalogo", { n: formatInt(catalogo.productos) })}
          />
          <TileLink
            to={`${base}/productos`}
            icon={Tag}
            titulo={t("restaurantes.resumen.categorias")}
            descripcion={catalogo === undefined ? t("restaurantes.resumen.cargandoCorto") : catalogo.categorias === null ? t("restaurantes.resumen.errorCatalogo") : t("restaurantes.resumen.enCatalogo", { n: formatInt(catalogo.categorias) })}
          />
          <TileLink
            to={`${base}/clientes`}
            icon={Users}
            titulo={t("restaurantes.resumen.clientes")}
            descripcion={t("restaurantes.resumen.enCartera", { n: formatInt(customers.totalCustomers) })}
          />
        </ResumenSeccion>

        <ResumenSeccion titulo={t("restaurantes.resumen.orquestacion")}>
          <TileLink
            to={`${base}/conversaciones`}
            icon={MessageCircle}
            titulo={t("restaurantes.resumen.whatsapp")}
            descripcion={t("restaurantes.resumen.whatsappNota", {
              conversaciones: t("restaurantes.resumen.conversaciones", { count: channels.whatsappConversations.total, n: formatInt(channels.whatsappConversations.total) }),
              conPedido: formatInt(channels.whatsappConversations.withOrder),
            })}
          />
          {ROLES_VOZ.has(role) && (
            <TileLink
              to={`${base}/agente-voz`}
              icon={Mic}
              titulo={t("restaurantes.resumen.voz")}
              descripcion={
                vozHoy === undefined
                  ? t("restaurantes.resumen.vozSinDato")
                  : t("restaurantes.resumen.vozNota", {
                      hoy: t("restaurantes.resumen.llamadas", { count: vozHoy, n: formatInt(vozHoy) }),
                      mes: t("restaurantes.resumen.llamadas", { count: extras.voz!.mes.llamadas, n: formatInt(extras.voz!.mes.llamadas) }),
                    })
              }
            />
          )}
          <TileLink
            to={`${base}/conversaciones`}
            icon={HandHelping}
            titulo={t("restaurantes.resumen.tomaHumana")}
            descripcion={
              extras.pendientes === null
                ? t("restaurantes.resumen.tomaHumanaSinDato")
                : extras.pendientes === 0
                  ? t("restaurantes.resumen.tomaHumanaNinguna")
                  : t("restaurantes.resumen.tomaHumanaEsperan", { count: extras.pendientes, n: formatInt(extras.pendientes) })
            }
          />
        </ResumenSeccion>

        <Card
          className="p-3"
          role="region"
          aria-labelledby="resumen-ultima-corrida"
        >
          <SectionLabel id="resumen-ultima-corrida">
            {t("restaurantes.resumen.ultimaCorrida")}
          </SectionLabel>
          <div className="mt-2">
            {ultimaWa === null && ultimaVz === null ? (
              <EstadoVacio
                compacto
                titulo={t("restaurantes.resumen.sinBitacora")}
                mensaje={t("restaurantes.resumen.sinBitacoraMensaje")}
              />
            ) : (
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {ultimaWa !== null && (
                  <AgentRunCard
                    nombre={t("restaurantes.resumen.agenteWhatsapp")}
                    meta={t("restaurantes.resumen.ultimaConversacion", { cuando: ultimaWa })}
                    href={`${base}/conversaciones`}
                  />
                )}
                {ultimaVz !== null && (
                  <AgentRunCard
                    nombre={t("restaurantes.resumen.agenteVoz")}
                    meta={t("restaurantes.resumen.ultimaLlamada", { cuando: ultimaVz })}
                    href={`${base}/conversaciones`}
                  />
                )}
              </div>
            )}
          </div>
        </Card>

        <RestaurantesFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
      </ResumenLayout>
      {resumenCfg != null && (
        <ConfigResumenDialogo
          abierto={configAbierta}
          onCerrar={() => setConfigAbierta(false)}
          vista={resumenCfg}
          onGuardar={async (config) => {
            const nueva = await guardarResumenConfig(fetch, apiBaseUrl, token, propertyId, config);
            setResumenCfg(nueva);
            notify.success(t("restaurantes.resumen.configGuardada"));
          }}
        />
      )}
    </PageContainer>
  );
}

/** Dialogo de «Horas y metas» (owner/admin). Vacio = quitar el valor. Los rangos vienen del servidor; si la base no tiene la migracion avisa y no guarda. */
function ConfigResumenDialogo({
  abierto,
  onCerrar,
  vista,
  onGuardar,
}: {
  readonly abierto: boolean;
  readonly onCerrar: () => void;
  readonly vista: ResumenConfigVista;
  readonly onGuardar: (config: { minutosPorConversacion: number | null; metaPedidosIaPct: number | null; metaIngresosIaPct: number | null }) => Promise<void>;
}) {
  const { t, idioma } = useI18n(restaurantesResumen);
  const [minutos, setMinutos] = useState("");
  const [metaPedidos, setMetaPedidos] = useState("");
  const [metaIngresos, setMetaIngresos] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!abierto) return;
    setMinutos(vista.config.minutosPorConversacion?.toString() ?? "");
    setMetaPedidos(vista.config.metaPedidosIaPct?.toString() ?? "");
    setMetaIngresos(vista.config.metaIngresosIaPct?.toString() ?? "");
    setError(null);
  }, [abierto, vista]);

  const leer = (texto: string, nombre: string, min: number, max: number): number | null | "error" => {
    const limpio = texto.trim();
    if (limpio === "") return null;
    const n = Number(limpio);
    if (!Number.isInteger(n) || n < min || n > max) {
      setError(t("restaurantes.resumen.config.enteroEntre", { campo: nombre, min, max }));
      return "error";
    }
    return n;
  };

  async function guardar() {
    setError(null);
    const m = leer(minutos, t("restaurantes.resumen.config.minutosCampo"), vista.rangos.minutos.min, vista.rangos.minutos.max);
    const mp = leer(metaPedidos, t("restaurantes.resumen.config.metaPedidosCampo"), vista.rangos.meta.min, vista.rangos.meta.max);
    const mi = leer(metaIngresos, t("restaurantes.resumen.config.metaIngresosCampo"), vista.rangos.meta.min, vista.rangos.meta.max);
    if (m === "error" || mp === "error" || mi === "error") return;
    setGuardando(true);
    try {
      await onGuardar({ minutosPorConversacion: m, metaPedidosIaPct: mp, metaIngresosIaPct: mi });
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.resumen.config.errorGuardar"));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <FormDialog
      open={abierto}
      onOpenChange={(o) => { if (!o) onCerrar(); }}
      titulo={t("restaurantes.resumen.config.titulo")}
      subtitulo={idioma === "es" ? vista.formula : t("restaurantes.resumen.formula")}
      anchoClase="max-w-3xl"
      onGuardar={() => void guardar()}
      guardando={guardando}
      guardarDeshabilitado={!vista.disponible}
    >
      <div className="grid gap-4">
        {!vista.disponible && <p className="text-ui text-muted-foreground">{t("restaurantes.resumen.config.noDisponible")}</p>}
        <FormField label={t("restaurantes.resumen.config.minutos")}>
          <Input id="resumen-minutos" inputMode="numeric" value={minutos} onChange={(e) => setMinutos(e.target.value)} placeholder={t("restaurantes.resumen.config.rango", { min: vista.rangos.minutos.min, max: vista.rangos.minutos.max })} />
        </FormField>
        <FormField label={t("restaurantes.resumen.config.metaPedidos")}>
          <Input id="resumen-meta-pedidos" inputMode="numeric" value={metaPedidos} onChange={(e) => setMetaPedidos(e.target.value)} placeholder={t("restaurantes.resumen.config.rango", { min: vista.rangos.meta.min, max: vista.rangos.meta.max })} />
        </FormField>
        <FormField label={t("restaurantes.resumen.config.metaIngresos")}>
          <Input id="resumen-meta-ingresos" inputMode="numeric" value={metaIngresos} onChange={(e) => setMetaIngresos(e.target.value)} placeholder={t("restaurantes.resumen.config.rango", { min: vista.rangos.meta.min, max: vista.rangos.meta.max })} />
        </FormField>
        {error !== null && <p role="alert" className="text-ui text-destructive">{error}</p>}
      </div>
    </FormDialog>
  );
}

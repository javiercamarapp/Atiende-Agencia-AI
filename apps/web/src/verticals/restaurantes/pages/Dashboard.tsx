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
  SectionLabel,
  StatCard,
  TileLink,
} from "@atiende/ui";
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
  /** Configuracion del Resumen (096): `null` = no se pudo leer. */
  readonly resumenCfg: ResumenConfigVista | null;
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
  resumenCfg: null,
};

async function cargarExtras(
  apiBaseUrl: string,
  token: string,
  propertyId: string,
): Promise<Extras> {
  const [tz, voz, pend, wa, vz, cfg] = await Promise.allSettled([
    fetchBranchTimezone(fetch, apiBaseUrl, token, propertyId),
    fetchVozKpi(fetch, apiBaseUrl, token, propertyId),
    fetchBandeja(fetch, apiBaseUrl, token, propertyId, { estado: "pendiente" }),
    fetchBandeja(fetch, apiBaseUrl, token, propertyId, { canal: "whatsapp" }),
    fetchBandeja(fetch, apiBaseUrl, token, propertyId, { canal: "voz" }),
    fetchResumenConfig(fetch, apiBaseUrl, token, propertyId),
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
    resumenCfg: cfg.status === "fulfilled" ? cfg.value : null,
  };
}

/** Marca del eje Y: pesos enteros con separador de miles (sin centavos, el eje no los necesita). */
function formatMoneyCorto(v: number): string {
  return `$${formatInt(Math.round(v))}`;
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

  const metaPedidos = extras.resumenCfg?.config.metaPedidosIaPct ?? null;
  const metaIngresos = extras.resumenCfg?.config.metaIngresosIaPct ?? null;
  const minutos = extras.resumenCfg?.config.minutosPorConversacion ?? null;
  const conversaciones = channels.whatsappConversations.total;
  const horas = horasAhorradas(conversaciones, minutos);
  const puedeConfigurar = ROLES_VOZ.has(role);

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
      nota={`${
        channels.aiAdoptionPct === null
          ? `Voz y WhatsApp · ${periodoCanales}`
          : `${channels.aiAdoptionPct.toFixed(0)}% de los pedidos · ${periodoCanales}`
      }${metaPedidos === null ? "" : ` · Tu meta: ${metaPedidos}%`}`}
    />,
    <StatCard
      key="ingresos-ia"
      variante="neutra"
      icon={Sparkles}
      label="Ingresos por agentes IA"
      value={formatMoney(ingresosIa)}
      nota={`Voz y WhatsApp, sin cancelados · ${periodoCanales}${metaIngresos === null ? "" : ` · Tu meta: ${metaIngresos}%`}`}
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
          </>
        }
      >
        <Card className="p-3" role="region" aria-labelledby="resumen-tendencias">
          <SectionLabel id="resumen-tendencias">Tendencias</SectionLabel>
          <div className="mt-2 grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            <Card className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="size-3 rounded-full bg-primary" />
                <span className="text-ui font-medium text-foreground">Ventas ($)</span>
              </div>
              <GraficaTendencia
                puntos={trend.map((p) => ({ etiqueta: p.label, valor: p.revenue }))}
                etiquetaSerie="Ventas ($)"
                formatoValor={(v) => formatMoneyCorto(v)}
              />
            </Card>
            <Card className="p-3">
              <div className="mb-2 flex items-center gap-2">
                <span aria-hidden="true" className="size-3 rounded-full bg-secondary" />
                <span className="text-ui font-medium text-foreground">Órdenes</span>
              </div>
              <GraficaTendencia
                puntos={trend.map((p) => ({ etiqueta: p.label, valor: p.orders }))}
                etiquetaSerie="Órdenes"
                formatoValor={(v) => formatInt(v)}
                tono="secondary"
              />
            </Card>
          </div>
        </Card>

        <ResumenSeccion titulo="Impacto de tus agentes">
          <div className="flex min-w-0 flex-col gap-1.5" title={extras.resumenCfg?.formula ?? "Horas ahorradas = conversaciones de WhatsApp atendidas por el agente (acumulado histórico de tus sucursales visibles; no cambia con el periodo) × minutos por conversación ÷ 60."}>
            <StatCard
              variante="neutra"
              icon={Clock}
              label="Horas de atención ahorradas"
              value={horas === null ? "—" : `${horas.toFixed(1)} h`}
              nota={
                extras.resumenCfg === null
                  ? "No se pudo leer la configuración"
                  : minutos === null
                    ? "Configúralo: minutos que ahorra cada conversación atendida por el agente"
                    : `${formatInt(conversaciones)} conversaciones (histórico, sucursales que ves) × ${minutos} min ÷ 60 · estimación con tu supuesto (config. de toda la organización), no una medición`
              }
            />
            {extras.resumenCfg === null && (
              <Button type="button" variant="outline" size="sm" className="self-start" iconLeft={<RefreshCw />} onClick={() => void cargar(period)}>
                Reintentar
              </Button>
            )}
            {puedeConfigurar && extras.resumenCfg !== null && (
              <Button type="button" variant="outline" size="sm" className="self-start" iconLeft={<Settings2 />} onClick={() => setConfigAbierta(true)}>
                Configurar horas y metas
              </Button>
            )}
          </div>
        </ResumenSeccion>

        <ResumenSeccion titulo="Tu operación">
          <TileLink
            to={`${base}/productos`}
            icon={Package}
            titulo="Total de productos"
            descripcion={catalogo === undefined ? "Cargando…" : catalogo.productos === null ? "No se pudo leer el catálogo" : `${formatInt(catalogo.productos)} en el catálogo`}
          />
          <TileLink
            to={`${base}/productos`}
            icon={Tag}
            titulo="Categorías"
            descripcion={catalogo === undefined ? "Cargando…" : catalogo.categorias === null ? "No se pudo leer el catálogo" : `${formatInt(catalogo.categorias)} en el catálogo`}
          />
          <TileLink
            to={`${base}/clientes`}
            icon={Users}
            titulo="Clientes registrados"
            descripcion={`${formatInt(customers.totalCustomers)} en tu cartera (con o sin pedidos)`}
          />
        </ResumenSeccion>

        <ResumenSeccion titulo="Orquestación de agentes">
          <TileLink
            to={`${base}/conversaciones`}
            icon={MessageCircle}
            titulo="WhatsApp"
            descripcion={`${plural(channels.whatsappConversations.total, "conversación", "conversaciones")} · ${formatInt(channels.whatsappConversations.withOrder)} con pedido · histórico`}
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

        <RestaurantesFijadosCopiloto apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} orgSlug={orgSlug} />
      </ResumenLayout>
      {extras.resumenCfg !== null && (
        <ConfigResumenDialogo
          abierto={configAbierta}
          onCerrar={() => setConfigAbierta(false)}
          vista={extras.resumenCfg}
          onGuardar={async (config) => {
            const nueva = await guardarResumenConfig(fetch, apiBaseUrl, token, propertyId, config);
            setExtras((e) => ({ ...e, resumenCfg: nueva }));
            notify.success("Configuración del Resumen guardada.");
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
    const t = texto.trim();
    if (t === "") return null;
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) {
      setError(`${nombre}: escribe un entero entre ${min} y ${max}, o déjalo vacío para quitarlo.`);
      return "error";
    }
    return n;
  };

  async function guardar() {
    setError(null);
    const m = leer(minutos, "Minutos por conversación", vista.rangos.minutos.min, vista.rangos.minutos.max);
    const mp = leer(metaPedidos, "Meta de pedidos por agentes", vista.rangos.meta.min, vista.rangos.meta.max);
    const mi = leer(metaIngresos, "Meta de ingresos por agentes", vista.rangos.meta.min, vista.rangos.meta.max);
    if (m === "error" || mp === "error" || mi === "error") return;
    setGuardando(true);
    try {
      await onGuardar({ minutosPorConversacion: m, metaPedidosIaPct: mp, metaIngresosIaPct: mi });
      onCerrar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la configuración.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <FormDialog
      open={abierto}
      onOpenChange={(o) => { if (!o) onCerrar(); }}
      titulo="Horas y metas del Resumen"
      subtitulo={vista.formula}
      anchoClase="max-w-3xl"
      onGuardar={() => void guardar()}
      guardando={guardando}
      guardarDeshabilitado={!vista.disponible}
    >
      <div className="grid gap-4">
        {!vista.disponible && <p className="text-ui text-muted-foreground">Esta función aún no está disponible en tu cuenta.</p>}
        <FormField label="Minutos que ahorra cada conversación atendida por el agente">
          <Input id="resumen-minutos" inputMode="numeric" value={minutos} onChange={(e) => setMinutos(e.target.value)} placeholder={`${vista.rangos.minutos.min} a ${vista.rangos.minutos.max}`} />
        </FormField>
        <FormField label="Meta de pedidos por agentes IA (%)">
          <Input id="resumen-meta-pedidos" inputMode="numeric" value={metaPedidos} onChange={(e) => setMetaPedidos(e.target.value)} placeholder={`${vista.rangos.meta.min} a ${vista.rangos.meta.max}`} />
        </FormField>
        <FormField label="Meta de ingresos por agentes IA (%)">
          <Input id="resumen-meta-ingresos" inputMode="numeric" value={metaIngresos} onChange={(e) => setMetaIngresos(e.target.value)} placeholder={`${vista.rangos.meta.min} a ${vista.rangos.meta.max}`} />
        </FormField>
        {error !== null && <p role="alert" className="text-ui text-destructive">{error}</p>}
      </div>
    </FormDialog>
  );
}

// Dashboard de KPIs (Fase 3, montado dentro de RestaurantesShell desde Fase 5.1) —
// landing post-login real: `decideLandingPath()` (auth-client.ts) manda aquí tras
// login con 1 sola organización. Vive DENTRO de RestaurantesShell (ver App.tsx),
// igual que Productos/Sucursales/Pedidos/Historial/Clientes, así el manager que
// entra al producto tiene la nav lateral completa (incluye el link "Panel (KPIs)"
// de vuelta a esta misma página) en vez de quedar en un callejón sin salida donde
// solo se podía llegar al back-office tecleando la URL a mano. Sesión/sucursal ya
// las resuelve el Shell una sola vez — este componente solo consume el contexto,
// mismo patrón que el resto de páginas de este vertical.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes (tarjeta
// hecha a mano, tiles de KPI hechos a mano, píldoras de periodo hechas a mano) se
// reemplazan por los primitivos que `@atiende/ui` ya exporta — `StatCard` para cada
// cifra, `Card`/`CardHeader`/`CardContent` para los paneles, `Tabs` para el selector
// de periodo, `Button` para "Actualizar" y `Badge` para los tiers — exactamente el
// mismo nivel de acabado que RestaurantesShell.tsx. TODA la lógica de carga/estado/
// fetch de abajo es la MISMA: solo cambia el JSX.
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  StatCard,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@atiende/ui";
import {
  Bot,
  CalendarClock,
  ClipboardList,
  Clock,
  CreditCard,
  Crown,
  DollarSign,
  MessageCircle,
  Mic,
  Receipt,
  RefreshCw,
  Repeat,
  Sparkles,
  Users,
} from "lucide-react";
import { fetchDashboardData, formatDays, formatInt, formatMoney, formatPct, formatSignedPct, PERIOD_OPTIONS } from "../dashboard-client.ts";
import type { DashboardData, StatsPeriod } from "../dashboard-client.ts";
import { saludoConNombre } from "../../../lib/greeting.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

/** Mismos 4 tiers de siempre (label/glifo idénticos); el color deja de ser un hex
 * suelto y pasa a clases de token que funcionan en claro y oscuro. */
const TIER_META: Record<"BLACK" | "PLATINUM" | "GOLD" | "BLUE", { label: string; glyph: string; clase: string }> = {
  BLACK: { label: "Black", glyph: "♛", clase: "border-transparent bg-foreground text-background" },
  PLATINUM: { label: "Platinum", glyph: "◆", clase: "border-border bg-muted text-muted-foreground" },
  GOLD: { label: "Gold", glyph: "★", clase: "border-transparent bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200" },
  BLUE: { label: "Blue", glyph: "●", clase: "border-transparent bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200" },
};

/** Sparkline SVG inline simple — no se agrega recharts como dependencia nueva solo
 * para dos mini-gráficas en una fase sobre todo de backend (ver diseño §3). El color
 * ahora es `currentColor`, así que lo define una clase de token del contenedor. */
function Sparkline({ points, className }: { points: readonly number[]; className: string }) {
  const width = 320;
  const height = 64;
  if (points.length === 0) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Tendencia" className={className}>
      <polyline fill="none" stroke="currentColor" strokeWidth={2} points={coords.join(" ")} />
    </svg>
  );
}

function TituloSeccion({ children }: { children: string }) {
  return <p className="m-0 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{children}</p>;
}

export function RestaurantesDashboardPage({ apiBaseUrl, token, propertyId, orgSlug, staffFullName, staffEmail }: RestaurantesShellContext) {
  const [period, setPeriod] = useState<StatsPeriod>("30");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadKpis(p: StatsPeriod) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDashboardData(fetch, apiBaseUrl, token, propertyId, p);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los KPIs.");
    } finally {
      setLoading(false);
    }
  }

  // `loadKpis` se recrea cada render (depende de `token`/`apiBaseUrl`/`propertyId`,
  // todos estables mientras el Shell no cambie de sesión/sucursal) — no está en el
  // arreglo de dependencias a propósito, mismo patrón que el resto de páginas de este
  // vertical (ver Productos.tsx). Este proyecto no tiene configurado
  // eslint-plugin-react-hooks (no hay otro `// eslint-disable` de esa regla en
  // apps/web), así que no hace falta silenciar nada.
  useEffect(() => {
    void loadKpis(period);
  }, [apiBaseUrl, token, propertyId, period]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-sm text-muted-foreground">{saludoConNombre(staffFullName, staffEmail)}</p>
          <h1 className="m-0 font-display text-xl font-semibold text-foreground">Panel de {orgSlug}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Tabs value={period} onValueChange={(v) => setPeriod(v as StatsPeriod)}>
            <TabsList className="flex-wrap">
              {PERIOD_OPTIONS.map((opt) => (
                <TabsTrigger key={opt.id} value={opt.id}>
                  {opt.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button type="button" variant="outline" size="sm" onClick={() => void loadKpis(period)} disabled={loading}>
            <RefreshCw className={loading ? "animate-spin" : undefined} />
            {loading ? "Actualizando…" : "Actualizar"}
          </Button>
        </div>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void loadKpis(period)} />}

      {!data && !error && <EstadoCargando etiqueta="Cargando panel…" />}

      {data && (
        <>
          <section className="flex flex-col gap-3">
            <TituloSeccion>Tus ventas</TituloSeccion>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              <StatCard
                icon={DollarSign}
                label="Ventas netas"
                value={formatMoney(data.sales.revenue)}
                nota={period === "historico" ? data.sales.periodLabel : `${formatSignedPct(data.sales.revenueChangePct)} ${data.sales.periodLabel}`}
              />
              <StatCard
                icon={ClipboardList}
                label="Número de órdenes"
                value={formatInt(data.sales.orders)}
                nota={period === "historico" ? data.sales.periodLabel : `${formatSignedPct(data.sales.ordersChangePct)} ${data.sales.periodLabel}`}
              />
              <StatCard
                icon={Receipt}
                label="Valor promedio"
                value={formatMoney(data.sales.averageOrder)}
                nota={period === "historico" ? data.sales.periodLabel : `${formatSignedPct(data.sales.avgOrderChangePct)} ${data.sales.periodLabel}`}
              />
            </div>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
              <Card>
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Ventas ($)</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <Sparkline points={data.trend.map((p) => p.revenue)} className="text-foreground" />
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="p-4 pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Órdenes</CardTitle>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  <Sparkline points={data.trend.map((p) => p.orders)} className="text-primary" />
                </CardContent>
              </Card>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <TituloSeccion>Impacto de tus agentes</TituloSeccion>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              <StatCard icon={Bot} label="Pedidos por agentes IA" value={formatPct(data.channels.aiAdoptionPct)} />
              <StatCard icon={Sparkles} label="Ingresos por agentes IA" value={formatPct(data.channels.aiRevenuePct)} />
              <StatCard
                icon={Clock}
                label="Horas de atención ahorradas"
                value={`${data.channels.estimatedHoursSaved.toFixed(1)} h`}
                nota="Estimado: ≈5 min de atención humana por pedido resuelto por un agente. Supuesto ajustable, no es una medición real."
              />
              <StatCard icon={Mic} label="Pedidos por voz" value={formatInt(data.channels.voice.orders)} />
              <StatCard icon={MessageCircle} label="Pedidos por WhatsApp" value={formatInt(data.channels.whatsapp.orders)} />
              <StatCard icon={DollarSign} label="Ingresos generados por IA" value={formatMoney(data.channels.voice.revenue + data.channels.whatsapp.revenue)} />
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <TituloSeccion>Clientes</TituloSeccion>
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
              <StatCard icon={Users} label="Clientes totales" value={formatInt(data.customers.totalCustomers)} />
              <StatCard
                icon={CreditCard}
                label="Ticket promedio"
                value={data.customers.averageOrderValue === null ? "Sin datos" : formatMoney(data.customers.averageOrderValue)}
              />
              <StatCard
                icon={Repeat}
                label="Clientes recurrentes"
                value={formatPct(data.customers.recurringCustomerPct)}
                nota={data.customers.recurringCustomerPct !== null ? "de quienes ya pidieron al menos una vez" : undefined}
              />
              <StatCard
                icon={Crown}
                label="Cliente más frecuente"
                value={data.customers.topCustomer ? data.customers.topCustomer.name || data.customers.topCustomer.phone : "Sin datos"}
                nota={data.customers.topCustomer ? `${data.customers.topCustomer.orderCount} pedidos` : undefined}
              />
              <StatCard
                icon={CalendarClock}
                label="Días desde su último pedido"
                value={formatDays(data.customers.avgDaysSinceLastOrder)}
                nota={data.customers.avgDaysSinceLastOrder !== null ? "promedio de la base" : undefined}
              />
            </div>
            <div className="flex flex-wrap gap-2 border-t border-dashed border-border pt-3">
              {data.customers.tierDistribution.metric === "sin_datos" ? (
                <p className="m-0 text-xs text-muted-foreground">
                  Todavía no hay pedidos vinculados a clientes ni frecuencia registrada — los tiers aparecen en cuanto haya actividad real.
                </p>
              ) : (
                (["BLACK", "PLATINUM", "GOLD", "BLUE"] as const).map((tier) => {
                  const meta = TIER_META[tier];
                  return (
                    <Badge key={tier} variant="outline" className={`gap-1.5 px-2.5 py-1 font-medium ${meta.clase}`}>
                      <span aria-hidden>{meta.glyph}</span>
                      {meta.label}
                      <span className="opacity-80">· {data.customers.tierDistribution[tier]}</span>
                    </Badge>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

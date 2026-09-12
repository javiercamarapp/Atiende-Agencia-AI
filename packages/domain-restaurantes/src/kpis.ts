// Fase 3 restaurantes — dashboards de KPIs (ver diseño §1-§2). Puerto ADAPTADO de la
// lógica real de restaurantes/src/pages/AdminDashboard.tsx (construirTramosTendencia
// líneas 1866-1971, construirPeriodosComparacion líneas 1977-1998,
// actualizarEstadisticasYTendencia líneas 2007-2067, statsAgentes líneas 3355-3393) y
// restaurantes/src/components/admin/ClientesSection.tsx (kpis líneas 314-334) — mismas
// fórmulas, calculadas server-side contra @atiende/domain-restaurantes::RestaurantesRepository
// en vez de en el navegador contra un array de `orders` truncado. Sin dependencias de
// fecha externas (no había date-fns en este monorepo — ver package.json — y no vale la
// pena agregarlo solo para esto): funciones puras de fecha con `Date` nativo.
//
// Ningún cálculo de negocio vive en la ruta HTTP (ver
// apps/api/src/routes/verticals/restaurantes/admin-kpis.ts): esta es la ÚNICA capa que
// decide tramos/porcentajes/etiquetas — la ruta solo resuelve auth/alcance y serializa.
import type {
  ChannelStatsRow,
  CustomerOverviewRow,
  KpiDateRange,
  RestaurantesRepository,
  SalesBucketRow,
  TierDistributionRow,
} from "./repository.ts";

export type StatsPeriod = "today" | "7" | "30" | "90" | "180" | "365" | "historico";

export const STATS_PERIODS: readonly StatsPeriod[] = ["today", "7", "30", "90", "180", "365", "historico"];

export function isStatsPeriod(value: string): value is StatsPeriod {
  return (STATS_PERIODS as readonly string[]).includes(value);
}

export interface TrendBucket {
  readonly start: Date;
  readonly end: Date;
  readonly label: string;
}

export interface ComparisonPeriods {
  readonly current: KpiDateRange;
  /** null solo para 'historico' — es un total, no una ventana con antes/después. */
  readonly previous: KpiDateRange | null;
}

const MESES_ES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS_ES = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
/** Mismo centinela que MUY_FUTURO/EPOCA de AdminDashboard.tsx (líneas 1669-1670): un
 * "fin" que nunca corta datos reales y un "inicio" que cubre todo el histórico. */
const MUY_FUTURO = new Date("9999-12-31T23:59:59.999Z");
const EPOCA = new Date(0);

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function subDays(d: Date, n: number): Date {
  return addDays(d, -n);
}

function startOfMonth(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  return r;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function subMonths(d: Date, n: number): Date {
  return addMonths(d, -n);
}

/**
 * Puerto de `construirTramosTendencia` (AdminDashboard.tsx:1866-1971). Granularidad
 * adaptativa por periodo (por hora en "Hoy", cada 3 días en "30", adaptativa en
 * histórico según la antigüedad real del primer pedido) — mismos tramos que el origen,
 * `fin` siempre exclusivo.
 */
export function buildTrendBuckets(period: StatsPeriod, now: Date, firstOrderAt: Date | null): readonly TrendBucket[] {
  const tramos: TrendBucket[] = [];
  switch (period) {
    case "today": {
      // Solo horas abiertas (11:00-23:00) — de lo contrario medianoche-6am sale
      // siempre en cero y aplasta la gráfica real de mediodía/noche.
      const HORA_APERTURA = 11;
      const HORA_CIERRE = 23;
      for (let h = HORA_APERTURA; h <= HORA_CIERRE; h += 1) {
        const inicio = startOfDay(now);
        inicio.setHours(h, 0, 0, 0);
        const fin = new Date(inicio.getTime() + 60 * 60 * 1000);
        tramos.push({ start: inicio, end: fin, label: `${pad2(h)}:00` });
      }
      break;
    }
    case "7": {
      for (let i = 6; i >= 0; i -= 1) {
        const inicio = startOfDay(subDays(now, i));
        const fin = addDays(inicio, 1);
        tramos.push({ start: inicio, end: fin, label: DIAS_ES[inicio.getDay()]! });
      }
      break;
    }
    case "30": {
      // Un punto cada 3 días (10 tramos) en vez de uno por día.
      for (let i = 27; i >= 0; i -= 3) {
        const inicio = startOfDay(subDays(now, i));
        const fin = addDays(inicio, 3);
        tramos.push({ start: inicio, end: fin, label: `${pad2(inicio.getDate())} ${MESES_ES[inicio.getMonth()]}` });
      }
      break;
    }
    case "90": {
      for (let i = 89; i >= 0; i -= 7) {
        const inicio = startOfDay(subDays(now, i));
        const fin = addDays(inicio, 7);
        tramos.push({ start: inicio, end: fin, label: `${pad2(inicio.getDate())} ${MESES_ES[inicio.getMonth()]}` });
      }
      break;
    }
    case "180": {
      for (let i = 25; i >= 0; i -= 1) {
        const inicio = startOfDay(subDays(now, i * 7));
        const fin = addDays(inicio, 7);
        tramos.push({ start: inicio, end: fin, label: `${pad2(inicio.getDate())} ${MESES_ES[inicio.getMonth()]}` });
      }
      break;
    }
    case "365": {
      for (let i = 11; i >= 0; i -= 1) {
        const inicio = startOfMonth(subMonths(now, i));
        const fin = addMonths(inicio, 1);
        tramos.push({ start: inicio, end: fin, label: `${MESES_ES[inicio.getMonth()]} ${String(inicio.getFullYear()).slice(2)}` });
      }
      break;
    }
    case "historico":
    default: {
      const inicioReal = firstOrderAt ?? now;
      const mesesDesdeInicio = Math.max(0, (now.getFullYear() - inicioReal.getFullYear()) * 12 + (now.getMonth() - inicioReal.getMonth()));
      if (mesesDesdeInicio <= 12) {
        for (let i = mesesDesdeInicio; i >= 0; i -= 1) {
          const inicio = startOfMonth(subMonths(now, i));
          const fin = addMonths(inicio, 1);
          tramos.push({ start: inicio, end: fin, label: `${MESES_ES[inicio.getMonth()]} ${String(inicio.getFullYear()).slice(2)}` });
        }
      } else if (mesesDesdeInicio <= 36) {
        for (let i = mesesDesdeInicio; i >= 0; i -= 3) {
          const inicio = startOfMonth(subMonths(now, i));
          const fin = addMonths(inicio, 3);
          tramos.push({ start: inicio, end: fin, label: `${MESES_ES[inicio.getMonth()]} ${String(inicio.getFullYear()).slice(2)}` });
        }
      } else {
        const añosDesdeInicio = Math.ceil(mesesDesdeInicio / 12);
        for (let i = añosDesdeInicio; i >= 0; i -= 1) {
          const inicio = startOfMonth(subMonths(now, i * 12));
          const fin = addMonths(inicio, 12);
          tramos.push({ start: inicio, end: fin, label: String(inicio.getFullYear()) });
        }
      }
      break;
    }
  }
  return tramos;
}

/** Puerto de `construirPeriodosComparacion` (AdminDashboard.tsx:1977-1998). */
export function buildComparisonPeriods(period: StatsPeriod, now: Date): ComparisonPeriods {
  switch (period) {
    case "today": {
      const hoy = startOfDay(now);
      return { current: { start: hoy, end: MUY_FUTURO }, previous: { start: subDays(hoy, 1), end: hoy } };
    }
    case "7":
      return { current: { start: subDays(now, 7), end: MUY_FUTURO }, previous: { start: subDays(now, 14), end: subDays(now, 7) } };
    case "30":
      return { current: { start: subDays(now, 30), end: MUY_FUTURO }, previous: { start: subDays(now, 60), end: subDays(now, 30) } };
    case "90":
      return { current: { start: subDays(now, 90), end: MUY_FUTURO }, previous: { start: subDays(now, 180), end: subDays(now, 90) } };
    case "180":
      return { current: { start: subDays(now, 180), end: MUY_FUTURO }, previous: { start: subDays(now, 360), end: subDays(now, 180) } };
    case "365":
      return { current: { start: subDays(now, 365), end: MUY_FUTURO }, previous: { start: subDays(now, 730), end: subDays(now, 365) } };
    case "historico":
    default:
      return { current: { start: EPOCA, end: MUY_FUTURO }, previous: null };
  }
}

/** Puerto de `getPeriodLabel` (AdminDashboard.tsx:2599-2610). */
export function periodLabel(period: StatsPeriod): string {
  switch (period) {
    case "today":
      return "vs ayer";
    case "7":
      return "vs 7 días anteriores";
    case "30":
      return "vs 30 días anteriores";
    case "90":
      return "vs 90 días anteriores";
    case "180":
      return "vs 180 días anteriores";
    case "365":
      return "vs el año anterior";
    case "historico":
    default:
      return "todo el tiempo registrado";
  }
}

/** Puerto literal de `calcChange` (AdminDashboard.tsx:2053-2056). */
function calcChangePct(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

export interface SalesSummary {
  readonly revenue: number;
  readonly orders: number;
  readonly customers: number;
  readonly averageOrder: number;
  /** null solo para 'historico' (no hay "periodo anterior" con el que comparar). */
  readonly revenueChangePct: number | null;
  readonly ordersChangePct: number | null;
  readonly customersChangePct: number | null;
  readonly avgOrderChangePct: number | null;
  readonly periodLabel: string;
}

export interface SalesTrendPoint {
  readonly label: string;
  readonly revenue: number;
  readonly orders: number;
}

/**
 * Orquesta "Tus ventas": arma la ventana actual/previa de comparación (ver
 * buildComparisonPeriods — no depende de `firstOrderAt`, a diferencia de la tendencia)
 * y pide ambas en una sola llamada al repositorio para calcular los `%` de cambio.
 */
export async function getSalesKpis(
  repo: RestaurantesRepository,
  organizationId: string,
  propertyIds: readonly string[] | null,
  period: StatsPeriod,
  now: Date,
): Promise<SalesSummary> {
  const comparison = buildComparisonPeriods(period, now);
  const buckets: KpiDateRange[] = [comparison.current, ...(comparison.previous ? [comparison.previous] : [])];
  const [currentRow, previousRow] = await repo.getSalesBucketedStats(organizationId, propertyIds, buckets);
  const current = currentRow ?? { revenue: 0, orderCount: 0, customerCount: 0 };
  const previous = comparison.previous ? (previousRow ?? { revenue: 0, orderCount: 0, customerCount: 0 }) : null;

  const averageOrder = current.orderCount > 0 ? current.revenue / current.orderCount : 0;
  const previousAverageOrder = previous && previous.orderCount > 0 ? previous.revenue / previous.orderCount : 0;

  return {
    revenue: current.revenue,
    orders: current.orderCount,
    customers: current.customerCount,
    averageOrder,
    revenueChangePct: previous ? calcChangePct(current.revenue, previous.revenue) : null,
    ordersChangePct: previous ? calcChangePct(current.orderCount, previous.orderCount) : null,
    customersChangePct: previous ? calcChangePct(current.customerCount, previous.customerCount) : null,
    avgOrderChangePct: previous ? calcChangePct(averageOrder, previousAverageOrder) : null,
    periodLabel: periodLabel(period),
  };
}

/** Orquesta "Tendencias": mismos tramos que buildTrendBuckets, una sola llamada. */
export async function getSalesTrendKpis(
  repo: RestaurantesRepository,
  organizationId: string,
  propertyIds: readonly string[] | null,
  period: StatsPeriod,
  now: Date,
  firstOrderAt: Date | null,
): Promise<readonly SalesTrendPoint[]> {
  const tramos = buildTrendBuckets(period, now, firstOrderAt);
  const rows = await repo.getSalesBucketedStats(organizationId, propertyIds, tramos);
  return tramos.map((t, i) => {
    const row: SalesBucketRow = rows[i] ?? { revenue: 0, orderCount: 0, customerCount: 0 };
    return { label: t.label, revenue: row.revenue, orders: row.orderCount };
  });
}

export interface ChannelKpis {
  readonly totalOrders: number;
  readonly totalRevenue: number;
  readonly voice: { readonly orders: number; readonly completed: number; readonly cancelled: number; readonly revenue: number };
  readonly whatsapp: { readonly orders: number; readonly completed: number; readonly cancelled: number; readonly revenue: number };
  readonly whatsappConversations: { readonly total: number; readonly withOrder: number; readonly averageMessages: number };
  /** null cuando totalOrders/totalRevenue es 0 — no hay base sobre la que calcular un
   * "%" real (mismo criterio `> 0 ? ... : null` que AdminDashboard.tsx:3358-3364). */
  readonly aiAdoptionPct: number | null;
  readonly aiRevenuePct: number | null;
  /** Supuesto declarado: ~5 min de atención humana por pedido resuelto por un agente
   * (voz o WhatsApp) — AdminDashboard.tsx:3375-3378. Siempre un número (0 es un cero
   * real cuando no hay pedidos completados por agentes, nunca "sin datos"). */
  readonly estimatedHoursSaved: number;
}

const MINUTOS_AHORRADOS_POR_PEDIDO_IA = 5;

/** Orquesta "Impacto de tus agentes" (AdminDashboard.tsx:3355-3393). */
export async function getChannelKpis(repo: RestaurantesRepository, organizationId: string, propertyIds: readonly string[] | null): Promise<ChannelKpis> {
  const [channels, conversations] = await Promise.all([
    repo.getChannelStats(organizationId, propertyIds),
    repo.getWhatsappConversationStats(organizationId, propertyIds),
  ]);
  return computeChannelKpis(channels, conversations);
}

export function computeChannelKpis(channels: ChannelStatsRow, conversations: { readonly total: number; readonly withOrder: number; readonly averageMessages: number }): ChannelKpis {
  const aiOrders = channels.voice.orders + channels.whatsapp.orders;
  const aiRevenue = channels.voice.revenue + channels.whatsapp.revenue;
  const aiCompleted = channels.voice.completed + channels.whatsapp.completed;
  return {
    totalOrders: channels.totalOrders,
    totalRevenue: channels.totalRevenue,
    voice: channels.voice,
    whatsapp: channels.whatsapp,
    whatsappConversations: conversations,
    aiAdoptionPct: channels.totalOrders > 0 ? (aiOrders / channels.totalOrders) * 100 : null,
    aiRevenuePct: channels.totalRevenue > 0 ? (aiRevenue / channels.totalRevenue) * 100 : null,
    estimatedHoursSaved: (aiCompleted * MINUTOS_AHORRADOS_POR_PEDIDO_IA) / 60,
  };
}

export interface CustomerKpis {
  readonly totalCustomers: number;
  readonly averageOrderValue: number | null;
  readonly recurringCustomerPct: number | null;
  readonly topCustomer: { readonly name: string | null; readonly phone: string; readonly orderCount: number } | null;
  readonly avgDaysSinceLastOrder: number | null;
  readonly tierDistribution: {
    readonly metric: "gasto" | "frecuencia" | "sin_datos";
    readonly BLACK: number;
    readonly PLATINUM: number;
    readonly GOLD: number;
    readonly BLUE: number;
    readonly withoutTier: number;
  };
}

/** Orquesta "Panorama de clientes" (ClientesSection.tsx:269-428). */
export async function getCustomerKpis(repo: RestaurantesRepository, organizationId: string): Promise<CustomerKpis> {
  const [overview, tiers] = await Promise.all([repo.getCustomerOverviewKpis(organizationId), repo.getCustomerTierDistribution(organizationId)]);
  return computeCustomerKpis(overview, tiers);
}

export function computeCustomerKpis(overview: CustomerOverviewRow, tiers: TierDistributionRow): CustomerKpis {
  // % recurrentes: mismo criterio que kpis.pctRecurrentes de ClientesSection.tsx —
  // sobre la base de quienes YA pidieron al menos una vez (order_count>0), no sobre
  // el total de clientes (que incluiría a quien nunca pidió, ej. registrado por
  // WhatsApp sin completar un pedido).
  const recurringCustomerPct = overview.customersWithOrders > 0 ? (overview.recurringCustomers / overview.customersWithOrders) * 100 : null;
  return {
    totalCustomers: overview.totalCustomers,
    averageOrderValue: overview.averageOrderValue,
    recurringCustomerPct,
    topCustomer: overview.topCustomer ? { name: overview.topCustomer.name, phone: overview.topCustomer.phone, orderCount: overview.topCustomer.orderCount } : null,
    avgDaysSinceLastOrder: overview.avgDaysSinceLastOrder,
    tierDistribution: {
      metric: tiers.metric,
      BLACK: tiers.black,
      PLATINUM: tiers.platinum,
      GOLD: tiers.gold,
      BLUE: tiers.blue,
      withoutTier: tiers.withoutTier,
    },
  };
}

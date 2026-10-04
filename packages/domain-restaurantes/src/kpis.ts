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
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { HorarioSucursal } from "./horarios.ts";
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

// QA-restaurantes-R1-automatizacion-03: todo el calendario ("Hoy", dias, meses, etiquetas) se calcula en la ZONA HORARIA DEL
// NEGOCIO, nunca en la del proceso: en Vercel el proceso corre en UTC y "Hoy" empezaba a las 18:00 de AYER en Merida. Sin
// zona explicita se usa la de plataforma (`resolverZonaHorariaNegocio(null)`). Aritmetica de calendario local, no de 24 h:
// un cambio de hora (DST) no desplaza los limites.
const CACHE_FORMATTER_KPI = new Map<string, Intl.DateTimeFormat>();

function formatterKpi(zona: string): Intl.DateTimeFormat {
  let f = CACHE_FORMATTER_KPI.get(zona);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zona, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
    CACHE_FORMATTER_KPI.set(zona, f);
  }
  return f;
}

interface PartesLocales {
  readonly y: number;
  /** 0-11 */
  readonly m: number;
  readonly d: number;
  readonly h: number;
  /** 0 = domingo */
  readonly dow: number;
}

const DOW_POR_NOMBRE: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partesLocales(instante: Date, zona: string): PartesLocales {
  const partes = formatterKpi(zona).formatToParts(instante);
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? "0");
  const weekday = partes.find((p) => p.type === "weekday")?.value ?? "Sun";
  return { y: n("year"), m: n("month") - 1, d: n("day"), h: n("hour") % 24, dow: DOW_POR_NOMBRE[weekday] ?? 0 };
}

/** Desfase de la zona en ese instante (hora local interpretada como UTC, menos el instante), en ms. */
function desfaseMs(instante: Date, zona: string): number {
  const partes = formatterKpi(zona).formatToParts(instante);
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? "0");
  const comoUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second"));
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/** Instante de la hora local `h:00` del dia local (y, m, d) (m/d fuera de rango se normalizan, como `Date.UTC`). */
function instanteLocal(y: number, m: number, d: number, h: number, zona: string): Date {
  const guess = Date.UTC(y, m, d, h);
  const off1 = desfaseMs(new Date(guess), zona);
  let t = guess - off1;
  const off2 = desfaseMs(new Date(t), zona);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

function startOfDay(d: Date, zona: string): Date {
  const p = partesLocales(d, zona);
  return instanteLocal(p.y, p.m, p.d, 0, zona);
}

/** Medianoche local `n` dias despues (negativo = antes) de la medianoche local de `d`. */
function startOfDayShift(d: Date, n: number, zona: string): Date {
  const p = partesLocales(d, zona);
  return instanteLocal(p.y, p.m, p.d + n, 0, zona);
}

/** `d` movido `n` dias de calendario local conservando la hora local (no 24 h fijas). */
function shiftDays(d: Date, n: number, zona: string): Date {
  const t = new Date(d.getTime() + n * 86_400_000);
  const delta = desfaseMs(t, zona) - desfaseMs(d, zona);
  return new Date(t.getTime() - delta);
}

function startOfMonthShift(d: Date, n: number, zona: string): Date {
  const p = partesLocales(d, zona);
  return instanteLocal(p.y, p.m + n, 1, 0, zona);
}

/** Primer dia del mes local `n` meses despues del mes local de `inicioDeMes`. */
function addMonthsLocal(inicioDeMes: Date, n: number, zona: string): Date {
  return startOfMonthShift(inicioDeMes, n, zona);
}

function etiquetaDiaMes(inicio: Date, zona: string): string {
  const p = partesLocales(inicio, zona);
  return `${pad2(p.d)} ${MESES_ES[p.m]}`;
}

function etiquetaMesAnio(inicio: Date, zona: string): string {
  const p = partesLocales(inicio, zona);
  return `${MESES_ES[p.m]} ${String(p.y).slice(2)}`;
}

/** Horas locales (0-23) del dia de `now` en que alguna sucursal atiende, segun su horario (un turno que cruza la
 *  medianoche aporta sus horas del final de la noche a este dia y las primeras del dia siguiente al siguiente). Sin ningun
 *  horario configurado devuelve `null` (el tablero muestra el dia completo, nunca un rango inventado). */
export function horasAbiertasHoy(horarios: readonly (HorarioSucursal | null)[], now: Date, zonaHoraria?: string | null): readonly number[] | null {
  const zona = resolverZonaHorariaNegocio(zonaHoraria);
  const validos = horarios.filter((h): h is HorarioSucursal => h !== null && h.length > 0);
  if (validos.length === 0) return null;
  const dow = partesLocales(now, zona).dow;
  const ayer = (dow + 6) % 7;
  const horas = new Set<number>();
  const aHoras = (hhmm: string): number => Number(hhmm.slice(0, 2)) + (Number(hhmm.slice(3, 5)) > 0 ? 1 : 0);
  for (const horario of validos) {
    for (const t of horario) {
      const abre = Number(t.abre.slice(0, 2));
      const cierraTope = aHoras(t.cierra); // primera hora ya cerrada (exclusiva)
      const cruza = t.cierra <= t.abre;
      if (t.dias.includes(dow)) {
        for (let h = abre; h < (cruza ? 24 : cierraTope); h += 1) horas.add(h);
      }
      if (cruza && t.dias.includes(ayer)) {
        for (let h = 0; h < cierraTope; h += 1) horas.add(h);
      }
    }
  }
  return horas.size === 0 ? null : [...horas].sort((x, y) => x - y);
}

export interface OpcionesTramos {
  /** Zona horaria IANA del negocio; sin ella, la de plataforma. */
  readonly zonaHoraria?: string | null;
  /** Solo "Hoy": horas locales (0-23) a graficar (ver `horasAbiertasHoy`). Sin valor: el dia completo. */
  readonly horasHoy?: readonly number[] | null;
}

/**
 * Puerto de `construirTramosTendencia` (AdminDashboard.tsx:1866-1971). Granularidad
 * adaptativa por periodo (por hora en "Hoy", cada 3 días en "30", adaptativa en
 * histórico según la antigüedad real del primer pedido) — mismos tramos que el origen,
 * `fin` siempre exclusivo. Todo en la zona horaria del negocio (QA-restaurantes-R1-automatizacion-03).
 */
export function buildTrendBuckets(period: StatsPeriod, now: Date, firstOrderAt: Date | null, opciones: OpcionesTramos = {}): readonly TrendBucket[] {
  const zona = resolverZonaHorariaNegocio(opciones.zonaHoraria);
  const tramos: TrendBucket[] = [];
  const lugar = partesLocales(now, zona);
  switch (period) {
    case "today": {
      // Horas del dia local en que atiende la sucursal (de su horario); sin horario, el dia completo. Antes eran las
      // horas 11-23 FIJAS y del proceso (UTC en Vercel): la cena de PM (hasta la 01:00) nunca aparecia.
      const horas = opciones.horasHoy && opciones.horasHoy.length > 0 ? opciones.horasHoy : Array.from({ length: 24 }, (_, h) => h);
      for (const h of horas) {
        const inicio = instanteLocal(lugar.y, lugar.m, lugar.d, h, zona);
        const fin = instanteLocal(lugar.y, lugar.m, lugar.d, h + 1, zona);
        tramos.push({ start: inicio, end: fin, label: `${pad2(h)}:00` });
      }
      break;
    }
    case "7": {
      for (let i = 6; i >= 0; i -= 1) {
        const inicio = startOfDayShift(now, -i, zona);
        const fin = startOfDayShift(inicio, 1, zona);
        tramos.push({ start: inicio, end: fin, label: DIAS_ES[partesLocales(inicio, zona).dow]! });
      }
      break;
    }
    case "30": {
      // Un punto cada 3 días (10 tramos) en vez de uno por día.
      for (let i = 27; i >= 0; i -= 3) {
        const inicio = startOfDayShift(now, -i, zona);
        const fin = startOfDayShift(inicio, 3, zona);
        tramos.push({ start: inicio, end: fin, label: etiquetaDiaMes(inicio, zona) });
      }
      break;
    }
    case "90": {
      for (let i = 89; i >= 0; i -= 7) {
        const inicio = startOfDayShift(now, -i, zona);
        const fin = startOfDayShift(inicio, 7, zona);
        tramos.push({ start: inicio, end: fin, label: etiquetaDiaMes(inicio, zona) });
      }
      break;
    }
    case "180": {
      for (let i = 25; i >= 0; i -= 1) {
        const inicio = startOfDayShift(now, -i * 7, zona);
        const fin = startOfDayShift(inicio, 7, zona);
        tramos.push({ start: inicio, end: fin, label: etiquetaDiaMes(inicio, zona) });
      }
      break;
    }
    case "365": {
      for (let i = 11; i >= 0; i -= 1) {
        const inicio = startOfMonthShift(now, -i, zona);
        const fin = addMonthsLocal(inicio, 1, zona);
        tramos.push({ start: inicio, end: fin, label: etiquetaMesAnio(inicio, zona) });
      }
      break;
    }
    case "historico":
    default: {
      const inicioReal = partesLocales(firstOrderAt ?? now, zona);
      const mesesDesdeInicio = Math.max(0, (lugar.y - inicioReal.y) * 12 + (lugar.m - inicioReal.m));
      if (mesesDesdeInicio <= 12) {
        for (let i = mesesDesdeInicio; i >= 0; i -= 1) {
          const inicio = startOfMonthShift(now, -i, zona);
          tramos.push({ start: inicio, end: addMonthsLocal(inicio, 1, zona), label: etiquetaMesAnio(inicio, zona) });
        }
      } else if (mesesDesdeInicio <= 36) {
        for (let i = mesesDesdeInicio; i >= 0; i -= 3) {
          const inicio = startOfMonthShift(now, -i, zona);
          tramos.push({ start: inicio, end: addMonthsLocal(inicio, 3, zona), label: etiquetaMesAnio(inicio, zona) });
        }
      } else {
        const añosDesdeInicio = Math.ceil(mesesDesdeInicio / 12);
        for (let i = añosDesdeInicio; i >= 0; i -= 1) {
          const inicio = startOfMonthShift(now, -i * 12, zona);
          tramos.push({ start: inicio, end: addMonthsLocal(inicio, 12, zona), label: String(partesLocales(inicio, zona).y) });
        }
      }
      break;
    }
  }
  return tramos;
}

/** Puerto de `construirPeriodosComparacion` (AdminDashboard.tsx:1977-1998), en la zona horaria del negocio. */
export function buildComparisonPeriods(period: StatsPeriod, now: Date, zonaHoraria?: string | null): ComparisonPeriods {
  const zona = resolverZonaHorariaNegocio(zonaHoraria);
  const atras = (n: number) => shiftDays(now, -n, zona);
  switch (period) {
    case "today": {
      const hoy = startOfDay(now, zona);
      return { current: { start: hoy, end: MUY_FUTURO }, previous: { start: startOfDayShift(hoy, -1, zona), end: hoy } };
    }
    case "7":
      return { current: { start: atras(7), end: MUY_FUTURO }, previous: { start: atras(14), end: atras(7) } };
    case "30":
      return { current: { start: atras(30), end: MUY_FUTURO }, previous: { start: atras(60), end: atras(30) } };
    case "90":
      return { current: { start: atras(90), end: MUY_FUTURO }, previous: { start: atras(180), end: atras(90) } };
    case "180":
      return { current: { start: atras(180), end: MUY_FUTURO }, previous: { start: atras(360), end: atras(180) } };
    case "365":
      return { current: { start: atras(365), end: MUY_FUTURO }, previous: { start: atras(730), end: atras(365) } };
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
  zonaHoraria?: string | null,
): Promise<SalesSummary> {
  const comparison = buildComparisonPeriods(period, now, zonaHoraria);
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
  opciones: OpcionesTramos = {},
): Promise<readonly SalesTrendPoint[]> {
  const tramos = buildTrendBuckets(period, now, firstOrderAt, opciones);
  const rows = await repo.getSalesBucketedStats(organizationId, propertyIds, tramos);
  return tramos.map((t, i) => {
    const row: SalesBucketRow = rows[i] ?? { revenue: 0, orderCount: 0, customerCount: 0 };
    return { label: t.label, revenue: row.revenue, orders: row.orderCount };
  });
}

export interface ChannelKpis {
  readonly totalOrders: number;
  /** Ventas SIN pedidos cancelados (R-30). */
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
  /** R-30: periodo REAL al que corresponden las cifras de pedidos/ventas de arriba. `acotado:false` =
   * todo el histórico (se pidió "histórico" o la base aún no tiene la migración 036); el rótulo sale de
   * aquí, nunca del periodo pedido. Las conversaciones de WhatsApp y las horas ahorradas siguen la
   * misma ventana de pedidos solo cuando `acotado` es true; `whatsappConversations` es siempre histórico. */
  readonly periodo: { readonly acotado: boolean; readonly etiqueta: string };
}

/** Rótulo del periodo al que se acotan los canales (no es el "vs anterior" de ventas). */
export function channelPeriodLabel(period: StatsPeriod, acotado: boolean): string {
  if (!acotado) return "Todo el tiempo registrado";
  switch (period) {
    case "today":
      return "Hoy";
    case "7":
      return "Últimos 7 días";
    case "30":
      return "Últimos 30 días";
    case "90":
      return "Últimos 90 días";
    case "180":
      return "Últimos 180 días";
    case "365":
      return "Último año";
    case "historico":
    default:
      return "Todo el tiempo registrado";
  }
}

const MINUTOS_AHORRADOS_POR_PEDIDO_IA = 5;

/** Orquesta "Impacto de tus agentes" (AdminDashboard.tsx:3355-3393), acotado al periodo pedido. */
export async function getChannelKpis(
  repo: RestaurantesRepository,
  organizationId: string,
  propertyIds: readonly string[] | null,
  period: StatsPeriod = "historico",
  now: Date = new Date(),
  zonaHoraria?: string | null,
): Promise<ChannelKpis> {
  const range = period === "historico" ? undefined : buildComparisonPeriods(period, now, zonaHoraria).current;
  const [channels, conversations] = await Promise.all([
    repo.getChannelStats(organizationId, propertyIds, range),
    repo.getWhatsappConversationStats(organizationId, propertyIds),
  ]);
  return computeChannelKpis(channels, conversations, period);
}

export function computeChannelKpis(
  channels: ChannelStatsRow,
  conversations: { readonly total: number; readonly withOrder: number; readonly averageMessages: number },
  period: StatsPeriod = "historico",
): ChannelKpis {
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
    periodo: { acotado: channels.acotadoAPeriodo, etiqueta: channelPeriodLabel(period, channels.acotadoAPeriodo) },
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

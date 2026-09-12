// Lógica de datos del dashboard de KPIs (Fase 3) — separada de Dashboard.tsx a
// propósito, mismo motivo que auth-client.ts: probarla con vitest en entorno "node"
// (sin DOM) mientras el componente solo la conecta a estado/render real. Llama a las
// rutas GET /v1/restaurantes/:propertyId/admin/kpis/* de apps/api (ver diseño Fase 3
// §2) — `fetchImpl` inyectado, nunca `globalThis.fetch` directo.
//
// `StatsPeriod` se REDECLARA aquí (en vez de importarse de @atiende/domain-restaurantes)
// a propósito: apps/web no depende de ningún paquete domain-* (ver package.json —
// solo react/react-dom/react-router-dom), mismo aislamiento que ya mantiene
// auth-client.ts al no importar tipos de @atiende/core-auth. Los valores deben
// mantenerse en sync con `STATS_PERIODS` de packages/domain-restaurantes/src/kpis.ts.
export type StatsPeriod = "today" | "7" | "30" | "90" | "180" | "365" | "historico";

export const PERIOD_OPTIONS: ReadonlyArray<{ id: StatsPeriod; label: string }> = [
  { id: "today", label: "Hoy" },
  { id: "7", label: "7 días" },
  { id: "30", label: "30 días" },
  { id: "90", label: "90 días" },
  { id: "180", label: "180 días" },
  { id: "365", label: "365 días" },
  { id: "historico", label: "Histórico" },
];

export interface BranchOption {
  readonly propertyId: string;
  readonly name: string;
  readonly slug: string;
}

export interface SalesKpis {
  readonly revenue: number;
  readonly orders: number;
  readonly customers: number;
  readonly averageOrder: number;
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

export interface ChannelKpis {
  readonly totalOrders: number;
  readonly totalRevenue: number;
  readonly voice: { readonly orders: number; readonly completed: number; readonly cancelled: number; readonly revenue: number };
  readonly whatsapp: { readonly orders: number; readonly completed: number; readonly cancelled: number; readonly revenue: number };
  readonly whatsappConversations: { readonly total: number; readonly withOrder: number; readonly averageMessages: number };
  readonly aiAdoptionPct: number | null;
  readonly aiRevenuePct: number | null;
  readonly estimatedHoursSaved: number;
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

export interface DashboardData {
  readonly sales: SalesKpis;
  readonly trend: readonly SalesTrendPoint[];
  readonly channels: ChannelKpis;
  readonly customers: CustomerKpis;
}

export class DashboardError extends Error {}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new DashboardError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** Helper de descubrimiento (ver admin-kpis.ts): la sesión de login no trae ningún
 * propertyId (solo {id, slug, nombre, vertical, rol}), pero las rutas de KPIs cuelgan
 * de `:propertyId`. Se resuelve UNA vez al entrar al dashboard. */
export async function fetchBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly BranchOption[]> {
  const body = await fetchJson<{ branches: readonly BranchOption[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${orgSlug}/admin/branches`, token);
  return body.branches;
}

export async function fetchDashboardData(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  period: StatsPeriod,
): Promise<DashboardData> {
  const base = `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/kpis`;
  const [sales, trendBody, channels, customers] = await Promise.all([
    fetchJson<SalesKpis>(fetchImpl, `${base}/sales?period=${period}`, token),
    fetchJson<{ buckets: readonly SalesTrendPoint[] }>(fetchImpl, `${base}/sales/trend?period=${period}`, token),
    fetchJson<ChannelKpis>(fetchImpl, `${base}/channels`, token),
    fetchJson<CustomerKpis>(fetchImpl, `${base}/customers`, token),
  ]);
  return { sales, trend: trendBody.buckets, channels, customers };
}

// ---- Formato — nunca un cero/porcentaje fingido: null se pinta "—"/"Sin datos" ----

export function formatMoney(n: number | null): string {
  if (n === null) return "—";
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatInt(n: number | null): string {
  if (n === null) return "—";
  return n.toLocaleString("es-MX");
}

export function formatSignedPct(n: number | null, digits = 1): string {
  if (n === null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}%`;
}

export function formatPct(n: number | null, digits = 0): string {
  if (n === null) return "Sin datos";
  return `${n.toFixed(digits)}%`;
}

export function formatDays(n: number | null): string {
  if (n === null) return "Sin datos";
  return n.toFixed(0);
}

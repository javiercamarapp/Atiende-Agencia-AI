// Dashboard mínimo de KPIs (Fase 3) — cierra el callejón sin salida real que ya existía
// hoy: `decideLandingPath()` (auth-client.ts) devuelve `/restaurantes/${slug}` tras
// login con 1 sola organización, pero esa ruta no existía en App.tsx. Mismo estilo que
// Login.tsx: React simple, estilos inline, sin traer un design system nuevo — esta
// fase es de agregación de backend, no de rediseño visual. Sin sesión persistida ->
// redirige a /restaurantes/login.
//
// Deliberadamente NO incluye (ver diseño §3): selector de sucursal visual (el filtro
// `branchId` ya queda listo en el backend), exportar PDF, ni "Ver más" navegando a
// sub-secciones.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { readPersistedSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import {
  fetchBranches,
  fetchDashboardData,
  formatDays,
  formatInt,
  formatMoney,
  formatPct,
  formatSignedPct,
  PERIOD_OPTIONS,
} from "../dashboard-client.ts";
import type { BranchOption, DashboardData, StatsPeriod } from "../dashboard-client.ts";

export interface DashboardPageProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
}

const TIER_META: Record<"BLACK" | "PLATINUM" | "GOLD" | "BLUE", { label: string; glyph: string; bg: string; fg: string }> = {
  BLACK: { label: "Black", glyph: "♛", bg: "#18181b", fg: "#fafafa" },
  PLATINUM: { label: "Platinum", glyph: "◆", bg: "#e2e8f0", fg: "#334155" },
  GOLD: { label: "Gold", glyph: "★", bg: "#fef3c7", fg: "#92400e" },
  BLUE: { label: "Blue", glyph: "●", bg: "#e0e7ff", fg: "#3730a3" },
};

function Card({ children }: { children: ReactNode }) {
  return <div style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "#fff" }}>{children}</div>;
}

function StatTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card>
      <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>{label}</p>
      <p style={{ fontSize: 22, fontWeight: 600, margin: "4px 0 0" }}>{value}</p>
      {note && (
        <p style={{ fontSize: 12, color: "#6b7280", margin: "4px 0 0" }}>{note}</p>
      )}
    </Card>
  );
}

/** Sparkline SVG inline simple — no se agrega recharts como dependencia nueva solo
 * para dos mini-gráficas en una fase sobre todo de backend (ver diseño §3). */
function Sparkline({ points, color }: { points: readonly number[]; color: string }) {
  const width = 320;
  const height = 64;
  if (points.length === 0) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = max - min || 1;
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const coords = points.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Tendencia">
      <polyline fill="none" stroke={color} strokeWidth={2} points={coords.join(" ")} />
    </svg>
  );
}

export function RestaurantesDashboardPage({ apiBaseUrl, orgSlug, onRequireLogin }: DashboardPageProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  const [period, setPeriod] = useState<StatsPeriod>("30");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = readPersistedSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  useEffect(() => {
    if (!session) return;
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchBranches(fetch, apiBaseUrl, session.token, orgSlug);
        if (!cancelado) setBranches(list);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [session, apiBaseUrl, orgSlug]);

  async function loadKpis(propertyId: string, p: StatsPeriod) {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDashboardData(fetch, apiBaseUrl, session!.token, propertyId, p);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los KPIs.");
    } finally {
      setLoading(false);
    }
  }

  // `loadKpis` se recrea cada render (depende de `session`, ya estable) — no está en
  // el arreglo de dependencias a propósito, mismo patrón que fetchData/dateFilterRef
  // en AdminDashboard.tsx: el efecto reacciona SOLO a `branches`/`period` reales, no a
  // la identidad de la función. Este proyecto no tiene configurado
  // eslint-plugin-react-hooks (no hay otro `// eslint-disable` de esa regla en
  // apps/web), así que no hace falta silenciar nada.
  useEffect(() => {
    if (!branches || branches.length === 0) return;
    void loadKpis(branches[0]!.propertyId, period);
  }, [branches, period]);

  if (session === undefined) return null; // resolviendo sesión persistida
  if (!session) return null; // onRequireLogin ya disparó la redirección

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif", display: "flex", flexDirection: "column", gap: 20 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Panel de {orgSlug}</h1>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => setPeriod(opt.id)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: "1px solid #d1d5db",
                background: period === opt.id ? "#111827" : "#fff",
                color: period === opt.id ? "#fff" : "#111827",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {opt.label}
            </button>
          ))}
          <button
            onClick={() => branches && branches[0] && void loadKpis(branches[0].propertyId, period)}
            disabled={loading || !branches?.length}
            style={{ padding: "6px 12px", borderRadius: 999, border: "1px solid #d1d5db", background: "#fff", fontSize: 12, cursor: "pointer" }}
          >
            {loading ? "Actualizando…" : "Actualizar"}
          </button>
        </div>
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {!data && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}

      {data && (
        <>
          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Tus ventas</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <StatTile label="Ventas netas" value={formatMoney(data.sales.revenue)} note={period === "historico" ? data.sales.periodLabel : `${formatSignedPct(data.sales.revenueChangePct)} ${data.sales.periodLabel}`} />
              <StatTile label="Número de órdenes" value={formatInt(data.sales.orders)} note={period === "historico" ? data.sales.periodLabel : `${formatSignedPct(data.sales.ordersChangePct)} ${data.sales.periodLabel}`} />
              <StatTile label="Valor promedio" value={formatMoney(data.sales.averageOrder)} note={period === "historico" ? data.sales.periodLabel : `${formatSignedPct(data.sales.avgOrderChangePct)} ${data.sales.periodLabel}`} />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
              <Card>
                <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px" }}>Ventas ($)</p>
                <Sparkline points={data.trend.map((p) => p.revenue)} color="#111827" />
              </Card>
              <Card>
                <p style={{ fontSize: 12, color: "#6b7280", margin: "0 0 8px" }}>Órdenes</p>
                <Sparkline points={data.trend.map((p) => p.orders)} color="#2563eb" />
              </Card>
            </div>
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Impacto de tus agentes</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <StatTile label="Pedidos por agentes IA" value={formatPct(data.channels.aiAdoptionPct)} />
              <StatTile label="Ingresos por agentes IA" value={formatPct(data.channels.aiRevenuePct)} />
              <StatTile label="Horas de atención ahorradas" value={`${data.channels.estimatedHoursSaved.toFixed(1)} h`} note="Estimado: ≈5 min de atención humana por pedido resuelto por un agente. Supuesto ajustable, no es una medición real." />
              <StatTile label="Pedidos por voz" value={formatInt(data.channels.voice.orders)} />
              <StatTile label="Pedidos por WhatsApp" value={formatInt(data.channels.whatsapp.orders)} />
              <StatTile label="Ingresos generados por IA" value={formatMoney(data.channels.voice.revenue + data.channels.whatsapp.revenue)} />
            </div>
          </section>

          <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: 0 }}>Clientes</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
              <StatTile label="Clientes totales" value={formatInt(data.customers.totalCustomers)} />
              <StatTile label="Ticket promedio" value={data.customers.averageOrderValue === null ? "Sin datos" : formatMoney(data.customers.averageOrderValue)} />
              <StatTile label="Clientes recurrentes" value={formatPct(data.customers.recurringCustomerPct)} note={data.customers.recurringCustomerPct !== null ? "de quienes ya pidieron al menos una vez" : undefined} />
              <StatTile label="Cliente más frecuente" value={data.customers.topCustomer ? (data.customers.topCustomer.name || data.customers.topCustomer.phone) : "Sin datos"} note={data.customers.topCustomer ? `${data.customers.topCustomer.orderCount} pedidos` : undefined} />
              <StatTile label="Días desde su último pedido" value={formatDays(data.customers.avgDaysSinceLastOrder)} note={data.customers.avgDaysSinceLastOrder !== null ? "promedio de la base" : undefined} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 8, borderTop: "1px dashed #e5e7eb" }}>
              {data.customers.tierDistribution.metric === "sin_datos" ? (
                <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>Todavía no hay pedidos vinculados a clientes ni frecuencia registrada — los tiers aparecen en cuanto haya actividad real.</p>
              ) : (
                (["BLACK", "PLATINUM", "GOLD", "BLUE"] as const).map((tier) => {
                  const meta = TIER_META[tier];
                  return (
                    <span key={tier} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, background: meta.bg, color: meta.fg }}>
                      <span aria-hidden>{meta.glyph}</span>
                      {meta.label}
                      <span style={{ opacity: 0.8 }}>· {data.customers.tierDistribution[tier]}</span>
                    </span>
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

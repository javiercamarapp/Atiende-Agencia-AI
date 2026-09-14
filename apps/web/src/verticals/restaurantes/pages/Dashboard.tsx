// Dashboard de KPIs (Fase 3, montado dentro de RestaurantesShell desde Fase 5.1) —
// landing post-login real: `decideLandingPath()` (auth-client.ts) manda aquí tras
// login con 1 sola organización. Vive DENTRO de RestaurantesShell (ver App.tsx),
// igual que Productos/Sucursales/Pedidos/Historial/Clientes, así el manager que
// entra al producto tiene la nav lateral completa (incluye el link "Panel (KPIs)"
// de vuelta a esta misma página) en vez de quedar en un callejón sin salida donde
// solo se podía llegar al back-office tecleando la URL a mano. Sesión/sucursal ya
// las resuelve el Shell una sola vez — este componente solo consume el contexto,
// mismo patrón que el resto de páginas de este vertical.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { fetchDashboardData, formatDays, formatInt, formatMoney, formatPct, formatSignedPct, PERIOD_OPTIONS } from "../dashboard-client.ts";
import type { DashboardData, StatsPeriod } from "../dashboard-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

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

export function RestaurantesDashboardPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
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
            onClick={() => void loadKpis(period)}
            disabled={loading}
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

// Historial de órdenes (Fase 5) — mismo endpoint de listado que Pedidos.tsx (ver
// comentario de cabecera de admin-orders.ts), con filtro de fecha y paginación por
// cursor en vez de por-estado-operativo.
import { useEffect, useState } from "react";
import { fetchOrders, ORDER_STATUS_LABELS } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary } from "../lib/orders-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const ALL_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema"];

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function HistorialPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "">("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [orders, setOrders] = useState<readonly OrderSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(reset: boolean) {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, {
        status: statusFilter || undefined,
        dateFrom: dateFrom ? new Date(dateFrom).toISOString() : undefined,
        dateTo: dateTo ? new Date(dateTo).toISOString() : undefined,
        limit: 20,
        cursor: reset ? undefined : cursor,
      });
      setOrders((prev) => (reset ? page.orders : [...prev, ...page.orders]));
      setNextCursor(page.nextCursor);
      setCursor(page.nextCursor ?? undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el historial.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, [apiBaseUrl, token, propertyId, statusFilter, dateFrom, dateTo]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Historial de órdenes</h1>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as OrderStatus | "")} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}>
          <option value="">Todos los estados</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {ORDER_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "#6b7280" }}>
          Desde{" "}
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
        </label>
        <label style={{ fontSize: 12, color: "#6b7280" }}>
          Hasta{" "}
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }} />
        </label>
      </div>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}

      {orders.length === 0 && !loading && !error && <p style={{ color: "#6b7280" }}>No hay pedidos en este filtro.</p>}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#6b7280", borderBottom: "1px solid #e5e7eb" }}>
              <th style={{ padding: "6px 8px" }}>Fecha</th>
              <th style={{ padding: "6px 8px" }}>Cliente</th>
              <th style={{ padding: "6px 8px" }}>Sucursal</th>
              <th style={{ padding: "6px 8px" }}>Estado</th>
              <th style={{ padding: "6px 8px" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <td style={{ padding: "8px" }}>{new Date(o.createdAt).toLocaleString("es-MX")}</td>
                <td style={{ padding: "8px" }}>{o.customerName}</td>
                <td style={{ padding: "8px", color: "#6b7280" }}>{o.branch ?? "—"}</td>
                <td style={{ padding: "8px" }}>{ORDER_STATUS_LABELS[o.status]}</td>
                <td style={{ padding: "8px" }}>{formatMoney(o.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {nextCursor && (
        <button onClick={() => void load(false)} disabled={loading} style={{ alignSelf: "flex-start", padding: "6px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", fontSize: 13, cursor: "pointer" }}>
          {loading ? "Cargando…" : "Cargar más"}
        </button>
      )}
    </div>
  );
}

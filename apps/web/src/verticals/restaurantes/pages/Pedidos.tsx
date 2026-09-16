// Pedidos en operación (Fase 5) — lista por estado + cambio de estado real vía la
// máquina de estados de order-lifecycle.ts (el servidor SIEMPRE re-valida la
// transición; los botones ofrecidos aquí son solo un espejo de NEXT_STATUSES para
// no mostrar una acción que el servidor rechazaría).
import { useEffect, useState } from "react";
import { EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { assignRepartidor, fetchOrders, NEXT_STATUSES, ORDER_STATUS_LABELS, updateOrderStatus } from "../lib/orders-client.ts";
import type { OrderStatus, OrderSummary } from "../lib/orders-client.ts";
import { fetchRepartidores } from "../lib/staff-client.ts";
import type { RepartidorMember } from "../lib/staff-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const OPERATIVE_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "problema"];

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PedidosPage({ apiBaseUrl, token, propertyId }: RestaurantesShellContext) {
  const [status, setStatus] = useState<OrderStatus | "todos">("todos");
  const [orders, setOrders] = useState<readonly OrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  // Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
  // no tiene UI"): lista de repartidores REALES de la organización (ver
  // admin-staff.ts::GET .../admin/staff/repartidores) para poblar el selector de abajo.
  // Estado separado de `orders`/`error` a propósito: si este fetch falla, el selector
  // simplemente no aparece -- nunca debe tumbar la lista de pedidos, que es la función
  // principal de esta página.
  const [repartidores, setRepartidores] = useState<readonly RepartidorMember[] | null>(null);
  const [repartidoresError, setRepartidoresError] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      if (status === "todos") {
        const pages = await Promise.all(OPERATIVE_STATUSES.map((s) => fetchOrders(fetch, apiBaseUrl, token, propertyId, { status: s, limit: 50 })));
        const merged = pages.flatMap((p) => p.orders).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setOrders(merged);
      } else {
        const page = await fetchOrders(fetch, apiBaseUrl, token, propertyId, { status, limit: 50 });
        setOrders(page.orders);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, status]);

  async function loadRepartidores() {
    setRepartidoresError(null);
    try {
      setRepartidores(await fetchRepartidores(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setRepartidores(null);
      setRepartidoresError(err instanceof Error ? err.message : "No se pudieron cargar los repartidores.");
    }
  }

  useEffect(() => {
    void loadRepartidores();
  }, [apiBaseUrl, token, propertyId]);

  // Fase 12 — hallazgo de auditoría (severidad ALTA, "'Marcar cancelado' ejecuta con un
  // clic sin confirmación"): "cancelado" es el único estado terminal (NEXT_STATUSES lo
  // deja sin salidas, junto con "completado") que además es un desenlace NEGATIVO — se
  // pierde el pedido, nunca se puede reabrir desde aquí — mismo patrón de confirmación
  // real que citas/Agenda.tsx::runLifecycleAction usa para su acción "cancel". Las demás
  // transiciones (preparando/en_camino/entregado/problema, y "completado" mismo — el
  // desenlace ESPERADO del flujo feliz) no ganan nada con un confirm de más.
  async function handleChangeStatus(order: OrderSummary, nextStatus: OrderStatus) {
    if (nextStatus === "cancelado" && !window.confirm(`¿Cancelar el pedido de ${order.customerName}? Esta acción no se puede deshacer.`)) return;
    setChangingId(order.id);
    setError(null);
    try {
      await updateOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, nextStatus);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar el estado del pedido.");
    } finally {
      setChangingId(null);
    }
  }

  // Fase 12 — dispara el dispatch real (PATCH .../assign-repartidor) en cuanto se
  // elige un repartidor del selector; volver a elegir uno distinto reasigna (el
  // servidor lo permite, no hay restricción de "una sola vez" — ver admin-orders.ts).
  // Elegir "Sin asignar" (repartidorId vacío) es un no-op: no existe un endpoint de
  // "desasignar" en el backend, así que nunca se finge uno aquí.
  async function handleAssignRepartidor(order: OrderSummary, repartidorId: string) {
    if (!repartidorId) return;
    setAssigningId(order.id);
    setError(null);
    try {
      await assignRepartidor(fetch, apiBaseUrl, token, propertyId, order.id, repartidorId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar el repartidor.");
    } finally {
      setAssigningId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Pedidos en operación</h1>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(["todos", ...OPERATIVE_STATUSES] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: "1px solid #d1d5db",
                background: status === s ? "#111827" : "#fff",
                color: status === s ? "#fff" : "#111827",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {s === "todos" ? "Todos" : ORDER_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      </header>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {repartidoresError && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0, fontSize: 12 }}>
          No se pudo cargar la lista de repartidores: {repartidoresError}
        </p>
      )}
      {!orders && !error && <EstadoCargando etiqueta="Cargando pedidos…" />}
      {orders && orders.length === 0 && <EstadoVacio mensaje="No hay pedidos en este filtro." />}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {orders?.map((o) => (
          <div key={o.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>
                  {o.customerName} · {formatMoney(o.total)}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                  {o.customerPhone} · {o.branch ?? "sin sucursal"} · {new Date(o.createdAt).toLocaleString("es-MX")}
                </p>
              </div>
              <span
                style={{
                  alignSelf: "flex-start",
                  fontSize: 12,
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: o.status === "problema" ? "#fee2e2" : "#f3f4f6",
                  color: o.status === "problema" ? "#991b1b" : "#374151",
                }}
              >
                {ORDER_STATUS_LABELS[o.status]}
              </span>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 13, color: "#374151" }}>{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "#374151" }}>
                Repartidor:{" "}
                <select
                  value={o.assignedRepartidorId ?? ""}
                  disabled={assigningId === o.id || !repartidores || repartidores.length === 0}
                  onChange={(e) => void handleAssignRepartidor(o, e.target.value)}
                  style={{ padding: "5px 8px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12 }}
                >
                  <option value="">Sin asignar</option>
                  {repartidores?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
              </label>
              {assigningId === o.id && <span style={{ fontSize: 12, color: "#6b7280" }}>Asignando…</span>}
              {o.estimatedDeliveryAt && (
                <span style={{ fontSize: 12, color: "#6b7280" }}>ETA {new Date(o.estimatedDeliveryAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}</span>
              )}
              {repartidores && repartidores.length === 0 && <span style={{ fontSize: 12, color: "#6b7280" }}>Sin repartidores dados de alta en esta organización.</span>}
            </div>
            {o.incidentNote && <p style={{ margin: "6px 0 0", fontSize: 12, color: "#991b1b" }}>⚠ {o.incidentNote}</p>}

            {NEXT_STATUSES[o.status].length > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {NEXT_STATUSES[o.status].map((next) => (
                  <button
                    key={next}
                    onClick={() => void handleChangeStatus(o, next)}
                    disabled={changingId === o.id}
                    style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #111827", background: "#fff", color: "#111827", fontSize: 12, cursor: "pointer" }}
                  >
                    {changingId === o.id ? "…" : `Marcar ${ORDER_STATUS_LABELS[next]}`}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

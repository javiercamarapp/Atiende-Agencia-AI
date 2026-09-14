// Fase 8 — panel mínimo, real (no maqueta) del rol "repartidor": acotado a SUS
// pedidos asignados, nunca gestión (ver domain-restaurantes/src/roles.ts::
// REPARTIDOR_ROLES). Deliberadamente SIN el shell de nav de RestaurantesShell.tsx:
// ese sidebar apunta a Productos/Sucursales/Historial/Clientes, todas rutas
// MANAGER_ROLES que un repartidor real nunca puede abrir (le devolverían 403) — este
// componente resuelve su propia sesión/property, mismo patrón de useEffect que
// RestaurantesShell, pero sin ese nav. Estilos inline, sin design system nuevo —
// mismo criterio que el resto de este vertical (ver Pedidos.tsx).
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { readPersistedSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";
import { fetchBranches } from "../dashboard-client.ts";
import { fetchAssignedOrders, REPARTIDOR_NEXT_STATUS, updateAssignedOrderStatus } from "../lib/repartidor-client.ts";
import type { RepartidorOrder, RepartidorOrderStatus } from "../lib/repartidor-client.ts";

const STATUS_LABELS: Record<RepartidorOrderStatus, string> = {
  pending: "Recibido",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
  problema: "Incidencia",
};

const NEXT_STATUS_LABEL: Record<RepartidorOrderStatus, string> = {
  pending: "",
  preparando: "Marcar en camino",
  en_camino: "Marcar entregado",
  entregado: "",
  completado: "",
  cancelado: "",
  problema: "",
};

function formatMoney(n: number): string {
  return `$${n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function RepartidorPedidosView({ apiBaseUrl, token, propertyId }: { apiBaseUrl: string; token: string; propertyId: string }) {
  const [orders, setOrders] = useState<readonly RepartidorOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setOrders(await fetchAssignedOrders(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar tus pedidos.");
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, token, propertyId]);

  async function handleAvanzar(order: RepartidorOrder) {
    const next = REPARTIDOR_NEXT_STATUS[order.status];
    if (!next) return;
    setChangingId(order.id);
    setError(null);
    try {
      await updateAssignedOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, next);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo actualizar el pedido.");
    } finally {
      setChangingId(null);
    }
  }

  async function handleReportarIncidencia(order: RepartidorOrder) {
    const nota = window.prompt("¿Qué pasó? (se guarda y administración lo ve de inmediato)");
    if (nota === null) return; // canceló el prompt
    if (!nota.trim()) {
      setError("Escribe qué pasó antes de reportar la incidencia.");
      return;
    }
    setChangingId(order.id);
    setError(null);
    try {
      await updateAssignedOrderStatus(fetch, apiBaseUrl, token, propertyId, order.id, "problema", nota.trim());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo reportar la incidencia.");
    } finally {
      setChangingId(null);
    }
  }

  const activos = orders?.filter((o) => o.status === "preparando" || o.status === "en_camino") ?? [];
  const resto = orders?.filter((o) => o.status !== "preparando" && o.status !== "en_camino") ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Mis entregas</h1>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!orders && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {orders && orders.length === 0 && <p style={{ color: "#6b7280" }}>No tienes ningún pedido asignado por ahora.</p>}

      {[...activos, ...resto].map((o) => {
        const nextLabel = NEXT_STATUS_LABEL[o.status];
        return (
          <div key={o.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <p style={{ margin: 0, fontWeight: 600 }}>
                  {o.customerName} · {formatMoney(o.total)}
                </p>
                <p style={{ margin: "2px 0 0", fontSize: 12, color: "#6b7280" }}>
                  {o.customerPhone} · {new Date(o.createdAt).toLocaleString("es-MX")}
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
                {STATUS_LABELS[o.status]}
              </span>
            </div>

            {o.customerAddress && <p style={{ margin: "8px 0 0", fontSize: 13, color: "#374151" }}>📍 {o.customerAddress}</p>}
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "#374151" }}>{o.items.map((it) => `${it.quantity}× ${it.name}`).join(", ")}</p>
            {o.incidentNote && <p style={{ margin: "6px 0 0", fontSize: 13, color: "#991b1b" }}>⚠ {o.incidentNote}</p>}

            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {o.customerAddress && (
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.customerAddress)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12, textDecoration: "none", color: "#111827" }}
                >
                  Mapa
                </a>
              )}
              <a href={`tel:${o.customerPhone}`} style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 12, textDecoration: "none", color: "#111827" }}>
                Llamar
              </a>
              {nextLabel && (
                <button
                  onClick={() => void handleAvanzar(o)}
                  disabled={changingId === o.id}
                  style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #111827", background: "#111827", color: "#fff", fontSize: 12, cursor: "pointer" }}
                >
                  {changingId === o.id ? "…" : nextLabel}
                </button>
              )}
              {(o.status === "pending" || o.status === "preparando" || o.status === "en_camino") && (
                <button
                  onClick={() => void handleReportarIncidencia(o)}
                  disabled={changingId === o.id}
                  style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #b91c1c", background: "#fff", color: "#b91c1c", fontSize: 12, cursor: "pointer" }}
                >
                  Reportar incidencia
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function RepartidorPedidosPage() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:8787";

  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [propertyId, setPropertyId] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const s = readPersistedSession(window.localStorage);
    setSession(s);
    if (!s) navigate("/restaurantes/login", { replace: true });
  }, [navigate]);

  useEffect(() => {
    if (!session || !orgSlug) return;
    let cancelado = false;
    (async () => {
      try {
        const branches = await fetchBranches(fetch, apiBaseUrl, session.token, orgSlug);
        if (cancelado) return;
        if (branches.length === 0) {
          setError("Este negocio todavía no tiene ninguna sucursal configurada.");
          return;
        }
        // Igual que RestaurantesShell.tsx: usa la primera sucursal hasta que haya un
        // selector visual real. Para repartidor esto solo ancla la resolución de
        // organización/rol (ver requirePropertyMembership) -- la lista de pedidos NO
        // se filtra por esta sucursal, es SIEMPRE "lo que tengo asignado" (ver
        // repartidor-orders.ts).
        setPropertyId(branches[0]!.propertyId);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [session, orgSlug, apiBaseUrl]);

  if (!orgSlug) return null;
  if (session === undefined || (session && propertyId === undefined)) return null;
  if (!session) return null; // ya redirigió a login

  if (error) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      </main>
    );
  }

  if (!propertyId) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p style={{ color: "#6b7280" }}>Cargando…</p>
      </main>
    );
  }

  return <RepartidorPedidosView apiBaseUrl={apiBaseUrl} token={session.token} propertyId={propertyId} />;
}

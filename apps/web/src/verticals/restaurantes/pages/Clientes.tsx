// Clientes (Fase 5) — lista + búsqueda + ficha real (tier/direcciones/"lo de
// siempre") sobre exactamente lo que customers.ts ya calcula — ver
// admin-customers.ts. Nunca inventa campos nuevos.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchCustomerDetail, fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerDetail, CustomerSummary, CustomerTier } from "../lib/customers-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const TIER_META: Record<CustomerTier, { label: string; glyph: string; bg: string; fg: string }> = {
  BLACK: { label: "Black", glyph: "♛", bg: "#18181b", fg: "#fafafa" },
  PLATINUM: { label: "Platinum", glyph: "◆", bg: "#e2e8f0", fg: "#334155" },
  GOLD: { label: "Gold", glyph: "★", bg: "#fef3c7", fg: "#92400e" },
  BLUE: { label: "Blue", glyph: "●", bg: "#e0e7ff", fg: "#3730a3" },
};

export function ClientesListPage({ apiBaseUrl, token, propertyId, orgSlug }: RestaurantesShellContext) {
  const [search, setSearch] = useState("");
  const [customers, setCustomers] = useState<readonly CustomerSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { search: search || undefined, limit: 50 })
      .then((page) => !cancelado && setCustomers(page.customers))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los clientes."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 style={{ fontSize: 20, margin: 0 }}>Clientes</h1>
      <input
        placeholder="Buscar por nombre o teléfono…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, maxWidth: 320 }}
      />

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!customers && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {customers && customers.length === 0 && <p style={{ color: "#6b7280" }}>No se encontraron clientes.</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {customers?.map((c) => (
          <Link key={c.id} to={`/restaurantes/${orgSlug}/clientes/${c.id}`} style={{ display: "block", border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, textDecoration: "none", color: "inherit" }}>
            <p style={{ margin: 0, fontWeight: 600 }}>{c.name ?? c.phone}</p>
            <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>
              {c.phone} · {c.orderCount} pedido{c.orderCount === 1 ? "" : "s"}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}

export interface ClienteFichaPageProps extends RestaurantesShellContext {
  readonly customerId: string;
}

export function ClienteFichaPage({ apiBaseUrl, token, propertyId, orgSlug, customerId }: ClienteFichaPageProps) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomerDetail(fetch, apiBaseUrl, token, propertyId, customerId)
      .then((d) => !cancelado && setDetail(d))
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudo cargar el cliente."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, customerId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 520 }}>
      <Link to={`/restaurantes/${orgSlug}/clientes`} style={{ fontSize: 13, color: "#6b7280" }}>
        ← Volver a clientes
      </Link>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!detail && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {detail?.isNew && <p style={{ color: "#6b7280" }}>Este cliente todavía no tiene ningún pedido registrado.</p>}

      {detail && !detail.isNew && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <h1 style={{ fontSize: 20, margin: 0 }}>{detail.name ?? "Sin nombre"}</h1>
            {detail.tier && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, fontSize: 12, fontWeight: 500, background: TIER_META[detail.tier].bg, color: TIER_META[detail.tier].fg }}>
                <span aria-hidden>{TIER_META[detail.tier].glyph}</span>
                {TIER_META[detail.tier].label}
              </span>
            )}
          </div>

          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 8, columnGap: 12, fontSize: 14 }}>
            <dt style={{ color: "#6b7280" }}>Pedidos totales</dt>
            <dd style={{ margin: 0 }}>{detail.orderCount}</dd>
          </dl>

          <section>
            <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>Direcciones guardadas</p>
            {detail.addresses.length === 0 ? (
              <p style={{ color: "#6b7280", fontSize: 13 }}>Sin direcciones guardadas.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {detail.addresses.map((a, i) => (
                  <li key={i}>
                    {a.address} {a.isDefault && <span style={{ color: "#6b7280" }}>(principal)</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <p style={{ margin: "0 0 8px", fontSize: 13, fontWeight: 600 }}>Lo que más pide</p>
            {detail.frequentItems.length === 0 ? (
              <p style={{ color: "#6b7280", fontSize: 13 }}>Sin historial suficiente todavía.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                {detail.frequentItems.map((item, i) => (
                  <li key={i}>
                    {item.quantity}× {item.name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.agentNotes.length > 0 && (
            <section style={{ border: "1px dashed #d1d5db", borderRadius: 10, padding: 12 }}>
              <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "#6b7280" }}>Notas para el agente</p>
              {detail.agentNotes.map((note, i) => (
                <p key={i} style={{ margin: "4px 0 0", fontSize: 13 }}>
                  {note}
                </p>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}

// Clientes del panel de citas (Fase 5) — lista paginada con búsqueda + ficha con
// citas próximas reales (customers-client.ts). El cliente se crea/actualiza solo
// implícitamente al reservar (upsertCustomer, Fase 1) — el panel nunca crea/edita
// un cliente directamente.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchCustomerDetail, fetchCustomers } from "../lib/customers-client.ts";
import type { CustomerDetail, CustomerSummary } from "../lib/customers-client.ts";
import { formatDateTime } from "../lib/format.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

const PAGE_SIZE = 20;

export function ClientesListPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [customers, setCustomers] = useState<readonly CustomerSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelado = false;
    fetchCustomers(fetch, apiBaseUrl, token, propertyId, { limit: PAGE_SIZE, offset, search: search || undefined })
      .then((page) => {
        if (cancelado) return;
        setCustomers(page.items);
        setTotal(page.total);
        setNextOffset(page.nextOffset);
      })
      .catch((err: unknown) => !cancelado && setError(err instanceof Error ? err.message : "No se pudieron cargar los clientes."));
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId, offset, search]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Clientes</h1>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
          placeholder="Buscar por nombre o teléfono…"
          style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", minWidth: 220 }}
        />
      </header>

      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!customers && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {customers && customers.length === 0 && <p style={{ color: "#6b7280" }}>{search ? "Ningún cliente coincide con esa búsqueda." : "Este negocio todavía no tiene clientes."}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {customers?.map((c) => (
          <Link key={c.id} to={`/citas/${orgSlug}/clientes/${c.id}`} style={{ display: "flex", justifyContent: "space-between", border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, textDecoration: "none", color: "inherit" }}>
            <span style={{ fontWeight: 600 }}>{c.fullName}</span>
            <span style={{ color: "#6b7280", fontSize: 13 }}>
              {c.phone}
              {c.email ? ` · ${c.email}` : ""}
            </span>
          </Link>
        ))}
      </div>

      {customers && customers.length > 0 && (
        <footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "#6b7280" }}>
          <span>
            {offset + 1}–{offset + customers.length} de {total}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
              ← Anterior
            </button>
            <button onClick={() => nextOffset !== null && setOffset(nextOffset)} disabled={nextOffset === null} style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
              Siguiente →
            </button>
          </div>
        </footer>
      )}
    </div>
  );
}

export interface ClienteFichaPageProps extends CitasShellContext {
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
    <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 560 }}>
      <Link to={`/citas/${orgSlug}/clientes`} style={{ fontSize: 13, color: "#6b7280" }}>
        ← Volver a clientes
      </Link>
      {error && (
        <p role="alert" style={{ color: "#b91c1c", margin: 0 }}>
          {error}
        </p>
      )}
      {!detail && !error && <p style={{ color: "#6b7280" }}>Cargando…</p>}
      {detail && (
        <>
          <header>
            <h1 style={{ fontSize: 20, margin: 0 }}>{detail.customer.fullName}</h1>
            <p style={{ margin: "4px 0 0", color: "#6b7280" }}>
              {detail.customer.phone}
              {detail.customer.email ? ` · ${detail.customer.email}` : ""}
            </p>
          </header>
          <section>
            <p style={{ margin: "0 0 8px", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280" }}>Próximas citas</p>
            {detail.upcomingAppointments.length === 0 ? (
              <p style={{ margin: 0, color: "#6b7280" }}>Sin citas próximas.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {detail.upcomingAppointments.map((apt) => (
                  <div key={apt.id} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 12 }}>
                    <p style={{ margin: 0, fontWeight: 600 }}>{apt.serviceName ?? "Servicio desconocido"}</p>
                    <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6b7280" }}>
                      {formatDateTime(apt.startsAt)} · {apt.providerName ?? "Proveedor desconocido"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

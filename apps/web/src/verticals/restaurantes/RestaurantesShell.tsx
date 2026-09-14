// Shell del back-office CORE de restaurantes (Fase 5) — mismo patrón que
// CitasShell.tsx (Fase 5 citas): resuelve sesión + propertyId UNA vez y le da a las
// páginas nuevas (Productos/Sucursales/Pedidos/Historial/Clientes) la misma nav
// lateral, además de un link de vuelta al Dashboard de KPIs (Fase 3, fuera de este
// shell — ver Dashboard.tsx). Estilos inline, sin design system nuevo — mismo
// criterio que el resto de este vertical.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { readPersistedSession } from "../../lib/auth-client.ts";
import type { LoginSession } from "../../lib/auth-client.ts";
import { fetchBranches } from "./dashboard-client.ts";
import type { BranchOption } from "./dashboard-client.ts";

export interface RestaurantesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
}

export interface RestaurantesShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: RestaurantesShellContext) => ReactNode;
}

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "productos", label: "Productos" },
  { to: "sucursales", label: "Sucursales" },
  { to: "pedidos", label: "Pedidos" },
  { to: "historial", label: "Historial" },
  { to: "clientes", label: "Clientes" },
];

const linkStyle = (isActive: boolean): CSSProperties => ({
  display: "block",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
  textDecoration: "none",
  color: isActive ? "#fff" : "#111827",
  background: isActive ? "#111827" : "transparent",
});

export function RestaurantesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: RestaurantesShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
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

  if (session === undefined) return null; // resolviendo sesión persistida
  if (!session) return null; // onRequireLogin ya disparó la redirección

  if (error) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p role="alert" style={{ color: "#b91c1c" }}>
          {error}
        </p>
      </main>
    );
  }

  if (!branches) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p style={{ color: "#6b7280" }}>Cargando…</p>
      </main>
    );
  }

  if (branches.length === 0) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Este negocio todavía no tiene ninguna sucursal configurada.
        </p>
      </main>
    );
  }

  // Igual que el Dashboard de KPIs (Fase 3): usa la primera sucursal hasta que haya
  // un selector visual real (fuera de alcance de esta fase, ver diseño §1).
  const propertyId = branches[0]!.propertyId;

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Restaurantes · {orgSlug}</p>
        <NavLink to={`/restaurantes/${orgSlug}`} end style={({ isActive }) => linkStyle(isActive)}>
          Panel (KPIs)
        </NavLink>
        <div style={{ height: 1, background: "#f3f4f6", margin: "6px 0" }} />
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/restaurantes/${orgSlug}/${item.to}`} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div style={{ flex: 1, padding: 24, overflow: "auto" }}>{children({ apiBaseUrl, token: session.token, propertyId, orgSlug })}</div>
    </div>
  );
}

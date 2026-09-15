// Shell del back-office CORE de restaurantes (Fase 5, ahora también landing post-
// login desde Fase 5.1) — mismo patrón que CitasShell.tsx (Fase 5 citas): resuelve
// sesión + propertyId UNA vez y le da a todas las páginas (Panel de KPIs incluido,
// ver Dashboard.tsx, más Productos/Sucursales/Pedidos/Historial/Clientes) la misma
// nav lateral, así el manager que entra al producto siempre tiene camino de vuelta
// al back-office y viceversa. Estilos inline, sin design system nuevo — mismo
// criterio que el resto de este vertical.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Navigate, NavLink } from "react-router-dom";
import { clearSession, logout, readPersistedSession } from "../../lib/auth-client.ts";
import type { LoginSession } from "../../lib/auth-client.ts";
import { fetchBranches } from "./dashboard-client.ts";
import type { BranchOption } from "./dashboard-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";

export interface RestaurantesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (owner/admin/staff/repartidor,
   * ver domain-restaurantes/src/roles.ts) — Fase 14, mismo criterio ya usado por
   * DespachosShell.tsx/LicitacionesShell.tsx: cosmético, para ocultar en el nav/UI
   * acciones que el servidor rechazaría igual (STAFF_INVITE_ROLES en admin-staff.ts
   * es SIEMPRE el enforcement real). */
  readonly role: string;
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
  // Fase 11 — hallazgo de auditoría (severidad ALTA, "Promociones/códigos de
  // descuento (Fase 11) sin UI"): ver Promociones.tsx/promotions-client.ts.
  { to: "promociones", label: "Promociones" },
];

/** Fase 14 — mismo `STAFF_INVITE_ROLES` que `domain-restaurantes/src/roles.ts`
 * (duplicado aquí a propósito, ver el comentario de `StaffVerticalRole` en
 * lib/staff-client.ts): solo oculta el link "Staff" del nav para quien el servidor
 * rechazaría de todas formas (403 en admin-staff.ts) — nunca la única barrera. */
const STAFF_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

const linkStyle = (isActive: boolean): CSSProperties => ({
  display: "block",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
  textDecoration: "none",
  color: isActive ? "#fff" : "#111827",
  background: isActive ? "#111827" : "transparent",
});

const logoutButtonStyle: CSSProperties = {
  marginTop: "auto",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
  textAlign: "left",
  color: "#b91c1c",
  background: "transparent",
  border: "1px solid #fecaca",
  cursor: "pointer",
};

export function RestaurantesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: RestaurantesShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que hoteles ("No existe botón ni flujo de 'Cerrar
  // sesión' en ninguna pantalla de restaurantes"): /auth/logout ya existe en el
  // backend (compartido entre verticales), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
  // "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
  // redirección"): fetchJson/sendJson de dashboard-client.ts/lib/admin-client.ts ya
  // intentan un refresh automático ante un 401 (ver ../../lib/authed-fetch.ts), pero
  // si ESE refresh también falla no tienen forma de navegar (no son componentes
  // React). Disparan SESSION_EXPIRED_EVENT en `window`; este Shell escucha y reusa
  // el `onRequireLogin` que ya tenía. Filtra por `detail.vertical` para no
  // reaccionar al session-expired de otra vertical abierta en otra pestaña.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "restaurantes") return;
      clearSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [onRequireLogin]);

  async function handleLogout() {
    if (!session) return;
    setLoggingOut(true);
    try {
      await logout(fetch, apiBaseUrl, session.refreshToken);
    } finally {
      clearSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
  }

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
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "staff";

  // Ronda 13 — hallazgo de auditoría (severidad ALTA, mismo archivo de causa que el
  // listener de SESSION_EXPIRED_EVENT de arriba): un repartidor que entra por URL
  // directa a `/restaurantes/:slug` (no por el link de su invitación, que ya lo manda
  // a `/restaurantes/:slug/repartidor` vía `decideLandingPathForInvite`, ver
  // shell-landing-path.spec.ts) llegaba HASTA AQUÍ, con este Shell pintando el nav de
  // gestión completo (Productos/Sucursales/Pedidos/Historial/Clientes) para un rol
  // que `MANAGER_ROLES` (domain-restaurantes/src/roles.ts) excluye a propósito — y el
  // `<Dashboard>` que las rutas hijas renderizan ahí responde 403 porque el backend sí
  // aplica esa misma lista. Redirige ANTES de pintar ese nav, al único panel que el
  // backend de verdad le permite (mismo REPARTIDOR_ROLES) — nunca al revés: un
  // MANAGER_ROLE nunca pasa por aquí (siempre es "staff" para cualquier rol vertical
  // que no reconozca, ver el `?? "staff"` de arriba, así que solo "repartidor" exacto
  // dispara esto).
  if (role === "repartidor") {
    return <Navigate to={`/restaurantes/${orgSlug}/repartidor`} replace />;
  }

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
        {/* Fase 14 — hallazgo de auditoría (severidad ALTA, "Invitaciones de staff sin
            ninguna UI"): ver STAFF_NAV_ROLES arriba. */}
        {STAFF_NAV_ROLES.has(role) && (
          <NavLink to={`/restaurantes/${orgSlug}/staff`} style={({ isActive }) => linkStyle(isActive)}>
            Staff
          </NavLink>
        )}
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0" }}>Rol: {role}</p>
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      <div style={{ flex: 1, padding: 24, overflow: "auto" }}>{children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role })}</div>
    </div>
  );
}

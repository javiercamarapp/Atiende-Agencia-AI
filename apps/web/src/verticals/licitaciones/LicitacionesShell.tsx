// Shell del panel de licitaciones (Fase 7) — resuelve sesión + propertyId UNA vez
// (mismo patrón de descubrimiento que CitasShell.tsx/restaurantes/Dashboard.tsx:
// la sesión de login nunca trae un propertyId, solo se resuelve al entrar al
// panel, vía GET /v1/licitaciones/:orgSlug/admin/branches) y le da a las páginas
// del panel (Convocatorias/detalle) la misma nav lateral y el mismo `role` del
// staff (para ocultar acciones que el servidor rechazaría igual, cosmético — el
// enforcement real es SIEMPRE server-side, ver WRITE_ROLES/GO_NO_GO_ROLES).
// Estilos inline, sin design system nuevo — mismo criterio que el resto de este
// monorepo (ver README de este vertical).
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearLicitacionesSession, logout, readPersistedLicitacionesSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchBranches } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";
import { ATIENDE_LOGO_DATA_URI, LICITACIONES_TAB_TITLE } from "./lib/brand.ts";

export interface LicitacionesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (owner/admin/analyst/writer/reviewer/viewer,
   * ver domain-licitaciones/src/roles.ts) — cosmético, para ocultar botones que el
   * servidor rechazaría igual; nunca la única barrera. */
  readonly role: string;
}

export interface LicitacionesShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: LicitacionesShellContext) => ReactNode;
}

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "convocatorias", label: "Convocatorias" },
  { to: "radar-renovaciones", label: "Radar de renovaciones" },
  { to: "perfil-matching", label: "Perfil de matching" },
  { to: "datos-empresa", label: "Datos de la empresa" },
];

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): mismo `STAFF_INVITE_ROLES`
// que domain-licitaciones/src/roles.ts (duplicado aquí a propósito, ver el
// comentario de `role` de `LicitacionesShellContext`) — solo oculta el link
// "Staff" del nav para quien el servidor rechazaría de todas formas (403 en
// admin-staff.ts), nunca la única barrera.
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

export function LicitacionesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: LicitacionesShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que hoteles/restaurantes/citas: /auth/logout ya
  // existe en el backend (compartido entre verticales), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedLicitacionesSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría ("título de pestaña fijo en 'Restaurantes'") — ver
  // el comentario de `LICITACIONES_TAB_TITLE` en lib/brand.ts.
  useEffect(() => {
    document.title = LICITACIONES_TAB_TITLE;
  }, []);

  // Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
  // "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
  // redirección"): fetchJson/postJson de lib/admin-client.ts ya intentan un refresh
  // automático ante un 401 (ver ../../lib/authed-fetch.ts); si ESE refresh también
  // falla disparan SESSION_EXPIRED_EVENT en `window` — este Shell escucha y reusa el
  // `onRequireLogin` que ya tenía. Filtra por `detail.vertical` para no reaccionar
  // al session-expired de otra vertical abierta en otra pestaña.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "licitaciones") return;
      clearLicitacionesSession(window.localStorage);
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
      clearLicitacionesSession(window.localStorage);
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
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar la organización.");
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
          Esta organización todavía no tiene ninguna property configurada.
        </p>
      </main>
    );
  }

  // §2.1 del diseño Fase 1 — licitaciones opera como property singleton por
  // organización (a diferencia de hoteles, multi-hotel bajo una sola cuenta): el
  // panel usa la primera property, mismo criterio que CitasShell.tsx.
  const propertyId = branches[0]!.propertyId;
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "viewer";

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <img src={ATIENDE_LOGO_DATA_URI} alt="atiende" width={88} height={16} style={{ display: "block", marginBottom: 10 }} />
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Licitaciones · {orgSlug}</p>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/licitaciones/${orgSlug}/${item.to}`} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
        {/* Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
            restaurantes permite gestionar roles desde el producto"): ver
            STAFF_NAV_ROLES arriba. */}
        {STAFF_NAV_ROLES.has(role) && (
          <NavLink to={`/licitaciones/${orgSlug}/staff`} style={({ isActive }) => linkStyle(isActive)}>
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

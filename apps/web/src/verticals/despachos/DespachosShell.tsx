// Shell del panel de staff de despachos (Fase 9) — primera UI operativa real de
// este vertical más allá del login (ver README: hasta esta fase solo existía
// Login.tsx, pese a que los motores de dominio (CFDI/conciliación/migración de
// catálogo/cierre mensual/nómina/contabilidad electrónica) ya estaban completos).
// Mismo patrón exacto que HotelesShell.tsx/LicitacionesShell.tsx: resuelve sesión +
// propertyId UNA vez (vía lib/admin-client.ts::fetchBranches, plumbing nuevo de
// esta fase — ver GET /v1/despachos/:orgSlug/admin/branches, admin.ts) y le da a
// las páginas nuevas (CierreMensual/Cfdi) la misma nav lateral y el mismo `role`
// del staff (cosmético, para ocultar acciones que el servidor rechazaría igual — el
// enforcement real es SIEMPRE server-side, ver VER_CIERRE_MENSUAL_ROLES/
// GESTIONAR_CIERRE_MENSUAL_ROLES/CERRAR_PERIODO_ROLES en roles.ts). Estilos
// inline, sin design system nuevo — mismo criterio que el resto de este monorepo.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearDespachosSession, logout, readPersistedDespachosSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchBranches } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";

export interface DespachosShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (admin/contador/auditor/
   * readonly, ver domain-despachos/src/roles.ts) — cosmético, para ocultar botones
   * que el servidor rechazaría igual; nunca la única barrera. */
  readonly role: string;
}

export interface DespachosShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: DespachosShellContext) => ReactNode;
}

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "cierre-mensual", label: "Cierre mensual" },
  { to: "cfdi", label: "CFDI" },
  { to: "cobranza", label: "Cobranza" },
  { to: "vencimientos", label: "Vencimientos" },
  { to: "declaraciones", label: "Declaraciones" },
  { to: "nomina", label: "Nómina" },
  { to: "conciliacion", label: "Conciliación bancaria" },
  { to: "migracion-catalogo", label: "Migración de catálogo" },
  { to: "devolucion-iva", label: "Devolución de IVA" },
  { to: "bookkeeping", label: "Bookkeeping" },
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

export function DespachosShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: DespachosShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que hoteles/restaurantes/citas/licitaciones:
  // /auth/logout ya existe en el backend (compartido entre verticales), solo
  // faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedDespachosSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

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
      if (detail?.vertical !== "despachos") return;
      clearDespachosSession(window.localStorage);
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
      clearDespachosSession(window.localStorage);
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
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar el despacho.");
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
          Este despacho todavía no tiene ninguna property configurada.
        </p>
      </main>
    );
  }

  // Despachos opera como property singleton por organización (mismo criterio que
  // licitaciones/citas §2.1 — un despacho no tiene "propiedades" físicas relevantes
  // al dominio): el panel usa la primera property hasta que haya un caso de negocio
  // real que necesite más de una.
  const propertyId = branches[0]!.propertyId;
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "readonly";

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Despachos · {orgSlug}</p>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/despachos/${orgSlug}/${item.to}`} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0" }}>Rol: {role}</p>
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      <div style={{ flex: 1, padding: 24, overflow: "auto" }}>{children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role })}</div>
    </div>
  );
}

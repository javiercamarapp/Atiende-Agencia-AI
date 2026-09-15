// Shell del panel de administración visual de citas (Fase 5) — resuelve sesión +
// propertyId UNA vez (mismo patrón de descubrimiento que
// restaurantes/pages/Dashboard.tsx: la sesión de login nunca trae un propertyId,
// solo se resuelve al entrar al panel) y le da a las 6 páginas
// (Agenda/Proveedores/Servicios/Clientes/Disponibilidad/Configuración) la misma
// nav lateral. Estilos inline, sin design system nuevo — mismo criterio que el
// resto de este vertical (ver README): esta fase es de CRUD de UI sobre lógica ya
// existente, no de rediseño visual.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearCitasSession, logout, readPersistedCitasSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchBranches, resolveActivePropertyId } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";

export interface CitasShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** UUID real de `core.organization` (Fase 10 — antes solo vivía embebido en el
   * JWT/`session.organizations`, nunca expuesto al contexto). Lo necesita
   * `realtime-client.ts` para el filtro `organization_id=eq.<orgId>` de la
   * suscripción — mismo patrón ya usado para `role` en
   * DespachosShell.tsx/LicitacionesShell.tsx: `session.organizations.find`. */
  readonly orgId: string;
  /** Fase 12 — hallazgo de auditoría ("citas define 3 roles de plataforma pero no
   * los aplica en NINGUNA capa"): mismo patrón exacto que DespachosShell.tsx/
   * LicitacionesShell.tsx (`session.organizations.find((o) => o.slug ===
   * orgSlug)?.rol`) — cosmético del lado del cliente (ocultar el formulario de
   * invitar cuando el rol no alcanza), el enforcement real sigue siendo SIEMPRE el
   * servidor (admin-staff.ts::assertVerticalRole + canInviteStaff). */
  readonly role: string;
}

export interface CitasShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: CitasShellContext) => ReactNode;
}

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "agenda", label: "Agenda" },
  { to: "proveedores", label: "Proveedores" },
  { to: "servicios", label: "Servicios" },
  { to: "clientes", label: "Clientes" },
  { to: "disponibilidad", label: "Disponibilidad" },
  { to: "configuracion", label: "Configuración" },
  { to: "staff", label: "Staff" },
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

const selectLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "#6b7280",
  margin: "0 0 4px",
};

const selectStyle: CSSProperties = {
  display: "block",
  width: "100%",
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #d1d5db",
  fontSize: 13,
  color: "#111827",
  background: "#fff",
  boxSizing: "border-box",
};

export function CitasShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: CitasShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  // Sucursal activa elegida en el selector de abajo -- mismo patrón exacto que
  // HotelesShell.tsx/RestaurantesShell.tsx: `null` hasta que el staff elige una
  // explícitamente, inicializado leyendo lib/property-selection.ts (persistido para
  // este `orgSlug`) para que sobreviva a que App.tsx monte una instancia NUEVA de
  // este Shell al navegar a otra ruta del panel.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(() => readPersistedPropertyId(window.localStorage, orgSlug));
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que hoteles/restaurantes: /auth/logout ya existe en
  // el backend (compartido entre verticales), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedCitasSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
  // "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
  // redirección"): fetchJson/sendJson de lib/admin-client.ts ya intentan un refresh
  // automático ante un 401 (ver ../../lib/authed-fetch.ts); si ESE refresh también
  // falla disparan SESSION_EXPIRED_EVENT en `window` (no son componentes React y no
  // reciben `onRequireLogin`) — este Shell escucha y reusa el `onRequireLogin` que
  // ya tenía. Filtra por `detail.vertical` para no reaccionar al session-expired de
  // otra vertical abierta en otra pestaña.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "citas") return;
      clearCitasSession(window.localStorage);
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
      clearCitasSession(window.localStorage);
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

  // Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA, "negocio
  // de citas con 2+ sucursales solo opera la primera"): antes se usaba SIEMPRE
  // `branches[0]!.propertyId` ("hasta que un negocio real necesite elegir entre
  // varias") — ver el comentario de cabecera de `resolveActivePropertyId`
  // (./lib/admin-client.ts) para el hallazgo completo y el patrón (idéntico a
  // hoteles/despachos/rentas/restaurantes) que lo cierra.
  const propertyId = resolveActivePropertyId(branches, selectedPropertyId)!;
  const activeBranch = branches.find((b) => b.propertyId === propertyId)!;
  const orgId = session.organizations.find((o) => o.slug === orgSlug)?.id ?? "";
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "staff";

  // Handler real del selector: actualiza el estado de React (recalcula
  // `children(ctx)` con el nuevo propertyId de inmediato, vía la `key={propertyId}`
  // de abajo) y persiste la selección best-effort (ver lib/property-selection.ts)
  // para que sobreviva a navegar a otra ruta del panel o a un refresh de página.
  function handleSelectBranch(nextPropertyId: string) {
    setSelectedPropertyId(nextPropertyId);
    persistPropertyId(window.localStorage, orgSlug, nextPropertyId);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Citas · {orgSlug}</p>
        {/* Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA):
            selector real, visible solo cuando hay más de una sucursal — mismo
            criterio que "Hotel activo" en HotelesShell.tsx. */}
        {branches.length > 1 ? (
          <div style={{ margin: "0 0 8px" }}>
            <label htmlFor="citas-sucursal-activa" style={selectLabelStyle}>
              Sucursal activa
            </label>
            <select id="citas-sucursal-activa" value={propertyId} onChange={(e) => handleSelectBranch(e.target.value)} style={selectStyle}>
              {branches.map((b) => (
                <option key={b.propertyId} value={b.propertyId}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 8px" }}>{activeBranch.name}</p>
        )}
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/citas/${orgSlug}/${item.to}`} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      {/* `key={propertyId}` fuerza a React a desmontar/remontar las páginas hijas
          cuando la sucursal activa cambia DENTRO de la misma instancia de Shell
          (selector, sin navegar) — mismo criterio que HotelesShell.tsx. */}
      <div key={propertyId} style={{ flex: 1, padding: 24, overflow: "auto" }}>
        {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, orgId, role })}
      </div>
    </div>
  );
}

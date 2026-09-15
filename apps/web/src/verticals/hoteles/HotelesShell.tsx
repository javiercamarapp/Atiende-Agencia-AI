// Shell del panel de staff de hoteles (Fase 7) — primera UI operativa real de este
// vertical más allá del login (ver README: hasta esta fase solo existía Login.tsx).
// Mismo patrón exacto que RestaurantesShell.tsx/CitasShell.tsx: resuelve sesión +
// propertyId UNA vez (vía discovery-client.ts, plumbing nuevo de esta fase — ver su
// comentario de cabecera) y le da a las páginas nuevas (Reservas/Mantenimiento/
// Fraude) la misma nav lateral. Estilos inline, sin design system nuevo — mismo
// criterio que el resto del panel de staff de este repo.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearHotelesSession, logout, readPersistedHotelesSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";

export interface HotelesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
}

export interface HotelesShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: HotelesShellContext) => ReactNode;
}

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "reservas", label: "Reservas" },
  { to: "mantenimiento", label: "Mantenimiento" },
  { to: "fraude", label: "Fraude" },
  { to: "cfdi", label: "CFDI" },
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

export function HotelesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: HotelesShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [properties, setProperties] = useState<readonly PropertyOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles"): deshabilita el botón mientras el POST /auth/logout está en vuelo, para
  // que un clic doble en un equipo compartido de recepción no dispare dos requests —
  // `logout()` es best-effort (nunca lanza, ver su comentario de cabecera en
  // apps/web/src/lib/auth-client.ts), así que esto es solo UX, no manejo de error.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedHotelesSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
  // "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
  // redirección"): `fetchJson`/`sendJson` de lib/admin-client.ts ya intentan un
  // refresh automático ante un 401 (ver ../../lib/authed-fetch.ts), pero cuando ESE
  // refresh también falla (refresh token vencido/revocado, o el staff cerró sesión
  // en otra pestaña) no tienen ninguna forma de navegar — no son componentes React y
  // no reciben `onRequireLogin`. Disparan `SESSION_EXPIRED_EVENT` en `window` en su
  // lugar; este Shell escucha y reusa el `onRequireLogin` que ya tenía para el caso
  // "no hay sesión persistida". El filtro por `detail.vertical` evita reaccionar al
  // session-expired de OTRA vertical si el usuario tiene varias pestañas abiertas en
  // el mismo navegador (cada una con su propia llave de localStorage).
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "hoteles") return;
      clearHotelesSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [onRequireLogin]);

  useEffect(() => {
    if (!session) return;
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchProperties(fetch, apiBaseUrl, session.token, orgSlug);
        if (!cancelado) setProperties(list);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las properties de este hotel.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [session, apiBaseUrl, orgSlug]);

  // Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
  // hoteles"): hasta esta pieza `clearHotelesSession` (lib/auth-client.ts) existía
  // pero NINGÚN componente la llamaba — un staff de recepción no tenía forma de
  // cerrar sesión en un equipo compartido. Revoca el refresh token del lado del
  // servidor (best-effort, ver `logout()`), SIEMPRE limpia la sesión local, y
  // SIEMPRE reusa `onRequireLogin` (la misma redirección a /hoteles/login que ya
  // dispara el efecto de arriba cuando no hay sesión) — nunca deja al staff en un
  // estado intermedio si el POST de red falla.
  async function handleLogout() {
    if (!session) return;
    setLoggingOut(true);
    try {
      await logout(fetch, apiBaseUrl, session.refreshToken);
    } finally {
      clearHotelesSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
  }

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

  if (!properties) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p style={{ color: "#6b7280" }}>Cargando…</p>
      </main>
    );
  }

  if (properties.length === 0) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p role="alert" style={{ color: "#b91c1c" }}>
          Esta organización todavía no tiene ningún hotel (property) configurado.
        </p>
      </main>
    );
  }

  // Igual que el shell de restaurantes: usa el primer hotel hasta que haya un
  // selector visual real (fuera de alcance de esta fase — la mayoría de las
  // organizaciones de hoteles de esta fase operan un solo hotel).
  const propertyId = properties[0]!.propertyId;

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 4px" }}>Hoteles · {orgSlug}</p>
        <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 8px" }}>{properties[0]!.nombre}</p>
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/hoteles/${orgSlug}/${item.to}`} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      <div style={{ flex: 1, padding: 24, overflow: "auto" }}>{children({ apiBaseUrl, token: session.token, propertyId, orgSlug })}</div>
    </div>
  );
}

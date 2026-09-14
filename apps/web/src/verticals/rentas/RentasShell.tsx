// Shell del panel de staff de rentas (Fase 12) — primera UI operativa real de este
// vertical más allá del login (ver README: hasta esta fase solo existía Login.tsx,
// y el login exitoso navegaba a una ruta que ni siquiera existía en <Routes> —
// pantalla en blanco). Mismo patrón exacto que HotelesShell.tsx/CitasShell.tsx:
// resuelve sesión + property UNA vez (vía discovery-client.ts, plumbing nuevo de
// esta fase — ver su comentario de cabecera) y le da a la página de resumen
// (pages/Dashboard.tsx) los datos ya resueltos. Estilos inline, sin design system
// nuevo — mismo criterio que el resto del panel de staff de este repo.
//
// A diferencia de HotelesShell (que solo expone la PRIMERA property, porque todas
// sus páginas hijas ya reciben un propertyId concreto), este shell expone también
// `properties` completo y la `session` — la única página hija de esta fase
// (Dashboard) es justamente el landing que lista las properties de la organización
// y el rol del staff logueado, no una página que opere sobre una sola property.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { clearRentasSession, logout, readPersistedRentasSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";

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

export interface RentasShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly properties: readonly PropertyOption[];
  readonly orgSlug: string;
  readonly session: LoginSession;
}

export interface RentasShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: RentasShellContext) => ReactNode;
}

export function RentasShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: RentasShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [properties, setProperties] = useState<readonly PropertyOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que el resto de las verticales: /auth/logout ya
  // existe en el backend (compartido), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedRentasSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  async function handleLogout() {
    if (!session) return;
    setLoggingOut(true);
    try {
      await logout(fetch, apiBaseUrl, session.refreshToken);
    } finally {
      clearRentasSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
  }

  useEffect(() => {
    if (!session) return;
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchProperties(fetch, apiBaseUrl, session.token, orgSlug);
        if (!cancelado) setProperties(list);
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las propiedades de esta organización.");
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
          Esta organización todavía no tiene ninguna propiedad configurada.
        </p>
      </main>
    );
  }

  // Igual que el shell de hoteles: usa la primera property hasta que haya un
  // selector visual real (fuera de alcance de esta fase).
  const propertyId = properties[0]!.propertyId;

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Rentas · {orgSlug}</p>
        <p style={{ display: "block", padding: "8px 12px", borderRadius: 8, fontSize: 14, color: "#fff", background: "#111827", margin: 0 }}>Resumen</p>
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      <div style={{ flex: 1, padding: 24, overflow: "auto" }}>{children({ apiBaseUrl, token: session.token, propertyId, properties, orgSlug, session })}</div>
    </div>
  );
}

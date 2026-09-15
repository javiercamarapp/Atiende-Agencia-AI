// Shell del panel de staff de rentas (Fase 12) — primera UI operativa real de este
// vertical más allá del login (ver README: hasta esta fase solo existía Login.tsx,
// y el login exitoso navegaba a una ruta que ni siquiera existía en <Routes> —
// pantalla en blanco). Mismo patrón exacto que HotelesShell.tsx/CitasShell.tsx:
// resuelve sesión + property UNA vez (vía discovery-client.ts, plumbing nuevo de
// esta fase — ver su comentario de cabecera) y le da a las páginas hijas los datos
// ya resueltos. Estilos inline, sin design system nuevo — mismo criterio que el
// resto del panel de staff de este repo.
//
// A diferencia de HotelesShell (que solo expone la PRIMERA property, porque todas
// sus páginas hijas ya reciben un propertyId concreto), este shell expone también
// `properties` completo y la `session` — Dashboard (la landing) sigue siendo la
// página que lista las properties de la organización y el rol del staff logueado.
//
// Fase 13 -- agrega el link de nav real a Calendario (NAV_ITEMS/NavLink, mismo
// patrón que HotelesShell.tsx): hasta esta fase la nav solo tenía un párrafo
// estático "Resumen" sin ningún link real porque Dashboard era la única página hija.
//
// Fase 14 -- agrega el link de nav a Precios (cotizador + configuración de pricing,
// ver pages/Precios.tsx): mismo patrón, un renglón más en NAV_ITEMS.
//
// Fase 15 -- agrega el link de nav a Aprobaciones (bandeja de aprobación de
// mensajería, ver pages/Aprobaciones.tsx): cierra el hallazgo de auditoría ALTA
// "la cola de aprobación no tiene botón de aprobar" -- mismo patrón, un renglón más
// en NAV_ITEMS.
//
// Fase 16 -- agrega el link de nav a Finanzas (movimiento por reserva, owner
// statements, payouts/conciliación -- ver pages/Finanzas.tsx): cierra el hallazgo de
// auditoría ALTA "Finanzas sin UI para admin_gestora ni contador" -- mismo patrón,
// un renglón más en NAV_ITEMS.
//
// Fase 17 -- agrega el link de nav a Mis tareas (panel operativo del rol `limpieza`:
// tareas/checklist/inventario/incidencias -- ver pages/MisTareas.tsx): cierra el
// hallazgo de auditoría ALTA "el rol `limpieza` sigue sin ninguna vista funcional" --
// mismo patrón, un renglón más en NAV_ITEMS (MisTareasPage gatea su propio contenido
// por LIMPIEZA_OPERACION_ROLES, igual que FinanzasPage/PreciosPage). Visible para cualquier rol (mismo criterio que
// Precios/Aprobaciones); FinanzasPage gatea su propio contenido por
// FINANZAS_LECTURA_ROLES/FINANZAS_ESCRITURA_ROLES.
//
// Fase 18 -- cierra el hallazgo de auditoría "en rentas, una empresa gestora con
// varias propiedades solo puede operar la primera": hasta esta fase `propertyId` se
// fijaba a `properties[0]` para siempre, con el comentario "hasta que haya un
// selector visual real". A diferencia de hoteles (donde ese atajo se justifica
// porque la mayoría opera un solo hotel -- ver el comentario de cabecera de
// HotelesShell.tsx), en rentas el caso multi-propiedad es EL CASO BASE del vertical
// (una gestora que administra propiedades de más de un anfitrión), así que ese
// atajo dejaba inoperable el caso real más común de la vertical.
//
// Selector real en el header del nav (dropdown si hay 2+ properties; mismo renglón
// que antes mostraba solo el nombre cuando hay exactamente 1) + persistencia vía
// lib/property-selection.ts (ver su comentario de cabecera para el porqué: cada
// ruta de App.tsx monta una instancia NUEVA de este Shell, así que el `useState` de
// abajo por sí solo NO sobrevive a navegar entre páginas del panel).
// `propertyId`/`setPropertyId` ahora viajan en RentasShellContext para que
// cualquier página hija pueda leer y cambiar la property activa (Dashboard.tsx ya
// lo usa para hacer clicables las properties listadas) -- Calendario.tsx/
// Precios.tsx/Aprobaciones.tsx/Finanzas.tsx/MisTareas.tsx NO necesitaron ningún
// cambio: todas ya desestructuraban `propertyId` de este mismo contexto y lo listan
// en el arreglo de dependencias de sus `useEffect` de carga, así que vuelven a
// pedir datos automáticamente en cuanto este Shell les pasa un `propertyId`
// distinto.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearRentasSession, logout, readPersistedRentasSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { persistPropertyId, readPersistedPropertyId, resolveActivePropertyId } from "./lib/property-selection.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";

const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "", label: "Resumen" },
  { to: "calendario", label: "Calendario" },
  { to: "precios", label: "Precios" },
  { to: "aprobaciones", label: "Aprobaciones" },
  { to: "finanzas", label: "Finanzas" },
  { to: "mis-tareas", label: "Mis tareas" },
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

export interface RentasShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Cambia la property activa del Shell (selector del nav, o cualquier página hija
   * -- Dashboard.tsx la usa para hacer clicables las properties listadas). Persiste
   * la selección vía lib/property-selection.ts para que sobreviva tanto a un
   * refresh de página como a navegar a otra ruta del panel (ver el comentario de
   * cabecera de este archivo). */
  readonly setPropertyId: (propertyId: string) => void;
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
  // Fase 18 -- property activa del selector (ver comentario de cabecera del
  // archivo). `null` hasta que `properties` termina de cargar; se resuelve en el
  // mismo efecto que carga `properties` (persistida si sigue siendo válida, si no
  // la primera de la lista -- ver resolveActivePropertyId).
  const [propertyId, setPropertyIdState] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que el resto de las verticales: /auth/logout ya
  // existe en el backend (compartido), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    const s = readPersistedRentasSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
  // "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
  // redirección"): fetchJson de lib/admin-client.ts/discovery-client.ts ya intenta
  // un refresh automático ante un 401 (ver ../../lib/authed-fetch.ts); si ESE
  // refresh también falla dispara SESSION_EXPIRED_EVENT en `window` — este Shell
  // escucha y reusa el `onRequireLogin` que ya tenía. Filtra por `detail.vertical`
  // para no reaccionar al session-expired de otra vertical abierta en otra pestaña.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "rentas") return;
      clearRentasSession(window.localStorage);
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
        if (cancelado) return;
        setProperties(list);
        // Fase 18 -- resuelve la property activa en cuanto se conoce la lista real:
        // la persistida para esta organización si sigue siendo una property válida
        // (pudo desaparecer entre sesiones), si no la primera -- mismo fallback que
        // antes, ahora solo como default inicial en vez de fijo para siempre.
        if (list.length > 0) {
          const persisted = readPersistedPropertyId(window.localStorage, orgSlug);
          setPropertyIdState(resolveActivePropertyId(list, persisted));
        }
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las propiedades de esta organización.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [session, apiBaseUrl, orgSlug]);

  // Fase 18 -- handler real del selector (nav del Shell y RentasDashboardPage, vía
  // RentasShellContext.setPropertyId): actualiza el estado de React (recalcula
  // `children(ctx)` con el nuevo propertyId de inmediato) y persiste la selección
  // best-effort (ver lib/property-selection.ts) para que sobreviva a navegar a otra
  // ruta del panel o a un refresh de página.
  function handleSelectProperty(nextPropertyId: string) {
    setPropertyIdState(nextPropertyId);
    persistPropertyId(window.localStorage, orgSlug, nextPropertyId);
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
          Esta organización todavía no tiene ninguna propiedad configurada.
        </p>
      </main>
    );
  }

  // `propertyId` se resuelve en el efecto de arriba, en el mismo tick en que se
  // conoce `properties` -- este `null` solo cubre el render intermedio entre ambos
  // `setState`, nunca un estado persistente con `properties` ya no vacío.
  if (!propertyId) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <p style={{ color: "#6b7280" }}>Cargando…</p>
      </main>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Rentas · {orgSlug}</p>
        {/* Fase 18 -- selector real de property: dropdown solo cuando hay 2+ (el
            caso base de este vertical, ver comentario de cabecera), mismo renglón
            que antes solo mostraba el nombre cuando había exactamente 1 (mismo
            criterio visual que HotelesShell.tsx muestra `properties[0].nombre`). */}
        {properties.length > 1 ? (
          <label style={{ fontSize: 12, color: "#374151", margin: "0 0 8px", display: "block" }}>
            Propiedad
            <select
              value={propertyId}
              onChange={(e) => handleSelectProperty(e.target.value)}
              style={{ display: "block", width: "100%", padding: "6px 8px", marginTop: 4, borderRadius: 8, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box" }}
            >
              {properties.map((p) => (
                <option key={p.propertyId} value={p.propertyId}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 8px" }}>{properties[0]!.nombre}</p>
        )}
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/rentas/${orgSlug}${item.to ? `/${item.to}` : ""}`} end={item.to === ""} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      <div style={{ flex: 1, padding: 24, overflow: "auto" }}>
        {children({ apiBaseUrl, token: session.token, propertyId, setPropertyId: handleSelectProperty, properties, orgSlug, session })}
      </div>
    </div>
  );
}

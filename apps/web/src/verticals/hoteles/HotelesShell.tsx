// Shell del panel de staff de hoteles (Fase 7) — primera UI operativa real de este
// vertical más allá del login (ver README: hasta esta fase solo existía Login.tsx).
// Mismo patrón exacto que RestaurantesShell.tsx/CitasShell.tsx: resuelve sesión +
// propertyId UNA vez (vía discovery-client.ts, plumbing nuevo de esta fase — ver su
// comentario de cabecera) y le da a las páginas nuevas (Reservas/Mantenimiento/
// Fraude) la misma nav lateral. Estilos inline, sin design system nuevo — mismo
// criterio que el resto del panel de staff de este repo.
//
// Hallazgo de auditoría (severidad ALTA, "cadena con 2+ hoteles solo opera el
// primero"): este Shell fijaba `properties[0]` para siempre, aunque
// GET .../admin/propiedades YA devolvía la lista COMPLETA de properties activas de
// la organización (ver admin-discovery.ts) — una cadena real con más de un hotel no
// podía operar ninguno salvo el primero desde el panel. Ahora expone un selector
// real ("Hotel activo" en la nav, visible cuando hay más de una property) y
// resuelve el `propertyId` activo con `resolveActivePropertyId`
// (discovery-client.ts) en vez de descartar el resto de la lista — MISMO patrón
// exacto que ya resolvió este problema en despachos/rentas
// (DespachosShell.tsx/RentasShell.tsx, leídos primero como plantilla), incluyendo
// la persistencia por organización (lib/property-selection.ts) para que la
// selección sobreviva a navegar entre rutas de React Router (App.tsx monta una
// instancia NUEVA de este Shell por cada ruta Hoteles*Route) y el
// `key={propertyId}` en el contenedor de páginas hijas, para que cambiar de hotel
// SIN navegar (el selector, dentro de la misma instancia de Shell) remonte
// Reservas/Mantenimiento/Fraude/etc. en vez de dejar en pantalla estado local ya
// calculado para el hotel anterior.
//
// Hallazgo de auditoría (severidad MEDIA/BRANDING): agrega el logo real de la
// marca (ver lib/atiende-logo.ts) al header del panel — hasta este cambio el único
// lugar donde un usuario real veía la marca era el correo transaccional. También
// fija `document.title` real ("Atiende — Hoteles") vía el hook genérico
// compartido de ../../shell/use-document-title.ts (construido en esta misma
// ronda de integración por la rama de restaurantes; consolidado aquí al integrar
// para no duplicar el mismo mecanismo dos veces en la misma SPA) en vez de dejar
// el título estático de index.html ("Atiende — Restaurantes") sin importar qué
// vertical estuviera abierta.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearHotelesSession, logout, readPersistedHotelesSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties, resolveActivePropertyId } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { ATIENDE_LOGO_DATA_URI } from "../../lib/atiende-logo.ts";

export interface HotelesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (owner/gm/frontdesk/
   * reservations/housekeeping/maintenance/fnb/accountant, ver
   * domain-hoteles/src/roles.ts) — Fase 15, mismo criterio ya usado por
   * RestaurantesShell.tsx/DespachosShell.tsx/LicitacionesShell.tsx: cosmético,
   * para ocultar en el nav/UI acciones que el servidor rechazaría igual
   * (TOMAR_PEDIDO_ROLES/CONFIRMAR_COCINA_ROLES en roles.ts, exigidas por
   * assertVerticalRole en pedidosFnb.ts, son SIEMPRE el enforcement real). */
  readonly role: string;
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
  { to: "asistencia", label: "Asistencia" },
  { to: "fraude", label: "Fraude" },
  { to: "cfdi", label: "CFDI" },
];

// Fase 15 — hallazgo de auditoría (severidad ALTA, "Pedidos F&B con guardia de
// alergias: backend real sin pantalla"): mismo `TOMAR_PEDIDO_ROLES` que
// domain-hoteles/src/roles.ts (duplicado aquí a propósito, ver el comentario de
// `role` arriba) — solo oculta el link "Pedidos F&B" del nav para quien el
// servidor rechazaría de todas formas (403 en pedidosFnb.ts), nunca la única
// barrera. housekeeping/maintenance/reservations/accountant nunca lo ven.
const PEDIDOS_FNB_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "fnb"]);

// Hallazgo de auditoría (severidad ALTA, "P&L USALI (P0)... sin UI", porción
// restante): mismo `PL_ROLES` exacto que domain-hoteles/src/roles.ts (duplicado aquí
// a propósito, ver el comentario de `role` arriba) — solo oculta el link "P&L" del
// nav para quien el servidor rechazaría de todas formas (403 en pl.ts).
const PL_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);

// Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
// tarifas/huéspedes imposible sin SQL directo"): mismo `ADMIN_ROLES` exacto que
// domain-hoteles/src/roles.ts (duplicado aquí a propósito, ver el comentario de
// `role` arriba) — solo oculta el link "Catálogo" del nav para quien el servidor
// rechazaría de todas formas (403 en admin-catalogo.ts, `hoteles.can_manage_catalog()`).
const CATALOGO_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);

const linkStyle = (isActive: boolean): CSSProperties => ({
  display: "block",
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 14,
  textDecoration: "none",
  color: isActive ? "#fff" : "#111827",
  background: isActive ? "#111827" : "transparent",
});

const logoImgStyle: CSSProperties = { height: 20, display: "block", margin: "0 0 12px" };

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
  useDocumentTitle("Hoteles");

  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [properties, setProperties] = useState<readonly PropertyOption[] | null>(null);
  // Hotel activo elegido en el selector de abajo -- `null` hasta que el staff elige
  // uno explícitamente, en cuyo caso `resolveActivePropertyId` cae al primero de
  // `properties` (mismo fallback que el `properties[0]` fijo de antes, pero ahora
  // es solo el default inicial, no un techo duro). Inicializado leyendo
  // lib/property-selection.ts (persistido para este `orgSlug`) para que sobreviva
  // a que App.tsx monte una instancia NUEVA de este Shell al navegar a otra ruta
  // del panel; `resolveActivePropertyId` ya tolera un valor persistido que quedó
  // obsoleto (property reasignada/dada de baja entre sesiones), así que no hace
  // falta validarlo aquí.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(() => readPersistedPropertyId(window.localStorage, orgSlug));
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

  // Hallazgo de auditoría (severidad ALTA, "cadena con 2+ hoteles solo opera el
  // primero"): una cadena real puede operar N properties, y GET .../admin/propiedades
  // ya devolvía la lista completa (ver discovery-client.ts) — este Shell
  // simplemente descartaba todo menos `properties[0]`. `resolveActivePropertyId`
  // respeta la selección del staff en el selector de abajo y solo cae a la primera
  // como default inicial (o si la selección quedó obsoleta).
  const propertyId = resolveActivePropertyId(properties, selectedPropertyId)!;
  const activeProperty = properties.find((p) => p.propertyId === propertyId)!;
  // Fail-closed: si por lo que sea la organización activa no aparece en la sesión
  // (no debería pasar, ver decideHotelesLandingPath), cae al rol operativo MÁS bajo
  // de HOTEL_ROLES (nunca uno que active gates administrativos/de F&B de más).
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "housekeeping";

  // Handler real del selector: actualiza el estado de React (recalcula
  // `children(ctx)` con el nuevo propertyId de inmediato, vía la `key={propertyId}`
  // de abajo) y persiste la selección best-effort (ver lib/property-selection.ts)
  // para que sobreviva a navegar a otra ruta del panel o a un refresh de página.
  function handleSelectProperty(nextPropertyId: string) {
    setSelectedPropertyId(nextPropertyId);
    persistPropertyId(window.localStorage, orgSlug, nextPropertyId);
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <nav style={{ width: 200, flexShrink: 0, borderRight: "1px solid #e5e7eb", padding: 16, display: "flex", flexDirection: "column", gap: 4 }}>
        <img src={ATIENDE_LOGO_DATA_URI} alt="Atiende" style={logoImgStyle} />
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 4px" }}>Hoteles · {orgSlug}</p>
        {properties.length > 1 ? (
          <div style={{ margin: "0 0 8px" }}>
            <label htmlFor="hoteles-hotel-activo" style={selectLabelStyle}>
              Hotel activo
            </label>
            <select id="hoteles-hotel-activo" value={propertyId} onChange={(e) => handleSelectProperty(e.target.value)} style={selectStyle}>
              {properties.map((p) => (
                <option key={p.propertyId} value={p.propertyId}>
                  {p.nombre}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p style={{ fontSize: 12, color: "#9ca3af", margin: "0 0 8px" }}>{activeProperty.nombre}</p>
        )}
        {/* Fase 16 — hallazgo de auditoría (severidad ALTA, "No hay dashboard por
            tipo de usuario"): landing real del panel, ver comentario de cabecera de
            pages/Dashboard.tsx. `end` evita que este link quede marcado activo en
            cualquier subruta (mismo criterio que "Panel (KPIs)" en
            RestaurantesShell.tsx). */}
        <NavLink to={`/hoteles/${orgSlug}`} end style={({ isActive }) => linkStyle(isActive)}>
          Dashboard
        </NavLink>
        <div style={{ height: 1, background: "#f3f4f6", margin: "6px 0" }} />
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={`/hoteles/${orgSlug}/${item.to}`} style={({ isActive }) => linkStyle(isActive)}>
            {item.label}
          </NavLink>
        ))}
        {/* Hallazgo de auditoría (severidad ALTA, "P&L USALI (P0)... sin UI",
            porción restante): ver PL_NAV_ROLES arriba. */}
        {PL_NAV_ROLES.has(role) && (
          <NavLink to={`/hoteles/${orgSlug}/pl`} style={({ isActive }) => linkStyle(isActive)}>
            P&amp;L
          </NavLink>
        )}
        {/* Fase 15 — hallazgo de auditoría (severidad ALTA, "Pedidos F&B con
            guardia de alergias: backend real sin pantalla"): ver
            PEDIDOS_FNB_NAV_ROLES arriba. */}
        {PEDIDOS_FNB_NAV_ROLES.has(role) && (
          <NavLink to={`/hoteles/${orgSlug}/pedidos-fnb`} style={({ isActive }) => linkStyle(isActive)}>
            Pedidos F&amp;B
          </NavLink>
        )}
        {/* Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-
            habitación/tarifas/huéspedes imposible sin SQL directo"): ver
            CATALOGO_NAV_ROLES arriba. */}
        {CATALOGO_NAV_ROLES.has(role) && (
          <NavLink to={`/hoteles/${orgSlug}/catalogo`} style={({ isActive }) => linkStyle(isActive)}>
            Catálogo
          </NavLink>
        )}
        <p style={{ fontSize: 11, color: "#9ca3af", margin: "16px 0 0" }}>Rol: {role}</p>
        <button type="button" onClick={handleLogout} disabled={loggingOut} style={logoutButtonStyle}>
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </button>
      </nav>
      {/* `key={propertyId}` fuerza a React a desmontar/remontar las páginas hijas
          cuando el hotel activo cambia DENTRO de la misma instancia de Shell
          (selector, sin navegar) — mismo criterio que DespachosShell.tsx: cualquier
          página que cachee en su propio useState un resultado calculado para la
          property anterior (ninguna lo hace hoy en hoteles, pero páginas futuras sí
          podrían) queda cubierta sin tener que auditarlas una por una. Páginas que
          ya refetchean por `useEffect` con `propertyId` en sus dependencias
          (Reservas/Mantenimiento/Fraude/etc.) no cambian de comportamiento: un
          remount con las mismas dependencias dispara el mismo fetch que ya
          disparaban. */}
      <div key={propertyId} style={{ flex: 1, padding: 24, overflow: "auto" }}>
        {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role })}
      </div>
    </div>
  );
}

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
//
// Fase 10 — hallazgo de auditoría (severidad ALTA, "un despacho solo puede operar
// UN contribuyente/cliente"): este Shell fijaba `branches[0]` para siempre,
// aunque el negocio central de un despacho real es dar servicio a N clientes/
// contribuyentes y GET .../admin/branches YA devolvía la lista completa (cada
// branch = un contribuyente distinto, `core.property` org-scoped con múltiples
// filas posibles — ver admin.ts/postgres-repository.ts, sin cambio de esquema
// necesario). Ahora expone un selector real ("Contribuyente" en la nav, visible
// cuando hay más de uno) y resuelve el `propertyId` activo con
// `resolveActivePropertyId` (admin-client.ts) en vez de descartar el resto de la
// lista — todas las páginas hijas (Cfdi/Declaraciones/Vencimientos/etc.) ya
// consumían `ctx.propertyId` sin cachear nada propio, así que cambiar la
// selección aquí basta para que TODAS refetcheen contra el contribuyente elegido.
// NO cubierto por esta fase: `despachos.tenant_profile` (RFC/razón social) sigue
// siendo `organization_id primary key` — UN solo RFC/razón social por
// organización, no por contribuyente/property — pero ningún archivo de código lo
// lee todavía (solo existe en la migración), así que no bloquea el selector ni
// ninguna de las 10 páginas de esta fase, que ya leen/escriben SIEMPRE por
// `property_id` (invoice/fiscal_deadline/invoice_review, todas RLS-scoped por
// property). Si en el futuro se necesita mostrar u operar el RFC/razón social
// POR contribuyente (no solo por despacho), `tenant_profile` necesitaría
// rediseñarse con `property_id` en la llave (o una tabla nueva) — cambio de
// esquema real, fuera de alcance aquí.
//
// Fase 19 — hallazgo de auditoría (severidad ALTA, "el selector real de
// contribuyente de la Fase 10 vive en un useState que se resetea cada vez que se
// navega"): App.tsx monta una instancia NUEVA de este Shell por cada una de las 14
// rutas Despachos*Route (`/despachos/:orgSlug/cfdi`, `/despachos/:orgSlug/
// declaraciones`, etc. — no hay un layout persistente entre rutas de React Router
// aquí, mismo motivo que llevó a rentas a necesitar lib/property-selection.ts en la
// misma ronda). Sin persistir la selección fuera del componente, un contador que
// elige el contribuyente B en CFDI y navega a Declaraciones volvía a ver los datos
// del contribuyente A (el primero, vía `resolveActivePropertyId(branches, null)`)
// sin ningún aviso. `selectedPropertyId` ahora se inicializa leyendo
// lib/property-selection.ts (persistido bajo la llave de esta organización) y
// `handleSelectProperty` persiste cada cambio — mismo patrón exacto que
// RentasShell.tsx.
//
// Hallazgo relacionado (misma fase): varias páginas "calculadora" de despachos
// (Conciliacion/DevolucionIva/Bookkeeping/Declaraciones/Nomina/
// ContabilidadElectronica) guardan en su propio useState el resultado calculado
// para el contribuyente activo, sin limpiarlo cuando `ctx.propertyId` cambia
// DENTRO de la misma instancia de Shell (cambiar el selector sin navegar) — el
// resultado en pantalla quedaba siendo el del contribuyente anterior hasta que el
// usuario disparaba el cálculo de nuevo manualmente. La forma más barata de
// corregirlo sin tocar cada página es remontar el árbol de `children(...)` cuando
// cambia `propertyId`: `key={propertyId}` en el `<div>` que los envuelve fuerza a
// React a destruir y recrear esas páginas (con todo su estado local) cada vez que
// el contribuyente activo cambia, exactamente como si se hubiera navegado a una
// ruta nueva.
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { clearDespachosSession, logout, readPersistedDespachosSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchBranches, resolveActivePropertyId } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
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
  { to: "contabilidad-electronica", label: "Contabilidad electrónica" },
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

export function DespachosShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: DespachosShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  // Contribuyente/cliente activo elegido en el selector de abajo -- `null` hasta
  // que el staff elige uno explícitamente, en cuyo caso `resolveActivePropertyId`
  // cae al primero de `branches` (mismo fallback que el `branches[0]` fijo de
  // antes, pero ahora es solo el default inicial, no un techo duro). Fase 19 --
  // inicializado leyendo lib/property-selection.ts (persistido para este
  // `orgSlug`) para que sobreviva a que App.tsx monte una instancia NUEVA de este
  // Shell al navegar a otra ruta del panel (ver comentario de cabecera del
  // archivo); `resolveActivePropertyId` ya tolera un valor persistido que quedó
  // obsoleto (branch reasignado/dado de baja entre sesiones), así que no hace
  // falta validarlo aquí.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(() => readPersistedPropertyId(window.localStorage, orgSlug));
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

  // Hallazgo de auditoría (severidad ALTA, "un despacho solo puede operar UN
  // contribuyente/cliente"): un despacho real da servicio a N clientes/
  // contribuyentes distintos, y GET .../admin/branches ya devolvía la lista
  // completa (cada branch = un contribuyente, ver admin-client.ts) -- este Shell
  // simplemente descartaba todo menos `branches[0]`. `resolveActivePropertyId`
  // respeta la selección del staff en el selector de abajo y solo cae al primero
  // como default inicial (o si la selección quedó obsoleta).
  const propertyId = resolveActivePropertyId(branches, selectedPropertyId)!;
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "readonly";

  // Fase 19 -- handler real del selector: actualiza el estado de React (recalcula
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
        <p style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b7280", margin: "0 0 8px" }}>Despachos · {orgSlug}</p>
        {branches.length > 1 ? (
          <div style={{ margin: "0 0 12px" }}>
            <label htmlFor="despachos-contribuyente-activo" style={selectLabelStyle}>
              Contribuyente
            </label>
            <select id="despachos-contribuyente-activo" value={propertyId} onChange={(e) => handleSelectProperty(e.target.value)} style={selectStyle}>
              {branches.map((b) => (
                <option key={b.propertyId} value={b.propertyId}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
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
      {/* Fase 19 -- `key={propertyId}` fuerza a React a desmontar/remontar las
          páginas hijas cuando el contribuyente activo cambia DENTRO de la misma
          instancia de Shell (selector, sin navegar) -- corrige el hallazgo
          relacionado en el que Conciliacion/DevolucionIva/Bookkeeping/
          Declaraciones/Nomina/ContabilidadElectronica conservaban en pantalla el
          resultado calculado para el contribuyente anterior porque su estado local
          de cálculo no se limpiaba solo porque `ctx.propertyId` cambiara (ver
          comentario de cabecera del archivo). Páginas que no cachean ningún
          resultado propio (Cfdi/Vencimientos/etc., que ya refetchean por
          `useEffect` con `propertyId` en su arreglo de dependencias) no cambian de
          comportamiento: un remount con las mismas dependencias dispara el mismo
          fetch que ya disparaban. */}
      <div key={propertyId} style={{ flex: 1, padding: 24, overflow: "auto" }}>
        {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role })}
      </div>
    </div>
  );
}

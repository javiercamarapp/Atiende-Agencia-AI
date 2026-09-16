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
//
// Visual (ronda de integración del design system real, @atiende/ui): reemplaza el
// `<nav>` de estilos inline por el `Sidebar` real ya portado desde atiende-hoteles
// (acordeón por sección, colapso, bloque de cuenta hundido) — misma anatomía que
// AppShell.tsx del repo standalone (leído primero como plantilla). El selector de
// hotel se pasa vía `hotelSelector` (prop de Sidebar), y el resto del header
// (fecha real, `BotonChatDatos` honesto, correo/rol de la sesión) vive en la barra
// superior, igual que ese AppShell. Ningún cambio de lógica de sesión/property/
// ruteo: solo el envoltorio visual.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarCheck,
  ClipboardCheck,
  LayoutDashboard,
  Receipt,
  ShieldAlert,
  Tags,
  TrendingUp,
  UtensilsCrossed,
  Wrench,
} from "lucide-react";
import { AtiendeWordmark, EstadoCargando, EstadoError, MobileHeader, Sidebar } from "@atiende/ui";
import type { SidebarSection } from "@atiende/ui";
import { BotonChatDatos } from "../../components/BotonChatDatos.tsx";
import { clearHotelesSession, logout, readPersistedHotelesSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties, resolveActivePropertyId } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";

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
      <main className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <EstadoError mensaje={error} />
        </div>
      </main>
    );
  }

  if (!properties) {
    return (
      <main className="min-h-screen bg-background p-6">
        <div className="max-w-md mx-auto">
          <EstadoCargando etiqueta="Cargando propiedades…" />
        </div>
      </main>
    );
  }

  if (properties.length === 0) {
    return (
      <main className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          <EstadoError titulo="Sin hoteles configurados" mensaje="Esta organización todavía no tiene ningún hotel (property) configurado." />
        </div>
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

  const base = `/hoteles/${orgSlug}`;

  // Mapeo real de NAV_ITEMS (antes un `<nav>` de estilos inline) a las secciones
  // del Sidebar compartido — mismas rutas y mismas etiquetas exactas, agrupadas por
  // función (misma anatomía que AppShell.tsx del repo standalone atiende-hoteles,
  // leído primero como plantilla): "Panel" fijo arriba (siempre abierto), luego
  // "Operación" (día a día del hotel) y "Administración" (P&L/Catálogo, solo para
  // los roles que ya podían verlos antes — ver *_NAV_ROLES arriba). Ningún ítem
  // nuevo, ninguna ruta renombrada.
  const sections: SidebarSection[] = [
    {
      title: "Panel",
      siempreAbierto: true,
      items: [{ to: base, label: "Dashboard", icon: LayoutDashboard }],
    },
    {
      title: "Operación",
      items: [
        { to: `${base}/reservas`, label: "Reservas", icon: CalendarCheck },
        { to: `${base}/mantenimiento`, label: "Mantenimiento", icon: Wrench },
        { to: `${base}/asistencia`, label: "Asistencia", icon: ClipboardCheck },
        { to: `${base}/fraude`, label: "Fraude", icon: ShieldAlert },
        { to: `${base}/cfdi`, label: "CFDI", icon: Receipt },
        ...(PEDIDOS_FNB_NAV_ROLES.has(role) ? [{ to: `${base}/pedidos-fnb`, label: "Pedidos F&B", icon: UtensilsCrossed }] : []),
      ],
    },
    {
      title: "Administración",
      items: [
        ...(PL_NAV_ROLES.has(role) ? [{ to: `${base}/pl`, label: "P&L", icon: TrendingUp }] : []),
        ...(CATALOGO_NAV_ROLES.has(role) ? [{ to: `${base}/catalogo`, label: "Catálogo", icon: Tags }] : []),
      ],
    },
    // "Administración" se omite por completo si el rol activo no puede ver P&L ni
    // Catálogo (frontdesk/reservations/housekeeping/maintenance/fnb) — un acordeón
    // vacío no aporta nada y confundiría más que ayudar.
  ].filter((s) => s.items.length > 0);

  const hotelSelector =
    properties.length > 1 ? (
      <div>
        <label htmlFor="hoteles-hotel-activo" className="block mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          Hotel activo
        </label>
        <select
          id="hoteles-hotel-activo"
          value={propertyId}
          onChange={(e) => handleSelectProperty(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-2 py-1.5 text-[13px] text-foreground"
        >
          {properties.map((p) => (
            <option key={p.propertyId} value={p.propertyId}>
              {p.nombre}
            </option>
          ))}
        </select>
      </div>
    ) : (
      <p className="text-[12px] text-muted-foreground truncate">{activeProperty.nombre}</p>
    );

  return (
    <div className="min-h-screen bg-background flex w-full gap-3 p-3">
      <Sidebar sections={sections} user={{ email: session.email, rol: role }} onLogout={handleLogout} hotelSelector={hotelSelector} />

      <MobileHeader title={<AtiendeWordmark className="scale-90 origin-left" />} action={hotelSelector} />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="hidden md:flex items-center justify-between gap-3 px-3 py-2">
          <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
            Hoteles · {orgSlug}
          </p>
          <div className="flex items-center gap-3">
            <BotonChatDatos />
            <span className="text-sm text-muted-foreground truncate max-w-[220px]">{session.email}</span>
            {loggingOut && <span className="text-xs text-muted-foreground">Cerrando sesión…</span>}
          </div>
        </header>
        <main className="flex-1 overflow-auto px-4 pt-20 pb-6 md:pt-4 md:px-6">
          <div key={propertyId} className="max-w-6xl mx-auto w-full">
            {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role })}
          </div>
        </main>
      </div>
    </div>
  );
}

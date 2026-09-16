// Shell del panel de staff de rentas (Fase 12) — primera UI operativa real de este
// vertical más allá del login (ver README: hasta esta fase solo existía Login.tsx,
// y el login exitoso navegaba a una ruta que ni siquiera existía en <Routes> —
// pantalla en blanco). Mismo patrón exacto que HotelesShell.tsx/CitasShell.tsx:
// resuelve sesión + property UNA vez (vía discovery-client.ts, plumbing nuevo de
// esta fase — ver su comentario de cabecera) y le da a las páginas hijas los datos
// ya resueltos.
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
// Selector real bajo el logo del Sidebar (dropdown si hay 2+ properties; mismo
// renglón que antes mostraba solo el nombre cuando hay exactamente 1) + persistencia
// vía lib/property-selection.ts (ver su comentario de cabecera para el porqué: cada
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
//
// Fase 18 (misma fase, hallazgo distinto) -- agrega el link de nav a Sincronización
// iCal (conectar el feed externo de Airbnb/Booking/Vrbo por unidad + copiar la URL
// del feed de exportación propio, ver pages/IcalSync.tsx): cierra el hallazgo de
// auditoría "el backend de iCal-sync (ical-sync.ts + ical-feed-publico.ts) está
// completo pero apps/web no tiene ningún cliente ni pantalla que lo consuma". Mismo
// patrón, un renglón más en NAV_ITEMS; IcalSyncPage gatea su propio contenido por
// SYNC_CALENDARIO_LECTURA_ROLES/SYNC_CALENDARIO_ESCRITURA_ROLES, igual que
// FinanzasPage/PreciosPage.
//
// Ronda de portado del sistema de diseño real (@atiende/ui, ver
// packages/ui/src/components/Sidebar.tsx): reemplaza el <nav> con estilos inline +
// NAV_ITEMS plano por <Sidebar> real -- acordeón por sección (agrupación inspirada en
// el AdminSidebar de atiende-rentas-vacacionales standalone: ANÁLISIS/OPERACIÓN/
// NEGOCIO), selector de property real bajo el logo (`hotelSelector`, nombre genérico
// pese al prop), y bloque de cuenta/logout ya resuelto por el propio Sidebar. Se
// agrega también <BotonChatDatos /> (honesto, deshabilitado: ver su comentario de
// cabecera) en la barra superior, y los tres estados intermedios (cargando sesión,
// error de red, organización sin properties) pasan de <p> con estilos inline a
// EstadoCargando/EstadoError/EstadoVacio reales. CERO cambios de lógica de negocio:
// mismos efectos, mismo manejo de sesión/expiración, mismas rutas.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  CalendarDays,
  ClipboardList,
  Home,
  Inbox,
  LayoutDashboard,
  RefreshCcw,
  Tag,
  Wallet,
} from "lucide-react";
import { DashboardHeader, EstadoCargando, EstadoError, EstadoVacio, NotificationBell, Sidebar } from "@atiende/ui";
import type { SidebarSection } from "@atiende/ui";
import { BotonChatDatos } from "../../components/BotonChatDatos.tsx";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { useNotifications } from "../../lib/useNotifications.ts";
import { clearRentasSession, logout, readPersistedRentasSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { persistPropertyId, readPersistedPropertyId, resolveActivePropertyId } from "./lib/property-selection.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";

/** Agrupación inspirada en el AdminSidebar real de atiende-rentas-vacacionales
 * standalone (ANÁLISIS/CALENDARIO/OPERACIÓN/NEGOCIO/PLATAFORMA) -- mismas rutas y
 * etiquetas exactas que las NAV_ITEMS previas de este Shell, solo agrupadas.
 * "Plataforma" se omite: los únicos ítems de ese tipo (notificaciones, perfil, plan
 * y facturación, configuración) ya vienen resueltos por el propio <Sidebar> en su
 * bloque de cuenta inferior -- no hay página de plataforma propia de rentas todavía. */
function buildSections(orgSlug: string): SidebarSection[] {
  const ruta = (sufijo: string) => `/rentas/${orgSlug}${sufijo ? `/${sufijo}` : ""}`;
  return [
    {
      title: "Análisis",
      siempreAbierto: true,
      items: [
        { to: ruta(""), label: "Resumen", icon: LayoutDashboard },
        { to: ruta("calendario"), label: "Calendario", icon: CalendarDays },
      ],
    },
    {
      title: "Operación",
      items: [
        { to: ruta("aprobaciones"), label: "Aprobaciones", icon: Inbox },
        { to: ruta("mis-tareas"), label: "Mis tareas", icon: ClipboardList },
        { to: ruta("ical-sync"), label: "Sincronización iCal", icon: RefreshCcw },
      ],
    },
    {
      title: "Negocio",
      items: [
        { to: ruta("precios"), label: "Precios", icon: Tag },
        { to: ruta("finanzas"), label: "Finanzas", icon: Wallet },
      ],
    },
  ];
}

export interface RentasShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Cambia la property activa del Shell (selector bajo el logo, o cualquier página
   * hija -- Dashboard.tsx la usa para hacer clicables las properties listadas).
   * Persiste la selección vía lib/property-selection.ts para que sobreviva tanto a
   * un refresh de página como a navegar a otra ruta del panel (ver el comentario de
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

  // Fase 18 -- handler real del selector (ahora bajo el logo del Sidebar, vía
  // RentasShellContext.setPropertyId): actualiza el estado de React (recalcula
  // `children(ctx)` con el nuevo propertyId de inmediato) y persiste la selección
  // best-effort (ver lib/property-selection.ts) para que sobreviva a navegar a otra
  // ruta del panel o a un refresh de página.
  function handleSelectProperty(nextPropertyId: string) {
    setPropertyIdState(nextPropertyId);
    persistPropertyId(window.localStorage, orgSlug, nextPropertyId);
  }

  // Campana de notificaciones del header (DashboardHeader/NotificationBell, ver
  // ambos comentarios de cabecera) -- se llama SIEMPRE, antes de los early return
  // de sesión de abajo, para no violar las reglas de hooks; `session?.token ?? ""`
  // deja que el propio hook maneje un token vacío mientras la sesión resuelve.
  const notif = useNotifications(apiBaseUrl, session?.token ?? "");

  if (session === undefined) return null; // resolviendo sesión persistida
  if (!session) return null; // onRequireLogin ya disparó la redirección

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <EstadoError mensaje={error} />
        </div>
      </main>
    );
  }

  if (!properties) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <EstadoCargando lineas={2} />
        </div>
      </main>
    );
  }

  if (properties.length === 0) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <EstadoVacio titulo="Sin propiedades" mensaje="Esta organización todavía no tiene ninguna propiedad configurada." />
        </div>
      </main>
    );
  }

  // `propertyId` se resuelve en el efecto de arriba, en el mismo tick en que se
  // conoce `properties` -- este `null` solo cubre el render intermedio entre ambos
  // `setState`, nunca un estado persistente con `properties` ya no vacío.
  if (!propertyId) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          <EstadoCargando lineas={2} />
        </div>
      </main>
    );
  }

  const org = session.organizations.find((o) => o.slug === orgSlug);

  // Selector real de property: dropdown solo cuando hay 2+ (el caso base de este
  // vertical, ver comentario de cabecera), mismo renglón que antes solo mostraba el
  // nombre cuando había exactamente 1.
  const hotelSelector =
    properties.length > 1 ? (
      <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        Propiedad
        <select
          value={propertyId}
          onChange={(e) => handleSelectProperty(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-2 py-1.5 font-sans text-[13px] normal-case tracking-normal text-foreground"
        >
          {properties.map((p) => (
            <option key={p.propertyId} value={p.propertyId}>
              {p.nombre}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <p className="px-0.5 truncate text-[12px] text-muted-foreground">{properties[0]!.nombre}</p>
    );

  return (
    <div className="min-h-screen bg-background flex gap-3 p-3">
      <Sidebar
        sections={buildSections(orgSlug)}
        user={{ email: session.email, rol: org?.rol }}
        onLogout={handleLogout}
        hotelSelector={hotelSelector}
      />
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <DashboardHeader
          variant="vertical"
          icon={<Home className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />}
          title={org?.nombre ?? orgSlug}
          fecha={fechaCortaEsMx()}
          notificationBell={
            <NotificationBell
              items={notif.items}
              unreadCount={notif.unreadCount}
              loading={notif.loading}
              onOpenChange={(open) => {
                if (open) notif.refetch();
              }}
              onMarkRead={notif.onMarkRead}
              onMarkAllRead={notif.onMarkAllRead}
            />
          }
          chatButton={<BotonChatDatos />}
        />
        <main className="flex-1 min-w-0 rounded-2xl border border-border bg-card p-6 overflow-auto">
          {children({ apiBaseUrl, token: session.token, propertyId, setPropertyId: handleSelectProperty, properties, orgSlug, session })}
        </main>
      </div>
      {loggingOut && <span className="sr-only" role="status">Cerrando sesión…</span>}
    </div>
  );
}

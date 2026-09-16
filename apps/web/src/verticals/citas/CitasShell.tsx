// Shell del panel de administración visual de citas (Fase 5) — resuelve sesión +
// propertyId UNA vez (mismo patrón de descubrimiento que
// restaurantes/pages/Dashboard.tsx: la sesión de login nunca trae un propertyId,
// solo se resuelve al entrar al panel) y le da a las 6 páginas
// (Agenda/Proveedores/Servicios/Clientes/Disponibilidad/Configuración) la misma
// nav lateral.
//
// Presentación real (Fase de diseño): la nav lateral ahora es el `Sidebar` real de
// @atiende/ui (mismo componente/anatomía que AppShell.tsx de atiende-hoteles:
// acordeón por sección, colapso, bloque de cuenta hundido) en vez del `<nav>`
// artesanal de antes. Toda la lógica de sesión/propertyId/realtime de abajo es
// exactamente la misma — solo cambia el chrome visual.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  BottomNav,
  DashboardHeader,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  MobileHeader,
  NotificationBell,
  Sidebar,
  AtiendeWordmark,
} from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import {
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  Scissors,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { BotonChatDatos } from "../../components/BotonChatDatos.tsx";
import { useNotifications } from "../../lib/useNotifications.ts";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
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
  /** Nombre completo y correo del staff en sesión — expuestos a las páginas hijas
   * (Fase de header compartido) solo para pintar el saludo real
   * (`saludoConNombre`, ver Agenda.tsx); antes este contexto no exponía nada de
   * identidad del staff más allá de lo que ya necesitaba `role`. */
  readonly staffFullName: string | undefined;
  readonly staffEmail: string;
}

export interface CitasShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: CitasShellContext) => ReactNode;
}

/** Mapa de navegación de citas — misma anatomía de acordeón que AppShell.tsx de
 * atiende-hoteles, agrupada por lo que ya documenta README.md de este vertical
 * (agenda operativa primero, catálogo/operación del negocio después,
 * administración al final). `to` construido con `orgSlug` porque `Sidebar` usa
 * `NavLink` con rutas reales, no un callback de sección. */
function buildSections(orgSlug: string): SidebarSection[] {
  const base = `/citas/${orgSlug}`;
  return [
    {
      title: "AGENDA",
      siempreAbierto: true,
      items: [{ to: `${base}/agenda`, label: "Agenda", icon: CalendarCheck }],
    },
    {
      title: "NEGOCIO",
      items: [
        { to: `${base}/proveedores`, label: "Proveedores", icon: UserRound },
        { to: `${base}/servicios`, label: "Servicios", icon: Scissors },
        { to: `${base}/clientes`, label: "Clientes", icon: Users },
        { to: `${base}/disponibilidad`, label: "Disponibilidad", icon: CalendarRange },
      ],
    },
    {
      title: "ADMINISTRAR",
      items: [
        { to: `${base}/configuracion`, label: "Configuración", icon: Settings },
        { to: `${base}/staff`, label: "Staff", icon: ShieldCheck },
      ],
    },
  ];
}

/** Bottom-nav móvil real — subconjunto operativo (≤5 ítems, mismo criterio que
 * AppShell.tsx de atiende-hoteles: más de 5 deja de ser usable con el pulgar). */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/citas/${orgSlug}`;
  return [
    { to: `${base}/agenda`, label: "Agenda", icon: CalendarCheck },
    { to: `${base}/proveedores`, label: "Proveedores", icon: UserRound },
    { to: `${base}/servicios`, label: "Servicios", icon: Scissors },
    { to: `${base}/clientes`, label: "Clientes", icon: Users },
    { to: `${base}/configuracion`, label: "Configuración", icon: Settings },
  ];
}

/** Centrado a pantalla completa — mismo contenedor para los 3 estados que
 * corren ANTES de que exista sesión/sucursal resuelta (sin Sidebar todavía que
 * envolver). */
function EstadoPantallaCompleta({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}

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
    // Nota: el botón de logout real (Sidebar de @atiende/ui, compartido, no se
    // modifica aquí) no expone un estado "deshabilitado/cargando" propio —
    // mismo criterio ya aceptado en AppShell.tsx de atiende-hoteles. La llamada
    // real a /auth/logout, la limpieza de sesión y la redirección son las mismas
    // de siempre.
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

  // Campana de notificaciones (header compartido) — llamada AQUÍ, antes de los
  // returns condicionales de abajo (reglas de hooks: un hook no puede vivir
  // después de un return condicional). `session?.token ?? ""` deja que el hook
  // se monte igual mientras la sesión resuelve/no existe; ya maneja bien un
  // token vacío (ver cabecera de useNotifications.ts) y en esas ramas el header
  // ni siquiera llega a pintarse.
  const notif = useNotifications(apiBaseUrl, session?.token ?? "");

  if (session === undefined) return null; // resolviendo sesión persistida
  if (!session) return null; // onRequireLogin ya disparó la redirección

  if (error) {
    return (
      <EstadoPantallaCompleta>
        <EstadoError mensaje={error} />
      </EstadoPantallaCompleta>
    );
  }

  if (!branches) {
    return (
      <EstadoPantallaCompleta>
        <EstadoCargando etiqueta="Cargando sucursales…" />
      </EstadoPantallaCompleta>
    );
  }

  if (branches.length === 0) {
    return (
      <EstadoPantallaCompleta>
        <EstadoVacio mensaje="Este negocio todavía no tiene ninguna sucursal configurada." />
      </EstadoPantallaCompleta>
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

  // Selector real, visible solo cuando hay más de una sucursal — mismo criterio
  // que "Hotel activo" de HotelesShell.tsx. Se ofrece tanto en el bloque de cuenta
  // del Sidebar (desktop) como en el MobileHeader (abajo), para no perder la
  // función en viewport angosto solo porque el Sidebar es `hidden md:flex`.
  const branchSelector =
    branches.length > 1 ? (
      <div>
        <label htmlFor="citas-sucursal-activa" className="block mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          Sucursal activa
        </label>
        <select
          id="citas-sucursal-activa"
          value={propertyId}
          onChange={(e) => handleSelectBranch(e.target.value)}
          className="block w-full rounded-lg border border-border bg-card px-2 py-1.5 text-[13px] text-foreground"
        >
          {branches.map((b) => (
            <option key={b.propertyId} value={b.propertyId}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
    ) : (
      <p className="text-[12px] text-muted-foreground truncate">{activeBranch.name}</p>
    );

  return (
    <div className="min-h-screen bg-background flex w-full">
      <div className="hidden md:block p-3">
        <Sidebar
          sections={buildSections(orgSlug)}
          user={{ email: session.email, rol: role }}
          onLogout={() => void handleLogout()}
          hotelSelector={branchSelector}
        />
      </div>

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        action={<div className="flex items-center gap-2">{branches.length > 1 ? branchSelector : null}</div>}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="hidden md:block">
          <DashboardHeader
            variant="vertical"
            icon={<CalendarClock className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />}
            title={`Citas · ${orgSlug}`}
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
        </div>
        {/* `key={propertyId}` fuerza a React a desmontar/remontar las páginas hijas
            cuando la sucursal activa cambia DENTRO de la misma instancia de Shell
            (selector, sin navegar) — mismo criterio que HotelesShell.tsx. */}
        <main key={propertyId} className="flex-1 px-4 py-4 pt-20 pb-24 md:pt-4 md:pb-8 md:px-6 overflow-auto">
          <div className="max-w-6xl mx-auto w-full">
            {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, orgId, role, staffFullName: session.fullName, staffEmail: session.email })}
          </div>
        </main>
      </div>

      <BottomNav items={buildMobileItems(orgSlug)} />
    </div>
  );
}

// Shell del back-office CORE de restaurantes (Fase 5, ahora también landing post-
// login desde Fase 5.1) — mismo patrón que CitasShell.tsx (Fase 5 citas): resuelve
// sesión + propertyId UNA vez y le da a todas las páginas (Panel de KPIs incluido,
// ver Dashboard.tsx, más Productos/Sucursales/Pedidos/Historial/Clientes) la misma
// nav lateral, así el manager que entra al producto siempre tiene camino de vuelta
// al back-office y viceversa.
//
// Presentación real desde esta ronda: <Sidebar> de @atiende/ui (mismo patrón "sidebar
// bottom hundido gris" ya documentado en su propio archivo) en vez del <nav> inline
// de antes — restaurantes es la vertical ORIGEN de ese sistema de diseño (docs/
// referencia/05-frontend-restaurantes.md), así que esta ronda solo la pone a la
// altura de lo que ella misma inspiró. TODA la lógica de sesión/sucursal/logout/
// SESSION_EXPIRED_EVENT/redirección de repartidor de abajo es la MISMA — únicamente
// cambia el JSX de presentación.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import {
  ClipboardList,
  History,
  LayoutDashboard,
  Store,
  Tag,
  UserCog,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { AtiendeWordmark, BottomNav, DashboardHeader, EstadoError, MobileHeader, NotificationBell, Sidebar } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { BotonChatDatos } from "../../components/BotonChatDatos.tsx";
import { clearSession, logout, readPersistedSession } from "../../lib/auth-client.ts";
import type { LoginSession } from "../../lib/auth-client.ts";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { useNotifications } from "../../lib/useNotifications.ts";
import { fetchBranches, resolveActivePropertyId } from "./dashboard-client.ts";
import type { BranchOption } from "./dashboard-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";

export interface RestaurantesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (owner/admin/staff/repartidor,
   * ver domain-restaurantes/src/roles.ts) — Fase 14, mismo criterio ya usado por
   * DespachosShell.tsx/LicitacionesShell.tsx: cosmético, para ocultar en el nav/UI
   * acciones que el servidor rechazaría igual (STAFF_INVITE_ROLES en admin-staff.ts
   * es SIEMPRE el enforcement real). */
  readonly role: string;
  /** Nombre/correo reales del staff en sesión, para el saludo de la landing
   * (`saludoConNombre`, ver Dashboard.tsx) — antes este contexto no exponía nada de
   * `session` más allá de `token`. `staffFullName` puede venir ausente (ver el
   * comentario de `LoginSession.fullName` en auth-client.ts), `saludoConNombre` ya
   * cae a `staffEmail` en ese caso. */
  readonly staffFullName: string | undefined;
  readonly staffEmail: string;
}

export interface RestaurantesShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: RestaurantesShellContext) => ReactNode;
}

/** Fase 14 — mismo `STAFF_INVITE_ROLES` que `domain-restaurantes/src/roles.ts`
 * (duplicado aquí a propósito, ver el comentario de `StaffVerticalRole` en
 * lib/staff-client.ts): solo oculta el link "Staff" del nav para quien el servidor
 * rechazaría de todas formas (403 en admin-staff.ts) — nunca la única barrera. */
const STAFF_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

function buildSections(orgSlug: string, canSeeStaff: boolean): SidebarSection[] {
  const base = `/restaurantes/${orgSlug}`;
  const sections: SidebarSection[] = [
    {
      title: "Panel",
      siempreAbierto: true,
      items: [{ to: base, label: "Panel (KPIs)", icon: LayoutDashboard }],
    },
    {
      title: "Operación",
      items: [
        { to: `${base}/pedidos`, label: "Pedidos", icon: ClipboardList },
        { to: `${base}/historial`, label: "Historial", icon: History },
        { to: `${base}/productos`, label: "Productos", icon: UtensilsCrossed },
        { to: `${base}/promociones`, label: "Promociones", icon: Tag },
      ],
    },
    {
      title: "Negocio",
      items: [
        { to: `${base}/sucursales`, label: "Sucursales", icon: Store },
        { to: `${base}/clientes`, label: "Clientes", icon: Users },
      ],
    },
  ];
  if (canSeeStaff) {
    sections.push({
      title: "Equipo",
      items: [{ to: `${base}/staff`, label: "Staff", icon: UserCog }],
    });
  }
  return sections;
}

// Hallazgo de auditoría (severidad ALTA, "en viewport móvil el usuario ve el
// contenido sin logo/menú/logout": este Shell nunca importaba/renderizaba
// MobileHeader/BottomNav, a diferencia de CitasShell.tsx/LicitacionesShell.tsx —
// el <Sidebar> compartido es `hidden md:flex` (packages/ui/src/components/
// Sidebar.tsx), así que en mobile no quedaba NINGÚN nav): subconjunto operativo
// (≤5 ítems, mismo criterio ya documentado en BottomNav.tsx/CitasShell.tsx: más
// de 5 deja de ser usable con el pulgar) — Panel/Pedidos/Historial/Productos/
// Clientes, el día a día real del manager en el piso; Promociones/Sucursales
// (tareas de configuración, no operación diaria) y Staff (ya oculto en el
// Sidebar para quien no sea owner/admin) se quedan fuera de la barra, mismo
// trade-off que CitasShell.tsx aplicó (dropea Disponibilidad/Staff del Sidebar
// completo). Ningún ítem nuevo: los 5 ya existen en `buildSections`.
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/restaurantes/${orgSlug}`;
  return [
    { to: base, label: "Panel", icon: LayoutDashboard },
    { to: `${base}/pedidos`, label: "Pedidos", icon: ClipboardList },
    { to: `${base}/historial`, label: "Historial", icon: History },
    { to: `${base}/productos`, label: "Productos", icon: UtensilsCrossed },
    { to: `${base}/clientes`, label: "Clientes", icon: Users },
  ];
}

export function RestaurantesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: RestaurantesShellProps) {
  // Hallazgo de auditoría (severidad MEDIA/BRANDING, "Título de pestaña fijo en
  // 'Restaurantes' para las 6 verticales"): ver el comentario de cabecera de
  // use-document-title.ts — mecanismo genérico, esta es solo la integración de
  // restaurantes.
  useDocumentTitle("Restaurantes", orgSlug);
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  // Sucursal activa elegida en el selector de abajo -- `null` hasta que el staff
  // elige una explícitamente, en cuyo caso `resolveActivePropertyId` cae a la primera
  // de `branches` (mismo fallback que el `branches[0]` fijo de antes, pero ahora es
  // solo el default inicial, no un techo duro). Inicializado leyendo
  // lib/property-selection.ts (persistido para este `orgSlug`) para que sobreviva a
  // que App.tsx monte una instancia NUEVA de este Shell al navegar a otra ruta del
  // panel — mismo patrón exacto que HotelesShell.tsx.
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(() => readPersistedPropertyId(window.localStorage, orgSlug));
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que hoteles ("No existe botón ni flujo de 'Cerrar
  // sesión' en ninguna pantalla de restaurantes"): /auth/logout ya existe en el
  // backend (compartido entre verticales), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);
  // Regla de hooks: este componente tiene returns condicionales más abajo (sesión sin
  // resolver, error, sucursales cargando/vacías, redirección de repartidor) — el hook
  // vive ANTES de todos ellos, en un punto que SIEMPRE se ejecuta, en vez de moverlo
  // después de un return condicional. `session?.token ?? ""` deja que el hook arranque
  // con un token vacío mientras la sesión resuelve (useNotifications ya maneja bien
  // ese caso, ver su comentario de cabecera) y en las ramas de early-return el header
  // ni siquiera se pinta.
  const notif = useNotifications(apiBaseUrl, session?.token ?? "");

  useEffect(() => {
    const s = readPersistedSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría (rubro 19, multi-organización, severidad ALTA, "duplicado en
  // TODAS las verticales": "Expiración del JWT (15 min) no se maneja: el panel queda
  // muerto sin refresh ni redirección"): fetchJson/sendJson de dashboard-client.ts/
  // lib/admin-client.ts ya intentan un refresh automático ante un 401 (ver
  // ../../lib/authed-fetch.ts), pero si ESE refresh también falla no tienen forma de
  // navegar (no son componentes React). Disparan SESSION_EXPIRED_EVENT en `window`;
  // este Shell escucha y reusa el `onRequireLogin` que ya tenía. Filtra por
  // `detail.vertical` para no reaccionar al session-expired de otra vertical abierta
  // en otra pestaña.
  useEffect(() => {
    function handleSessionExpired(event: Event) {
      const detail = (event as CustomEvent<SessionExpiredEventDetail>).detail;
      if (detail?.vertical !== "restaurantes") return;
      clearSession(window.localStorage);
      setSession(null);
      onRequireLogin();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [onRequireLogin]);

  async function handleLogout() {
    if (!session || loggingOut) return;
    setLoggingOut(true);
    try {
      await logout(fetch, apiBaseUrl, session.refreshToken);
    } finally {
      clearSession(window.localStorage);
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
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-md">
          <EstadoError mensaje={error} />
        </div>
      </main>
    );
  }

  if (!branches) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">Cargando…</p>
      </main>
    );
  }

  if (branches.length === 0) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-md">
          <EstadoError mensaje="Este negocio todavía no tiene ninguna sucursal configurada." />
        </div>
      </main>
    );
  }

  // Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA, "cadena de
  // restaurantes con 2+ sucursales solo opera la primera"): antes se usaba SIEMPRE
  // `branches[0]!.propertyId`, sin importar cuántas sucursales trajera `branches` —
  // ver el comentario de cabecera de `resolveActivePropertyId`
  // (./dashboard-client.ts) para el hallazgo completo y el patrón (idéntico a
  // hoteles/despachos/rentas) que lo cierra.
  const propertyId = resolveActivePropertyId(branches, selectedPropertyId)!;
  const activeBranch = branches.find((b) => b.propertyId === propertyId)!;
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "staff";

  // Handler real del selector: actualiza el estado de React (recalcula
  // `children(ctx)` con el nuevo propertyId de inmediato, vía la `key={propertyId}`
  // de abajo) y persiste la selección best-effort (ver lib/property-selection.ts)
  // para que sobreviva a navegar a otra ruta del panel o a un refresh de página.
  function handleSelectBranch(nextPropertyId: string) {
    setSelectedPropertyId(nextPropertyId);
    persistPropertyId(window.localStorage, orgSlug, nextPropertyId);
  }

  // Ronda 13 — hallazgo de auditoría (severidad ALTA, mismo archivo de causa que el
  // listener de SESSION_EXPIRED_EVENT de arriba): un repartidor que entra por URL
  // directa a `/restaurantes/:orgSlug` (no por el link de su invitación, que ya lo
  // manda a `/restaurantes/:orgSlug/repartidor` vía `decideLandingPathForInvite`, ver
  // shell-landing-path.spec.ts) llegaba HASTA AQUÍ, con este Shell pintando el nav de
  // gestión completo (Productos/Sucursales/Pedidos/Historial/Clientes) para un rol
  // que `MANAGER_ROLES` (domain-restaurantes/src/roles.ts) excluye a propósito — y el
  // `<Dashboard>` que las rutas hijas renderizan ahí responde 403 porque el backend sí
  // aplica esa misma lista. Redirige ANTES de pintar ese nav, al único panel que el
  // backend de verdad le permite (mismo REPARTIDOR_ROLES) — nunca al revés: un
  // MANAGER_ROLE nunca pasa por aquí (siempre es "staff" para cualquier rol vertical
  // que no reconozca, ver el `?? "staff"` de arriba, así que solo "repartidor" exacto
  // dispara esto). Por esto mismo "Repartidor" nunca aparece como ítem de este
  // <Sidebar>: quien tiene ese rol jamás ve este nav, y quien SÍ lo ve (management)
  // nunca navega a esa ruta desde aquí.
  if (role === "repartidor") {
    return <Navigate to={`/restaurantes/${orgSlug}/repartidor`} replace />;
  }

  const sections = buildSections(orgSlug, STAFF_NAV_ROLES.has(role));

  const sucursalSelector =
    branches.length > 1 ? (
      <div>
        <label htmlFor="restaurantes-sucursal-activa" className="block mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          Sucursal activa
        </label>
        <select
          id="restaurantes-sucursal-activa"
          value={propertyId}
          onChange={(e) => handleSelectBranch(e.target.value)}
          className="w-full rounded-lg border border-border bg-card px-2 py-1.5 text-[13px] text-foreground"
        >
          {branches.map((b) => (
            <option key={b.propertyId} value={b.propertyId}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">{activeBranch.name}</p>
    );

  return (
    <div className="min-h-screen bg-background flex gap-3 p-3">
      <Sidebar sections={sections} user={{ email: session.email, rol: role }} onLogout={() => void handleLogout()} hotelSelector={sucursalSelector} />

      <MobileHeader
        title={<AtiendeWordmark className="scale-90 origin-left" />}
        action={<div className="flex items-center gap-2">{branches.length > 1 ? sucursalSelector : null}</div>}
      />

      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <div className="hidden md:block">
          <DashboardHeader
            variant="vertical"
            icon={<UtensilsCrossed className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />}
            title={
              <span className="min-w-0 flex flex-col">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground truncate">Restaurantes · {orgSlug}</span>
                <span className="text-sm font-medium text-foreground truncate">{activeBranch.name}</span>
              </span>
            }
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
            (selector, sin navegar) — mismo criterio que HotelesShell.tsx: cualquier
            página que cachee en su propio useState un resultado calculado para la
            sucursal anterior queda cubierta sin tener que auditarlas una por una. */}
        <main key={propertyId} className="flex-1 min-w-0 overflow-auto rounded-2xl border border-border bg-card pt-20 pb-24 md:pt-0 md:pb-0">
          {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role, staffFullName: session.fullName, staffEmail: session.email })}
        </main>
      </div>

      <BottomNav items={buildMobileItems(orgSlug)} />
    </div>
  );
}

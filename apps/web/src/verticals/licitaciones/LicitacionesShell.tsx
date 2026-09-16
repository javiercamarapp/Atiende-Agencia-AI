// Shell del panel de licitaciones (Fase 7) — resuelve sesión + propertyId UNA vez
// (mismo patrón de descubrimiento que CitasShell.tsx/restaurantes/Dashboard.tsx:
// la sesión de login nunca trae un propertyId, solo se resuelve al entrar al
// panel, vía GET /v1/licitaciones/:orgSlug/admin/branches) y le da a las páginas
// del panel (Convocatorias/detalle) la misma nav lateral y el mismo `role` del
// staff (para ocultar acciones que el servidor rechazaría igual, cosmético — el
// enforcement real es SIEMPRE server-side, ver WRITE_ROLES/GO_NO_GO_ROLES).
//
// Fase "sistema de diseño real" — reemplaza el `<nav>` inline-styled y sus
// `NAV_ITEMS` por el `Sidebar` real de @atiende/ui (mismo patrón "sidebar
// bottom hundido gris" que ya consumen Convocatorias/etc. de otras
// verticales), mapeando los mismos 4 ítems + Staff (gateado por rol, igual
// que antes) a `SidebarSection[]`. Cero cambios de sesión/routing/lógica de
// negocio: mismo fetch de branches, mismo manejo de error, mismo logout,
// mismo listener de SESSION_EXPIRED_EVENT.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Building2, FileText, Gavel, Radar, Target, Users } from "lucide-react";
import { Sidebar, DashboardHeader, NotificationBell, EstadoError, EstadoVacio, MobileHeader, BottomNav } from "@atiende/ui";
import type { SidebarSection } from "@atiende/ui";
import { BotonChatDatos } from "../../components/BotonChatDatos.tsx";
import { useNotifications } from "../../lib/useNotifications.ts";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { clearLicitacionesSession, logout, readPersistedLicitacionesSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchBranches } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { SESSION_EXPIRED_EVENT } from "../../lib/authed-fetch.ts";
import type { SessionExpiredEventDetail } from "../../lib/authed-fetch.ts";
import { ATIENDE_LOGO_DATA_URI, LICITACIONES_TAB_TITLE } from "./lib/brand.ts";

export interface LicitacionesShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (owner/admin/analyst/writer/reviewer/viewer,
   * ver domain-licitaciones/src/roles.ts) — cosmético, para ocultar botones que el
   * servidor rechazaría igual; nunca la única barrera. */
  readonly role: string;
  /** Para el saludo real (`saludoConNombre`) del landing (Convocatorias.tsx) --
   *  el Shell ya resuelve `session` pero no lo exponía completo a las páginas
   *  hijas, solo estos dos campos puntuales. */
  readonly staffFullName: string | undefined;
  readonly staffEmail: string;
}

export interface LicitacionesShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: LicitacionesShellContext) => ReactNode;
}

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): mismo `STAFF_INVITE_ROLES`
// que domain-licitaciones/src/roles.ts (duplicado aquí a propósito, ver el
// comentario de `role` de `LicitacionesShellContext`) — solo oculta el link
// "Staff" del nav para quien el servidor rechazaría de todas formas (403 en
// admin-staff.ts), nunca la única barrera.
const STAFF_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function LicitacionesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: LicitacionesShellProps) {
  const [session, setSession] = useState<LoginSession | null | undefined>(undefined);
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Mismo hallazgo de auditoría que hoteles/restaurantes/citas: /auth/logout ya
  // existe en el backend (compartido entre verticales), solo faltaba el botón.
  const [loggingOut, setLoggingOut] = useState(false);
  // Regla de hooks: este componente tiene early-returns condicionales más abajo
  // (sesión sin resolver/ausente, error, branches cargando/vacío) -- el hook se
  // llama aquí, ANTES de cualquiera de esos returns, con `session?.token ?? ""`
  // (useNotifications ya tolera un token vacío, ver su comentario de cabecera).
  const notif = useNotifications(apiBaseUrl, session?.token ?? "");

  useEffect(() => {
    const s = readPersistedLicitacionesSession(window.localStorage);
    setSession(s);
    if (!s) onRequireLogin();
  }, [onRequireLogin]);

  // Hallazgo de auditoría ("título de pestaña fijo en 'Restaurantes'") — ver
  // el comentario de `LICITACIONES_TAB_TITLE` en lib/brand.ts.
  useEffect(() => {
    document.title = LICITACIONES_TAB_TITLE;
  }, []);

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
      if (detail?.vertical !== "licitaciones") return;
      clearLicitacionesSession(window.localStorage);
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
      clearLicitacionesSession(window.localStorage);
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
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudo cargar la organización.");
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
          <EstadoVacio mensaje="Esta organización todavía no tiene ninguna property configurada." />
        </div>
      </main>
    );
  }

  // §2.1 del diseño Fase 1 — licitaciones opera como property singleton por
  // organización (a diferencia de hoteles, multi-hotel bajo una sola cuenta): el
  // panel usa la primera property, mismo criterio que CitasShell.tsx.
  const propertyId = branches[0]!.propertyId;
  const role = session.organizations.find((o) => o.slug === orgSlug)?.rol ?? "viewer";
  const puedeVerStaff = STAFF_NAV_ROLES.has(role);

  const base = `/licitaciones/${orgSlug}`;
  const sections: SidebarSection[] = [
    {
      title: "Licitaciones",
      siempreAbierto: true,
      items: [
        { to: `${base}/convocatorias`, label: "Convocatorias", icon: Gavel },
        { to: `${base}/radar-renovaciones`, label: "Radar de renovaciones", icon: Radar },
      ],
    },
    {
      title: "Organización",
      items: [
        { to: `${base}/perfil-matching`, label: "Perfil de matching", icon: Target },
        { to: `${base}/datos-empresa`, label: "Datos de la empresa", icon: Building2 },
        ...(puedeVerStaff ? [{ to: `${base}/staff`, label: "Staff", icon: Users }] : []),
      ],
    },
  ];

  const contexto: LicitacionesShellContext = {
    apiBaseUrl,
    token: session.token,
    propertyId,
    orgSlug,
    role,
    staffFullName: session.fullName,
    staffEmail: session.email,
  };

  return (
    <div className="min-h-screen bg-muted/30 flex gap-3 p-3">
      <Sidebar sections={sections} user={{ email: session.email, rol: role }} onLogout={handleLogout} />

      <MobileHeader
        title={
          <span className="flex items-center gap-2 min-w-0">
            <img src={ATIENDE_LOGO_DATA_URI} alt="atiende" width={80} height={14} />
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground truncate">Licitaciones · {orgSlug}</span>
          </span>
        }
        action={
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="text-[12px] text-destructive font-medium min-h-11 px-2"
          >
            {loggingOut ? "Saliendo…" : "Salir"}
          </button>
        }
      />

      <div className="flex-1 min-w-0 flex flex-col gap-3 pt-16 pb-20 md:pt-0 md:pb-0">
        <DashboardHeader
          className="hidden md:flex"
          variant="vertical"
          icon={<FileText className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />}
          title={`Licitaciones · ${orgSlug}`}
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

        <main className="flex-1 min-w-0 overflow-auto rounded-2xl border border-border bg-card p-4 sm:p-6">{children(contexto)}</main>
      </div>

      <BottomNav
        items={[
          { to: `${base}/convocatorias`, label: "Convocatorias", icon: Gavel },
          { to: `${base}/radar-renovaciones`, label: "Radar", icon: Radar },
          { to: `${base}/perfil-matching`, label: "Matching", icon: Target },
          { to: `${base}/datos-empresa`, label: "Empresa", icon: Building2 },
        ]}
      />
    </div>
  );
}

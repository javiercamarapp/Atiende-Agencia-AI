// Shell del panel de administración visual de citas — resuelve sesión +
// propertyId UNA vez y le da a las páginas (Agenda/Proveedores/Servicios/Clientes/
// Disponibilidad/Configuración/Staff/Auditoría/Privacidad) la misma nav.
//
// PR-4 del plan de diseño-ux: vertical PILOTO del shell único. La sesión (lectura
// persistida, SESSION_EXPIRED_EVENT, sucursales, sucursal activa, rol, logout) vive
// ahora en `useVerticalSession` (../../lib/useVerticalSession.ts) y el chrome
// (Sidebar, MobileHeader + menú de cuenta, BottomNav con "Más", cabecera de
// escritorio, <main>) en `VerticalShell` de @atiende/ui; este archivo solo aporta
// lo propio de citas: el adaptador de sesión, el mapa de navegación y el contexto
// que reciben las páginas.
import type { ReactNode } from "react";
import { VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import {
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ClipboardList,
  LayoutDashboard,
  Lock,
  Scissors,
  Settings,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { clearCitasSession, logout, readPersistedCitasSession } from "./lib/auth-client.ts";
import { fetchBranches, resolveActivePropertyId } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";

/** Adaptador de sesión de citas. DEBE ser una constante de módulo (el hook lo usa como dependencia de sus efectos). */
const CITAS_SESSION: VerticalSessionAdapter<BranchOption> = {
  vertical: "citas",
  readSession: readPersistedCitasSession,
  clearSession: clearCitasSession,
  logout,
  fetchBranches,
  readPropertyId: readPersistedPropertyId,
  persistPropertyId,
  resolveActivePropertyId,
};

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
      title: "Agenda",
      siempreAbierto: true,
      items: [
        // C-05 -- panel Resumen (citas hoy/semana, por confirmar, no-shows, clientes nuevos).
        { to: `${base}/resumen`, label: "Resumen", icon: LayoutDashboard },
        { to: `${base}/agenda`, label: "Agenda", icon: CalendarCheck },
      ],
    },
    {
      title: "Negocio",
      items: [
        { to: `${base}/proveedores`, label: "Proveedores", icon: UserRound },
        { to: `${base}/servicios`, label: "Servicios", icon: Scissors },
        { to: `${base}/clientes`, label: "Clientes", icon: Users },
        { to: `${base}/disponibilidad`, label: "Disponibilidad", icon: CalendarRange },
      ],
    },
    {
      title: "Administrar",
      items: [
        { to: `${base}/configuracion`, label: "Configuración", icon: Settings },
        { to: `${base}/staff`, label: "Staff", icon: ShieldCheck },
        // FASE 3 (producto) — bitácora de auditoría del staff (ver
        // packages/domain-citas/migrations/023_citas_audit_log.sql). Solo
        // owner/admin la ven con datos reales -- `AuditoriaPage` misma gatea su
        // propio contenido por rol (mismo criterio que restaurantes/rentas).
        { to: `${base}/auditoria`, label: "Auditoría", icon: ClipboardList },
        // C-02 -- solicitudes de derechos ARCO (owner/admin; la página gatea por rol).
        { to: `${base}/privacidad`, label: "Privacidad", icon: Lock },
      ],
    },
  ];
}

/** Barra inferior móvil: los 4 destinos operativos más usados; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y
 * lista TODAS las secciones, así Disponibilidad, Configuración, Staff, Auditoría y Privacidad también se alcanzan en móvil. */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/citas/${orgSlug}`;
  return [
    { to: `${base}/agenda`, label: "Agenda", icon: CalendarCheck },
    { to: `${base}/proveedores`, label: "Proveedores", icon: UserRound },
    { to: `${base}/servicios`, label: "Servicios", icon: Scissors },
    { to: `${base}/clientes`, label: "Clientes", icon: Users },
  ];
}

export function CitasShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: CitasShellProps) {
  const s = useVerticalSession({ adapter: CITAS_SESSION, apiBaseUrl, orgSlug, onRequireLogin });

  if (s.fase === "resolviendo") return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (s.fase === "sin-sesion") return null; // onRequireLogin ya disparó la redirección
  if (s.fase === "error") return <VerticalShellEstado estado="error" mensaje={s.error ?? undefined} onReintentar={s.reintentar} />;
  if (s.fase === "cargando") return <VerticalShellEstado estado="cargando" mensaje="Cargando sucursales…" />;
  if (s.fase === "vacio") return <VerticalShellEstado estado="vacio" mensaje="Este negocio todavía no tiene ninguna sucursal configurada." />;

  const { session, branches, activeBranch, propertyId, orgId, role } = s;
  const user = { email: session.email, rol: role };

  // Selector real, visible solo cuando hay más de una sucursal (si no, solo el nombre). Se ofrece en el bloque
  // de cuenta del Sidebar (escritorio) y en el MobileHeader, para no perder la función en viewport angosto.
  const branchSelector =
    branches.length > 1 ? (
      <div>
        <label htmlFor="citas-sucursal-activa" className="block mb-1 font-mono text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
          Sucursal activa
        </label>
        <select
          id="citas-sucursal-activa"
          value={propertyId}
          onChange={(e) => s.selectBranch(e.target.value)}
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
    <VerticalShellConectado
      apiBaseUrl={apiBaseUrl}
      token={session.token}
      vertical="citas"
      sections={buildSections(orgSlug)}
      mobileItems={buildMobileItems(orgSlug)}
      user={user}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <CalendarClock className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />, title: `Citas · ${orgSlug}`, fecha: fechaCortaEsMx() }}
      branchSelector={branchSelector}
      mobileSelector={branches.length > 1 ? branchSelector : null}
      contentKey={propertyId}
    >
      {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, orgId, role, staffFullName: session.fullName, staffEmail: session.email })}
    </VerticalShellConectado>
  );
}

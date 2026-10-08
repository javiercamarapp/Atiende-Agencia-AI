// Shell del panel de staff de rentas — resuelve sesión + propiedad activa UNA vez y le da
// a todas las páginas hijas la misma navegación y el mismo contexto.
//
// PR-7 del plan de diseño-ux (DS v2): igual que restaurantes (PR-5), hoteles (PR-6) y
// despachos (PR-8), la sesión (lectura persistida, SESSION_EXPIRED_EVENT, propiedades,
// propiedad activa persistida por organización, logout) vive en `useVerticalSession` y el
// chrome (Sidebar, MobileHeader + menú de cuenta, BottomNav con "Más", cabecera de
// escritorio, un único <main> con skip link) en `VerticalShell` de @atiende/ui; este
// archivo solo aporta lo propio de rentas: el adaptador de sesión, el mapa de navegación,
// el chat con datos y el contexto que reciben las páginas.
//
// El contexto (`RentasShellContext`) no cambia: las páginas siguen recibiendo `properties`,
// `setPropertyId` y `session` (el rol de cada página se sigue derivando de `session`; es
// cosmético, el enforcement real es SIEMPRE server-side).
//
// Rentas es multi-propiedad por diseño (una gestora administra propiedades de varios
// anfitriones): el selector real de propiedad va bajo el logo del Sidebar y en el
// MobileHeader, la propiedad activa se persiste por organización (lib/property-selection.ts,
// porque App.tsx monta una instancia nueva del shell en cada ruta) y su nombre se ve siempre
// en la cabecera de escritorio. `contentKey={propertyId}` remonta las páginas hijas al
// cambiar de propiedad, para que ningún formulario/estado local muestre datos de la anterior.
import type { ReactNode } from "react";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  ClipboardCheck,
  ClipboardList,
  Home,
  Inbox,
  KeyRound,
  LayoutDashboard,
  Lock,
  MessageSquareText,
  Network,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Tag,
  Users,
  Wallet,
  Building2,
} from "lucide-react";
import { NativeSelect, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { etiquetaRol } from "../../lib/roles.ts";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { crearChatConexionRentas } from "./lib/data-chat-client.ts";
import { clearRentasSession, logout, readPersistedRentasSession } from "./lib/auth-client.ts";
import type { LoginSession } from "./lib/auth-client.ts";
import { fetchProperties } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { persistPropertyId, readPersistedPropertyId, resolveActivePropertyId } from "./lib/property-selection.ts";

/** Propiedad con el `name` que exige `useVerticalSession`; `nombre` sigue siendo el campo del API. */
type PropiedadOption = PropertyOption & { readonly name: string };

/** Adaptador de sesión de rentas. DEBE ser una constante de módulo (el hook lo usa como dependencia de sus efectos). */
const RENTAS_SESSION: VerticalSessionAdapter<PropiedadOption> = {
  vertical: "rentas",
  readSession: readPersistedRentasSession,
  clearSession: clearRentasSession,
  logout,
  fetchBranches: async (fetchImpl, apiBaseUrl, token, orgSlug) => (await fetchProperties(fetchImpl, apiBaseUrl, token, orgSlug)).map((p) => ({ ...p, name: p.nombre })),
  readPropertyId: readPersistedPropertyId,
  persistPropertyId,
  resolveActivePropertyId,
};

/** Roles con acceso al Copiloto = `FINANZAS_LECTURA_ROLES` de domain-rentas/src/roles.ts (duplicado aquí a propósito, igual que
 * en Finanzas.tsx): solo oculta la entrada del Sidebar, la píldora y el botón a quien el servidor rechazaría con 403
 * (admin-data-chat.ts); nunca es la única barrera. */
const COPILOTO_ROLES: ReadonlySet<string> = new Set(["admin_gestora", "contador"]);

/** UNI-6: categorías en el orden de Likida (Operación, Canales, Finanzas, Configuración, Control) con "Resumen" y "Calendario"
 * como raíz sin título. Mismas rutas y etiquetas exactas que antes, solo reagrupadas (la agrupación original se inspiró en el
 * AdminSidebar de atiende-rentas-vacacionales standalone). "Plataforma" se omite: notificaciones, perfil y cierre de sesión ya
 * viven en el pie del Sidebar. Catálogo y Equipo se quedan en "Configuración": cada página gatea su contenido por rol. */
function buildSections(orgSlug: string, canSeeCopiloto: boolean, canSeePrivacidad: boolean): SidebarSection[] {
  const ruta = (sufijo: string) => `/rentas/${orgSlug}${sufijo ? `/${sufijo}` : ""}`;
  return [
    {
      title: "Resumen",
      siempreAbierto: true,
      items: [
        { to: ruta(""), label: "Resumen", icon: LayoutDashboard, end: true },
        // CHAT-10: el Copiloto ("Pregunta a tus datos") va justo debajo de Resumen, como en las demás consolas.
        ...(canSeeCopiloto ? [{ to: ruta("copiloto"), label: "Copiloto", icon: Sparkles }] : []),
        { to: ruta("calendario"), label: "Calendario", icon: CalendarDays },
      ],
    },
    {
      title: "Operación",
      items: [
        { to: ruta("aprobaciones"), label: "Aprobaciones", icon: Inbox },
        { to: ruta("mis-tareas"), label: "Mis tareas", icon: ClipboardList },
        { to: ruta("plantillas"), label: "Plantillas", icon: MessageSquareText },
        { to: ruta("acceso-huesped"), label: "Acceso al huésped", icon: KeyRound },
      ],
    },
    {
      title: "Canales",
      items: [
        { to: ruta("conectividad"), label: "Conectividad", icon: Network },
        { to: ruta("ical-sync"), label: "Sincronización iCal", icon: RefreshCcw },
        { to: ruta("monitor-sync"), label: "Monitor de conflictos", icon: AlertTriangle },
      ],
    },
    {
      title: "Finanzas",
      items: [
        { to: ruta("precios"), label: "Precios", icon: Tag },
        { to: ruta("finanzas"), label: "Finanzas", icon: Wallet },
        { to: ruta("reportes"), label: "Reportes", icon: BarChart3 },
      ],
    },
    {
      title: "Configuración",
      items: [
        // Rn-19: alta y edición de propiedades, unidades y propietarios; Rn-20: invitar, rol y baja del equipo.
        { to: ruta("catalogo"), label: "Catálogo", icon: Building2 },
        { to: ruta("equipo"), label: "Equipo", icon: Users },
      ],
    },
    {
      title: "Control",
      items: [
        // Bitácora de auditoría del staff; AuditoriaPage gatea su propio contenido por admin_gestora.
        { to: ruta("auditoria"), label: "Auditoría", icon: ClipboardCheck },
        // Rn-07: solicitudes ARCO de rentas (admin_gestora) y privacidad de TODA la organización (ARCO de todos los verticales, retención, aviso versionado).
        // Solo admin_gestora: las dos páginas (y su RLS) bloquean a los demás roles, así que no se les ofrece la entrada.
        ...(canSeePrivacidad
          ? [
              { to: ruta("privacidad"), label: "Privacidad", icon: Lock },
              { to: ruta("privacidad-organizacion"), label: "Privacidad de la organización", icon: ShieldCheck },
            ]
          : []),
      ],
    },
  ];
}

/** Barra inferior móvil: los 4 destinos de uso diario en piso (incluido `Mis tareas`, único panel funcional del rol
 * `limpieza`); el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las secciones de `buildSections` (hasta 16
 * destinos), de modo que Precios, Finanzas, iCal, Monitor, Acceso al huésped, Reportes y Auditoría siguen alcanzables. */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/rentas/${orgSlug}`;
  return [
    { to: base, label: "Resumen", icon: LayoutDashboard, end: true },
    { to: `${base}/calendario`, label: "Calendario", icon: CalendarDays },
    { to: `${base}/mis-tareas`, label: "Mis tareas", icon: ClipboardList },
    { to: `${base}/finanzas`, label: "Finanzas", icon: Wallet },
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
  // Título de pestaña por vertical/organización. El hook va ANTES de los returns condicionales.
  useDocumentTitle("Rentas", orgSlug);
  const s = useVerticalSession({ adapter: RENTAS_SESSION, apiBaseUrl, orgSlug, onRequireLogin });

  if (s.fase === "resolviendo") return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (s.fase === "sin-sesion") return null; // onRequireLogin ya disparó la redirección
  if (s.fase === "error") return <VerticalShellEstado estado="error" mensaje={s.error ?? undefined} onReintentar={s.reintentar} />;
  if (s.fase === "cargando") return <VerticalShellEstado estado="cargando" mensaje="Cargando propiedades…" />;
  if (s.fase === "vacio") return <VerticalShellEstado estado="vacio" mensaje="Esta organización todavía no tiene ninguna propiedad configurada." />;

  const { session, branches, activeBranch, propertyId } = s;
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeCopiloto = org ? COPILOTO_ROLES.has(org.rol) : false;
  const puedePrivacidad = org?.rol === "admin_gestora";

  // "Chatea con tus datos": conexión real con el backend de rentas (catálogo cerrado, solo admin_gestora/contador en el
  // servidor). El servidor decide el alcance a partir del token; aquí solo van la propiedad activa y el texto.
  const chatConexion = crearChatConexionRentas(apiBaseUrl, session.token, propertyId);

  // Selector real de propiedad: lista solo con 2+ (el caso base de este vertical); con una sola se muestra su nombre. Va
  // en el bloque de cuenta del Sidebar (escritorio) y en el MobileHeader, para no perder la función en viewport angosto.
  const propiedadSelector =
    branches.length > 1 ? (
      <div>
        <label htmlFor="rentas-propiedad-activa" className="block mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Propiedad
        </label>
        <NativeSelect id="rentas-propiedad-activa" size="sm" value={propertyId} onChange={(e) => s.selectBranch(e.target.value)}>
          {branches.map((p) => (
            <option key={p.propertyId} value={p.propertyId}>
              {p.nombre}
            </option>
          ))}
        </NativeSelect>
      </div>
    ) : (
      <p className="text-xs text-muted-foreground truncate">{activeBranch.nombre}</p>
    );

  return (
    <VerticalShellConectado
      apiBaseUrl={apiBaseUrl}
      token={session.token}
      notificacionesHref={`/rentas/${orgSlug}/notificaciones`}
      chat={chatConexion}
      vertical="rentas"
      copilotoHref={`/rentas/${orgSlug}/copiloto`}
      ocultarChat={!puedeCopiloto}
      sections={buildSections(orgSlug, puedeCopiloto, puedePrivacidad)}
      mobileItems={buildMobileItems(orgSlug)}
      user={{ email: session.email, rol: org?.rol, nombre: session.fullName, rolEtiqueta: etiquetaRol(org?.rol) }}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <Home className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: `${org?.nombre ?? orgSlug} · ${activeBranch.nombre}`, fecha: fechaCortaEsMx(), resumenTo: `/rentas/${orgSlug}` }}
      branchSelector={propiedadSelector}
      mobileSelector={branches.length > 1 ? propiedadSelector : null}
      contentKey={propertyId}
    >
      {children({ apiBaseUrl, token: session.token, propertyId, setPropertyId: s.selectBranch, properties: branches, orgSlug, session })}
    </VerticalShellConectado>
  );
}

// Shell del back-office CORE de restaurantes (landing post-login) — resuelve sesión +
// propertyId UNA vez y le da a todas las páginas (Panel de KPIs, Productos, Sucursales,
// Pedidos, Historial, Clientes, ...) la misma navegación.
//
// PR-5 del plan de diseño-ux (R-22): restaurantes, primer cliente PM, migra al shell
// único. La sesión (lectura persistida, SESSION_EXPIRED_EVENT, sucursales, sucursal
// activa, rol, logout) vive en `useVerticalSession` y el chrome (Sidebar, MobileHeader +
// menú de cuenta, BottomNav con "Más", cabecera de escritorio, <main>) en
// `VerticalShell` de @atiende/ui; este archivo solo aporta lo propio de restaurantes:
// el adaptador de sesión, el mapa de navegación, la redirección del repartidor, el chat
// con datos y el contexto que reciben las páginas.
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import {
  BellRing,
  CalendarCheck,
  ClipboardCheck,
  ClipboardList,
  ClipboardPaste,
  History,
  Clock,
  LayoutDashboard,
  LineChart,
  ListChecks,
  Lock,
  Megaphone,
  MessageSquare,
  MessageCircle,
  Mic,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Tag,
  UserCog,
  Users,
  UtensilsCrossed,
} from "lucide-react";
import { Selector, VarianteEstadoVacioProvider, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import type { ChatDatosConexion } from "../../components/PanelChateaConTusDatos.tsx";
import { clearSession, logout, readPersistedSession } from "../../lib/auth-client.ts";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { etiquetaRol } from "../../lib/roles.ts";
import { puedeEn } from "./lib/permisos.ts";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { fetchBranches, resolveActivePropertyId } from "./dashboard-client.ts";
import type { BranchOption } from "./dashboard-client.ts";
import { SUGERENCIAS_RESTAURANTES, ejecutarConsultaDirecta, fetchDataChatDisponible, preguntarDatos } from "./data-chat-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { PuertaOnboarding } from "./PuertaOnboarding.tsx";

/** Adaptador de sesión de restaurantes. DEBE ser una constante de módulo (el hook lo usa como dependencia de sus efectos). */
const RESTAURANTES_SESSION: VerticalSessionAdapter<BranchOption> = {
  vertical: "restaurantes",
  readSession: readPersistedSession,
  clearSession,
  logout,
  fetchBranches,
  readPropertyId: readPersistedPropertyId,
  persistPropertyId,
  resolveActivePropertyId,
};

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
  /** Nombre de la sucursal activa (encabezado del chat de prueba y de la vista previa de voz). Opcional: los contextos de prueba pueden omitirlo. */
  readonly nombreSucursal?: string;
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

/** Roles con acceso al Copiloto = `MANAGER_ROLES` de domain-restaurantes/src/roles.ts (duplicado aquí a propósito, igual que
 * STAFF_NAV_ROLES): solo oculta la entrada del Sidebar, la pildora y el botón a quien el servidor rechazaría con 403
 * (admin-data-chat.ts); nunca es la única barrera. Un repartidor ya es redirigido a `/repartidor` antes de pintar el nav. */
const COPILOTO_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "staff"]);

// UNI-6: categorías en el orden de Likida (Operación, Catálogo, Clientes y, solo owner/admin, Agente y Configuración) con
// "Resumen" como raíz sin título. Mismos destinos y roles que antes: ningún link se agrega ni se quita, solo se reagrupan
// (Agente de voz y los de gestión siguen detrás de STAFF_NAV_ROLES).
function buildSections(orgSlug: string, canSeeStaff: boolean, canSeeCopiloto: boolean, canSeePromociones = true, canSeeCfo = false): SidebarSection[] {
  const base = `/restaurantes/${orgSlug}`;
  const sections: SidebarSection[] = [
    {
      title: "Resumen",
      siempreAbierto: true,
      // CHAT-08: el Copiloto ("Pregunta a tus datos") va justo debajo de Resumen, como en las demás consolas (spec de diseño §203).
      items: [
        { to: base, label: "Resumen", icon: LayoutDashboard, end: true },
        ...(canSeeCopiloto ? [{ to: `${base}/copiloto`, label: "Copiloto", icon: Sparkles }] : []),
        // CFO-07: tablero financiero (solo owner/admin, `cfo.ver`; staff y repartidor no lo ven y el API les responde 403).
        ...(canSeeCfo ? [{ to: `${base}/cfo`, label: "CFO", icon: LineChart }] : []),
      ],
    },
    {
      title: "Operación",
      items: [
        { to: `${base}/pedidos`, label: "Pedidos", icon: ClipboardList },
        // Captura asistida de SoftRestaurant: la cola de comandas que alguien teclea en el POS (MANAGER_ROLES, igual que el servidor).
        { to: `${base}/comandas-pos`, label: "Comandas al POS", icon: ClipboardPaste },
        // R-21: bandeja de conversaciones (WhatsApp y llamadas) con toma por una persona, y turnos de personal.
        { to: `${base}/conversaciones`, label: "Conversaciones", icon: MessageSquare },
        { to: `${base}/turnos`, label: "Turnos", icon: Clock },
        { to: `${base}/historial`, label: "Historial", icon: History },
        // R-16: "Mis avisos" para quien no ve la categoria Configuración (el staff de piso); owner/admin lo tienen allí.
        ...(canSeeStaff ? [] : [{ to: `${base}/avisos`, label: "Avisos", icon: BellRing }]),
        // R-42: cierre del día y resumen semanal (solo owner/admin: el servidor exige el mismo umbral).
        ...(canSeeStaff ? [{ to: `${base}/cierres`, label: "Cierre del día", icon: CalendarCheck }] : []),
      ],
    },
    {
      title: "Catálogo",
      items: [
        { to: `${base}/productos`, label: "Productos", icon: UtensilsCrossed },
        // PL-23: las promociones son de owner/admin (el servidor las rechaza con 403 para staff): no se muestra el enlace.
        ...(canSeePromociones ? [{ to: `${base}/promociones`, label: "Promociones", icon: Tag }] : []),
      ],
    },
    {
      title: "Clientes",
      items: [
        { to: `${base}/clientes`, label: "Clientes", icon: Users },
        // Autopiloto 2: campañas de reactivación de clientes inactivos (solo owner/admin: el servidor exige el mismo umbral).
        ...(canSeeStaff ? [{ to: `${base}/campanas`, label: "Campañas", icon: Megaphone }] : []),
        { to: `${base}/sucursales`, label: "Sucursales", icon: Store },
      ],
    },
  ];
  if (canSeeStaff) {
    // Agente de voz (config, vista previa, conversaciones) -- mismo umbral owner/admin: la configuración del agente es
    // de gestión, no de operación.
    sections.push({
      title: "Agente",
      items: [
        { to: `${base}/agente-voz`, label: "Agente de voz", icon: Mic },
        // R-31: indicadores del agente de WhatsApp (conversaciones, conversión, handoff y costo LLM por día).
        { to: `${base}/agente-whatsapp`, label: "Agente de WhatsApp", icon: MessageCircle },
        // Modelo, temperatura, voz, sonido de fondo y conocimiento automatico del agente (owner/admin).
        { to: `${base}/agente-ajustes`, label: "Ajustes del agente", icon: SlidersHorizontal },
      ],
    });
    // FASE 3 (producto) — la bitácora de auditoría es de lectura SOLO owner/admin (mismo mandato que el servidor exige,
    // ver apps/api/src/routes/verticals/restaurantes/auditoria.ts) -- reusa el mismo `canSeeStaff`
    // (STAFF_NAV_ROLES = {"owner","admin"}) en vez de una lista nueva: todos estos links comparten el mismo umbral de rol.
    sections.push({
      title: "Configuración",
      items: [
        // R-33: checklist de onboarding calculado con datos reales (mismo umbral owner/admin).
        { to: `${base}/primeros-pasos`, label: "Primeros pasos", icon: ListChecks },
        // FASE 3 (producto) — configuración de WhatsApp/zonas conocidas.
        { to: `${base}/configuracion`, label: "Configuración", icon: Settings },
        { to: `${base}/staff`, label: "Staff", icon: UserCog },
        // R-16: avisos por persona (matriz del equipo) y tiempo de gracia de la entrega tardía por sucursal.
        { to: `${base}/avisos`, label: "Avisos", icon: BellRing },
        { to: `${base}/auditoria`, label: "Auditoría", icon: ClipboardCheck },
        // PM PR-9 -- solicitudes ARCO y configuración de privacidad (owner/admin).
        { to: `${base}/privacidad`, label: "Privacidad", icon: Lock },
        // PL-13 -- privacidad de TODA la organizacion (ARCO de todos los verticales, retención, purgas, aviso versionado).
        { to: `${base}/privacidad-organizacion`, label: "Privacidad de la organización", icon: ShieldCheck },
      ],
    });
  }
  return sections;
}

/** Barra inferior móvil: los 4 destinos operativos de cada día; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS
 * las secciones, así Clientes, Conversaciones, Turnos, Promociones, Sucursales y las de gestión también se alcanzan en móvil
 * (antes eran 5 destinos fijos y el resto no tenía acceso móvil). Ningún ítem nuevo: los 4 ya existen en `buildSections`. */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/restaurantes/${orgSlug}`;
  return [
    { to: base, label: "Resumen", icon: LayoutDashboard, end: true },
    { to: `${base}/pedidos`, label: "Pedidos", icon: ClipboardList },
    { to: `${base}/historial`, label: "Historial", icon: History },
    { to: `${base}/productos`, label: "Productos", icon: UtensilsCrossed },
  ];
}

export function RestaurantesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: RestaurantesShellProps) {
  // Título de pestaña por vertical/organización (ver use-document-title.ts). El hook va ANTES de los returns condicionales.
  useDocumentTitle("Restaurantes", orgSlug);
  const s = useVerticalSession({ adapter: RESTAURANTES_SESSION, apiBaseUrl, orgSlug, onRequireLogin });

  if (s.fase === "resolviendo") return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (s.fase === "sin-sesion") return null; // onRequireLogin ya disparó la redirección
  if (s.fase === "error") return <VerticalShellEstado estado="error" mensaje={s.error ?? undefined} onReintentar={s.reintentar} />;
  if (s.fase === "cargando") return <VerticalShellEstado estado="cargando" mensaje="Cargando sucursales…" />;
  if (s.fase === "vacio") return <VerticalShellEstado estado="vacio" mensaje="Este negocio todavía no tiene ninguna sucursal configurada." />;

  const { session, branches, activeBranch, propertyId, role } = s;

  // Ronda 13 — hallazgo de auditoría (severidad ALTA): un repartidor que entra por URL directa a
  // `/restaurantes/:orgSlug` (no por el link de su invitación, que ya lo manda a `/repartidor`, ver
  // shell-landing-path.spec.ts) llegaba hasta aquí con el nav de gestión completo, y el `<Dashboard>` respondía 403
  // porque el backend sí aplica `MANAGER_ROLES`. Se redirige ANTES de pintar ese nav al único panel que el backend le
  // permite (mismo REPARTIDOR_ROLES). Cualquier rol vertical que no se reconozca cae a "staff" (`defaultRole`), así
  // que solo "repartidor" exacto dispara esto; "Repartidor" nunca aparece como ítem del Sidebar.
  if (role === "repartidor") {
    return <Navigate to={`/restaurantes/${orgSlug}/repartidor`} replace />;
  }

  // "Chatea con tus datos": conexión real con el backend de restaurantes (piloto del motor compartido).
  // El servidor decide el alcance a partir del token; aquí solo van la sucursal activa y el texto.
  const chatConexion: ChatDatosConexion = {
    clave: propertyId,
    disponible: () => fetchDataChatDisponible(fetch, apiBaseUrl, session.token, propertyId),
    enviar: (pregunta, historial) => preguntarDatos(fetch, apiBaseUrl, session.token, propertyId, pregunta, historial),
    ejecutarOpcion: (tool) => ejecutarConsultaDirecta(fetch, apiBaseUrl, session.token, propertyId, tool),
    sugerencias: SUGERENCIAS_RESTAURANTES,
  };

  // Selector real, visible solo cuando hay más de una sucursal (si no, solo el nombre). Se ofrece en el bloque de
  // cuenta del Sidebar (escritorio) y en el MobileHeader, para no perder la función en viewport angosto.
  // El MISMO selector se pinta en el Sidebar y en el MobileHeader (ambos viven en el DOM; CSS oculta uno): cada copia lleva su
  // propio id y su propio <label for>, para que no haya ids duplicados y el select visible tenga nombre accesible
  // (QA-restaurantes-R1-botones-03).
  const sucursalSelector = (idSelect: string) =>
    branches.length > 1 ? (
      <div>
        <label htmlFor={idSelect} className="block mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Sucursal activa
        </label>
        <Selector id={idSelect} size="sm" value={propertyId} onChange={(e) => s.selectBranch(e.target.value)}>
          {branches.map((b) => (
            <option key={b.propertyId} value={b.propertyId}>
              {b.name}
            </option>
          ))}
        </Selector>
      </div>
    ) : (
      <p className="text-xs text-muted-foreground truncate">{activeBranch.name}</p>
    );

  return (
    <VerticalShellConectado
      apiBaseUrl={apiBaseUrl}
      token={session.token}
      notificacionesHref={`/restaurantes/${orgSlug}/notificaciones`}
      chat={chatConexion}
      vertical="restaurantes"
      copilotoHref={`/restaurantes/${orgSlug}/copiloto`}
      ocultarChat={!COPILOTO_ROLES.has(role)}
      sections={buildSections(orgSlug, STAFF_NAV_ROLES.has(role), COPILOTO_ROLES.has(role), puedeEn(role, "promociones.ver"), puedeEn(role, "cfo.ver"))}
      mobileItems={buildMobileItems(orgSlug)}
      user={{ email: session.email, rol: role, nombre: session.fullName, rolEtiqueta: etiquetaRol(role) }}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <UtensilsCrossed className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: `Restaurantes · ${orgSlug}`, fecha: fechaCortaEsMx(), resumenTo: `/restaurantes/${orgSlug}` }}
      branchSelector={sucursalSelector("restaurantes-sucursal-activa")}
      mobileSelector={branches.length > 1 ? sucursalSelector("restaurantes-sucursal-activa-movil") : null}
      contentKey={propertyId}
    >
      {/* R-33: gate de onboarding (aterrizaje en "Primeros pasos" + banner en el Resumen) solo para owner/admin. */}
      <PuertaOnboarding apiBaseUrl={apiBaseUrl} token={session.token} propertyId={propertyId} orgSlug={orgSlug} role={role}>
        <VarianteEstadoVacioProvider value="centrado">
          {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role, staffFullName: session.fullName, staffEmail: session.email, nombreSucursal: activeBranch.name })}
        </VarianteEstadoVacioProvider>
      </PuertaOnboarding>
    </VerticalShellConectado>
  );
}

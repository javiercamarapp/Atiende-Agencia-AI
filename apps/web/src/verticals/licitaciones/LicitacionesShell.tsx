// Shell del panel de licitaciones — resuelve sesión + propertyId (empresa activa) UNA vez
// y le da a todas las páginas la misma navegación y el mismo `role` del staff (cosmético,
// para ocultar acciones que el servidor rechazaría igual: el enforcement real es SIEMPRE
// server-side, ver WRITE_ROLES/GO_NO_GO_ROLES en domain-licitaciones/src/roles.ts).
//
// PR-9 del plan de diseño-ux (DS v2): igual que restaurantes (PR-5), hoteles (PR-6) y
// despachos (PR-8), la sesión (lectura persistida, SESSION_EXPIRED_EVENT, sucursales, rol,
// logout) vive en `useVerticalSession` y el chrome (Sidebar, MobileHeader + menú de cuenta,
// BottomNav con "Más", cabecera de escritorio, <main> único con skip link) en `VerticalShell`
// de @atiende/ui; este archivo solo aporta lo propio de licitaciones: el adaptador de
// sesión, el mapa de navegación, el chat con datos y el contexto que reciben las páginas.
//
// §2.1 del diseño Fase 1 — licitaciones opera como property SINGLETON por organización (a
// diferencia de hoteles): el adaptador resuelve siempre la primera property y no persiste
// ninguna elección (mismo criterio que antes: `branches[0]`), así que no hay selector.
import type { ReactNode } from "react";
import { BellRing, Building2, CalendarOff, CheckCheck, Database, FileText, Gavel, LayoutDashboard, Lock, MessageCircle, Radar, ScrollText, ShieldAlert, ShieldCheck, Sparkles, Target, Users } from "lucide-react";
import { VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { etiquetaRol } from "../../lib/roles.ts";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { conexionChatDatosLicitaciones } from "./lib/chat-datos-client.ts";
import { clearLicitacionesSession, logout, readPersistedLicitacionesSession } from "./lib/auth-client.ts";
import { fetchBranches } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { STAFF_NAV_ROLES, puedeVerPrivacidad } from "./roles-nav.ts";

/** Adaptador de sesión de licitaciones. DEBE ser una constante de módulo (el hook lo usa como dependencia de sus efectos). */
const LICITACIONES_SESSION: VerticalSessionAdapter<BranchOption> = {
  vertical: "licitaciones",
  readSession: readPersistedLicitacionesSession,
  clearSession: clearLicitacionesSession,
  logout,
  fetchBranches,
  // Property singleton: nada que leer ni persistir; siempre la primera.
  readPropertyId: () => null,
  persistPropertyId: () => {},
  resolveActivePropertyId: (branches) => branches[0]?.propertyId ?? null,
};

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

// puedeVerPrivacidad y STAFF_NAV_ROLES viven en ./roles-nav.ts (sin React) para que App.tsx no importe este shell de forma estática (R-37).
export { puedeVerPrivacidad };


// Mismos destinos y rutas que antes (ningún link se agrega ni se quita; "Panel" ahora se llama "Resumen", como en las demás
// consolas) — UNI-6: categorías en el orden de Likida (Oportunidades, Inteligencia, Organización) con "Resumen" como raíz sin
// título; Staff solo para owner/admin. "Más" de la barra móvil lista TODOS (las mismas secciones del Sidebar), nada queda
// inalcanzable en móvil.
function buildSidebarSections(orgSlug: string, puedeVerStaff: boolean, puedePrivacidad: boolean): SidebarSection[] {
  const base = `/licitaciones/${orgSlug}`;
  return [
    {
      title: "Resumen",
      siempreAbierto: true,
      items: [
        { to: `${base}/panel`, label: "Resumen", icon: LayoutDashboard },
        // CHAT-12: el Copiloto ("Pregunta a tus datos") va justo debajo de Resumen, como en las demás consolas.
        { to: `${base}/copiloto`, label: "Copiloto", icon: Sparkles },
      ],
    },
    {
      title: "Oportunidades",
      items: [
        { to: `${base}/convocatorias`, label: "Convocatorias", icon: Gavel },
        { to: `${base}/seguimiento`, label: "Seguimiento", icon: BellRing },
        { to: `${base}/radar-renovaciones`, label: "Radar de renovaciones", icon: Radar },
      ],
    },
    {
      title: "Inteligencia",
      items: [
        { to: `${base}/fuentes`, label: "Fuentes y frescura", icon: Database },
        { to: `${base}/kyc-69b`, label: "KYC proveedores (69-B)", icon: ShieldAlert },
        { to: `${base}/perfil-matching`, label: "Perfil de matching", icon: Target },
      ],
    },
    {
      title: "Organización",
      items: [
        { to: `${base}/datos-empresa`, label: "Datos de la empresa", icon: Building2 },
        { to: `${base}/dias-inhabiles`, label: "Días inhábiles", icon: CalendarOff },
        { to: `${base}/aprobaciones`, label: "Aprobaciones", icon: CheckCheck },
        ...(puedeVerStaff ? [{ to: `${base}/staff`, label: "Staff", icon: Users }] : []),
        // L-P3-17: quién cambió qué, con antes y después (solo owner/admin, mismo umbral que Staff).
        ...(puedeVerStaff ? [{ to: `${base}/bitacora`, label: "Bitácora", icon: ScrollText }] : []),
        { to: `${base}/whatsapp`, label: "WhatsApp", icon: MessageCircle },
        { to: `${base}/seguridad`, label: "Seguridad", icon: ShieldCheck },
        // L-20: solicitudes ARCO, retención y aviso de privacidad de la organización (solo owner/admin).
        ...(puedePrivacidad ? [{ to: `${base}/privacidad`, label: "Privacidad", icon: Lock }] : []),
      ],
    },
  ];
}

/** Barra inferior móvil: los 4 destinos de uso diario; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las secciones.
 * Las etiquetas son cortas a propósito (cada lugar mide 75 px a 375 px y el e2e `shells-categorias` mide que ninguna se recorte,
 * tampoco con la tipografía de respaldo de Linux): "Concursos" es la barra de "Convocatorias" y "Radar" la de "Radar de
 * renovaciones"; los nombres completos son los de la hoja "Más" y del Sidebar. */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/licitaciones/${orgSlug}`;
  return [
    { to: `${base}/panel`, label: "Resumen", icon: LayoutDashboard },
    { to: `${base}/convocatorias`, label: "Concursos", icon: Gavel },
    { to: `${base}/radar-renovaciones`, label: "Radar", icon: Radar },
    { to: `${base}/datos-empresa`, label: "Empresa", icon: Building2 },
  ];
}

export function LicitacionesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: LicitacionesShellProps) {
  // Título de pestaña por vertical/organización (ver use-document-title.ts). El hook va ANTES de los returns condicionales.
  useDocumentTitle("Licitaciones", orgSlug);
  const s = useVerticalSession({ adapter: LICITACIONES_SESSION, apiBaseUrl, orgSlug, onRequireLogin, defaultRole: "viewer" });

  if (s.fase === "resolviendo") return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (s.fase === "sin-sesion") return null; // onRequireLogin ya disparó la redirección
  if (s.fase === "error") return <VerticalShellEstado estado="error" mensaje={s.error ?? undefined} onReintentar={s.reintentar} />;
  if (s.fase === "cargando") return <VerticalShellEstado estado="cargando" mensaje="Cargando organización…" />;
  if (s.fase === "vacio") return <VerticalShellEstado estado="vacio" mensaje="Esta organización todavía no tiene ninguna property configurada." />;

  const { session, propertyId, role } = s;
  const puedeVerStaff = STAFF_NAV_ROLES.has(role);
  // "Chatea con tus datos": conexión real con el backend de licitaciones (motor compartido, catálogo cerrado de
  // solo lectura). El servidor decide el alcance (organización, rol) a partir del token; aquí solo va el texto.
  const chatConexion = conexionChatDatosLicitaciones(fetch, apiBaseUrl, session.token, propertyId);

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
    <VerticalShellConectado
      apiBaseUrl={apiBaseUrl}
      token={session.token}
      notificacionesHref={`/licitaciones/${orgSlug}/notificaciones`}
      chat={chatConexion}
      copilotoHref={`/licitaciones/${orgSlug}/copiloto`}
      vertical="licitaciones"
      sections={buildSidebarSections(orgSlug, puedeVerStaff, puedeVerPrivacidad(role))}
      mobileItems={buildMobileItems(orgSlug)}
      user={{ email: session.email, rol: role, nombre: session.fullName, rolEtiqueta: etiquetaRol(role) }}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <FileText className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: `Licitaciones · ${orgSlug}`, fecha: fechaCortaEsMx(), resumenTo: `/licitaciones/${orgSlug}/panel` }}
      contentKey={propertyId}
    >
      {children(contexto)}
    </VerticalShellConectado>
  );
}

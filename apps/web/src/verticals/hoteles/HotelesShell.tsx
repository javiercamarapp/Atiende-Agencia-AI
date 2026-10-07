// Shell del panel de staff de hoteles (Fase 7) — resuelve sesión + propertyId UNA vez y le da
// a todas las páginas (Dashboard, Reservas, Housekeeping, Tickets, ..., Agentes, Aprobaciones)
// la misma navegación.
//
// PR-6 del plan de diseño-ux (hoteles al DS v2): mismo recorrido que citas (piloto, PR-4) y
// restaurantes (PR-5). La sesión (lectura persistida, SESSION_EXPIRED_EVENT, lista de hoteles,
// hotel activo persistido por organización, rol, logout) vive en `useVerticalSession` y el chrome
// (Sidebar, MobileHeader + menú de cuenta, BottomNav con "Más", cabecera de escritorio, <main>
// con `key={propertyId}`) en `VerticalShell` de @atiende/ui; este archivo solo aporta lo propio
// de hoteles: el adaptador de sesión, el mapa de navegación por rol, el chat con datos y el
// contexto que reciben las páginas. Sin cambios de rutas, etiquetas, roles ni contratos API.
//
// Hallazgos de auditoría que se conservan: cadena con 2+ hoteles (selector real "Hotel activo",
// `resolveActivePropertyId` tolera una selección obsoleta), logout explícito, título de pestaña
// por vertical y expiración de sesión (el filtro por vertical vive en el hook).
import type { ReactNode } from "react";
import {
  BedDouble,
  Bot,
  CalendarCheck,
  ClipboardCheck,
  ConciergeBell,
  ClipboardList,
  Fingerprint,
  Gauge,
  LayoutDashboard,
  ListChecks,
  LifeBuoy,
  MessageCircle,
  MessagesSquare,
  Receipt,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Star,
  Tags,
  TrendingUp,
  UserRound,
  UserCog,
  UsersRound,
  UtensilsCrossed,
  Wrench,
} from "lucide-react";
import { NativeSelect, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { etiquetaRol } from "../../lib/roles.ts";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { clearHotelesSession, logout, readPersistedHotelesSession } from "./lib/auth-client.ts";
import { crearChatConexionHoteles } from "./lib/data-chat-client.ts";
import { COPILOTO_HOTELES_ROLES } from "./pages/Copiloto.tsx";
import { fetchProperties, resolveActivePropertyId } from "./lib/discovery-client.ts";
import type { PropertyOption } from "./lib/discovery-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { PuertaOnboarding } from "./PuertaOnboarding.tsx";

/** Hotel (property) con el `name` que exige `useVerticalSession`; `nombre` sigue siendo el campo del API. */
type HotelOption = PropertyOption & { readonly name: string };

/** Adaptador de sesión de hoteles. DEBE ser una constante de módulo (el hook lo usa como dependencia de sus efectos). */
const HOTELES_SESSION: VerticalSessionAdapter<HotelOption> = {
  vertical: "hoteles",
  readSession: readPersistedHotelesSession,
  clearSession: clearHotelesSession,
  logout,
  fetchBranches: async (fetchImpl, apiBaseUrl, token, orgSlug) => (await fetchProperties(fetchImpl, apiBaseUrl, token, orgSlug)).map((p) => ({ ...p, name: p.nombre })),
  readPropertyId: readPersistedPropertyId,
  persistPropertyId,
  resolveActivePropertyId,
};

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
  /** Nombre completo y correo del staff en sesión — expuestos a las páginas hijas
   * (header compartido, BarraPagina/NotificationBell) solo para pintar el
   * saludo real (`saludoConNombre`, ver pages/Dashboard.tsx); antes este contexto
   * no exponía nada de identidad del staff más allá de lo que ya necesitaba `role`. */
  readonly staffFullName: string | undefined;
  readonly staffEmail: string;
  /** Nombre de la property activa (UNI-RES-hoteles: subtitulo del Resumen). Opcional: sin el, el Resumen usa el slug de la organizacion. */
  readonly propertyName?: string;
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

// Fase 9 hoteles (REQ-REV-003/004/005/007) — wiring del motor de revenue
// management: mismo `REVENUE_GATE_MANAGE_ROLES` (owner/gm) que
// domain-hoteles/src/roles.ts (duplicado aquí a propósito, ver el comentario de
// `role` arriba) — solo oculta el link "Revenue" del nav para quien el servidor
// rechazaría de todas formas transicionar el gate (403 en revenue.ts); ver
// accountant en REVENUE_BACKTEST_ROLES puede registrar un backtest, así que
// también ve el link (la página gatea cada acción por separado).
const REVENUE_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);

// Fase 11/13 hoteles (REQ-CRM-002/003) — wiring de reputación/CRM: mismo
// `REPUTACION_VIEW_ROLES` exacto que domain-hoteles/src/roles.ts (duplicado aquí a
// propósito, ver el comentario de `role` arriba) — solo oculta el link
// "Reputación" del nav para quien el servidor rechazaría de todas formas (403 en
// reputacion.ts); housekeeping/maintenance/fnb nunca lo ven.
const REPUTACION_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);

// H-01 — bóveda de identidad: mismo `IDENTITY_CAPTURE_ROLES` exacto que
// domain-hoteles/src/roles.ts (duplicado aquí a propósito, ver el comentario de `role`
// arriba) — solo oculta el link "Identidad" del nav para quien el servidor rechazaría de
// todas formas (403 en identidad.ts); housekeeping/maintenance/fnb/accountant nunca lo ven.
const IDENTIDAD_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);
// H-03 -- catalogo de agentes y cola de aprobaciones humanas: mismo conjunto que AGENT_VIEW_ROLES (cosmetico; la RLS manda).
const AGENTES_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);
/** H-06: mismos roles que ven grupos en la base (`hoteles.can_view_groups`); cosmético, el servidor es la barrera real. */
const GRUPOS_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations", "accountant"]);

// H-28 (recepción) y H-27 (ficha de huésped): mismos `RECEPCION_VIEW_ROLES` / `GUEST_CRM_ROLES` que domain-hoteles/src/roles.ts
// (duplicado aquí a propósito, ver el comentario de `role` arriba) — solo oculta los links para quien el servidor rechazaría (403).
const RECEPCION_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);
// H-20 -- bandeja de conversaciones de WhatsApp: mismo CONVERSACIONES_ROLES (owner/gm/frontdesk/reservations) que domain-hoteles/src/conversaciones/tipos.ts;
// cosmetico, el servidor manda (403).
const CONVERSACIONES_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "reservations"]);

// H-04 — housekeeping completo: mismo `HOUSEKEEPING_BOARD_VIEW_ROLES` exacto que
// domain-hoteles/src/roles.ts (duplicado aquí a propósito, ver el comentario de `role`
// arriba) — solo oculta el link "Housekeeping" del nav para quien el servidor rechazaría de
// todas formas (403 en housekeeping.ts); frontdesk/maintenance/etc. lo ven según este set.
// H-29 -- Mensajeria (canal WhatsApp + voz): mismo MENSAJERIA_CONFIG_ROLES (owner/gm) que domain-hoteles/src/roles.ts; cosmetico, el servidor manda (403).
const MENSAJERIA_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
// H-P3-04/05/06 -- Configuracion (owner/gm escriben, accountant lee), Equipo y Primeros pasos (owner/gm). Cosmetico: el servidor manda (403).
const CONFIGURACION_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "accountant"]);
const EQUIPO_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
const PRIMEROS_PASOS_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm"]);
const HOUSEKEEPING_NAV_ROLES: ReadonlySet<string> = new Set(["owner", "gm", "frontdesk", "housekeeping", "maintenance"]);

export function HotelesShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: HotelesShellProps) {
  // Título de pestaña por vertical/organización. El hook va ANTES de los returns condicionales.
  useDocumentTitle("Hoteles", orgSlug);
  // Fail-closed: si la organización activa no aparece en la sesión (no debería pasar, ver decideHotelesLandingPath),
  // cae al rol operativo MÁS bajo de HOTEL_ROLES (nunca uno que active gates administrativos/de F&B de más).
  const s = useVerticalSession({ adapter: HOTELES_SESSION, apiBaseUrl, orgSlug, onRequireLogin, defaultRole: "housekeeping" });

  if (s.fase === "resolviendo") return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (s.fase === "sin-sesion") return null; // onRequireLogin ya disparó la redirección
  if (s.fase === "error") return <VerticalShellEstado estado="error" mensaje={s.error ?? undefined} onReintentar={s.reintentar} />;
  if (s.fase === "cargando") return <VerticalShellEstado estado="cargando" mensaje="Cargando propiedades…" />;
  if (s.fase === "vacio") return <VerticalShellEstado estado="vacio" mensaje="Esta organización todavía no tiene ningún hotel (property) configurado." />;

  const { session, branches, activeBranch, propertyId, role } = s;

  // "Chatea con tus datos": conexion real con el backend de hoteles (catalogo cerrado, solo owner/gm en el servidor).
  // El servidor decide el alcance a partir del token; aqui solo van el hotel activo y el texto.
  const chatConexion = crearChatConexionHoteles(apiBaseUrl, session.token, propertyId);

  const base = `/hoteles/${orgSlug}`;

  // UNI-6: categorías en el orden de Likida (Operación, Huéspedes, Finanzas, Agentes, Configuración) con "Resumen" como raíz
  // sin título. Mismas rutas, etiquetas y gates de rol que antes (ver *_NAV_ROLES arriba): solo se reagrupan. Una categoría
  // cuyo rol activo no ve ningún destino se omite por completo (un acordeón vacío confunde).
  const sections: SidebarSection[] = [
    {
      title: "Resumen",
      siempreAbierto: true,
      // CHAT-09: el Copiloto ("Pregunta a tus datos") va justo debajo de Resumen, solo para owner/gm (los unicos que el servidor deja usarlo).
      items: [
        { to: base, label: "Resumen", icon: LayoutDashboard, end: true },
        ...(COPILOTO_HOTELES_ROLES.has(role) ? [{ to: `${base}/copiloto`, label: "Copiloto", icon: Sparkles }] : []),
      ],
    },
    {
      title: "Operación",
      items: [
        ...(RECEPCION_NAV_ROLES.has(role) ? [{ to: `${base}/recepcion`, label: "Recepción", icon: ConciergeBell }] : []),
        { to: `${base}/reservas`, label: "Reservas", icon: CalendarCheck },
        ...(CONVERSACIONES_NAV_ROLES.has(role) ? [{ to: `${base}/conversaciones`, label: "Conversaciones", icon: MessagesSquare }] : []),
        ...(HOUSEKEEPING_NAV_ROLES.has(role) ? [{ to: `${base}/housekeeping`, label: "Housekeeping", icon: BedDouble }] : []),
        { to: `${base}/mantenimiento`, label: "Mantenimiento", icon: Wrench },
        { to: `${base}/tickets`, label: "Tickets", icon: LifeBuoy },
        { to: `${base}/asistencia`, label: "Asistencia", icon: ClipboardCheck },
      ],
    },
    {
      title: "Huéspedes",
      items: [
        ...(RECEPCION_NAV_ROLES.has(role) ? [{ to: `${base}/huespedes`, label: "Huéspedes", icon: UserRound }] : []),
        ...(PEDIDOS_FNB_NAV_ROLES.has(role) ? [{ to: `${base}/pedidos-fnb`, label: "Pedidos F&B", icon: UtensilsCrossed }] : []),
        ...(REPUTACION_NAV_ROLES.has(role) ? [{ to: `${base}/reputacion`, label: "Reputación", icon: Star }] : []),
        ...(IDENTIDAD_NAV_ROLES.has(role) ? [{ to: `${base}/identidad`, label: "Identidad", icon: Fingerprint }] : []),
        ...(GRUPOS_NAV_ROLES.has(role) ? [{ to: `${base}/grupos`, label: "Grupos", icon: UsersRound }] : []),
      ],
    },
    {
      title: "Finanzas",
      items: [
        ...(PL_NAV_ROLES.has(role) ? [{ to: `${base}/pl`, label: "P&L", icon: TrendingUp }] : []),
        ...(REVENUE_NAV_ROLES.has(role) ? [{ to: `${base}/revenue`, label: "Revenue", icon: Gauge }] : []),
        { to: `${base}/cfdi`, label: "CFDI", icon: Receipt },
        { to: `${base}/fraude`, label: "Fraude", icon: ShieldAlert },
      ],
    },
    {
      title: "Agentes",
      items: [
        ...(AGENTES_NAV_ROLES.has(role) ? [{ to: `${base}/agentes`, label: "Agentes", icon: Bot }] : []),
        ...(AGENTES_NAV_ROLES.has(role) ? [{ to: `${base}/aprobaciones`, label: "Aprobaciones", icon: ClipboardList }] : []),
      ],
    },
    {
      title: "Configuración",
      items: [
        ...(CATALOGO_NAV_ROLES.has(role) ? [{ to: `${base}/catalogo`, label: "Catálogo", icon: Tags }] : []),
        ...(MENSAJERIA_NAV_ROLES.has(role) ? [{ to: `${base}/mensajeria`, label: "Mensajería", icon: MessageCircle }] : []),
        ...(CONFIGURACION_NAV_ROLES.has(role) ? [{ to: `${base}/configuracion`, label: "Configuración del hotel", icon: SlidersHorizontal }] : []),
        ...(EQUIPO_NAV_ROLES.has(role) ? [{ to: `${base}/equipo`, label: "Equipo", icon: UserCog }] : []),
        ...(PRIMEROS_PASOS_NAV_ROLES.has(role) ? [{ to: `${base}/primeros-pasos`, label: "Primeros pasos", icon: ListChecks }] : []),
      ],
    },
  ].filter((sec) => sec.items.length > 0);

  // Hoteles tiene hasta 16 destinos: la barra trae 4 de uso diario (visibles para todos los roles, con etiqueta completa) y
  // "Más" (lo agrega `VerticalShell`) abre TODAS las secciones del mismo árbol que el Sidebar de escritorio, ya filtradas por rol.
  const mobileItems: BottomNavItem[] = [
    { to: base, label: "Resumen", icon: LayoutDashboard, end: true },
    { to: `${base}/reservas`, label: "Reservas", icon: CalendarCheck },
    { to: `${base}/tickets`, label: "Tickets", icon: LifeBuoy },
    { to: `${base}/asistencia`, label: "Asistencia", icon: ClipboardCheck },
  ];

  // Selector real, visible solo con más de un hotel (si no, solo el nombre). Va en el bloque de cuenta del Sidebar
  // (escritorio) y en el MobileHeader, para no perder la función en viewport angosto.
  const hotelSelector =
    branches.length > 1 ? (
      <div>
        <label htmlFor="hoteles-hotel-activo" className="block mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Hotel activo
        </label>
        <NativeSelect id="hoteles-hotel-activo" size="sm" value={propertyId} onChange={(e) => s.selectBranch(e.target.value)}>
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
      notificacionesHref={`/hoteles/${orgSlug}/notificaciones`}
      chat={chatConexion}
      copilotoHref={`${base}/copiloto`}
      ocultarChat={!COPILOTO_HOTELES_ROLES.has(role)}
      vertical="hoteles"
      sections={sections}
      mobileItems={mobileItems}
      user={{ email: session.email, rol: role, nombre: session.fullName, rolEtiqueta: etiquetaRol(role) }}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <BedDouble className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: `Hoteles · ${orgSlug}`, fecha: fechaCortaEsMx(), resumenTo: `/hoteles/${orgSlug}` }}
      branchSelector={hotelSelector}
      mobileSelector={branches.length > 1 ? hotelSelector : null}
      contentKey={propertyId}
    >
      <PuertaOnboarding apiBaseUrl={apiBaseUrl} token={session.token} propertyId={propertyId} orgSlug={orgSlug} role={role}>
        {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role, staffFullName: session.fullName, staffEmail: session.email, propertyName: activeBranch.nombre })}
      </PuertaOnboarding>
    </VerticalShellConectado>
  );
}

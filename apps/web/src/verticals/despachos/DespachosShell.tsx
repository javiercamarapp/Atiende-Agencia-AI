// Shell del panel de staff de despachos — resuelve sesión + propertyId (contribuyente
// activo) UNA vez y le da a todas las páginas la misma navegación y el mismo `role`
// del staff (cosmético, para ocultar acciones que el servidor rechazaría igual: el
// enforcement real es SIEMPRE server-side, ver VER_CIERRE_MENSUAL_ROLES/
// GESTIONAR_CIERRE_MENSUAL_ROLES/CERRAR_PERIODO_ROLES en roles.ts).
//
// PR-8 del plan de diseño-ux (DS v2): igual que restaurantes (PR-5), la sesión
// (lectura persistida, SESSION_EXPIRED_EVENT, contribuyentes, contribuyente activo
// persistido por organización, rol, logout) vive en `useVerticalSession` y el chrome
// (Sidebar, MobileHeader + menú de cuenta, BottomNav con "Más", cabecera de escritorio,
// <main> con skip link) en `VerticalShell` de @atiende/ui; este archivo solo aporta lo
// propio de despachos: el adaptador de sesión, el mapa de navegación, el chat con datos
// y el contexto que reciben las páginas.
//
// Un despacho da servicio a N contribuyentes (cada branch = un contribuyente, ver
// admin-client.ts). `contentKey={propertyId}` remonta las páginas hijas cuando cambia el
// contribuyente activo (mismo `key` que antes tenía el <main>): las páginas
// "calculadora" (Conciliacion/DevolucionIva/Bookkeeping/Declaraciones/Nomina/
// ContabilidadElectronica) guardan el resultado calculado en estado local y sin el
// remonte mostrarían el del contribuyente anterior.
import type { ReactNode } from "react";
import {
  BookOpen,
  Briefcase,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  FileBarChart,
  FileDigit,
  FileSpreadsheet,
  FileText,
  FolderInput,
  HandCoins,
  Landmark,
  Link2,
  LayoutDashboard,
  Settings,
  Undo2,
  UsersRound,
  Wallet,
} from "lucide-react";
import { NativeSelect, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { conexionChatDatosDespachos } from "./lib/chat-datos-client.ts";
import { clearDespachosSession, logout, readPersistedDespachosSession } from "./lib/auth-client.ts";
import { fetchBranches, resolveActivePropertyId } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";

/** Adaptador de sesión de despachos. DEBE ser una constante de módulo (el hook lo usa como dependencia de sus efectos). */
const DESPACHOS_SESSION: VerticalSessionAdapter<BranchOption> = {
  vertical: "despachos",
  readSession: readPersistedDespachosSession,
  clearSession: clearDespachosSession,
  logout,
  fetchBranches,
  readPropertyId: readPersistedPropertyId,
  persistPropertyId,
  resolveActivePropertyId,
};

export interface DespachosShellContext {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Rol de la vertical del staff en ESTA organización (admin/contador/auditor/
   * readonly, ver domain-despachos/src/roles.ts) — cosmético, para ocultar botones
   * que el servidor rechazaría igual; nunca la única barrera. */
  readonly role: string;
  /** Nombre completo y correo del staff en sesión — expuestos a las páginas hijas
   * (header compartido) solo para pintar el saludo real (`saludoConNombre`, ver
   * CierreMensual.tsx), mismo patrón ya expuesto en CitasShellContext/RentasShellContext. */
  readonly staffFullName: string | undefined;
  readonly staffEmail: string;
}

export interface DespachosShellProps {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: DespachosShellContext) => ReactNode;
}

// Mismos 12 destinos/etiquetas/rutas exactos que antes (ningún link se agrega,
// quita ni renombra) — solo se agrupan por dominio contable para el `Sidebar` real
// y cada uno gana un ícono de lucide-react. El primer grupo ("Panel") se deja
// `siempreAbierto` (sin acordeón) porque el cierre mensual es la vista de entrada
// natural de un despacho; el resto sigue el mismo acordeón "uno abierto a la vez"
// que ya trae `Sidebar`.
const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "dashboard", label: "Dashboard" },
  { to: "cierre-mensual", label: "Cierre mensual" },
  { to: "cfdi", label: "CFDI" },
  { to: "cobranza", label: "Cobranza" },
  { to: "cola-cobranza", label: "Cola de cobranza" },
  { to: "vencimientos", label: "Vencimientos" },
  { to: "declaraciones", label: "Declaraciones" },
  { to: "nomina", label: "Nómina" },
  { to: "conciliacion", label: "Conciliación bancaria" },
  { to: "migracion-catalogo", label: "Migración de catálogo" },
  { to: "devolucion-iva", label: "Devolución de IVA" },
  { to: "bookkeeping", label: "Bookkeeping" },
  { to: "reportes", label: "Reportes de cliente" },
  { to: "contabilidad-electronica", label: "Contabilidad electrónica" },
  { to: "portal-cliente", label: "Portal del cliente" },
  { to: "staff", label: "Staff" },
  { to: "configuracion", label: "Configuración" },
];

function buildSidebarSections(orgSlug: string): SidebarSection[] {
  const to = (path: string) => `/despachos/${orgSlug}/${path}`;
  const item = (path: string) => {
    const found = NAV_ITEMS.find((i) => i.to === path)!;
    return { to: to(found.to), label: found.label };
  };
  return [
    {
      title: "Panel",
      siempreAbierto: true,
      items: [
        { ...item("dashboard"), icon: LayoutDashboard },
        { ...item("cierre-mensual"), icon: CalendarCheck },
      ],
    },
    {
      title: "Facturación",
      items: [
        { ...item("cfdi"), icon: FileText },
        { ...item("cobranza"), icon: HandCoins },
        { ...item("cola-cobranza"), icon: ClipboardList },
        { ...item("vencimientos"), icon: CalendarClock },
      ],
    },
    {
      title: "Fiscal y contable",
      items: [
        { ...item("declaraciones"), icon: FileSpreadsheet },
        { ...item("nomina"), icon: Wallet },
        { ...item("conciliacion"), icon: Landmark },
        { ...item("contabilidad-electronica"), icon: FileDigit },
        { ...item("devolucion-iva"), icon: Undo2 },
        { ...item("bookkeeping"), icon: BookOpen },
        { ...item("reportes"), icon: FileBarChart },
        { ...item("migracion-catalogo"), icon: FolderInput },
      ],
    },
    {
      title: "Equipo",
      items: [
        { ...item("portal-cliente"), icon: Link2 },
        { ...item("staff"), icon: UsersRound },
        { ...item("configuracion"), icon: Settings },
      ],
    },
  ];
}

/** Barra inferior móvil: los 4 destinos de uso diario; el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista TODAS las
 * secciones fiscales/contables (los 16 destinos de `buildSidebarSections`, sin curarlos a ojo). */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/despachos/${orgSlug}`;
  return [
    { to: `${base}/cierre-mensual`, label: "Cierre", icon: CalendarCheck },
    { to: `${base}/cfdi`, label: "CFDI", icon: FileText },
    { to: `${base}/cobranza`, label: "Cobranza", icon: HandCoins },
    { to: `${base}/vencimientos`, label: "Vencim.", icon: CalendarClock },
  ];
}

export function DespachosShell({ apiBaseUrl, orgSlug, onRequireLogin, children }: DespachosShellProps) {
  // Título de pestaña por vertical/organización (ver use-document-title.ts). El hook va ANTES de los returns condicionales.
  useDocumentTitle("Despachos", orgSlug);
  const s = useVerticalSession({ adapter: DESPACHOS_SESSION, apiBaseUrl, orgSlug, onRequireLogin, defaultRole: "readonly" });

  if (s.fase === "resolviendo") return <VerticalShellEstado estado="cargando" mensaje="Cargando…" />;
  if (s.fase === "sin-sesion") return null; // onRequireLogin ya disparó la redirección
  if (s.fase === "error") return <VerticalShellEstado estado="error" mensaje={s.error ?? undefined} onReintentar={s.reintentar} />;
  if (s.fase === "cargando") return <VerticalShellEstado estado="cargando" mensaje="Cargando contribuyentes…" />;
  if (s.fase === "vacio") return <VerticalShellEstado estado="vacio" mensaje="Este despacho todavía no tiene ningún contribuyente configurado." />;

  const { session, branches, activeBranch, propertyId, role } = s;

  // "Chatea con tus datos": conexión real con el backend de despachos (motor compartido, catálogo cerrado de
  // solo lectura). El servidor decide el alcance (organización, clientes, rol) a partir del token; aquí solo
  // van el cliente activo y el texto.
  const chatConexion = conexionChatDatosDespachos(fetch, apiBaseUrl, session.token, propertyId);

  // Selector real de CONTRIBUYENTE, visible solo cuando hay más de uno (con uno solo se muestra su nombre). Se ofrece
  // en el bloque de cuenta del Sidebar (escritorio) y en el MobileHeader, para no perder la función en viewport angosto.
  const contribuyenteSelector =
    branches.length > 1 ? (
      <div>
        <label htmlFor="despachos-contribuyente-activo" className="block mb-1 font-mono text-2xs uppercase tracking-[0.06em] text-muted-foreground">
          Contribuyente
        </label>
        <NativeSelect id="despachos-contribuyente-activo" size="sm" value={propertyId} onChange={(e) => s.selectBranch(e.target.value)}>
          {branches.map((b) => (
            <option key={b.propertyId} value={b.propertyId}>
              {b.name}
            </option>
          ))}
        </NativeSelect>
      </div>
    ) : (
      <p className="text-xs text-muted-foreground truncate">{activeBranch.name}</p>
    );

  return (
    <VerticalShellConectado
      apiBaseUrl={apiBaseUrl}
      token={session.token}
      chat={chatConexion}
      vertical="despachos"
      sections={buildSidebarSections(orgSlug)}
      mobileItems={buildMobileItems(orgSlug)}
      user={{ email: session.email, rol: role }}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <Briefcase className="w-4 h-4 text-muted-foreground" strokeWidth={1.75} />, title: `Despachos · ${activeBranch.name}`, fecha: fechaCortaEsMx() }}
      branchSelector={contribuyenteSelector}
      mobileSelector={contribuyenteSelector}
      contentKey={propertyId}
    >
      {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role, staffFullName: session.fullName, staffEmail: session.email })}
    </VerticalShellConectado>
  );
}

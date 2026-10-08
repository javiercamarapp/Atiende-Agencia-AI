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
  BookMarked,
  BookOpen,
  Calculator,
  Briefcase,
  CalendarCheck,
  CalendarClock,
  ClipboardList,
  FileBarChart,
  FileDigit,
  FileSpreadsheet,
  FileText,
  Contact,
  FolderInput,
  HandCoins,
  Landmark,
  Link2,
  LayoutDashboard,
  Settings,
  Sparkles,
  Undo2,
  UsersRound,
  Wallet,
} from "lucide-react";
import { SelectorSucursal, VerticalShellEstado } from "@atiende/ui";
import type { BottomNavItem, SidebarSection } from "@atiende/ui";
import { VerticalShellConectado } from "../../components/VerticalShellConectado.tsx";
import { fechaCortaEsMx } from "../../lib/formato-fecha.ts";
import { etiquetaRol } from "../../lib/roles.ts";
import { useVerticalSession } from "../../lib/useVerticalSession.ts";
import type { VerticalSessionAdapter } from "../../lib/useVerticalSession.ts";
import { useDocumentTitle } from "../../shell/use-document-title.ts";
import { conexionChatDatosDespachos } from "./lib/chat-datos-client.ts";
import { clearDespachosSession, logout, readPersistedDespachosSession } from "./lib/auth-client.ts";
import { fetchBranches, resolveActivePropertyId } from "./lib/admin-client.ts";
import type { BranchOption } from "./lib/admin-client.ts";
import { persistPropertyId, readPersistedPropertyId } from "./lib/property-selection.ts";
import { StepUpDialog } from "./components/StepUpDialog.tsx";
import { AltaPrimerCliente } from "./pages/Cartera.tsx";
import { COPILOTO_DESPACHOS_ROLES } from "./pages/Copiloto.tsx";

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

// Mismos destinos y rutas que antes (ningún link se agrega ni se quita; "Dashboard" ahora se llama "Resumen", como en las
// demás consolas) — solo se agrupan por dominio contable para el `Sidebar` real y cada uno gana un ícono de lucide-react.
// UNI-6: categorías en el orden de Likida (Facturación, Fiscal, Contabilidad, Clientes y equipo) con "Resumen" y "Cierre
// mensual" como raíz sin título (el cierre mensual es la vista de entrada natural de un despacho); el resto sigue el mismo
// acordeón "uno abierto a la vez" que trae `Sidebar`.
const NAV_ITEMS: ReadonlyArray<{ to: string; label: string }> = [
  { to: "dashboard", label: "Resumen" },
  { to: "cierre-mensual", label: "Cierre mensual" },
  { to: "cartera", label: "Cartera de clientes" },
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
  { to: "libro-contable", label: "Libro contable" },
  { to: "pagos-provisionales", label: "Pagos provisionales" },
  { to: "contabilidad-electronica", label: "Contabilidad electrónica" },
  { to: "portal-cliente", label: "Portal del cliente" },
  { to: "staff", label: "Staff" },
  { to: "configuracion", label: "Configuración" },
];

function buildSidebarSections(orgSlug: string, conCopiloto: boolean): SidebarSection[] {
  const to = (path: string) => `/despachos/${orgSlug}/${path}`;
  const item = (path: string) => {
    const found = NAV_ITEMS.find((i) => i.to === path)!;
    return { to: to(found.to), label: found.label };
  };
  return [
    {
      title: "Resumen",
      siempreAbierto: true,
      items: [
        { ...item("dashboard"), icon: LayoutDashboard },
        // CHAT-11: el Copiloto ("Pregunta a tus datos") va justo debajo de Resumen, solo para los roles que el servidor deja usar chat-datos.
        ...(conCopiloto ? [{ to: to("copiloto"), label: "Copiloto", icon: Sparkles }] : []),
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
      title: "Fiscal",
      items: [
        { ...item("declaraciones"), icon: FileSpreadsheet },
        { ...item("pagos-provisionales"), icon: Calculator },
        { ...item("contabilidad-electronica"), icon: FileDigit },
        { ...item("devolucion-iva"), icon: Undo2 },
        { ...item("nomina"), icon: Wallet },
      ],
    },
    {
      title: "Contabilidad",
      items: [
        { ...item("conciliacion"), icon: Landmark },
        { ...item("libro-contable"), icon: BookMarked },
        { ...item("bookkeeping"), icon: BookOpen },
        { ...item("reportes"), icon: FileBarChart },
        { ...item("migracion-catalogo"), icon: FolderInput },
      ],
    },
    {
      title: "Clientes y equipo",
      items: [
        { ...item("cartera"), icon: Contact },
        { ...item("portal-cliente"), icon: Link2 },
        { ...item("staff"), icon: UsersRound },
        { ...item("configuracion"), icon: Settings },
      ],
    },
  ];
}

/** Barra inferior móvil: los 4 destinos de uso diario (etiquetas completas); el 5.º lugar es "Más" (lo agrega `VerticalShell`) y lista
 * TODAS las secciones fiscales/contables (los 20 destinos de `buildSidebarSections`, sin curarlos a ojo). */
function buildMobileItems(orgSlug: string): BottomNavItem[] {
  const base = `/despachos/${orgSlug}`;
  return [
    { to: `${base}/dashboard`, label: "Resumen", icon: LayoutDashboard },
    { to: `${base}/cierre-mensual`, label: "Cierre", icon: CalendarCheck },
    { to: `${base}/cfdi`, label: "CFDI", icon: FileText },
    { to: `${base}/cobranza`, label: "Cobranza", icon: HandCoins },
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
  if (s.fase === "vacio") {
    // Un despacho sin ningun cliente no tiene contribuyente activo: quien puede dar de alta (admin/contador) captura el primero aqui.
    const rolVacio = s.session?.organizations.find((o) => o.slug === orgSlug)?.rol;
    if (s.session && (rolVacio === "admin" || rolVacio === "contador")) {
      return <AltaPrimerCliente apiBaseUrl={apiBaseUrl} token={s.session.token} orgSlug={orgSlug} onCreado={s.reintentar} />;
    }
    return <VerticalShellEstado estado="vacio" mensaje="Este despacho todavía no tiene ningún contribuyente configurado. Pide a un administrador que lo dé de alta." />;
  }

  const { session, branches, activeBranch, propertyId, role } = s;

  // "Chatea con tus datos": conexión real con el backend de despachos (motor compartido, catálogo cerrado de
  // solo lectura). El servidor decide el alcance (organización, clientes, rol) a partir del token; aquí solo
  // van el cliente activo y el texto.
  const conCopiloto = COPILOTO_DESPACHOS_ROLES.has(role);
  const chatConexion = conexionChatDatosDespachos(fetch, apiBaseUrl, session.token, propertyId);

  // Selector real de CONTRIBUYENTE, visible solo cuando hay más de uno (con uno solo se muestra su nombre). Se ofrece
  // en el bloque de cuenta del Sidebar (escritorio) y en el MobileHeader, para no perder la función en viewport angosto.
  const contribuyenteSelector =
    <SelectorSucursal id="despachos-contribuyente-activo" etiqueta="Contribuyente" valor={propertyId} onCambia={s.selectBranch} opciones={branches.map((b) => ({ valor: b.propertyId, etiqueta: b.name }))} />;

  return (
    <VerticalShellConectado
      apiBaseUrl={apiBaseUrl}
      token={session.token}
      notificacionesHref={`/despachos/${orgSlug}/notificaciones`}
      chat={chatConexion}
      copilotoHref={`/despachos/${orgSlug}/copiloto`}
      ocultarChat={!conCopiloto}
      vertical="despachos"
      sections={buildSidebarSections(orgSlug, conCopiloto)}
      mobileItems={buildMobileItems(orgSlug)}
      user={{ email: session.email, rol: role, nombre: session.fullName, rolEtiqueta: etiquetaRol(role) }}
      onLogout={() => void s.logout()}
      loggingOut={s.loggingOut}
      header={{ icon: <Briefcase className="size-[15px] text-muted-foreground" strokeWidth={1.75} />, title: `Despachos · ${activeBranch.name}`, fecha: fechaCortaEsMx(), resumenTo: `/despachos/${orgSlug}/dashboard` }}
      branchSelector={contribuyenteSelector}
      mobileSelector={contribuyenteSelector}
      contentKey={propertyId}
    >
      {children({ apiBaseUrl, token: session.token, propertyId, orgSlug, role, staffFullName: session.fullName, staffEmail: session.email })}
      {/* D-30: dialogo de segundo factor de las acciones sensibles (lib/step-up.ts); se monta una sola vez por shell. */}
      <StepUpDialog orgSlug={orgSlug} />
    </VerticalShellConectado>
  );
}

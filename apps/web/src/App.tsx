// Shell mínimo de apps/web para esta fase — solo lo necesario para que la pantalla
// de login del vertical restaurantes sea real y navegable, sin portar el resto del
// dashboard visual (fuera de alcance explícito de Fase 1, ver el brief).
import { useNavigate, useParams } from "react-router-dom";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";
import { RestaurantesLoginPage } from "./verticals/restaurantes/pages/Login.tsx";
import { RestaurantesDashboardPage } from "./verticals/restaurantes/pages/Dashboard.tsx";
import { RestaurantesShell } from "./verticals/restaurantes/RestaurantesShell.tsx";
import { ProductosPage } from "./verticals/restaurantes/pages/Productos.tsx";
import { SucursalesPage } from "./verticals/restaurantes/pages/Sucursales.tsx";
import { PedidosPage } from "./verticals/restaurantes/pages/Pedidos.tsx";
import { HistorialPage } from "./verticals/restaurantes/pages/Historial.tsx";
import { ClienteFichaPage as RestaurantesClienteFichaPage, ClientesListPage as RestaurantesClientesListPage } from "./verticals/restaurantes/pages/Clientes.tsx";
import { RepartidorPedidosPage } from "./verticals/restaurantes/pages/Repartidor.tsx";
import { StaffPage } from "./verticals/restaurantes/pages/Staff.tsx";
import { PromocionesPage } from "./verticals/restaurantes/pages/Promociones.tsx";
import { AceptarInvitacionPage } from "./shell/AceptarInvitacion.tsx";
import { SeleccionarVerticalPage } from "./shell/SeleccionarVertical.tsx";
import { GoogleCallbackPage } from "./shell/GoogleCallback.tsx";
import { TerminosPage } from "./pages/Terminos.tsx";
import { PrivacidadPage } from "./pages/Privacidad.tsx";
import { SuperAdminShell } from "./superadmin/SuperAdminShell.tsx";
import { SuperAdminDashboardPage } from "./superadmin/pages/Dashboard.tsx";
import { SuperAdminProspectosPage } from "./superadmin/pages/Prospectos.tsx";
import { SuperAdminPanelesPage } from "./superadmin/pages/Paneles.tsx";
import { SuperAdminGastoApiPage } from "./superadmin/pages/GastoApi.tsx";
import { Toaster } from "@atiende/ui";
import { HotelesLoginPage } from "./verticals/hoteles/pages/Login.tsx";
import { HotelesShell } from "./verticals/hoteles/HotelesShell.tsx";
import { DashboardPage as HotelesDashboardPage } from "./verticals/hoteles/pages/Dashboard.tsx";
import { ReservasPage } from "./verticals/hoteles/pages/Reservas.tsx";
import { FolioPage } from "./verticals/hoteles/pages/Folio.tsx";
import { MantenimientoPage } from "./verticals/hoteles/pages/Mantenimiento.tsx";
import { AsistenciaPage } from "./verticals/hoteles/pages/Asistencia.tsx";
import { FraudePage } from "./verticals/hoteles/pages/Fraude.tsx";
import { CfdiPage as HotelesCfdiPage } from "./verticals/hoteles/pages/Cfdi.tsx";
import { CfdiListadoPage as HotelesCfdiListadoPage } from "./verticals/hoteles/pages/CfdiListado.tsx";
import { PlPage as HotelesPlPage } from "./verticals/hoteles/pages/Pl.tsx";
import { RevenuePage as HotelesRevenuePage } from "./verticals/hoteles/pages/Revenue.tsx";
import { CatalogoPage as HotelesCatalogoPage } from "./verticals/hoteles/pages/Catalogo.tsx";
import { PedidosFnbPage } from "./verticals/hoteles/pages/PedidosFnb.tsx";
import { RentasLoginPage } from "./verticals/rentas/pages/Login.tsx";
import { RentasRegistroPage } from "./verticals/rentas/pages/Registro.tsx";
import { RentasShell } from "./verticals/rentas/RentasShell.tsx";
import { RentasDashboardPage } from "./verticals/rentas/pages/Dashboard.tsx";
import { CalendarioPage as RentasCalendarioPage } from "./verticals/rentas/pages/Calendario.tsx";
import { PreciosPage as RentasPreciosPage } from "./verticals/rentas/pages/Precios.tsx";
import { AprobacionesPage as RentasAprobacionesPage } from "./verticals/rentas/pages/Aprobaciones.tsx";
import { FinanzasPage as RentasFinanzasPage } from "./verticals/rentas/pages/Finanzas.tsx";
import { MisTareasPage as RentasMisTareasPage } from "./verticals/rentas/pages/MisTareas.tsx";
import { IcalSyncPage as RentasIcalSyncPage } from "./verticals/rentas/pages/IcalSync.tsx";
import { OwnerPortalLoginPage } from "./verticals/rentas/pages/OwnerPortalLogin.tsx";
import { OwnerPortalActivarPage } from "./verticals/rentas/pages/OwnerPortalActivar.tsx";
import { OwnerPortalDashboardPage } from "./verticals/rentas/pages/OwnerPortalDashboard.tsx";
import { SinOrganizacionPage } from "./shell/SinOrganizacion.tsx";
import { SeleccionarOrganizacionPage } from "./shell/SeleccionarOrganizacion.tsx";
import { CitasLoginPage } from "./verticals/citas/pages/Login.tsx";
import { CitasShell } from "./verticals/citas/CitasShell.tsx";
import { AgendaPage } from "./verticals/citas/pages/Agenda.tsx";
import { ProveedorFichaPage, ProveedoresListPage } from "./verticals/citas/pages/Proveedores.tsx";
import { ServicioFichaPage, ServiciosListPage } from "./verticals/citas/pages/Servicios.tsx";
import { ClienteFichaPage, ClientesListPage } from "./verticals/citas/pages/Clientes.tsx";
import { DisponibilidadPage } from "./verticals/citas/pages/Disponibilidad.tsx";
import { ConfiguracionPage } from "./verticals/citas/pages/Configuracion.tsx";
import { StaffPage as CitasStaffPage } from "./verticals/citas/pages/Staff.tsx";
import { LicitacionesLoginPage } from "./verticals/licitaciones/pages/Login.tsx";
import { LicitacionesShell } from "./verticals/licitaciones/LicitacionesShell.tsx";
import { ConvocatoriasPage } from "./verticals/licitaciones/pages/Convocatorias.tsx";
import { ConvocatoriaDetallePage } from "./verticals/licitaciones/pages/ConvocatoriaDetalle.tsx";
import { RequisitosConvocatoriaPage } from "./verticals/licitaciones/pages/RequisitosConvocatoria.tsx";
import { PropuestaTecnicaPage } from "./verticals/licitaciones/pages/PropuestaTecnica.tsx";
import { CierrePage } from "./verticals/licitaciones/pages/Cierre.tsx";
import { ContratoPage } from "./verticals/licitaciones/pages/Contrato.tsx";
import { PostAdjudicacionPage } from "./verticals/licitaciones/pages/PostAdjudicacion.tsx";
import { AutopsiaPage } from "./verticals/licitaciones/pages/Autopsia.tsx";
import { RadarRenovacionesPage } from "./verticals/licitaciones/pages/RadarRenovaciones.tsx";
import { PerfilMatchingPage } from "./verticals/licitaciones/pages/PerfilMatching.tsx";
import { DatosEmpresaPage } from "./verticals/licitaciones/pages/DatosEmpresa.tsx";
import { StaffPage as LicitacionesStaffPage } from "./verticals/licitaciones/pages/Staff.tsx";
import { DespachosLoginPage } from "./verticals/despachos/pages/Login.tsx";
import { DespachosShell } from "./verticals/despachos/DespachosShell.tsx";
import { CierreMensualPage } from "./verticals/despachos/pages/CierreMensual.tsx";
import { CierreMensualDetallePage } from "./verticals/despachos/pages/CierreMensualDetalle.tsx";
import { CfdiPage } from "./verticals/despachos/pages/Cfdi.tsx";
import { CfdiDetallePage } from "./verticals/despachos/pages/CfdiDetalle.tsx";
import { CobranzaPage } from "./verticals/despachos/pages/Cobranza.tsx";
import { VencimientosPage } from "./verticals/despachos/pages/Vencimientos.tsx";
import { DeclaracionesPage } from "./verticals/despachos/pages/Declaraciones.tsx";
import { NominaPage } from "./verticals/despachos/pages/Nomina.tsx";
import { ConciliacionPage } from "./verticals/despachos/pages/Conciliacion.tsx";
import { MigracionCatalogoPage } from "./verticals/despachos/pages/MigracionCatalogo.tsx";
import { DevolucionIvaPage } from "./verticals/despachos/pages/DevolucionIva.tsx";
import { BookkeepingPage } from "./verticals/despachos/pages/Bookkeeping.tsx";
import { ContabilidadElectronicaPage } from "./verticals/despachos/pages/ContabilidadElectronica.tsx";
import { StaffPage as DespachosStaffPage } from "./verticals/despachos/pages/Staff.tsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

interface ShellRouteProps<Ctx> {
  readonly apiBaseUrl: string;
  readonly orgSlug: string;
  readonly onRequireLogin: () => void;
  readonly children: (ctx: Ctx) => ReactNode;
}

/** Fábrica del wrapper de ruta "orgSlug + Shell + página" que se repetía, letra por
 * letra salvo 3 nombres (Shell/loginPath/Page), en ~56 de las 73 funciones de este
 * archivo (rubro 7/8 de la auditoría, "App.tsx con wrappers de ruta casi
 * idénticos"): leer `orgSlug` de useParams, volver al login del vertical si falta
 * (nunca renderizar el Shell sin org), y envolver la página en el Shell de esa
 * vertical con el `onRequireLogin` que la regresa al mismo login. El riesgo real de
 * mantenimiento que esto cerraba: ese guard/redirect es la MISMA lógica de sesión
 * copiada 56 veces -- un ajuste ahí (p. ej. pasar más contexto al guard) antes
 * requería tocar 56 funciones idénticas para no dejar una desincronizada.
 *
 * Sigue siendo explícito y buscable en cada `const XRoute = shellRoute(...)` de
 * abajo cuál Shell/loginPath/página monta cada ruta -- solo el esqueleto mecánico
 * (hooks + guard + JSX) vive aquí una sola vez. Las rutas con un segmento extra en
 * la URL (folioId/customerId/providerId/serviceId) o con lógica propia (login,
 * registro, redirects de landing, portal de propietario) se quedan como función
 * completa a propósito: forzarlas en esta fábrica genérica (parámetros opcionales,
 * ramas condicionales) las haría MENOS legibles que hoy, no más. */
function shellRoute<Ctx>(Shell: (props: ShellRouteProps<Ctx>) => ReactElement | null, loginPath: string, renderPage: (ctx: Ctx) => ReactNode): () => ReactElement | null {
  return function ShellRoute() {
    const navigate = useNavigate();
    const { orgSlug } = useParams<{ orgSlug: string }>();
    if (!orgSlug) return <Navigate to={loginPath} replace />;
    return (
      <Shell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate(loginPath, { replace: true })}>
        {renderPage}
      </Shell>
    );
  };
}

function RestaurantesLoginRoute() {
  const navigate = useNavigate();
  return (
    <RestaurantesLoginPage
      apiBaseUrl={API_BASE_URL}
      // Ver comentario de cabecera de apps/web/src/shell/SinOrganizacion.tsx y
      // SeleccionarOrganizacion.tsx: ninguna de las dos páginas genéricas puede
      // adivinar por sí sola de qué vertical es la sesión recién persistida.
      onLoggedIn={(session, landingPath) => navigate(landingPath, { state: { session, vertical: "restaurantes", email: session.email } })}
    />
  );
}

const RestaurantesDashboardRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesDashboardPage {...ctx} />);
const RestaurantesProductosRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <ProductosPage {...ctx} />);
const RestaurantesSucursalesRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <SucursalesPage {...ctx} />);
const RestaurantesPedidosRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <PedidosPage {...ctx} />);
const RestaurantesHistorialRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <HistorialPage {...ctx} />);
const RestaurantesClientesRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesClientesListPage {...ctx} />);

function RestaurantesClienteFichaRoute() {
  const navigate = useNavigate();
  const { orgSlug, customerId } = useParams<{ orgSlug: string; customerId: string }>();
  if (!orgSlug || !customerId) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <RestaurantesClienteFichaPage {...ctx} customerId={customerId} />}
    </RestaurantesShell>
  );
}

const RestaurantesStaffRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <StaffPage {...ctx} />);

// Fase 11 — hallazgo de auditoría (severidad ALTA, "Promociones/códigos de
// descuento (Fase 11) sin UI"): mismo patrón exacto de ruta que
// RestaurantesStaffRoute de arriba.
const RestaurantesPromocionesRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <PromocionesPage {...ctx} />);

/** Ruta pública genérica (Fase 14) — ver comentario de cabecera de
 * shell/AceptarInvitacion.tsx: fuera de cualquier shell autenticado, mismo patrón
 * que `*LoginRoute` de abajo (esta página tampoco puede adivinar por sí sola a qué
 * vertical navegar después de aceptar — usa el `vertical` real de la organización
 * que la sesión aceptada ya trae, ver decideLandingPathForInvite). */
function AceptarInvitacionRoute() {
  const navigate = useNavigate();
  return (
    <AceptarInvitacionPage
      apiBaseUrl={API_BASE_URL}
      onAccepted={(session, landingPath) => navigate(landingPath, { state: { session, vertical: session.organizations[0]?.vertical, email: session.email } })}
    />
  );
}

/** Puente genérico de retorno de "Sign in with Google" (ver
 * `apps/api/src/routes/auth-google.ts` + `shell/GoogleCallback.tsx`) — una sola ruta
 * para las 6 verticales, `:vertical` viene del propio path que el backend arma al
 * redirigir de vuelta. */
function GoogleCallbackRoute() {
  return <GoogleCallbackPage apiBaseUrl={API_BASE_URL} />;
}

/** Back office de plataforma — igual patrón de shell+ruta que cada vertical,
 * pero sin `orgSlug` (el superadmin no está dentro de ninguna organización). */
function SuperAdminRoute() {
  const navigate = useNavigate();
  return (
    <SuperAdminShell apiBaseUrl={API_BASE_URL} onRequireLogin={() => navigate("/", { replace: true })}>
      {(ctx) => <SuperAdminDashboardPage {...ctx} />}
    </SuperAdminShell>
  );
}

function SuperAdminProspectosRoute() {
  const navigate = useNavigate();
  return (
    <SuperAdminShell apiBaseUrl={API_BASE_URL} onRequireLogin={() => navigate("/", { replace: true })}>
      {(ctx) => <SuperAdminProspectosPage {...ctx} />}
    </SuperAdminShell>
  );
}

function SuperAdminPanelesRoute() {
  const navigate = useNavigate();
  return (
    <SuperAdminShell apiBaseUrl={API_BASE_URL} onRequireLogin={() => navigate("/", { replace: true })}>
      {(ctx) => <SuperAdminPanelesPage {...ctx} />}
    </SuperAdminShell>
  );
}

function SuperAdminGastoApiRoute() {
  const navigate = useNavigate();
  return (
    <SuperAdminShell apiBaseUrl={API_BASE_URL} onRequireLogin={() => navigate("/", { replace: true })}>
      {(ctx) => <SuperAdminGastoApiPage {...ctx} />}
    </SuperAdminShell>
  );
}

function HotelesLoginRoute() {
  const navigate = useNavigate();
  return (
    <HotelesLoginPage
      apiBaseUrl={API_BASE_URL}
      // Ver comentario de cabecera de apps/web/src/shell/SinOrganizacion.tsx y
      // SeleccionarOrganizacion.tsx: ninguna de las dos páginas genéricas puede
      // adivinar por sí sola de qué vertical es la sesión recién persistida.
      onLoggedIn={(session, landingPath) => navigate(landingPath, { state: { session, vertical: "hoteles", email: session.email } })}
    />
  );
}

/** Landing real de `/hoteles/:orgSlug` a secas (Fase 16) — hallazgo de auditoría
 * (severidad ALTA, "No hay dashboard por tipo de usuario: todos aterrizan en
 * Reservas"): antes de esta fase esta ruta era una redirección forzosa a
 * `/hoteles/:orgSlug/reservas` para CUALQUIER rol (`HotelesRootRedirect`, ver
 * historial de git) — owner/gm/accountant no tenían ninguna vista financiera y
 * housekeeping/maintenance/fnb no tenían ninguna vista propia. Mismo patrón EXACTO
 * que `RestaurantesDashboardRoute`: el Dashboard se monta DIRECTO en la raíz del
 * orgSlug, sin redirección aparte — ver comentario de cabecera de
 * verticals/hoteles/pages/Dashboard.tsx para el detalle de las dos variantes por
 * rol. */
const HotelesDashboardRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesDashboardPage {...ctx} />);
const HotelesReservasRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <ReservasPage {...ctx} />);

function HotelesFolioRoute() {
  const navigate = useNavigate();
  const { orgSlug, folioId } = useParams<{ orgSlug: string; folioId: string }>();
  if (!orgSlug || !folioId) return <Navigate to="/hoteles/login" replace />;
  return (
    <HotelesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/hoteles/login", { replace: true })}>
      {(ctx) => <FolioPage {...ctx} folioId={folioId} />}
    </HotelesShell>
  );
}

const HotelesMantenimientoRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <MantenimientoPage {...ctx} />);

/** Fase 16 — hallazgo de auditoría (severidad ALTA, "checador de asistencia LFT sin
 * UI"): mismo patrón que HotelesMantenimientoRoute — sin gating de rol aquí (el
 * checador de autoservicio es para TODO staff autenticado; la sección de
 * administración dentro de AsistenciaPage se autogatea por `role`). */
const HotelesAsistenciaRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <AsistenciaPage {...ctx} />);

const HotelesFraudeRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <FraudePage {...ctx} />);
const HotelesCfdiListadoRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesCfdiListadoPage {...ctx} />);

/** Hallazgo de auditoría (severidad ALTA, "P&L USALI (P0)... sin UI", porción
 * restante): back-office de P&L completo (pages/Pl.tsx) — mismo patrón que
 * HotelesMantenimientoRoute/HotelesFraudeRoute (nav gateada cosméticamente por rol
 * en HotelesShell.tsx, no aquí; un rol sin acceso que navegue directo a esta URL ve
 * el 403 real del servidor como mensaje de error dentro de Pl.tsx). */
const HotelesPlRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesPlPage {...ctx} />);

/** Fase 9 (REQ-REV-003/004/005/007) — wiring del motor de revenue management
 * (pages/Revenue.tsx) — mismo patrón que HotelesPlRoute/HotelesFraudeRoute (nav
 * gateada cosméticamente por rol en HotelesShell.tsx, no aquí; un rol sin acceso
 * que navegue directo a esta URL ve el 403 real del servidor como mensaje de
 * error dentro de Revenue.tsx). */
const HotelesRevenueRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesRevenuePage {...ctx} />);

/** Fix hallazgo CRÍTICO ("Alta de organización/property/tipos-de-habitación/
 * tarifas/huéspedes imposible sin SQL directo"): pantalla de catálogo (pages/
 * Catalogo.tsx) — mismo patrón que HotelesPlRoute/HotelesFraudeRoute (nav gateada
 * cosméticamente por rol en HotelesShell.tsx, no aquí; un rol sin acceso que
 * navegue directo a esta URL ve el 403 real del servidor como mensaje de error
 * dentro de Catalogo.tsx). */
const HotelesCatalogoRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesCatalogoPage {...ctx} />);

/** Fase 15 — hallazgo de auditoría (severidad ALTA, "Pedidos F&B con guardia de
 * alergias: backend real sin pantalla"): mismo patrón que
 * HotelesMantenimientoRoute/HotelesFraudeRoute (nav gateada cosméticamente por rol
 * en HotelesShell.tsx, no aquí). */
const HotelesPedidosFnbRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <PedidosFnbPage {...ctx} />);

function HotelesFolioCfdiRoute() {
  const navigate = useNavigate();
  const { orgSlug, folioId } = useParams<{ orgSlug: string; folioId: string }>();
  if (!orgSlug || !folioId) return <Navigate to="/hoteles/login" replace />;
  return (
    <HotelesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/hoteles/login", { replace: true })}>
      {(ctx) => <HotelesCfdiPage {...ctx} folioId={folioId} />}
    </HotelesShell>
  );
}

function RentasLoginRoute() {
  const navigate = useNavigate();
  return (
    <RentasLoginPage
      apiBaseUrl={API_BASE_URL}
      // `state` alimenta las páginas genéricas /sin-organizacion y
      // /seleccionar-organizacion (ver sus comentarios de cabecera en
      // apps/web/src/shell/): ninguna de las dos puede adivinar por sí sola de qué
      // vertical es la sesión que se acaba de persistir.
      onLoggedIn={(session, landingPath) => navigate(landingPath, { state: { session, vertical: "rentas", email: session.email } })}
    />
  );
}

/** Hallazgo de auditoría (severidad CRÍTICA, "el onboarding self-serve de rentas
 * está bloqueado en producción y ni siquiera tiene pantalla") — pantalla real de
 * alta (organización + property + unidades), sin sesión previa. */
function RentasRegistroRoute() {
  return <RentasRegistroPage apiBaseUrl={API_BASE_URL} />;
}

/** Landing real del panel de rentas (Fase 12) — cierra el hallazgo "login de rentas
 * redirige a /rentas/:slug, ruta que no existe en la SPA": a diferencia de
 * hoteles/citas (que redirigen la raíz del orgSlug a una subruta como
 * .../reservas), rentas aún no tiene subpáginas de negocio (ver README) — el
 * dashboard de resumen ES la landing, sin redirect intermedio. */
const RentasDashboardRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasDashboardPage {...ctx} />);

/** Calendario de reservas y bloqueos (Fase 13) — mismo patrón de ruta hija que
 * HotelesReservasRoute: la sesión + property ya la resuelve RentasShell, esta ruta
 * solo monta la página de negocio dentro de ese shell. */
const RentasCalendarioRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasCalendarioPage {...ctx} />);

/** Cotizador + configuración de pricing (Fase 14) — mismo patrón de ruta hija que
 * RentasCalendarioRoute. */
const RentasPreciosRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasPreciosPage {...ctx} />);

/** Bandeja de aprobación de mensajería (Fase 15) — cierra el hallazgo de auditoría
 * ALTA "la cola de aprobación no tiene botón de aprobar". Mismo patrón de ruta hija
 * que RentasCalendarioRoute/RentasPreciosRoute. */
const RentasAprobacionesRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasAprobacionesPage {...ctx} />);

/** Finanzas (Fase 16) — movimiento por reserva, owner statements, payouts/
 * conciliación. Cierra el hallazgo de auditoría ALTA "Finanzas sin UI para
 * admin_gestora ni contador". Mismo patrón de ruta hija que
 * RentasCalendarioRoute/RentasPreciosRoute/RentasAprobacionesRoute. */
const RentasFinanzasRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasFinanzasPage {...ctx} />);

/** Mis tareas (Fase 17) — panel operativo del rol `limpieza` (tareas/checklist/
 * inventario/incidencias). Cierra el hallazgo de auditoría ALTA "el rol `limpieza`
 * sigue sin ninguna vista funcional". Mismo patrón de ruta hija que
 * RentasCalendarioRoute/RentasPreciosRoute/RentasAprobacionesRoute/RentasFinanzasRoute. */
const RentasMisTareasRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasMisTareasPage {...ctx} />);

/** Sincronización de calendario por iCal (Fase 18) — conectar el feed externo de
 * Airbnb/Booking/Vrbo por unidad + copiar la URL del feed de exportación propio.
 * Cierra el hallazgo de auditoría "el backend de iCal-sync está completo pero
 * apps/web no tiene ningún cliente ni pantalla que lo consuma". Mismo patrón de
 * ruta hija que RentasCalendarioRoute/RentasPreciosRoute/.../RentasMisTareasRoute. */
const RentasIcalSyncRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasIcalSyncPage {...ctx} />);

/** Portal de propietario (Fase 3 backend, UI de esta fase) — 3 rutas PÚBLICAS, fuera
 * de RentasShell a propósito: es una identidad completamente distinta de staff (su
 * propio JWT/secreto, ver owner-portal.ts), nunca pasa por el shell autenticado del
 * panel de staff. Mismo criterio de aislamiento que /aceptar-invitacion (shell/
 * AceptarInvitacion.tsx) frente al login/shell de staff. */
function RentasOwnerPortalLoginRoute() {
  const navigate = useNavigate();
  return <OwnerPortalLoginPage apiBaseUrl={API_BASE_URL} onLoggedIn={() => navigate("/rentas/portal-propietario", { replace: true })} />;
}

function RentasOwnerPortalActivarRoute() {
  return <OwnerPortalActivarPage apiBaseUrl={API_BASE_URL} />;
}

function RentasOwnerPortalDashboardRoute() {
  const navigate = useNavigate();
  return <OwnerPortalDashboardPage apiBaseUrl={API_BASE_URL} onRequireLogin={() => navigate("/rentas/portal-propietario/login", { replace: true })} />;
}

function CitasLoginRoute() {
  const navigate = useNavigate();
  return (
    <CitasLoginPage
      apiBaseUrl={API_BASE_URL}
      // Ver comentario de cabecera de apps/web/src/shell/SinOrganizacion.tsx y
      // SeleccionarOrganizacion.tsx: ninguna de las dos páginas genéricas puede
      // adivinar por sí sola de qué vertical es la sesión recién persistida.
      onLoggedIn={(session, landingPath) => navigate(landingPath, { state: { session, vertical: "citas", email: session.email } })}
    />
  );
}

/** Redirección al abrir `/citas/:orgSlug` a secas — la agenda es la landing real
 * del panel (mismo criterio de "página de entrada" que un dashboard de KPIs en
 * otras verticales, pero citas no tiene KPIs todavía, ver README). */
function CitasRootRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/citas/${orgSlug}/agenda`} replace />;
}

const CitasAgendaRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <AgendaPage {...ctx} />);
const CitasProveedoresRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <ProveedoresListPage {...ctx} />);

function CitasProveedorFichaRoute() {
  const navigate = useNavigate();
  const { orgSlug, providerId } = useParams<{ orgSlug: string; providerId: string }>();
  if (!orgSlug || !providerId) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ProveedorFichaPage {...ctx} providerId={providerId} />}
    </CitasShell>
  );
}

const CitasServiciosRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <ServiciosListPage {...ctx} />);

function CitasServicioFichaRoute() {
  const navigate = useNavigate();
  const { orgSlug, serviceId } = useParams<{ orgSlug: string; serviceId: string }>();
  if (!orgSlug || !serviceId) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ServicioFichaPage {...ctx} serviceId={serviceId} />}
    </CitasShell>
  );
}

const CitasClientesRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <ClientesListPage {...ctx} />);

function CitasClienteFichaRoute() {
  const navigate = useNavigate();
  const { orgSlug, customerId } = useParams<{ orgSlug: string; customerId: string }>();
  if (!orgSlug || !customerId) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ClienteFichaPage {...ctx} customerId={customerId} />}
    </CitasShell>
  );
}

const CitasDisponibilidadRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <DisponibilidadPage {...ctx} />);
const CitasConfiguracionRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <ConfiguracionPage {...ctx} />);

// Fase 12 — hallazgo de auditoría ("citas define 3 roles de plataforma pero no los
// aplica en NINGUNA capa"): mismo patrón exacto que RestaurantesStaffRoute.
const CitasStaffRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasStaffPage {...ctx} />);

function LicitacionesLoginRoute() {
  const navigate = useNavigate();
  return (
    <LicitacionesLoginPage
      apiBaseUrl={API_BASE_URL}
      // Ver comentario de cabecera de apps/web/src/shell/SinOrganizacion.tsx y
      // SeleccionarOrganizacion.tsx: ninguna de las dos páginas genéricas puede
      // adivinar por sí sola de qué vertical es la sesión recién persistida.
      onLoggedIn={(session, landingPath) => navigate(landingPath, { state: { session, vertical: "licitaciones", email: session.email } })}
    />
  );
}

/** Redirección al abrir `/licitaciones/:orgSlug` a secas — convocatorias es la
 * landing real del panel (Fase 7, mismo criterio que CitasRootRedirect: aún no
 * hay dashboard de KPIs para este vertical). */
function LicitacionesRootRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/licitaciones/${orgSlug}/convocatorias`} replace />;
}

const LicitacionesConvocatoriasRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <ConvocatoriasPage {...ctx} />);
const LicitacionesConvocatoriaDetalleRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <ConvocatoriaDetallePage {...ctx} />);
const LicitacionesRequisitosRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <RequisitosConvocatoriaPage {...ctx} />);
const LicitacionesPropuestaTecnicaRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <PropuestaTecnicaPage {...ctx} />);
const LicitacionesCierreRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <CierrePage {...ctx} />);
const LicitacionesContratoRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <ContratoPage {...ctx} />);
const LicitacionesPostAdjudicacionRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <PostAdjudicacionPage {...ctx} />);
const LicitacionesAutopsiaRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <AutopsiaPage {...ctx} />);
const LicitacionesRadarRenovacionesRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <RadarRenovacionesPage {...ctx} />);
const LicitacionesPerfilMatchingRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <PerfilMatchingPage {...ctx} />);
const LicitacionesDatosEmpresaRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <DatosEmpresaPage {...ctx} />);

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): licitaciones tenía
// `admin-staff.ts` construido desde una fase anterior pero sin ningún panel que lo
// llamara — mismo patrón que LicitacionesConvocatoriasRoute de arriba.
function LicitacionesStaffRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/licitaciones/login" replace />;
  return (
    <LicitacionesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/licitaciones/login", { replace: true })}>
      {(ctx) => <LicitacionesStaffPage {...ctx} />}
    </LicitacionesShell>
  );
}

function DespachosLoginRoute() {
  const navigate = useNavigate();
  return (
    <DespachosLoginPage
      apiBaseUrl={API_BASE_URL}
      // Ver comentario de cabecera de apps/web/src/shell/SinOrganizacion.tsx y
      // SeleccionarOrganizacion.tsx: ninguna de las dos páginas genéricas puede
      // adivinar por sí sola de qué vertical es la sesión recién persistida.
      onLoggedIn={(session, landingPath) => navigate(landingPath, { state: { session, vertical: "despachos", email: session.email } })}
    />
  );
}

/** Redirección al abrir `/despachos/:orgSlug` a secas — cierre mensual es la
 * landing real del panel (Fase 9, mismo criterio que CitasRootRedirect): es la
 * tarea operativa más recurrente y de mayor riesgo de un despacho. */
function DespachosRootRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/despachos/${orgSlug}/cierre-mensual`} replace />;
}

const DespachosCierreMensualRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CierreMensualPage {...ctx} />);
const DespachosCierreMensualDetalleRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CierreMensualDetallePage {...ctx} />);
const DespachosCfdiRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CfdiPage {...ctx} />);
const DespachosCfdiDetalleRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CfdiDetallePage {...ctx} />);
const DespachosCobranzaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CobranzaPage {...ctx} />);
const DespachosVencimientosRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <VencimientosPage {...ctx} />);
const DespachosDeclaracionesRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DeclaracionesPage {...ctx} />);
const DespachosNominaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <NominaPage {...ctx} />);
const DespachosConciliacionRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <ConciliacionPage {...ctx} />);
const DespachosMigracionCatalogoRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <MigracionCatalogoPage {...ctx} />);
const DespachosDevolucionIvaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DevolucionIvaPage {...ctx} />);
const DespachosBookkeepingRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <BookkeepingPage {...ctx} />);
const DespachosContabilidadElectronicaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <ContabilidadElectronicaPage {...ctx} />);
const DespachosStaffRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosStaffPage {...ctx} />);

export function App() {
  return (
    <BrowserRouter>
      {/* Hallazgo real (verificado con grep, no supuesto): ningún `<Toaster />`
          estaba montado en toda la app -- cada `toast(...)` (BotonChatDatos,
          los 6 Login.tsx de "Continuar con Google", etc.) empujaba a la cola
          interna de sonner pero nada la pintaba en pantalla. Montado UNA sola
          vez aquí, a nivel raíz, para que TODA notificación de toda vertical
          se vea de verdad. */}
      <Toaster />
      <Routes>
        <Route path="/restaurantes/login" element={<RestaurantesLoginRoute />} />
        <Route path="/restaurantes/:orgSlug" element={<RestaurantesDashboardRoute />} />
        <Route path="/restaurantes/:orgSlug/productos" element={<RestaurantesProductosRoute />} />
        <Route path="/restaurantes/:orgSlug/sucursales" element={<RestaurantesSucursalesRoute />} />
        <Route path="/restaurantes/:orgSlug/pedidos" element={<RestaurantesPedidosRoute />} />
        <Route path="/restaurantes/:orgSlug/historial" element={<RestaurantesHistorialRoute />} />
        <Route path="/restaurantes/:orgSlug/clientes" element={<RestaurantesClientesRoute />} />
        <Route path="/restaurantes/:orgSlug/clientes/:customerId" element={<RestaurantesClienteFichaRoute />} />
        {/* Fase 8 — panel real del rol "repartidor" (ver domain-restaurantes/src/
            roles.ts::REPARTIDOR_ROLES), deliberadamente FUERA del nav de
            RestaurantesShell (ver comentario de cabecera de Repartidor.tsx). */}
        <Route path="/restaurantes/:orgSlug/repartidor" element={<RepartidorPedidosPage />} />
        <Route path="/restaurantes/:orgSlug/staff" element={<RestaurantesStaffRoute />} />
        <Route path="/restaurantes/:orgSlug/promociones" element={<RestaurantesPromocionesRoute />} />
        {/* Fase 14 — genérica, fuera de cualquier shell/vertical (ver shell/
            AceptarInvitacion.tsx): el invitado todavía no tiene sesión. */}
        <Route path="/aceptar-invitacion" element={<AceptarInvitacionRoute />} />
        <Route path="/terminos" element={<TerminosPage />} />
        <Route path="/privacidad" element={<PrivacidadPage />} />
        <Route path="/superadmin" element={<SuperAdminRoute />} />
        <Route path="/superadmin/prospectos" element={<SuperAdminProspectosRoute />} />
        <Route path="/superadmin/paneles" element={<SuperAdminPanelesRoute />} />
        <Route path="/superadmin/gasto-api" element={<SuperAdminGastoApiRoute />} />
        <Route path="/:vertical/auth/google/callback" element={<GoogleCallbackRoute />} />
        <Route path="/hoteles/login" element={<HotelesLoginRoute />} />
        <Route path="/hoteles/:orgSlug" element={<HotelesDashboardRoute />} />
        <Route path="/hoteles/:orgSlug/reservas" element={<HotelesReservasRoute />} />
        <Route path="/hoteles/:orgSlug/folios/:folioId" element={<HotelesFolioRoute />} />
        <Route path="/hoteles/:orgSlug/folios/:folioId/cfdi" element={<HotelesFolioCfdiRoute />} />
        <Route path="/hoteles/:orgSlug/mantenimiento" element={<HotelesMantenimientoRoute />} />
        <Route path="/hoteles/:orgSlug/asistencia" element={<HotelesAsistenciaRoute />} />
        <Route path="/hoteles/:orgSlug/fraude" element={<HotelesFraudeRoute />} />
        <Route path="/hoteles/:orgSlug/pedidos-fnb" element={<HotelesPedidosFnbRoute />} />
        <Route path="/hoteles/:orgSlug/cfdi" element={<HotelesCfdiListadoRoute />} />
        <Route path="/hoteles/:orgSlug/pl" element={<HotelesPlRoute />} />
        <Route path="/hoteles/:orgSlug/revenue" element={<HotelesRevenueRoute />} />
        <Route path="/hoteles/:orgSlug/catalogo" element={<HotelesCatalogoRoute />} />
        <Route path="/rentas/login" element={<RentasLoginRoute />} />
        <Route path="/rentas/registro" element={<RentasRegistroRoute />} />
        <Route path="/rentas/:orgSlug" element={<RentasDashboardRoute />} />
        <Route path="/rentas/:orgSlug/calendario" element={<RentasCalendarioRoute />} />
        <Route path="/rentas/:orgSlug/precios" element={<RentasPreciosRoute />} />
        <Route path="/rentas/:orgSlug/aprobaciones" element={<RentasAprobacionesRoute />} />
        <Route path="/rentas/:orgSlug/finanzas" element={<RentasFinanzasRoute />} />
        <Route path="/rentas/:orgSlug/mis-tareas" element={<RentasMisTareasRoute />} />
        <Route path="/rentas/:orgSlug/ical-sync" element={<RentasIcalSyncRoute />} />
        {/* Portal de propietario -- rutas literales, react-router-dom v6 ya rankea un
            segmento literal sobre uno dinámico (:orgSlug) sin importar el orden de
            declaración, así que "portal-propietario" nunca se confunde con un orgSlug
            real (a diferencia de Hono en apps/api, ver el comentario de cabecera de
            rentas.ts sobre por qué ahí SÍ importa el orden de montaje). */}
        <Route path="/rentas/portal-propietario/login" element={<RentasOwnerPortalLoginRoute />} />
        <Route path="/rentas/portal-propietario/activar" element={<RentasOwnerPortalActivarRoute />} />
        <Route path="/rentas/portal-propietario" element={<RentasOwnerPortalDashboardRoute />} />
        <Route path="/sin-organizacion" element={<SinOrganizacionPage />} />
        <Route path="/seleccionar-organizacion" element={<SeleccionarOrganizacionPage />} />
        <Route path="/citas/login" element={<CitasLoginRoute />} />
        <Route path="/citas/:orgSlug" element={<CitasRootRedirect />} />
        <Route path="/citas/:orgSlug/agenda" element={<CitasAgendaRoute />} />
        <Route path="/citas/:orgSlug/proveedores" element={<CitasProveedoresRoute />} />
        <Route path="/citas/:orgSlug/proveedores/:providerId" element={<CitasProveedorFichaRoute />} />
        <Route path="/citas/:orgSlug/servicios" element={<CitasServiciosRoute />} />
        <Route path="/citas/:orgSlug/servicios/:serviceId" element={<CitasServicioFichaRoute />} />
        <Route path="/citas/:orgSlug/clientes" element={<CitasClientesRoute />} />
        <Route path="/citas/:orgSlug/clientes/:customerId" element={<CitasClienteFichaRoute />} />
        <Route path="/citas/:orgSlug/disponibilidad" element={<CitasDisponibilidadRoute />} />
        <Route path="/citas/:orgSlug/configuracion" element={<CitasConfiguracionRoute />} />
        <Route path="/citas/:orgSlug/staff" element={<CitasStaffRoute />} />
        <Route path="/licitaciones/login" element={<LicitacionesLoginRoute />} />
        <Route path="/licitaciones/:orgSlug" element={<LicitacionesRootRedirect />} />
        <Route path="/licitaciones/:orgSlug/convocatorias" element={<LicitacionesConvocatoriasRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId" element={<LicitacionesConvocatoriaDetalleRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/requisitos" element={<LicitacionesRequisitosRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/propuesta-tecnica" element={<LicitacionesPropuestaTecnicaRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/cierre" element={<LicitacionesCierreRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/contrato" element={<LicitacionesContratoRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/post-adjudicacion" element={<LicitacionesPostAdjudicacionRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/autopsia" element={<LicitacionesAutopsiaRoute />} />
        <Route path="/licitaciones/:orgSlug/radar-renovaciones" element={<LicitacionesRadarRenovacionesRoute />} />
        <Route path="/licitaciones/:orgSlug/perfil-matching" element={<LicitacionesPerfilMatchingRoute />} />
        <Route path="/licitaciones/:orgSlug/datos-empresa" element={<LicitacionesDatosEmpresaRoute />} />
        <Route path="/licitaciones/:orgSlug/staff" element={<LicitacionesStaffRoute />} />
        <Route path="/despachos/login" element={<DespachosLoginRoute />} />
        <Route path="/despachos/:orgSlug" element={<DespachosRootRedirect />} />
        <Route path="/despachos/:orgSlug/cierre-mensual" element={<DespachosCierreMensualRoute />} />
        <Route path="/despachos/:orgSlug/cierre-mensual/:periodoId" element={<DespachosCierreMensualDetalleRoute />} />
        <Route path="/despachos/:orgSlug/cfdi" element={<DespachosCfdiRoute />} />
        <Route path="/despachos/:orgSlug/cfdi/:invoiceId" element={<DespachosCfdiDetalleRoute />} />
        <Route path="/despachos/:orgSlug/cobranza" element={<DespachosCobranzaRoute />} />
        <Route path="/despachos/:orgSlug/vencimientos" element={<DespachosVencimientosRoute />} />
        <Route path="/despachos/:orgSlug/declaraciones" element={<DespachosDeclaracionesRoute />} />
        <Route path="/despachos/:orgSlug/nomina" element={<DespachosNominaRoute />} />
        <Route path="/despachos/:orgSlug/conciliacion" element={<DespachosConciliacionRoute />} />
        <Route path="/despachos/:orgSlug/migracion-catalogo" element={<DespachosMigracionCatalogoRoute />} />
        <Route path="/despachos/:orgSlug/devolucion-iva" element={<DespachosDevolucionIvaRoute />} />
        <Route path="/despachos/:orgSlug/bookkeeping" element={<DespachosBookkeepingRoute />} />
        <Route path="/despachos/:orgSlug/contabilidad-electronica" element={<DespachosContabilidadElectronicaRoute />} />
        <Route path="/despachos/:orgSlug/staff" element={<DespachosStaffRoute />} />
        <Route path="/" element={<SeleccionarVerticalPage />} />
      </Routes>
    </BrowserRouter>
  );
}

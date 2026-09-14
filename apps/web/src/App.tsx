// Shell mínimo de apps/web para esta fase — solo lo necesario para que la pantalla
// de login del vertical restaurantes sea real y navegable, sin portar el resto del
// dashboard visual (fuera de alcance explícito de Fase 1, ver el brief).
import { useNavigate, useParams } from "react-router-dom";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { RestaurantesLoginPage } from "./verticals/restaurantes/pages/Login.tsx";
import { RestaurantesDashboardPage } from "./verticals/restaurantes/pages/Dashboard.tsx";
import { RestaurantesShell } from "./verticals/restaurantes/RestaurantesShell.tsx";
import { ProductosPage } from "./verticals/restaurantes/pages/Productos.tsx";
import { SucursalesPage } from "./verticals/restaurantes/pages/Sucursales.tsx";
import { PedidosPage } from "./verticals/restaurantes/pages/Pedidos.tsx";
import { HistorialPage } from "./verticals/restaurantes/pages/Historial.tsx";
import { ClienteFichaPage as RestaurantesClienteFichaPage, ClientesListPage as RestaurantesClientesListPage } from "./verticals/restaurantes/pages/Clientes.tsx";
import { RepartidorPedidosPage } from "./verticals/restaurantes/pages/Repartidor.tsx";
import { HotelesLoginPage } from "./verticals/hoteles/pages/Login.tsx";
import { HotelesShell } from "./verticals/hoteles/HotelesShell.tsx";
import { ReservasPage } from "./verticals/hoteles/pages/Reservas.tsx";
import { FolioPage } from "./verticals/hoteles/pages/Folio.tsx";
import { MantenimientoPage } from "./verticals/hoteles/pages/Mantenimiento.tsx";
import { FraudePage } from "./verticals/hoteles/pages/Fraude.tsx";
import { RentasLoginPage } from "./verticals/rentas/pages/Login.tsx";
import { RentasShell } from "./verticals/rentas/RentasShell.tsx";
import { RentasDashboardPage } from "./verticals/rentas/pages/Dashboard.tsx";
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
import { LicitacionesLoginPage } from "./verticals/licitaciones/pages/Login.tsx";
import { LicitacionesShell } from "./verticals/licitaciones/LicitacionesShell.tsx";
import { ConvocatoriasPage } from "./verticals/licitaciones/pages/Convocatorias.tsx";
import { ConvocatoriaDetallePage } from "./verticals/licitaciones/pages/ConvocatoriaDetalle.tsx";
import { PerfilMatchingPage } from "./verticals/licitaciones/pages/PerfilMatching.tsx";
import { DespachosLoginPage } from "./verticals/despachos/pages/Login.tsx";
import { DespachosShell } from "./verticals/despachos/DespachosShell.tsx";
import { CierreMensualPage } from "./verticals/despachos/pages/CierreMensual.tsx";
import { CierreMensualDetallePage } from "./verticals/despachos/pages/CierreMensualDetalle.tsx";
import { CfdiPage } from "./verticals/despachos/pages/Cfdi.tsx";
import { CfdiDetallePage } from "./verticals/despachos/pages/CfdiDetalle.tsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

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

function RestaurantesDashboardRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <RestaurantesDashboardPage {...ctx} />}
    </RestaurantesShell>
  );
}

function RestaurantesProductosRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <ProductosPage {...ctx} />}
    </RestaurantesShell>
  );
}

function RestaurantesSucursalesRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <SucursalesPage {...ctx} />}
    </RestaurantesShell>
  );
}

function RestaurantesPedidosRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <PedidosPage {...ctx} />}
    </RestaurantesShell>
  );
}

function RestaurantesHistorialRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <HistorialPage {...ctx} />}
    </RestaurantesShell>
  );
}

function RestaurantesClientesRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}>
      {(ctx) => <RestaurantesClientesListPage {...ctx} />}
    </RestaurantesShell>
  );
}

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

/** Redirección al abrir `/hoteles/:orgSlug` a secas — Reservas es la landing real
 * del panel (mismo criterio que CitasRootRedirect: la agenda/reservas es lo primero
 * que necesita ver recepción al entrar). */
function HotelesRootRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/hoteles/${orgSlug}/reservas`} replace />;
}

function HotelesReservasRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/hoteles/login" replace />;
  return (
    <HotelesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/hoteles/login", { replace: true })}>
      {(ctx) => <ReservasPage {...ctx} />}
    </HotelesShell>
  );
}

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

function HotelesMantenimientoRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/hoteles/login" replace />;
  return (
    <HotelesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/hoteles/login", { replace: true })}>
      {(ctx) => <MantenimientoPage {...ctx} />}
    </HotelesShell>
  );
}

function HotelesFraudeRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/hoteles/login" replace />;
  return (
    <HotelesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/hoteles/login", { replace: true })}>
      {(ctx) => <FraudePage {...ctx} />}
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

/** Landing real del panel de rentas (Fase 12) — cierra el hallazgo "login de rentas
 * redirige a /rentas/:slug, ruta que no existe en la SPA": a diferencia de
 * hoteles/citas (que redirigen la raíz del orgSlug a una subruta como
 * .../reservas), rentas aún no tiene subpáginas de negocio (ver README) — el
 * dashboard de resumen ES la landing, sin redirect intermedio. */
function RentasDashboardRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/rentas/login" replace />;
  return (
    <RentasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/rentas/login", { replace: true })}>
      {(ctx) => <RentasDashboardPage {...ctx} />}
    </RentasShell>
  );
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

function CitasAgendaRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <AgendaPage {...ctx} />}
    </CitasShell>
  );
}

function CitasProveedoresRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ProveedoresListPage {...ctx} />}
    </CitasShell>
  );
}

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

function CitasServiciosRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ServiciosListPage {...ctx} />}
    </CitasShell>
  );
}

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

function CitasClientesRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ClientesListPage {...ctx} />}
    </CitasShell>
  );
}

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

function CitasDisponibilidadRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <DisponibilidadPage {...ctx} />}
    </CitasShell>
  );
}

function CitasConfiguracionRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/citas/login" replace />;
  return (
    <CitasShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/citas/login", { replace: true })}>
      {(ctx) => <ConfiguracionPage {...ctx} />}
    </CitasShell>
  );
}

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

function LicitacionesConvocatoriasRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/licitaciones/login" replace />;
  return (
    <LicitacionesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/licitaciones/login", { replace: true })}>
      {(ctx) => <ConvocatoriasPage {...ctx} />}
    </LicitacionesShell>
  );
}

function LicitacionesConvocatoriaDetalleRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/licitaciones/login" replace />;
  return (
    <LicitacionesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/licitaciones/login", { replace: true })}>
      {(ctx) => <ConvocatoriaDetallePage {...ctx} />}
    </LicitacionesShell>
  );
}

function LicitacionesPerfilMatchingRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/licitaciones/login" replace />;
  return (
    <LicitacionesShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/licitaciones/login", { replace: true })}>
      {(ctx) => <PerfilMatchingPage {...ctx} />}
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

function DespachosCierreMensualRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/despachos/login" replace />;
  return (
    <DespachosShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/despachos/login", { replace: true })}>
      {(ctx) => <CierreMensualPage {...ctx} />}
    </DespachosShell>
  );
}

function DespachosCierreMensualDetalleRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/despachos/login" replace />;
  return (
    <DespachosShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/despachos/login", { replace: true })}>
      {(ctx) => <CierreMensualDetallePage {...ctx} />}
    </DespachosShell>
  );
}

function DespachosCfdiRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/despachos/login" replace />;
  return (
    <DespachosShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/despachos/login", { replace: true })}>
      {(ctx) => <CfdiPage {...ctx} />}
    </DespachosShell>
  );
}

function DespachosCfdiDetalleRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/despachos/login" replace />;
  return (
    <DespachosShell apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} onRequireLogin={() => navigate("/despachos/login", { replace: true })}>
      {(ctx) => <CfdiDetallePage {...ctx} />}
    </DespachosShell>
  );
}

export function App() {
  return (
    <BrowserRouter>
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
        <Route path="/hoteles/login" element={<HotelesLoginRoute />} />
        <Route path="/hoteles/:orgSlug" element={<HotelesRootRedirect />} />
        <Route path="/hoteles/:orgSlug/reservas" element={<HotelesReservasRoute />} />
        <Route path="/hoteles/:orgSlug/folios/:folioId" element={<HotelesFolioRoute />} />
        <Route path="/hoteles/:orgSlug/mantenimiento" element={<HotelesMantenimientoRoute />} />
        <Route path="/hoteles/:orgSlug/fraude" element={<HotelesFraudeRoute />} />
        <Route path="/rentas/login" element={<RentasLoginRoute />} />
        <Route path="/rentas/:orgSlug" element={<RentasDashboardRoute />} />
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
        <Route path="/licitaciones/login" element={<LicitacionesLoginRoute />} />
        <Route path="/licitaciones/:orgSlug" element={<LicitacionesRootRedirect />} />
        <Route path="/licitaciones/:orgSlug/convocatorias" element={<LicitacionesConvocatoriasRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId" element={<LicitacionesConvocatoriaDetalleRoute />} />
        <Route path="/licitaciones/:orgSlug/perfil-matching" element={<LicitacionesPerfilMatchingRoute />} />
        <Route path="/despachos/login" element={<DespachosLoginRoute />} />
        <Route path="/despachos/:orgSlug" element={<DespachosRootRedirect />} />
        <Route path="/despachos/:orgSlug/cierre-mensual" element={<DespachosCierreMensualRoute />} />
        <Route path="/despachos/:orgSlug/cierre-mensual/:periodoId" element={<DespachosCierreMensualDetalleRoute />} />
        <Route path="/despachos/:orgSlug/cfdi" element={<DespachosCfdiRoute />} />
        <Route path="/despachos/:orgSlug/cfdi/:invoiceId" element={<DespachosCfdiDetalleRoute />} />
        <Route path="/" element={<Navigate to="/restaurantes/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

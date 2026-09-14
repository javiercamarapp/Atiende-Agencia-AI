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
import { HotelesLoginPage } from "./verticals/hoteles/pages/Login.tsx";
import { RentasLoginPage } from "./verticals/rentas/pages/Login.tsx";
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

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787";

function RestaurantesLoginRoute() {
  const navigate = useNavigate();
  return (
    <RestaurantesLoginPage
      apiBaseUrl={API_BASE_URL}
      onLoggedIn={(_session, landingPath) => navigate(landingPath)}
    />
  );
}

function RestaurantesDashboardRoute() {
  const navigate = useNavigate();
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug) return <Navigate to="/restaurantes/login" replace />;
  return (
    <RestaurantesDashboardPage
      apiBaseUrl={API_BASE_URL}
      orgSlug={orgSlug}
      onRequireLogin={() => navigate("/restaurantes/login", { replace: true })}
    />
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
      onLoggedIn={(_session, landingPath) => navigate(landingPath)}
    />
  );
}

function RentasLoginRoute() {
  const navigate = useNavigate();
  return (
    <RentasLoginPage
      apiBaseUrl={API_BASE_URL}
      onLoggedIn={(_session, landingPath) => navigate(landingPath)}
    />
  );
}

function CitasLoginRoute() {
  const navigate = useNavigate();
  return <CitasLoginPage apiBaseUrl={API_BASE_URL} onLoggedIn={(_session, landingPath) => navigate(landingPath)} />;
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
  return <LicitacionesLoginPage apiBaseUrl={API_BASE_URL} onLoggedIn={(_session, landingPath) => navigate(landingPath)} />;
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
        <Route path="/hoteles/login" element={<HotelesLoginRoute />} />
        <Route path="/rentas/login" element={<RentasLoginRoute />} />
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
        <Route path="/" element={<Navigate to="/restaurantes/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

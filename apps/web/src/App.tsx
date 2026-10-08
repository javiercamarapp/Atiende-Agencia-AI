// Shell mínimo de apps/web para esta fase — solo lo necesario para que la pantalla
// de login del vertical restaurantes sea real y navegable, sin portar el resto del
// dashboard visual (fuera de alcance explícito de Fase 1, ver el brief).
import { useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Suspense, useCallback } from "react";
import type { ComponentProps, ComponentType, LazyExoticComponent, ReactElement, ReactNode } from "react";
import { REDIRECCIONES_SUPERADMIN } from "./superadmin/rutas.ts";
import { cargaPerezosa, ErrorBoundaryRaiz } from "./lib/carga-perezosa.tsx";
import { EstadoCargando, EstadoError, Toaster, VerticalNoEncontrado } from "@atiende/ui";
import { puedeVerPrivacidad as licitacionesPuedeVerPrivacidad } from "./verticals/licitaciones/roles-nav.ts";

// R-37: cada pantalla es su propio chunk (ver lib/carga-perezosa.tsx: reintento, recarga protegida y ErrorBoundary raíz).
const RestaurantesLoginPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Login.tsx"), "RestaurantesLoginPage");
const RestaurantesDashboardPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Dashboard.tsx"), "RestaurantesDashboardPage");
const RestaurantesShell = cargaPerezosa(() => import("./verticals/restaurantes/RestaurantesShell.tsx"), "RestaurantesShell");
const ProductosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Productos.tsx"), "ProductosPage");
const SucursalesPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Sucursales.tsx"), "SucursalesPage");
const PedidosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Pedidos.tsx"), "PedidosPage");
const RestaurantesComandasPosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/ComandasPos.tsx"), "ComandasPosPage");
const HistorialPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Historial.tsx"), "HistorialPage");
const RestaurantesClienteFichaPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Clientes.tsx"), "ClienteFichaPage");
const RestaurantesClientesListPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Clientes.tsx"), "ClientesListPage");
const RepartidorPedidosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Repartidor.tsx"), "RepartidorPedidosPage");
const StaffPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Staff.tsx"), "StaffPage");
const PromocionesPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Promociones.tsx"), "PromocionesPage");
const RestaurantesAuditoriaPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Auditoria.tsx"), "AuditoriaPage");
const RestaurantesConfiguracionPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Configuracion.tsx"), "ConfiguracionPage");
const RestaurantesAgenteVozPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/AgenteVoz.tsx"), "AgenteVozPage");
const RestaurantesAjustesAgentePage = cargaPerezosa(() => import("./verticals/restaurantes/pages/AjustesAgente.tsx"), "AjustesAgentePage");
const RestaurantesIndicadoresWhatsappPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/IndicadoresWhatsapp.tsx"), "IndicadoresWhatsappPage");
const RestaurantesCierresPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Cierres.tsx"), "CierresPage");
const RestaurantesCampanasPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Campanas.tsx"), "CampanasPage");
const RestaurantesPrivacidadPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Privacidad.tsx"), "PrivacidadPage");
const RestaurantesConversacionesPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Conversaciones.tsx"), "ConversacionesPage");
const RestaurantesTurnosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Turnos.tsx"), "TurnosPage");
const RestaurantesAvisosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/AvisosStaff.tsx"), "AvisosStaffPage");
const AceptarInvitacionPage = cargaPerezosa(() => import("./shell/AceptarInvitacion.tsx"), "AceptarInvitacionPage");
const SeleccionarVerticalPage = cargaPerezosa(() => import("./shell/SeleccionarVertical.tsx"), "SeleccionarVerticalPage");
const GoogleCallbackPage = cargaPerezosa(() => import("./shell/GoogleCallback.tsx"), "GoogleCallbackPage");
const TerminosPage = cargaPerezosa(() => import("./pages/Terminos.tsx"), "TerminosPage");
const NotFoundPage = cargaPerezosa(() => import("./pages/NotFound.tsx"), "NotFoundPage");
const PrivacidadPage = cargaPerezosa(() => import("./pages/Privacidad.tsx"), "PrivacidadPage");
const SuperAdminShell = cargaPerezosa(() => import("./superadmin/SuperAdminShell.tsx"), "SuperAdminShell");
const SuperAdminOrganizacionesPage = cargaPerezosa(() => import("./superadmin/pages/Organizaciones.tsx"), "SuperAdminOrganizacionesPage");
const SuperAdminOrganizacionFichaPage = cargaPerezosa(() => import("./superadmin/pages/OrganizacionFicha.tsx"), "SuperAdminOrganizacionFichaPage");
const SuperAdminProspectosPage = cargaPerezosa(() => import("./superadmin/pages/Prospectos.tsx"), "SuperAdminProspectosPage");
const SuperAdminTaxonomiaPage = cargaPerezosa(() => import("./superadmin/pages/Taxonomia.tsx"), "SuperAdminTaxonomiaPage");
const SuperAdminCerebroMapaPage = cargaPerezosa(() => import("./superadmin/cerebro/CerebroMapa.tsx"), "SuperAdminCerebroMapaPage");
const SuperAdminFichaProspectoPage = cargaPerezosa(() => import("./superadmin/cerebro/FichaProspecto.tsx"), "SuperAdminFichaProspectoPage");
const SuperAdminPanelesPage = cargaPerezosa(() => import("./superadmin/pages/Paneles.tsx"), "SuperAdminPanelesPage");
const SuperAdminConsumoIaPage = cargaPerezosa(() => import("./superadmin/pages/ConsumoIa.tsx"), "SuperAdminConsumoIaPage");
const SuperAdminBreakGlassPage = cargaPerezosa(() => import("./superadmin/pages/BreakGlass.tsx"), "SuperAdminBreakGlassPage");
const SuperAdminImpersonacionPage = cargaPerezosa(() => import("./superadmin/pages/Impersonacion.tsx"), "SuperAdminImpersonacionPage");
const SuperAdminAuthzAuditoriaPage = cargaPerezosa(() => import("./superadmin/pages/AuthzAuditoria.tsx"), "SuperAdminAuthzAuditoriaPage");
const SuperAdminIntegracionesPage = cargaPerezosa(() => import("./superadmin/pages/Integraciones.tsx"), "SuperAdminIntegracionesPage");
const SuperAdminSaludPage = cargaPerezosa(() => import("./superadmin/pages/Salud.tsx"), "SuperAdminSaludPage");
const SuperAdminResumenPage = cargaPerezosa(() => import("./superadmin/pages/Resumen.tsx"), "SuperAdminResumenPage");
const SuperAdminConsolaResumenPage = cargaPerezosa(() => import("./superadmin/pages/ConsolaResumen.tsx"), "SuperAdminConsolaResumenPage");
const SuperAdminAccionesPage = cargaPerezosa(() => import("./superadmin/pages/Acciones.tsx"), "SuperAdminAccionesPage");
const SuperAdminCopilotoPage = cargaPerezosa(() => import("./superadmin/pages/Copiloto.tsx"), "SuperAdminCopilotoPage");
const SuperAdminSeguridadPage = cargaPerezosa(() => import("./superadmin/pages/Seguridad.tsx"), "SuperAdminSeguridadPage");
const SuperAdminInterruptoresPage = cargaPerezosa(() => import("./superadmin/pages/Interruptores.tsx"), "SuperAdminInterruptoresPage");
const SuperAdminPrivacidadPage = cargaPerezosa(() => import("./superadmin/pages/Privacidad.tsx"), "SuperAdminPrivacidadPage");
const SuperAdminSupresionPage = cargaPerezosa(() => import("./superadmin/pages/Supresion.tsx"), "SuperAdminSupresionPage");
const SuperAdminAgentesPage = cargaPerezosa(() => import("./superadmin/pages/Agentes.tsx"), "SuperAdminAgentesPage");
const SuperAdminAgenteConciliacionPage = cargaPerezosa(() => import("./superadmin/pages/AgenteFicha.tsx"), "SuperAdminAgenteConciliacionPage");
const SuperAdminAgenteExtractorPage = cargaPerezosa(() => import("./superadmin/pages/AgenteFicha.tsx"), "SuperAdminAgenteExtractorPage");
const SuperAdminAgenteWhatsappPage = cargaPerezosa(() => import("./superadmin/pages/AgenteFicha.tsx"), "SuperAdminAgenteWhatsappPage");
const SuperAdminModelOpsPage = cargaPerezosa(() => import("./superadmin/pages/ModelOps.tsx"), "SuperAdminModelOpsPage");
const PrivacidadOrganizacionPage = cargaPerezosa(() => import("./pages/PrivacidadOrganizacion.tsx"), "PrivacidadOrganizacionPage");
const SuperAdminCostosFacturacionPage = cargaPerezosa(() => import("./superadmin/pages/CostosFacturacion.tsx"), "SuperAdminCostosFacturacionPage");
const SuperAdminEjecutivoPage = cargaPerezosa(() => import("./superadmin/pages/Ejecutivo.tsx"), "SuperAdminEjecutivoPage");
const SuperAdminZonaCfoPage = cargaPerezosa(() => import("./superadmin/pages/ZonaCfo.tsx"), "SuperAdminZonaCfoPage");
const SuperAdminPlanesPage = cargaPerezosa(() => import("./superadmin/pages/Planes.tsx"), "SuperAdminPlanesPage");
const NotificacionesPagina = cargaPerezosa(() => import("./components/NotificacionesPagina.tsx"), "NotificacionesPagina");
const PlanYUsoPagina = cargaPerezosa(() => import("./components/PlanYUsoPagina.tsx"), "PlanYUsoPagina");
const ReservarPage = cargaPerezosa(() => import("./verticals/citas/reserva/ReservarPage.tsx"), "ReservarPage");
const RestaurantesPrimerosPasosPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/PrimerosPasos.tsx"), "RestaurantesPrimerosPasosPage");
const RestaurantesCopilotoPage = cargaPerezosa(() => import("./verticals/restaurantes/pages/Copiloto.tsx"), "RestaurantesCopilotoPage");
const RentasCopilotoPage = cargaPerezosa(() => import("./verticals/rentas/pages/Copiloto.tsx"), "RentasCopilotoPage");
const DemoWhatsAppPage = cargaPerezosa(() => import("./verticals/restaurantes/demo/DemoWhatsAppPage.tsx"), "DemoWhatsAppPage");
const HotelesLoginPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Login.tsx"), "HotelesLoginPage");
const AvisoPublicoPage = cargaPerezosa(() => import("./verticals/hoteles/privacidad-publica/AvisoPublicoPage.tsx"), "AvisoPublicoPage");
const MisDatosPage = cargaPerezosa(() => import("./verticals/hoteles/privacidad-publica/MisDatosPage.tsx"), "MisDatosPage");
const HotelesShell = cargaPerezosa(() => import("./verticals/hoteles/HotelesShell.tsx"), "HotelesShell");
const HotelesCopilotoPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Copiloto.tsx"), "HotelesCopilotoPage");
const HotelesDashboardPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Dashboard.tsx"), "DashboardPage");
const ReservasPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Reservas.tsx"), "ReservasPage");
const FolioPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Folio.tsx"), "FolioPage");
const MantenimientoPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Mantenimiento.tsx"), "MantenimientoPage");
const HousekeepingPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Housekeeping.tsx"), "HousekeepingPage");
const MensajeriaPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Mensajeria.tsx"), "MensajeriaPage");
const TicketsPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Tickets.tsx"), "TicketsPage");
const AgentesPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Agentes.tsx"), "AgentesPage");
const AprobacionesAgentesPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Aprobaciones.tsx"), "AprobacionesAgentesPage");
const GruposPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Grupos.tsx"), "GruposPage");
const RecepcionPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Recepcion.tsx"), "RecepcionPage");
const HuespedesPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Huespedes.tsx"), "HuespedesPage");
const HuespedFichaPage = cargaPerezosa(() => import("./verticals/hoteles/pages/HuespedFicha.tsx"), "HuespedFichaPage");
const HotelesConversacionesPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Conversaciones.tsx"), "ConversacionesPage");
const AsistenciaPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Asistencia.tsx"), "AsistenciaPage");
const FraudePage = cargaPerezosa(() => import("./verticals/hoteles/pages/Fraude.tsx"), "FraudePage");
const IdentidadPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Identidad.tsx"), "IdentidadPage");
const HotelesCfdiPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Cfdi.tsx"), "CfdiPage");
const HotelesCfdiListadoPage = cargaPerezosa(() => import("./verticals/hoteles/pages/CfdiListado.tsx"), "CfdiListadoPage");
const HotelesPlPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Pl.tsx"), "PlPage");
const HotelesRevenuePage = cargaPerezosa(() => import("./verticals/hoteles/pages/Revenue.tsx"), "RevenuePage");
const HotelesReputacionPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Reputacion.tsx"), "ReputacionPage");
const HotelesCatalogoPage = cargaPerezosa(() => import("./verticals/hoteles/pages/Catalogo.tsx"), "CatalogoPage");
const PedidosFnbPage = cargaPerezosa(() => import("./verticals/hoteles/pages/PedidosFnb.tsx"), "PedidosFnbPage");
const RentasLoginPage = cargaPerezosa(() => import("./verticals/rentas/pages/Login.tsx"), "RentasLoginPage");
const RentasRegistroPage = cargaPerezosa(() => import("./verticals/rentas/pages/Registro.tsx"), "RentasRegistroPage");
const RentasShell = cargaPerezosa(() => import("./verticals/rentas/RentasShell.tsx"), "RentasShell");
const RentasDashboardPage = cargaPerezosa(() => import("./verticals/rentas/pages/Dashboard.tsx"), "RentasDashboardPage");
const RentasCalendarioPage = cargaPerezosa(() => import("./verticals/rentas/pages/Calendario.tsx"), "CalendarioPage");
const RentasPreciosPage = cargaPerezosa(() => import("./verticals/rentas/pages/Precios.tsx"), "PreciosPage");
const RentasAprobacionesPage = cargaPerezosa(() => import("./verticals/rentas/pages/Aprobaciones.tsx"), "AprobacionesPage");
const RentasHiloPage = cargaPerezosa(() => import("./verticals/rentas/pages/aprobaciones/Hilo.tsx"), "HiloPage");
const RentasFinanzasPage = cargaPerezosa(() => import("./verticals/rentas/pages/Finanzas.tsx"), "FinanzasPage");
const RentasMisTareasPage = cargaPerezosa(() => import("./verticals/rentas/pages/MisTareas.tsx"), "MisTareasPage");
const RentasIcalSyncPage = cargaPerezosa(() => import("./verticals/rentas/pages/IcalSync.tsx"), "IcalSyncPage");
const RentasMonitorSyncPage = cargaPerezosa(() => import("./verticals/rentas/pages/MonitorSync.tsx"), "MonitorSyncPage");
const RentasReportesPage = cargaPerezosa(() => import("./verticals/rentas/pages/Reportes.tsx"), "ReportesPage");
const RentasAccesoHuespedPage = cargaPerezosa(() => import("./verticals/rentas/pages/AccesoHuesped.tsx"), "AccesoHuespedPage");
const RentasPlantillasPage = cargaPerezosa(() => import("./verticals/rentas/pages/Plantillas.tsx"), "PlantillasPage");
const RentasPrivacidadPage = cargaPerezosa(() => import("./verticals/rentas/pages/Privacidad.tsx"), "PrivacidadPage");
const RentasAuditoriaPage = cargaPerezosa(() => import("./verticals/rentas/pages/Auditoria.tsx"), "AuditoriaPage");
const RentasCatalogoPage = cargaPerezosa(() => import("./verticals/rentas/pages/Catalogo.tsx"), "CatalogoPage");
const RentasEquipoPage = cargaPerezosa(() => import("./verticals/rentas/pages/Equipo.tsx"), "EquipoPage");
const OwnerPortalLoginPage = cargaPerezosa(() => import("./verticals/rentas/pages/OwnerPortalLogin.tsx"), "OwnerPortalLoginPage");
const OwnerPortalActivarPage = cargaPerezosa(() => import("./verticals/rentas/pages/OwnerPortalActivar.tsx"), "OwnerPortalActivarPage");
const OwnerPortalDashboardPage = cargaPerezosa(() => import("./verticals/rentas/pages/OwnerPortalDashboard.tsx"), "OwnerPortalDashboardPage");
const SinOrganizacionPage = cargaPerezosa(() => import("./shell/SinOrganizacion.tsx"), "SinOrganizacionPage");
const SeleccionarOrganizacionPage = cargaPerezosa(() => import("./shell/SeleccionarOrganizacion.tsx"), "SeleccionarOrganizacionPage");
const CitasLoginPage = cargaPerezosa(() => import("./verticals/citas/pages/Login.tsx"), "CitasLoginPage");
const CitasShell = cargaPerezosa(() => import("./verticals/citas/CitasShell.tsx"), "CitasShell");
const AgendaPage = cargaPerezosa(() => import("./verticals/citas/pages/Agenda.tsx"), "AgendaPage");
const CitasResumenPage = cargaPerezosa(() => import("./verticals/citas/pages/Resumen.tsx"), "ResumenPage");
const CitasCopilotoPage = cargaPerezosa(() => import("./verticals/citas/pages/Copiloto.tsx"), "CitasCopilotoPage");
const CitasPrimerosPasosPage = cargaPerezosa(() => import("./verticals/citas/pages/PrimerosPasos.tsx"), "PrimerosPasosPage");
const ProveedorFichaPage = cargaPerezosa(() => import("./verticals/citas/pages/Proveedores.tsx"), "ProveedorFichaPage");
const ProveedoresListPage = cargaPerezosa(() => import("./verticals/citas/pages/Proveedores.tsx"), "ProveedoresListPage");
const ServicioFichaPage = cargaPerezosa(() => import("./verticals/citas/pages/Servicios.tsx"), "ServicioFichaPage");
const ServiciosListPage = cargaPerezosa(() => import("./verticals/citas/pages/Servicios.tsx"), "ServiciosListPage");
const ClienteFichaPage = cargaPerezosa(() => import("./verticals/citas/pages/Clientes.tsx"), "ClienteFichaPage");
const ClientesListPage = cargaPerezosa(() => import("./verticals/citas/pages/Clientes.tsx"), "ClientesListPage");
const DisponibilidadPage = cargaPerezosa(() => import("./verticals/citas/pages/Disponibilidad.tsx"), "DisponibilidadPage");
const ConfiguracionPage = cargaPerezosa(() => import("./verticals/citas/pages/Configuracion.tsx"), "ConfiguracionPage");
const CitasStaffPage = cargaPerezosa(() => import("./verticals/citas/pages/Staff.tsx"), "StaffPage");
const CitasAuditoriaPage = cargaPerezosa(() => import("./verticals/citas/pages/Auditoria.tsx"), "AuditoriaPage");
const CitasAvisosPage = cargaPerezosa(() => import("./verticals/citas/pages/Avisos.tsx"), "AvisosPage");
const CitasPrivacidadPage = cargaPerezosa(() => import("./verticals/citas/pages/Privacidad.tsx"), "PrivacidadPage");
const CitasAgenteWhatsappPage = cargaPerezosa(() => import("./verticals/citas/pages/AgenteWhatsapp.tsx"), "AgenteWhatsappPage");
const CitasWhatsappMensajesPage = cargaPerezosa(() => import("./verticals/citas/pages/WhatsappMensajes.tsx"), "WhatsappMensajesPage");
const CitasConversacionesPage = cargaPerezosa(() => import("./verticals/citas/pages/Conversaciones.tsx"), "ConversacionesPage");
const LicitacionesLoginPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Login.tsx"), "LicitacionesLoginPage");
const LicitacionesShell = cargaPerezosa(() => import("./verticals/licitaciones/LicitacionesShell.tsx"), "LicitacionesShell");
const LicitacionesCopilotoPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Copiloto.tsx"), "LicitacionesCopilotoPage");
const ConvocatoriasPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Convocatorias.tsx"), "ConvocatoriasPage");
const ConvocatoriaDetallePage = cargaPerezosa(() => import("./verticals/licitaciones/pages/ConvocatoriaDetalle.tsx"), "ConvocatoriaDetallePage");
const RequisitosConvocatoriaPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/RequisitosConvocatoria.tsx"), "RequisitosConvocatoriaPage");
const PropuestaTecnicaPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/PropuestaTecnica.tsx"), "PropuestaTecnicaPage");
const CierrePage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Cierre.tsx"), "CierrePage");
const ContratoPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Contrato.tsx"), "ContratoPage");
const PostAdjudicacionPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/PostAdjudicacion.tsx"), "PostAdjudicacionPage");
const AutopsiaPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Autopsia.tsx"), "AutopsiaPage");
const RadarRenovacionesPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/RadarRenovaciones.tsx"), "RadarRenovacionesPage");
const PerfilMatchingPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/PerfilMatching.tsx"), "PerfilMatchingPage");
const DatosEmpresaPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/DatosEmpresa.tsx"), "DatosEmpresaPage");
const LicitacionesStaffPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Staff.tsx"), "StaffPage");
const LicitacionesBitacoraPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Bitacora.tsx"), "BitacoraPage");
const LicitacionesSeguridadPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Seguridad.tsx"), "SeguridadPage");
const LicitacionesWhatsappPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Whatsapp.tsx"), "WhatsappPage");
const LicitacionesDiasInhabilesPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/DiasInhabiles.tsx"), "DiasInhabilesPage");
const LicitacionesKyc69bPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Kyc69b.tsx"), "Kyc69bPage");
const RestablecerContrasenaPage = cargaPerezosa(() => import("./shell/cuenta/CuentaEnlaces.tsx"), "RestablecerContrasenaPage");
const VerificarCorreoPage = cargaPerezosa(() => import("./shell/cuenta/CuentaEnlaces.tsx"), "VerificarCorreoPage");
const SeguridadCuentaPagina = cargaPerezosa(() => import("./shell/cuenta/SeguridadCuentaPagina.tsx"), "SeguridadCuentaPagina");
const LicitacionesPanelPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Panel.tsx"), "PanelPage");
const FuentesFrescuraPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/FuentesFrescura.tsx"), "FuentesFrescuraPage");
const SeguimientoPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Seguimiento.tsx"), "SeguimientoPage");
const AprobacionesPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/Aprobaciones.tsx"), "AprobacionesPage");
const SalaGuerraPage = cargaPerezosa(() => import("./verticals/licitaciones/pages/SalaGuerra.tsx"), "SalaGuerraPage");
const DespachosLoginPage = cargaPerezosa(() => import("./verticals/despachos/pages/Login.tsx"), "DespachosLoginPage");
const DespachosShell = cargaPerezosa(() => import("./verticals/despachos/DespachosShell.tsx"), "DespachosShell");
const DespachosSeguridadPage = cargaPerezosa(() => import("./verticals/despachos/pages/Seguridad.tsx"), "SeguridadPage");
const DespachosCopilotoPage = cargaPerezosa(() => import("./verticals/despachos/pages/Copiloto.tsx"), "DespachosCopilotoPage");
const DespachosDashboardPage = cargaPerezosa(() => import("./verticals/despachos/pages/Dashboard.tsx"), "DashboardPage");
const DespachosReportesPage = cargaPerezosa(() => import("./verticals/despachos/pages/Reportes.tsx"), "ReportesPage");
const CierreMensualPage = cargaPerezosa(() => import("./verticals/despachos/pages/CierreMensual.tsx"), "CierreMensualPage");
const CierreMensualDetallePage = cargaPerezosa(() => import("./verticals/despachos/pages/CierreMensualDetalle.tsx"), "CierreMensualDetallePage");
const CarteraPage = cargaPerezosa(() => import("./verticals/despachos/pages/Cartera.tsx"), "CarteraPage");
const CfdiPage = cargaPerezosa(() => import("./verticals/despachos/pages/Cfdi.tsx"), "CfdiPage");
const CfdiDetallePage = cargaPerezosa(() => import("./verticals/despachos/pages/CfdiDetalle.tsx"), "CfdiDetallePage");
const CobranzaPage = cargaPerezosa(() => import("./verticals/despachos/pages/Cobranza.tsx"), "CobranzaPage");
const ColaCobranzaPage = cargaPerezosa(() => import("./verticals/despachos/pages/ColaCobranza.tsx"), "ColaCobranzaPage");
const VencimientosPage = cargaPerezosa(() => import("./verticals/despachos/pages/Vencimientos.tsx"), "VencimientosPage");
const DeclaracionesPage = cargaPerezosa(() => import("./verticals/despachos/pages/Declaraciones.tsx"), "DeclaracionesPage");
const NominaPage = cargaPerezosa(() => import("./verticals/despachos/pages/Nomina.tsx"), "NominaPage");
const ConciliacionPage = cargaPerezosa(() => import("./verticals/despachos/pages/Conciliacion.tsx"), "ConciliacionPage");
const ImportarEstadoCuentaPage = cargaPerezosa(() => import("./verticals/despachos/pages/ImportarEstadoCuenta.tsx"), "ImportarEstadoCuentaPage");
const MigracionCatalogoPage = cargaPerezosa(() => import("./verticals/despachos/pages/MigracionCatalogo.tsx"), "MigracionCatalogoPage");
const DevolucionIvaPage = cargaPerezosa(() => import("./verticals/despachos/pages/DevolucionIva.tsx"), "DevolucionIvaPage");
const BookkeepingPage = cargaPerezosa(() => import("./verticals/despachos/pages/Bookkeeping.tsx"), "BookkeepingPage");
const ContabilidadElectronicaPage = cargaPerezosa(() => import("./verticals/despachos/pages/ContabilidadElectronica.tsx"), "ContabilidadElectronicaPage");
const LibroContablePage = cargaPerezosa(() => import("./verticals/despachos/pages/LibroContable.tsx"), "LibroContablePage");
const PagosProvisionalesPage = cargaPerezosa(() => import("./verticals/despachos/pages/PagosProvisionales.tsx"), "PagosProvisionalesPage");
const DespachosStaffPage = cargaPerezosa(() => import("./verticals/despachos/pages/Staff.tsx"), "StaffPage");
const DespachosConfiguracionPage = cargaPerezosa(() => import("./verticals/despachos/pages/Configuracion.tsx"), "ConfiguracionPage");
const DespachosPortalClientePage = cargaPerezosa(() => import("./verticals/despachos/pages/PortalCliente.tsx"), "PortalClientePage");
const PortalClientePublicoPage = cargaPerezosa(() => import("./verticals/despachos/portal/PortalClientePage.tsx"), "PortalClientePage");

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
function shellRoute<Ctx>(Shell: ComponentType<ShellRouteProps<Ctx>> | LazyExoticComponent<ComponentType<ShellRouteProps<Ctx>>>, loginPath: string, renderPage: (ctx: Ctx) => ReactNode): () => ReactElement | null {
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
// Captura asistida de SoftRestaurant: cola de comandas que alguien teclea en el POS (owner/admin/staff; el servidor exige MANAGER_ROLES).
const RestaurantesComandasPosRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesComandasPosPage {...ctx} />);
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

/** 404 DENTRO del shell de restaurantes (QA-restaurantes-R1-botones-11): una ruta desconocida bajo `/restaurantes/:orgSlug/` conserva el
 * menu y ofrece volver al resumen (mismo patron que `CitasNoEncontradoRoute`). Los prefijos que no son un negocio
 * (`/restaurantes/login/...`, enlaces de correo) caen al 404 global. */
const RestaurantesNoEncontradoShellRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <VerticalNoEncontrado volverA={`/restaurantes/${ctx.orgSlug}`} volverEtiqueta="Volver al resumen" />);
const PREFIJOS_RESTAURANTES_QUE_NO_SON_NEGOCIO: ReadonlySet<string> = new Set(["login", "restablecer-contrasena", "verificar-correo"]);
function RestaurantesNoEncontradoRoute() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (!orgSlug || PREFIJOS_RESTAURANTES_QUE_NO_SON_NEGOCIO.has(orgSlug)) return <NotFoundPage />;
  return <RestaurantesNoEncontradoShellRoute />;
}
const RestaurantesStaffRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <StaffPage {...ctx} />);

// Fase 11 — hallazgo de auditoría (severidad ALTA, "Promociones/códigos de
// descuento (Fase 11) sin UI"): mismo patrón exacto de ruta que
// RestaurantesStaffRoute de arriba.
const RestaurantesPromocionesRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <PromocionesPage {...ctx} />);

// FASE 3 (producto) — bitácora de auditoría del staff, mismo patrón exacto que
// RestaurantesStaffRoute/RestaurantesPromocionesRoute de arriba.
const RestaurantesAuditoriaRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesAuditoriaPage {...ctx} />);
// FASE 3 (producto) — configuración editable de WhatsApp/zonas conocidas
// (owner/admin), mismo patrón exacto que RestaurantesAuditoriaRoute de arriba.
const RestaurantesConfiguracionRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesConfiguracionPage {...ctx} />);
// Agente de voz (Gemini Live, sin ElevenLabs): config, vista previa y conversaciones.
const RestaurantesAgenteVozRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesAgenteVozPage {...ctx} />);
// Ajustes del agente por organizacion (modelo, temperatura, voz, fondo, conocimiento automatico), owner/admin.
const RestaurantesAjustesAgenteRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesAjustesAgentePage {...ctx} />);
// R-31: indicadores del agente de WhatsApp (owner/admin).
const RestaurantesIndicadoresWhatsappRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesIndicadoresWhatsappPage {...ctx} />);
const RestaurantesCierresRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesCierresPage {...ctx} />);
const RestaurantesCampanasRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesCampanasPage {...ctx} />);
// PM PR-9 -- privacidad (solicitudes ARCO + aviso/retención/grabación), owner/admin.
const RestaurantesPrivacidadRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesPrivacidadPage {...ctx} />);
// PL-13 -- privacidad de la organizacion (ARCO de todos los verticales, retencion, bloqueo de purga, aviso versionado).
const RestaurantesPrivacidadOrganizacionRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <PrivacidadOrganizacionPage apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
// R-21: bandeja de conversaciones con handoff a humano y turnos de personal por sucursal.
const RestaurantesConversacionesRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesConversacionesPage {...ctx} />);
const RestaurantesPrimerosPasosRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesPrimerosPasosPage {...ctx} />);
const RestaurantesTurnosRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesTurnosPage {...ctx} />);
// R-16: avisos del staff (Mis avisos para todos; matriz del equipo y umbral de entrega tardia para owner/admin).
const RestaurantesAvisosRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesAvisosPage {...ctx} />);
// CHAT-08 -- Copiloto ("Pregunta a tus datos"): pagina generica de @atiende/ui conectada al chat-datos real de restaurantes.
const RestaurantesCopilotoRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <RestaurantesCopilotoPage {...ctx} />);

// Demo de WhatsApp (R-19): chat publico contra el agente real, solo para organizaciones marcadas como demo.
function DemoWhatsAppRoute() {
  const { orgSlug = "" } = useParams();
  return <DemoWhatsAppPage apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} />;
}
// H-30 -- privacidad PUBLICA del huesped de hoteles (aviso + ARCO sin login, y "mis datos" con enlace firmado): sin shell de panel.
function HotelesAvisoPublicoRoute() {
  const { orgSlug = "" } = useParams();
  return <AvisoPublicoPage apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} />;
}
function HotelesMisDatosRoute() {
  const { orgSlug = "" } = useParams();
  return <MisDatosPage apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} />;
}
// Pagina PUBLICA de reservas de citas (C-19): sin login ni shell; solo necesita el slug del negocio.
function ReservarCitasRoute() {
  const { orgSlug = "" } = useParams();
  return <ReservarPage apiBaseUrl={API_BASE_URL} orgSlug={orgSlug} />;
}

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

/** Contexto que el layout del back office (`SuperAdminLayoutRoute`) entrega a cada pagina: API, token y datos de la sesion. */
type SuperAdminCtx = Parameters<ComponentProps<typeof SuperAdminShell>["children"]>[0];
function useSuperAdminCtx(): SuperAdminCtx {
  return useOutletContext<SuperAdminCtx>();
}

/** Layout de TODAS las rutas /superadmin/*: el shell (sidebar, barra, banner de impersonacion, dialogo de step-up y el panel Cmd+J del Copiloto) se monta UNA
 * sola vez y las paginas entran por el `Outlet`; navegar no lo desmonta, asi el panel conserva su conversacion (CHAT-17). */
function SuperAdminLayoutRoute() {
  const navigate = useNavigate();
  const alPedirLogin = useCallback(() => navigate("/", { replace: true }), [navigate]);
  return (
    <SuperAdminShell apiBaseUrl={API_BASE_URL} onRequireLogin={alPedirLogin}>
      {(ctx) => (
        <Suspense fallback={<EstadoCargando variante="pantalla" />}>
          <Outlet context={ctx} />
        </Suspense>
      )}
    </SuperAdminShell>
  );
}

/** Back office de plataforma — igual patrón de shell+ruta que cada vertical,
 * pero sin `orgSlug` (el superadmin no está dentro de ninguna organización). */
function SuperAdminRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminConsolaResumenPage {...ctx} />;
}

/** El parte diario (antes en la raíz): ruta propia sin item de menú; el Resumen lo enlaza con "Ver parte diario". */
function SuperAdminParteDiarioRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminResumenPage {...ctx} />;
}

/** SA-L-01: el listado de organizaciones (antes en la raíz /superadmin) vive en su propia ruta; la raíz es el Resumen. */
function SuperAdminOrganizacionesRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminOrganizacionesPage {...ctx} />;
}

/** SA-07: ficha 360 de una organizacion. */
function SuperAdminOrganizacionFichaRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminOrganizacionFichaPage {...ctx} />;
}

function SuperAdminProspectosRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminProspectosPage {...ctx} />;
}

/** SA-L-42: el mapa del Cerebro de ventas (el mundo virtual de la cartera). */
function SuperAdminCerebroMapaRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminCerebroMapaPage {...ctx} />;
}

/** SA-L-43: la ficha de un prospecto del Cerebro. */
function SuperAdminFichaProspectoRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminFichaProspectoPage {...ctx} />;
}

function SuperAdminPanelesRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminPanelesPage {...ctx} />;
}

function SuperAdminConsumoIaRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminConsumoIaPage {...ctx} />;
}

function SuperAdminIntegracionesRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminIntegracionesPage {...ctx} />;
}

function SuperAdminSaludRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminSaludPage {...ctx} />;
}

function SuperAdminCopilotoRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminCopilotoPage apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />;
}

function SuperAdminAccionesRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminAccionesPage {...ctx} />;
}

function SuperAdminSeguridadRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminSeguridadPage {...ctx} />;
}

function SuperAdminInterruptoresRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminInterruptoresPage {...ctx} />;
}

function SuperAdminPrivacidadRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminPrivacidadPage {...ctx} />;
}

function SuperAdminTaxonomiaRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminTaxonomiaPage {...ctx} />;
}

function SuperAdminSupresionRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminSupresionPage {...ctx} />;
}

function SuperAdminAgentesRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminAgentesPage {...ctx} />;
}

function SuperAdminAgenteExtractorRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminAgenteExtractorPage {...ctx} />;
}

function SuperAdminAgenteConciliacionRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminAgenteConciliacionPage {...ctx} />;
}

function SuperAdminAgenteWhatsappRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminAgenteWhatsappPage {...ctx} />;
}

function SuperAdminModelOpsRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminModelOpsPage {...ctx} />;
}

function SuperAdminEjecutivoRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminEjecutivoPage {...ctx} />;
}

function SuperAdminZonaCfoRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminZonaCfoPage {...ctx} />;
}

function SuperAdminCostosFacturacionRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminCostosFacturacionPage {...ctx} />;
}

function SuperAdminPlanesRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminPlanesPage {...ctx} />;
}

function SuperAdminNotificacionesRoute() {
  const ctx = useSuperAdminCtx();
  return <NotificacionesPagina {...ctx} />;
}

// Pagina de notificaciones (campana): una sola pagina compartida, montada en el shell de cada vertical.
const RestaurantesNotificacionesRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <NotificacionesPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const HotelesNotificacionesRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <NotificacionesPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const RentasNotificacionesRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <NotificacionesPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const CitasNotificacionesRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <NotificacionesPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const DespachosNotificacionesRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <NotificacionesPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const LicitacionesNotificacionesRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <NotificacionesPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
// Plan y uso (PL-16): una sola pagina compartida, montada en el shell de cada vertical.
const RestaurantesPlanRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <PlanYUsoPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const HotelesPlanRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <PlanYUsoPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const RentasPlanRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <PlanYUsoPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const CitasPlanRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <PlanYUsoPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const DespachosPlanRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <PlanYUsoPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
const LicitacionesPlanRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <PlanYUsoPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);
// Seguridad de la cuenta (PL-21): pagina compartida (correo, contrasena, Google, sesiones) en el shell de cada vertical.
// Licitaciones y despachos conservan su propia pagina (`LicitacionesSeguridadRoute`, `DespachosSeguridadRoute`), que antepone la verificacion en dos pasos.
const RestaurantesSeguridadRoute = shellRoute(RestaurantesShell, "/restaurantes/login", (ctx) => <SeguridadCuentaPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} orgSlug={ctx.orgSlug} vertical="restaurantes" />);
const HotelesSeguridadRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <SeguridadCuentaPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} orgSlug={ctx.orgSlug} vertical="hoteles" />);
const RentasSeguridadRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <SeguridadCuentaPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} orgSlug={ctx.orgSlug} vertical="rentas" />);
const CitasSeguridadRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <SeguridadCuentaPagina apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} orgSlug={ctx.orgSlug} vertical="citas" />);
const DespachosSeguridadRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosSeguridadPage {...ctx} />);

function SuperAdminBreakGlassRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminBreakGlassPage {...ctx} />;
}

function SuperAdminImpersonacionRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminImpersonacionPage {...ctx} />;
}

function SuperAdminAuthzAuditoriaRoute() {
  const ctx = useSuperAdminCtx();
  return <SuperAdminAuthzAuditoriaPage {...ctx} />;
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
// CHAT-09 -- Copiloto ("Pregunta a tus datos"): pagina generica de @atiende/ui conectada al chat-datos real de hoteles (solo owner/gm).
const HotelesCopilotoRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesCopilotoPage {...ctx} />);
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
// H-04 — housekeeping completo (tablero, tareas, inspección, fuera de servicio, reporte).
const HotelesHousekeepingRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HousekeepingPage {...ctx} />);
// H-29 — canal WhatsApp + agente de voz editables (owner/gm; el servidor responde 403 al resto).
const HotelesMensajeriaRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <MensajeriaPage {...ctx} />);
// H-05 — tickets de huésped con SLA, escalación y bitácora (cualquier rol hotelero; el servidor filtra por rol).
const HotelesTicketsRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <TicketsPage {...ctx} />);
const HotelesAgentesRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <AgentesPage {...ctx} />);
const HotelesAprobacionesRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <AprobacionesAgentesPage {...ctx} />);
const HotelesGruposRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <GruposPage {...ctx} />);
const HotelesRecepcionRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <RecepcionPage {...ctx} />);
const HotelesHuespedesRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HuespedesPage {...ctx} />);
const HotelesHuespedFichaRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HuespedFichaPage {...ctx} />);
const HotelesConversacionesRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesConversacionesPage {...ctx} />);

/** Fase 16 — hallazgo de auditoría (severidad ALTA, "checador de asistencia LFT sin
 * UI"): mismo patrón que HotelesMantenimientoRoute — sin gating de rol aquí (el
 * checador de autoservicio es para TODO staff autenticado; la sección de
 * administración dentro de AsistenciaPage se autogatea por `role`). */
const HotelesAsistenciaRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <AsistenciaPage {...ctx} />);

const HotelesFraudeRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <FraudePage {...ctx} />);
/** H-01 — bóveda de identidad + registro migratorio + purga con doble control (pages/Identidad.tsx). */
const HotelesIdentidadRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <IdentidadPage {...ctx} />);
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

/** Fase 11/13 (REQ-CRM-002/003) — wiring de reputación/CRM (pages/Reputacion.tsx)
 * — mismo patrón que HotelesPlRoute/HotelesFraudeRoute (nav gateada
 * cosméticamente por rol en HotelesShell.tsx, no aquí; un rol sin acceso que
 * navegue directo a esta URL ve el 403 real del servidor como mensaje de error
 * dentro de Reputacion.tsx). */
const HotelesReputacionRoute = shellRoute(HotelesShell, "/hoteles/login", (ctx) => <HotelesReputacionPage {...ctx} />);

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

/** Hilo de una conversación (Rn-P3-20): mensajes del huésped con sus borradores, dentro de Aprobaciones. */
const RentasHiloRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasHiloPage {...ctx} />);

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

/** Monitor de sincronización y conflictos de calendario (Rn-01/Rn-02): estado de cada
 * feed iCal, alertas del sync y conflictos entre canales por resolver. Mismo patrón de
 * ruta hija que RentasIcalSyncRoute. */
const RentasMonitorSyncRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasMonitorSyncPage {...ctx} />);
const RentasReportesRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasReportesPage {...ctx} />);
const RentasAccesoHuespedRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasAccesoHuespedPage {...ctx} />);
const RentasPlantillasRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasPlantillasPage {...ctx} />);
// Rn-07 -- privacidad: solicitudes ARCO de rentas (admin_gestora) y privacidad de la organizacion (PL-13: ARCO de todos los verticales, retencion, aviso versionado).
const RentasPrivacidadRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasPrivacidadPage {...ctx} />);
const RentasPrivacidadOrganizacionRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <PrivacidadOrganizacionPage apiBaseUrl={ctx.apiBaseUrl} token={ctx.token} />);

/** Bitácora de auditoría del staff (r5) — cierra el hueco detectado al diseñar el
 * panel de superadmin: rentas no tenía ninguna pantalla que mostrara qué hizo cada
 * miembro del staff. Mismo patrón de ruta hija que RentasCalendarioRoute/.../
 * RentasIcalSyncRoute; AuditoriaPage gatea su propio contenido por
 * AUDITORIA_LECTURA_ROLES (admin_gestora), igual que FinanzasPage/PreciosPage. */
const RentasAuditoriaRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasAuditoriaPage {...ctx} />);
/** Rn-19 -- catálogo (propiedades, unidades, propietarios) y Rn-20 -- equipo (invitar, rol, baja). */
const RentasCatalogoRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasCatalogoPage {...ctx} />);
// CHAT-10 -- Copiloto ("Pregunta a tus datos") de rentas: pagina generica de @atiende/ui conectada al chat-datos real (admin_gestora/contador).
const RentasCopilotoRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasCopilotoPage {...ctx} />);
const RentasEquipoRoute = shellRoute(RentasShell, "/rentas/login", (ctx) => <RentasEquipoPage {...ctx} />);

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

/** Redirección al abrir `/citas/:orgSlug` a secas — C-05: el Resumen (citas hoy/semana,
 * pendientes, no-shows, clientes nuevos) es ahora la página de entrada, igual que el dashboard
 * de KPIs de otras verticales; la agenda queda a un clic desde el propio Resumen. */
function CitasRootRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/citas/${orgSlug}/resumen`} replace />;
}

const CitasResumenRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasResumenPage {...ctx} />);
// CHAT-13 -- Copiloto ("Pregunta a tus datos") de citas: pagina generica de @atiende/ui conectada al chat-datos real (solo owner/admin).
const CitasCopilotoRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasCopilotoPage {...ctx} />);
// C-06 -- checklist de primeros pasos (owner/admin; la pagina gatea por rol).
const CitasPrimerosPasosRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasPrimerosPasosPage {...ctx} />);

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
const CitasAuditoriaRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasAuditoriaPage {...ctx} />);
// C-16 -- centro de avisos (por confirmar, recordatorios agotados, escalaciones de crisis con seguimiento).
const CitasAvisosRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasAvisosPage {...ctx} />);
const CitasPrivacidadRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasPrivacidadPage {...ctx} />);
const CitasWhatsappMensajesRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasWhatsappMensajesPage {...ctx} />);
// C-11 -- bandeja de conversaciones de WhatsApp con handoff a humano.
const CitasConversacionesRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasConversacionesPage {...ctx} />);
const CitasAgenteWhatsappRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <CitasAgenteWhatsappPage {...ctx} />);

/** 404 DENTRO del shell de citas (PR-4): una ruta desconocida bajo `/citas/:orgSlug/` conserva la navegación y
 * ofrece volver a la agenda. `/citas/login/...` no es un negocio: cae al 404 global. */
const CitasNoEncontradoShellRoute = shellRoute(CitasShell, "/citas/login", (ctx) => <VerticalNoEncontrado volverA={`/citas/${ctx.orgSlug}/agenda`} volverEtiqueta="Volver a la agenda" />);
function CitasNoEncontradoRoute() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  if (orgSlug === "login") return <NotFoundPage />;
  return <CitasNoEncontradoShellRoute />;
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

/** Redirección al abrir `/licitaciones/:orgSlug` a secas — la landing es el
 * Panel (L-03: resumen con métricas reales; desde ahí se llega a convocatorias). */
function LicitacionesRootRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/licitaciones/${orgSlug}/panel`} replace />;
}

/** `/firmantes` abre la pestaña de firmantes de Datos de la empresa (no hay una segunda pantalla que mantener). */
function LicitacionesFirmantesRedirect() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  return <Navigate to={`/licitaciones/${orgSlug}/datos-empresa?tab=firmantes`} replace />;
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
// L-01: verificación en dos pasos + cierre de otras sesiones.
// CHAT-12 -- Copiloto ("Pregunta a tus datos") de licitaciones: pagina generica de @atiende/ui conectada al chat-datos real.
const LicitacionesCopilotoRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesCopilotoPage {...ctx} />);
const LicitacionesPanelRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesPanelPage {...ctx} />);
const LicitacionesFuentesRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <FuentesFrescuraPage {...ctx} />);
const LicitacionesSeguimientoRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <SeguimientoPage {...ctx} />);
const LicitacionesAprobacionesRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <AprobacionesPage {...ctx} />);
const LicitacionesSalaGuerraRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <SalaGuerraPage {...ctx} />);
const LicitacionesSeguridadRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesSeguridadPage {...ctx} />);
// L-05: configuración de WhatsApp (opt-in, temas de aviso, decisión go/no-go por botón).
// L-20: privacidad de la organización (PL-13) también desde la consola de licitaciones. La organización sale del token; un
// rol que no sea owner/admin ve el estado denegado sin llamar a la API (el servidor también responde 403).
const LicitacionesPrivacidadRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) =>
  licitacionesPuedeVerPrivacidad(ctx.role) ? (
    <PrivacidadOrganizacionPage
      apiBaseUrl={ctx.apiBaseUrl}
      token={ctx.token}
      notaVertical="Licitaciones todavía no registra solicitudes ARCO propias ni tiene clases de retención propias (firmantes, bitácora KYC, WhatsApp, documentos de empresa): lo que ves aquí viene de los demás verticales de tu organización."
    />
  ) : (
    <EstadoError mensaje="Solo el owner o un admin de la organización puede administrar la privacidad." />
  ),
);
const LicitacionesWhatsappRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesWhatsappPage {...ctx} />);
// L-08: KYC negativo contra la lista 69-B del SAT (proveedores y competidores).
const LicitacionesKyc69bRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesKyc69bPage {...ctx} />);
// L-P3-17: bitácora de escrituras de la organización (solo owner/admin; el servidor y la RLS lo exigen).
const LicitacionesBitacoraRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesBitacoraPage {...ctx} />);
const LicitacionesDiasInhabilesRoute = shellRoute(LicitacionesShell, "/licitaciones/login", (ctx) => <LicitacionesDiasInhabilesPage {...ctx} />);

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

const DespachosDashboardRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosDashboardPage {...ctx} />);
// CHAT-11 -- Copiloto ("Pregunta a tus datos"): pagina generica de @atiende/ui conectada al chat-datos real de despachos (admin, contador, auditor, readonly).
const DespachosCopilotoRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosCopilotoPage {...ctx} />);
const DespachosReportesRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosReportesPage {...ctx} />);
const DespachosCierreMensualRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CierreMensualPage {...ctx} />);
const DespachosCierreMensualDetalleRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CierreMensualDetallePage {...ctx} />);
const DespachosCarteraRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CarteraPage {...ctx} />);
const DespachosCfdiRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CfdiPage {...ctx} />);
const DespachosCfdiDetalleRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CfdiDetallePage {...ctx} />);
const DespachosCobranzaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <CobranzaPage {...ctx} />);
const DespachosColaCobranzaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <ColaCobranzaPage {...ctx} />);
const DespachosVencimientosRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <VencimientosPage {...ctx} />);
const DespachosDeclaracionesRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DeclaracionesPage {...ctx} />);
const DespachosNominaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <NominaPage {...ctx} />);
const DespachosConciliacionRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <ConciliacionPage {...ctx} />);
const DespachosImportarEstadoCuentaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <ImportarEstadoCuentaPage {...ctx} />);
const DespachosMigracionCatalogoRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <MigracionCatalogoPage {...ctx} />);
const DespachosDevolucionIvaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DevolucionIvaPage {...ctx} />);
const DespachosBookkeepingRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <BookkeepingPage {...ctx} />);
const DespachosContabilidadElectronicaRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <ContabilidadElectronicaPage {...ctx} />);
const DespachosLibroContableRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <LibroContablePage {...ctx} />);
const DespachosPagosProvisionalesRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <PagosProvisionalesPage {...ctx} />);
const DespachosStaffRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosStaffPage {...ctx} />);
const DespachosConfiguracionRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosConfiguracionPage {...ctx} />);
const DespachosPortalClienteRoute = shellRoute(DespachosShell, "/despachos/login", (ctx) => <DespachosPortalClientePage {...ctx} />);

/** R-37: con pantallas perezosas, React Router cambia la URL al instante pero confirma la ruta (contenido, barra superior, h1)
 * cuando baja el chunk. Este marcador invisible refleja la ruta ya confirmada, para que las pruebas E2E esperen a la pantalla
 * asentada en vez de leer el DOM a medio navegar. No pinta nada. */
function RutaConfirmada() {
  const { pathname } = useLocation();
  return <span hidden data-ruta-confirmada={pathname} />;
}

export function App() {
  return (
    <BrowserRouter>
      <RutaConfirmada />
      {/* Hallazgo real (verificado con grep, no supuesto): ningún `<Toaster />`
          estaba montado en toda la app -- cada `toast(...)` (BotonChatDatos,
          los 6 Login.tsx de "Continuar con Google", etc.) empujaba a la cola
          interna de sonner pero nada la pintaba en pantalla. Montado UNA sola
          vez aquí, a nivel raíz, para que TODA notificación de toda vertical
          se vea de verdad. */}
      <Toaster />
      {/* R-37: las pantallas son chunks cargados bajo demanda; mientras baja el chunk de la ruta se pinta el estado de carga estándar. */}
      <ErrorBoundaryRaiz>
      <Suspense fallback={<div data-atiende-carga-ruta><EstadoCargando variante="pantalla" /></div>}>
      <Routes>
        <Route path="/restaurantes/login" element={<RestaurantesLoginRoute />} />
        {/* PL-21: enlaces del correo de restaurantes (restablecer contraseña / verificar correo): públicos, sin shell ni sesión. */}
        <Route path="/restaurantes/restablecer-contrasena" element={<RestablecerContrasenaPage apiBaseUrl={API_BASE_URL} vertical="restaurantes" />} />
        <Route path="/restaurantes/verificar-correo" element={<VerificarCorreoPage apiBaseUrl={API_BASE_URL} vertical="restaurantes" />} />
        <Route path="/restaurantes/:orgSlug" element={<RestaurantesDashboardRoute />} />
        <Route path="/restaurantes/:orgSlug/productos" element={<RestaurantesProductosRoute />} />
        <Route path="/restaurantes/:orgSlug/sucursales" element={<RestaurantesSucursalesRoute />} />
        <Route path="/restaurantes/:orgSlug/pedidos" element={<RestaurantesPedidosRoute />} />
        <Route path="/restaurantes/:orgSlug/comandas-pos" element={<RestaurantesComandasPosRoute />} />
        <Route path="/restaurantes/:orgSlug/historial" element={<RestaurantesHistorialRoute />} />
        <Route path="/restaurantes/:orgSlug/clientes" element={<RestaurantesClientesRoute />} />
        <Route path="/restaurantes/:orgSlug/clientes/:customerId" element={<RestaurantesClienteFichaRoute />} />
        {/* Fase 8 — panel real del rol "repartidor" (ver domain-restaurantes/src/
            roles.ts::REPARTIDOR_ROLES), deliberadamente FUERA del nav de
            RestaurantesShell (ver comentario de cabecera de Repartidor.tsx). */}
        <Route path="/restaurantes/:orgSlug/repartidor" element={<RepartidorPedidosPage />} />
        <Route path="/restaurantes/:orgSlug/staff" element={<RestaurantesStaffRoute />} />
        <Route path="/restaurantes/:orgSlug/promociones" element={<RestaurantesPromocionesRoute />} />
        <Route path="/restaurantes/:orgSlug/auditoria" element={<RestaurantesAuditoriaRoute />} />
        <Route path="/restaurantes/:orgSlug/configuracion" element={<RestaurantesConfiguracionRoute />} />
        <Route path="/restaurantes/:orgSlug/agente-voz" element={<RestaurantesAgenteVozRoute />} />
        <Route path="/restaurantes/:orgSlug/agente-ajustes" element={<RestaurantesAjustesAgenteRoute />} />
        <Route path="/restaurantes/:orgSlug/agente-whatsapp" element={<RestaurantesIndicadoresWhatsappRoute />} />
        <Route path="/restaurantes/:orgSlug/cierres" element={<RestaurantesCierresRoute />} />
        <Route path="/restaurantes/:orgSlug/campanas" element={<RestaurantesCampanasRoute />} />
        <Route path="/restaurantes/:orgSlug/privacidad" element={<RestaurantesPrivacidadRoute />} />
        <Route path="/restaurantes/:orgSlug/privacidad-organizacion" element={<RestaurantesPrivacidadOrganizacionRoute />} />
        <Route path="/restaurantes/:orgSlug/conversaciones" element={<RestaurantesConversacionesRoute />} />
        <Route path="/restaurantes/:orgSlug/turnos" element={<RestaurantesTurnosRoute />} />
        <Route path="/restaurantes/:orgSlug/avisos" element={<RestaurantesAvisosRoute />} />
        <Route path="/restaurantes/:orgSlug/copiloto" element={<RestaurantesCopilotoRoute />} />
        <Route path="/restaurantes/:orgSlug/primeros-pasos" element={<RestaurantesPrimerosPasosRoute />} />
        <Route path="/restaurantes/:orgSlug/notificaciones" element={<RestaurantesNotificacionesRoute />} />
        <Route path="/restaurantes/:orgSlug/plan" element={<RestaurantesPlanRoute />} />
        <Route path="/restaurantes/:orgSlug/seguridad" element={<RestaurantesSeguridadRoute />} />
        <Route path="/restaurantes/:orgSlug/*" element={<RestaurantesNoEncontradoRoute />} />
        {/* Fase 14 — genérica, fuera de cualquier shell/vertical (ver shell/
            AceptarInvitacion.tsx): el invitado todavía no tiene sesión. */}
        <Route path="/aceptar-invitacion" element={<AceptarInvitacionRoute />} />
        <Route path="/terminos" element={<TerminosPage />} />
        <Route path="/privacidad" element={<PrivacidadPage />} />
        <Route path="/demo/:orgSlug" element={<DemoWhatsAppRoute />} />
        <Route path="/reservar/:orgSlug" element={<ReservarCitasRoute />} />
        {/* La tienda en línea (/pedir/*) ya no existe: los pedidos entran por WhatsApp o por llamada. */}
        <Route path="/pedir/*" element={<Navigate to="/" replace />} />
        <Route element={<SuperAdminLayoutRoute />}>
          <Route path="/superadmin" element={<SuperAdminRoute />} />
          <Route path="/superadmin/parte-diario" element={<SuperAdminParteDiarioRoute />} />
          <Route path="/superadmin/cerebro" element={<SuperAdminProspectosRoute />} />
          <Route path="/superadmin/cerebro/taxonomia" element={<SuperAdminTaxonomiaRoute />} />
          <Route path="/superadmin/mapa-prospectos" element={<SuperAdminCerebroMapaRoute />} />
          <Route path="/superadmin/mapa-prospectos/:id" element={<SuperAdminFichaProspectoRoute />} />
          <Route path="/superadmin/paneles" element={<SuperAdminPanelesRoute />} />
          <Route path="/superadmin/consumo-ia" element={<SuperAdminConsumoIaRoute />} />
          <Route path="/superadmin/salud" element={<SuperAdminSaludRoute />} />
          <Route path="/superadmin/organizaciones" element={<SuperAdminOrganizacionesRoute />} />
          <Route path="/superadmin/organizaciones/:id" element={<SuperAdminOrganizacionFichaRoute />} />
          <Route path="/superadmin/acciones" element={<SuperAdminAccionesRoute />} />
          <Route path="/superadmin/seguridad" element={<SuperAdminSeguridadRoute />} />
          <Route path="/superadmin/interruptores" element={<SuperAdminInterruptoresRoute />} />
          <Route path="/superadmin/privacidad" element={<SuperAdminPrivacidadRoute />} />
          <Route path="/superadmin/supresion" element={<SuperAdminSupresionRoute />} />
          <Route path="/superadmin/agentes" element={<SuperAdminAgentesRoute />} />
          <Route path="/superadmin/agente-extractor" element={<SuperAdminAgenteExtractorRoute />} />
          <Route path="/superadmin/agente-conciliacion" element={<SuperAdminAgenteConciliacionRoute />} />
          <Route path="/superadmin/agente-whatsapp" element={<SuperAdminAgenteWhatsappRoute />} />
          <Route path="/superadmin/model-ops" element={<SuperAdminModelOpsRoute />} />
          <Route path="/superadmin/ejecutivo" element={<SuperAdminEjecutivoRoute />} />
          <Route path="/superadmin/zona-cfo" element={<SuperAdminZonaCfoRoute />} />
          <Route path="/superadmin/costos-facturacion" element={<SuperAdminCostosFacturacionRoute />} />
          <Route path="/superadmin/planes" element={<SuperAdminPlanesRoute />} />
          <Route path="/superadmin/notificaciones" element={<SuperAdminNotificacionesRoute />} />
          <Route path="/superadmin/break-glass" element={<SuperAdminBreakGlassRoute />} />
          <Route path="/superadmin/impersonacion" element={<SuperAdminImpersonacionRoute />} />
          <Route path="/superadmin/auditoria-denegaciones" element={<SuperAdminAuthzAuditoriaRoute />} />
          <Route path="/superadmin/integraciones" element={<SuperAdminIntegracionesRoute />} />
          <Route path="/superadmin/copiloto" element={<SuperAdminCopilotoRoute />} />
        </Route>
        {/* Rutas que cambiaron de lugar (SA-L-01): la vieja redirige a la nueva, sin 404. */}
        {Object.entries(REDIRECCIONES_SUPERADMIN).map(([desde, hacia]) => (
          <Route key={desde} path={desde} element={<Navigate to={hacia} replace />} />
        ))}
        <Route path="/:vertical/auth/google/callback" element={<GoogleCallbackRoute />} />
        <Route path="/hoteles/login" element={<HotelesLoginRoute />} />
        {/* PL-21: enlaces del correo de hoteles (restablecer contraseña / verificar correo): públicos, sin shell ni sesión. */}
        <Route path="/hoteles/restablecer-contrasena" element={<RestablecerContrasenaPage apiBaseUrl={API_BASE_URL} vertical="hoteles" />} />
        <Route path="/hoteles/verificar-correo" element={<VerificarCorreoPage apiBaseUrl={API_BASE_URL} vertical="hoteles" />} />
        <Route path="/hoteles/:orgSlug/aviso" element={<HotelesAvisoPublicoRoute />} />
        <Route path="/hoteles/:orgSlug/mis-datos" element={<HotelesMisDatosRoute />} />
        <Route path="/hoteles/:orgSlug" element={<HotelesDashboardRoute />} />
        <Route path="/hoteles/:orgSlug/copiloto" element={<HotelesCopilotoRoute />} />
        <Route path="/hoteles/:orgSlug/reservas" element={<HotelesReservasRoute />} />
        <Route path="/hoteles/:orgSlug/folios/:folioId" element={<HotelesFolioRoute />} />
        <Route path="/hoteles/:orgSlug/folios/:folioId/cfdi" element={<HotelesFolioCfdiRoute />} />
        <Route path="/hoteles/:orgSlug/mantenimiento" element={<HotelesMantenimientoRoute />} />
        <Route path="/hoteles/:orgSlug/housekeeping" element={<HotelesHousekeepingRoute />} />
        <Route path="/hoteles/:orgSlug/mensajeria" element={<HotelesMensajeriaRoute />} />
        <Route path="/hoteles/:orgSlug/tickets" element={<HotelesTicketsRoute />} />
        <Route path="/hoteles/:orgSlug/agentes" element={<HotelesAgentesRoute />} />
        <Route path="/hoteles/:orgSlug/aprobaciones" element={<HotelesAprobacionesRoute />} />
        <Route path="/hoteles/:orgSlug/grupos" element={<HotelesGruposRoute />} />
        <Route path="/hoteles/:orgSlug/recepcion" element={<HotelesRecepcionRoute />} />
        <Route path="/hoteles/:orgSlug/huespedes" element={<HotelesHuespedesRoute />} />
        <Route path="/hoteles/:orgSlug/huespedes/:guestId" element={<HotelesHuespedFichaRoute />} />
        <Route path="/hoteles/:orgSlug/conversaciones" element={<HotelesConversacionesRoute />} />
        <Route path="/hoteles/:orgSlug/asistencia" element={<HotelesAsistenciaRoute />} />
        <Route path="/hoteles/:orgSlug/fraude" element={<HotelesFraudeRoute />} />
        <Route path="/hoteles/:orgSlug/identidad" element={<HotelesIdentidadRoute />} />
        <Route path="/hoteles/:orgSlug/pedidos-fnb" element={<HotelesPedidosFnbRoute />} />
        <Route path="/hoteles/:orgSlug/cfdi" element={<HotelesCfdiListadoRoute />} />
        <Route path="/hoteles/:orgSlug/notificaciones" element={<HotelesNotificacionesRoute />} />
        <Route path="/hoteles/:orgSlug/plan" element={<HotelesPlanRoute />} />
        <Route path="/hoteles/:orgSlug/seguridad" element={<HotelesSeguridadRoute />} />
        <Route path="/hoteles/:orgSlug/pl" element={<HotelesPlRoute />} />
        <Route path="/hoteles/:orgSlug/revenue" element={<HotelesRevenueRoute />} />
        <Route path="/hoteles/:orgSlug/reputacion" element={<HotelesReputacionRoute />} />
        <Route path="/hoteles/:orgSlug/catalogo" element={<HotelesCatalogoRoute />} />
        <Route path="/rentas/login" element={<RentasLoginRoute />} />
        {/* PL-21: enlaces del correo de rentas (restablecer contraseña / verificar correo): públicos, sin shell ni sesión. */}
        <Route path="/rentas/restablecer-contrasena" element={<RestablecerContrasenaPage apiBaseUrl={API_BASE_URL} vertical="rentas" />} />
        <Route path="/rentas/verificar-correo" element={<VerificarCorreoPage apiBaseUrl={API_BASE_URL} vertical="rentas" />} />
        <Route path="/rentas/registro" element={<RentasRegistroRoute />} />
        <Route path="/rentas/:orgSlug" element={<RentasDashboardRoute />} />
        <Route path="/rentas/:orgSlug/calendario" element={<RentasCalendarioRoute />} />
        <Route path="/rentas/:orgSlug/precios" element={<RentasPreciosRoute />} />
        <Route path="/rentas/:orgSlug/aprobaciones" element={<RentasAprobacionesRoute />} />
        <Route path="/rentas/:orgSlug/aprobaciones/:conversacionId" element={<RentasHiloRoute />} />
        <Route path="/rentas/:orgSlug/finanzas" element={<RentasFinanzasRoute />} />
        <Route path="/rentas/:orgSlug/mis-tareas" element={<RentasMisTareasRoute />} />
        <Route path="/rentas/:orgSlug/ical-sync" element={<RentasIcalSyncRoute />} />
        <Route path="/rentas/:orgSlug/monitor-sync" element={<RentasMonitorSyncRoute />} />
        <Route path="/rentas/:orgSlug/reportes" element={<RentasReportesRoute />} />
        <Route path="/rentas/:orgSlug/acceso-huesped" element={<RentasAccesoHuespedRoute />} />
        <Route path="/rentas/:orgSlug/plantillas" element={<RentasPlantillasRoute />} />
        <Route path="/rentas/:orgSlug/privacidad" element={<RentasPrivacidadRoute />} />
        <Route path="/rentas/:orgSlug/privacidad-organizacion" element={<RentasPrivacidadOrganizacionRoute />} />
        <Route path="/rentas/:orgSlug/auditoria" element={<RentasAuditoriaRoute />} />
        <Route path="/rentas/:orgSlug/notificaciones" element={<RentasNotificacionesRoute />} />
        <Route path="/rentas/:orgSlug/plan" element={<RentasPlanRoute />} />
        <Route path="/rentas/:orgSlug/seguridad" element={<RentasSeguridadRoute />} />
        <Route path="/rentas/:orgSlug/catalogo" element={<RentasCatalogoRoute />} />
        <Route path="/rentas/:orgSlug/equipo" element={<RentasEquipoRoute />} />
        <Route path="/rentas/:orgSlug/copiloto" element={<RentasCopilotoRoute />} />
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
        {/* PL-21: enlaces del correo de citas (restablecer contraseña / verificar correo): públicos, sin shell ni sesión. */}
        <Route path="/citas/restablecer-contrasena" element={<RestablecerContrasenaPage apiBaseUrl={API_BASE_URL} vertical="citas" />} />
        <Route path="/citas/verificar-correo" element={<VerificarCorreoPage apiBaseUrl={API_BASE_URL} vertical="citas" />} />
        <Route path="/citas/:orgSlug" element={<CitasRootRedirect />} />
        <Route path="/citas/:orgSlug/resumen" element={<CitasResumenRoute />} />
        <Route path="/citas/:orgSlug/copiloto" element={<CitasCopilotoRoute />} />
        <Route path="/citas/:orgSlug/primeros-pasos" element={<CitasPrimerosPasosRoute />} />
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
        <Route path="/citas/:orgSlug/auditoria" element={<CitasAuditoriaRoute />} />
        <Route path="/citas/:orgSlug/avisos" element={<CitasAvisosRoute />} />
        <Route path="/citas/:orgSlug/notificaciones" element={<CitasNotificacionesRoute />} />
        <Route path="/citas/:orgSlug/plan" element={<CitasPlanRoute />} />
        <Route path="/citas/:orgSlug/seguridad" element={<CitasSeguridadRoute />} />
        <Route path="/citas/:orgSlug/privacidad" element={<CitasPrivacidadRoute />} />
        <Route path="/citas/:orgSlug/mensajes-whatsapp" element={<CitasWhatsappMensajesRoute />} />
        <Route path="/citas/:orgSlug/conversaciones" element={<CitasConversacionesRoute />} />
        <Route path="/citas/:orgSlug/agente-whatsapp" element={<CitasAgenteWhatsappRoute />} />
        <Route path="/citas/:orgSlug/*" element={<CitasNoEncontradoRoute />} />
        <Route path="/licitaciones/login" element={<LicitacionesLoginRoute />} />
        {/* PL-21: enlaces del correo de licitaciones (restablecer contraseña / verificar correo): públicos, sin shell ni sesión. */}
        <Route path="/licitaciones/restablecer-contrasena" element={<RestablecerContrasenaPage apiBaseUrl={API_BASE_URL} vertical="licitaciones" />} />
        <Route path="/licitaciones/verificar-correo" element={<VerificarCorreoPage apiBaseUrl={API_BASE_URL} vertical="licitaciones" />} />
        <Route path="/licitaciones/:orgSlug" element={<LicitacionesRootRedirect />} />
        <Route path="/licitaciones/:orgSlug/convocatorias" element={<LicitacionesConvocatoriasRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId" element={<LicitacionesConvocatoriaDetalleRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/requisitos" element={<LicitacionesRequisitosRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/sala-guerra" element={<LicitacionesSalaGuerraRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/propuesta-tecnica" element={<LicitacionesPropuestaTecnicaRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/cierre" element={<LicitacionesCierreRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/contrato" element={<LicitacionesContratoRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/post-adjudicacion" element={<LicitacionesPostAdjudicacionRoute />} />
        <Route path="/licitaciones/:orgSlug/convocatorias/:tenderId/autopsia" element={<LicitacionesAutopsiaRoute />} />
        <Route path="/licitaciones/:orgSlug/privacidad" element={<LicitacionesPrivacidadRoute />} />
        <Route path="/licitaciones/:orgSlug/radar-renovaciones" element={<LicitacionesRadarRenovacionesRoute />} />
        <Route path="/licitaciones/:orgSlug/perfil-matching" element={<LicitacionesPerfilMatchingRoute />} />
        <Route path="/licitaciones/:orgSlug/datos-empresa" element={<LicitacionesDatosEmpresaRoute />} />
        <Route path="/licitaciones/:orgSlug/staff" element={<LicitacionesStaffRoute />} />
        <Route path="/licitaciones/:orgSlug/bitacora" element={<LicitacionesBitacoraRoute />} />
        <Route path="/licitaciones/:orgSlug/notificaciones" element={<LicitacionesNotificacionesRoute />} />
        <Route path="/licitaciones/:orgSlug/plan" element={<LicitacionesPlanRoute />} />
        <Route path="/licitaciones/:orgSlug/seguridad" element={<LicitacionesSeguridadRoute />} />
        <Route path="/licitaciones/:orgSlug/whatsapp" element={<LicitacionesWhatsappRoute />} />
        <Route path="/licitaciones/:orgSlug/kyc-69b" element={<LicitacionesKyc69bRoute />} />
        <Route path="/licitaciones/:orgSlug/dias-inhabiles" element={<LicitacionesDiasInhabilesRoute />} />
        <Route path="/licitaciones/:orgSlug/panel" element={<LicitacionesPanelRoute />} />
        <Route path="/licitaciones/:orgSlug/copiloto" element={<LicitacionesCopilotoRoute />} />
        <Route path="/licitaciones/:orgSlug/fuentes" element={<LicitacionesFuentesRoute />} />
        <Route path="/licitaciones/:orgSlug/seguimiento" element={<LicitacionesSeguimientoRoute />} />
        <Route path="/licitaciones/:orgSlug/aprobaciones" element={<LicitacionesAprobacionesRoute />} />
        <Route path="/licitaciones/:orgSlug/firmantes" element={<LicitacionesFirmantesRedirect />} />
        <Route path="/despachos/login" element={<DespachosLoginRoute />} />
        {/* PL-21: enlaces del correo de despachos (restablecer contraseña / verificar correo): públicos, sin shell ni sesión. */}
        <Route path="/despachos/restablecer-contrasena" element={<RestablecerContrasenaPage apiBaseUrl={API_BASE_URL} vertical="despachos" />} />
        <Route path="/despachos/verificar-correo" element={<VerificarCorreoPage apiBaseUrl={API_BASE_URL} vertical="despachos" />} />
        <Route path="/despachos/:orgSlug" element={<DespachosRootRedirect />} />
        <Route path="/despachos/:orgSlug/dashboard" element={<DespachosDashboardRoute />} />
        <Route path="/despachos/:orgSlug/copiloto" element={<DespachosCopilotoRoute />} />
        <Route path="/despachos/:orgSlug/notificaciones" element={<DespachosNotificacionesRoute />} />
        <Route path="/despachos/:orgSlug/plan" element={<DespachosPlanRoute />} />
        <Route path="/despachos/:orgSlug/seguridad" element={<DespachosSeguridadRoute />} />
        <Route path="/despachos/:orgSlug/reportes" element={<DespachosReportesRoute />} />
        <Route path="/despachos/:orgSlug/cierre-mensual" element={<DespachosCierreMensualRoute />} />
        <Route path="/despachos/:orgSlug/cierre-mensual/:periodoId" element={<DespachosCierreMensualDetalleRoute />} />
        <Route path="/despachos/:orgSlug/cartera" element={<DespachosCarteraRoute />} />
        <Route path="/despachos/:orgSlug/cfdi" element={<DespachosCfdiRoute />} />
        <Route path="/despachos/:orgSlug/cfdi/:invoiceId" element={<DespachosCfdiDetalleRoute />} />
        <Route path="/despachos/:orgSlug/cobranza" element={<DespachosCobranzaRoute />} />
        <Route path="/despachos/:orgSlug/cola-cobranza" element={<DespachosColaCobranzaRoute />} />
        <Route path="/despachos/:orgSlug/vencimientos" element={<DespachosVencimientosRoute />} />
        <Route path="/despachos/:orgSlug/declaraciones" element={<DespachosDeclaracionesRoute />} />
        <Route path="/despachos/:orgSlug/nomina" element={<DespachosNominaRoute />} />
        <Route path="/despachos/:orgSlug/conciliacion" element={<DespachosConciliacionRoute />} />
        <Route path="/despachos/:orgSlug/conciliacion/importar" element={<DespachosImportarEstadoCuentaRoute />} />
        <Route path="/despachos/:orgSlug/migracion-catalogo" element={<DespachosMigracionCatalogoRoute />} />
        <Route path="/despachos/:orgSlug/devolucion-iva" element={<DespachosDevolucionIvaRoute />} />
        <Route path="/despachos/:orgSlug/bookkeeping" element={<DespachosBookkeepingRoute />} />
        <Route path="/despachos/:orgSlug/libro-contable" element={<DespachosLibroContableRoute />} />
        <Route path="/despachos/:orgSlug/pagos-provisionales" element={<DespachosPagosProvisionalesRoute />} />
        <Route path="/despachos/:orgSlug/contabilidad-electronica" element={<DespachosContabilidadElectronicaRoute />} />
        <Route path="/despachos/:orgSlug/staff" element={<DespachosStaffRoute />} />
        <Route path="/despachos/:orgSlug/configuracion" element={<DespachosConfiguracionRoute />} />
        <Route path="/despachos/:orgSlug/portal-cliente" element={<DespachosPortalClienteRoute />} />
        {/* D-08: portal PUBLICO del cliente final; el token va en el fragmento (#t=...), nunca en la ruta. */}
        <Route path="/portal/cliente" element={<PortalClientePublicoPage apiBaseUrl={API_BASE_URL} />} />
        <Route path="/" element={<SeleccionarVerticalPage />} />
        {/* Cualquier URL sin ruta propia: 404 real en vez de pantalla en blanco. */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      </Suspense>
      </ErrorBoundaryRaiz>
    </BrowserRouter>
  );
}

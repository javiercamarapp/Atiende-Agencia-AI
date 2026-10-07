import type { DemoAgentsDeps } from "./demo-agents/types.ts";
import type {
  AgentRunRepository,
  AuthzAuditRepository,
  CoreRepository,
  CoreStaffRepository,
  StaffSecurityRepository,
  ImpersonationRepository,
  LlmUsageRepository,
  MfaRepository,
  CfoRepository,
  PylRepository,
  CfoZoneRepository,
  ConsolaRepository,
  OrgEquipoRepository,
  OrgFichaRepository,
  FichasAgenteRepository,
  ContratosRepository,
  PlataformaPrivacidadRepository,
  CostosPlanesRepository,
  OrgAdminRepository,
  PlatformSwitchRepository,
  ResumenDiarioRepository,
  SaludRepository,
  SuperadminAccionesRepository,
} from "@atiende/db";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import type { AuditSink } from "@atiende/core-authz";
import type { DataChatDeps } from "./data-chat/deps.ts";
import type { AutopilotoRepository, CierreRepository, ResultadoAlertasVozSistema, ConversacionesRepository, RepartidorPerfilRepository, DemoRepository, HandoffAgentGate, PrivacidadRepository, PuertoNotasDeVoz, RestaurantesRepository, VoiceAgentProvider, VozKpiRepository, VozLlamadaRepository, VozRepository, WhatsAppTurnHandler, WhatsappKpiRepository, AjustesAgenteRepository } from "@atiende/domain-restaurantes";
import type { ComandaOutboxStore, ResolverCodigosPos, ResolverSucursalPos, SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import type { HotelesRepository, GuestTicketRepository, AgentesRepository, GruposRepository, HuespedesRepository, RecepcionRepository, CambioFechasRepository, ListaEsperaRepository, ReservasAgenteRepository, HotelesWhatsAppTurnHandler, HousekeepingRepository, HousekeepingResidualRepository, HousekeepingDiaSistemaRepository, MensajeriaConfigRepository, IdentityRepository, PaymentsPort, PrivacyRepository, PublicPrivacyRepository, GuestDataRepository, ConversacionesRepository as HotelesConversacionesRepository, ConversacionesSistemaPort as HotelesConversacionesSistemaPort } from "@atiende/domain-hoteles";
import type { CfdiPort } from "@atiende/mcp-cfdi";
import type {
  CalComPortConfig,
  CalDavPortConfig,
  CalendarSyncPort as CitasCalendarSyncPort,
  CitasConversationGuard,
  CitasRepository,
  ConversacionesRepository as CitasConversacionesRepository,
  ExchangeAuthorizationCodeInput,
  HandoffAgentGate as CitasHandoffAgentGate,
  ExchangeAuthorizationCodeResult,
  ResolveCalendarPort,
  ResolveCalendarSyncPort,
  WhatsAppTurnHandler as CitasWhatsAppTurnHandler,
} from "@atiende/domain-citas";
import type { AvisosSistemaRepository, DiasInhabilesRepository, Kyc69bRepository, LicitacionesRepository, PostAdjudicacionRepository, SalaGuerraRepository, WhatsAppRepository } from "@atiende/domain-licitaciones";
import type { CarteraRepository, ColaCobranzaRepository, ConciliacionPersistidaRepository, ConsultaCfdiSatPort, CronSatRepository, DespachosRepository, LibroRepository, PagosProvisionalesRepository, PilotoRepository, PortalClienteRepository } from "@atiende/domain-despachos";
import type { Efos69bSource } from "@atiende/worker";
import type {
  BreakGlassAuditRepository,
  BreakGlassRentasDataRepository,
  BreakGlassSessionRepository,
  CalendarSyncPort,
  CanalMensajeria,
  CanalMensajeriaCodigo,
  RentasCalendarSyncRepository,
  RentasAccesoRepository,
  RentasMensajesAutomaticosRepository,
  RentasPrivacidadRepository,
  RentasCatalogoRepository,
  RentasReportesRepository,
  RentasResumenRepository,
  RentasMensajeriaRepository,
  RentasOnboardingRepository,
  RentasOwnerPortalRepository,
  RentasRepository,
} from "@atiende/domain-rentas";
import type { LlmGateway } from "@atiende/agent-core";
import type { WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import type { CustomerLookup, StripeBillingPortalClient, StripeClient } from "@atiende/billing";
import type { ApiEnv } from "./env.ts";
import type { PlatformSwitchGuard } from "./platform-switches.ts";
import type { DespachadorAlertas } from "./alertas/tipos.ts";
import type { SuperadminCopilotoDeps } from "./superadmin-copiloto/deps.ts";
import type { LlmRouteConfig } from "./production/llm-models.ts";

/** Todo lo que las rutas necesitan, inyectado — nunca construido dentro de una ruta.
 * En tests, `coreRepo`/`restaurantesRepo`/`hotelesRepo`/`rentasRepo` son los
 * adaptadores en memoria de @atiende/db/@atiende/domain-restaurantes/
 * @atiende/domain-hoteles/@atiende/domain-rentas; en producción son los adaptadores
 * de Postgres — las rutas no cambian de forma entre ambos.
 *
 * `engine` (@atiende/core-tenancy::TenancyEngine) es lo que `dbSession()` de
 * @atiende/core-auth usa para abrir la sesión de BD por request que
 * `requirePropertyMembership()` necesita para resolver membership en vivo contra
 * `core.membership` — genérico, compartido por cualquier vertical con rutas
 * autenticadas de staff (folios/pedidos-fnb/quotes de hoteles, reservas/cotizaciones/
 * finanzas de rentas). Las rutas de rentas/reservas.ts pasan además ESTE MISMO
 * `TenantDbSession` del request directo a `crearReservaConfirmada`/
 * `modificarFechasReserva`/`cancelarOcupacion` de @atiende/domain-rentas (satisface
 * `EjecutorTransaccional` por structural typing) — en tests, `engine` debe ser un
 * `InMemoryRentasTenancyEngine` (no el `InMemoryTenancyEngine` genérico) para que esas
 * queries crudas resuelvan (ver apps/api/tests/rentas-fixtures.ts).
 *
 * `restaurantesRepo`/`hotelesRepo`/`citasRepo`/`licitacionesRepo`/`despachosRepo`/
 * `rentasRepo`/`rentasOwnerPortalRepo` son FÁBRICAS `(db: TenantDbSession) =>
 * XRepository`, NUNCA un repositorio ya construido — a diferencia de `coreRepo`
 * (login, sesión de sistema `userId: null`, sin ambigüedad, ver
 * production/core-repository.ts), la autorización real de estos puertos depende de
 * RLS por-tenant resuelta en la transacción de Postgres de CADA request
 * (`auth.uid()`/rol vía `core.has_property_access` y equivalentes por vertical). Esa
 * transacción se abre por-request — `dbSession(engine)` la deja en `c.get("db")`
 * (`TenantDbSession`, ver @atiende/core-auth/src/middleware.ts) en rutas de staff
 * autenticado, o cada ruta pública/de sistema abre la suya con
 * `engine.withAppSession({ userId: null }, ...)` (ver rutas de citas/restaurantes
 * sin authMiddleware) — nunca un objeto fijo construido una sola vez al armar
 * `AppDeps`, que fijaría una sola sesión para TODAS las requests y rompería el
 * aislamiento RLS entre tenants (ver production/not-ready.ts para el detalle
 * completo de por qué esto NO puede ser un singleton). Cada ruta HTTP hace
 * `deps.xRepo(c.get("db"))` (o `deps.xRepo(db)` dentro de un `withAppSession`
 * propio) para obtener el repositorio ya ligado a la sesión correcta de ESE
 * request. En producción la fábrica es `(db) => new PostgresXRepository(db)`
 * (ver production/deps.ts); en tests con repos en memoria, `(_db) =>
 * xRepoInstance` — ignora el argumento porque el repo en memoria no tiene ningún
 * concepto de sesión/RLS (ver apps/api/tests/fixtures.ts y fixtures por vertical). */
export interface AppDeps {
  /** Public marketing sandbox: no tenant records or mutation tools. */
  readonly publicDemoAgents?: DemoAgentsDeps;
  readonly env: ApiEnv;
  /** `index.html` del panel para las meta de vista previa de `/pedir/*` (storefront-meta.ts). OPCIONAL: ausente =
   * el embebido en el build o el del CDN; los tests lo inyectan. */
  readonly storefrontIndexHtml?: () => Promise<string | null>;
  readonly coreRepo: CoreRepository;
  /** Fase 10 — invitar/gestionar staff (crear/listar/revocar invitación), ver
   * `@atiende/db::CoreStaffRepository`. A DIFERENCIA de `coreRepo` (objeto fijo,
   * sesión de sistema `userId: null`, correcto para login porque el actor todavía no
   * tiene sesión), esta es una FÁBRICA `(db) => CoreStaffRepository` — MISMO patrón
   * que `restaurantesRepo`/`rentasOwnerPortalRepo` (ver comentario largo más abajo):
   * quien invita YA está autenticado, así que la ruta pasa `c.get("db")` (sesión real
   * por-request, `auth.uid()` = su propio userId) para que la policy RLS de
   * `core.staff_invite` (owner/admin de la organización) sea la autoridad real, no
   * una promesa de la capa TS. `findStaffInviteByTokenHash`/`acceptStaffInvite` (el
   * lado del INVITADO, sin sesión todavía) se quedan en `coreRepo` de arriba, mismo
   * criterio que login. */
  readonly coreStaffRepo: (db: TenantDbSession) => CoreStaffRepository;
  /** L-01/L-02 — segundo factor TOTP/step-up, cambio/reset de contraseña y verificación
   * de correo (`@atiende/db::StaffSecurityRepository`). Objeto fijo: cada método abre SU
   * PROPIA transacción (ver el contrato en `staff-security-repository.ts`), así que el
   * conteo de intentos fallidos sobrevive al 4xx de la ruta y un SQLSTATE de migración
   * pendiente se traduce a `StaffSecurityUnavailableError` sin abortar la sesión del
   * request. OPCIONAL a propósito: ausente (fixtures viejos) = comportamiento previo
   * (sin 2FA); las rutas de 2FA responden 503 "no disponible aún" y las transiciones
   * sensibles del contrato siguen exigiendo solo `DECISION_ROLES`. */
  readonly staffSecurityRepo?: StaffSecurityRepository;
  readonly engine: TenancyEngine;
  readonly restaurantesRepo: (db: TenantDbSession) => RestaurantesRepository;
  /** SoftRestaurant (POS de PM): adaptador hacia el POS. OPCIONAL y sin default de
   * produccion: mientras el distribuidor no entregue la API real, no se inyecta y las
   * rutas usan `SoftRestaurantNoConfiguradoPort` (nunca un folio, y la bandera no se
   * puede prender). Ver packages/domain-restaurantes/src/softrestaurant/README.md. */
  readonly softRestaurantPort?: SoftRestaurantPort;
  /** Fabrica por-request del outbox/bandera de SoftRestaurant. Sin ella se usa
   * `PostgresComandaOutboxStore(db)`; los tests inyectan el store en memoria. */
  readonly softRestaurantStore?: (db: TenantDbSession) => ComandaOutboxStore;
  /** Mapeo producto->codigo del POS y sucursal->T1..T8. Sin el, ningun producto tiene codigo:
   * las comandas van a captura manual (nunca se inventan codigos). */
  readonly softRestaurantMapeo?: { readonly resolverCodigos: ResolverCodigosPos; readonly resolverSucursal: ResolverSucursalPos };
  readonly turnHandler: WhatsAppTurnHandler;
  /** PM-C5: espera real (en ms) entre las dos fases del webhook de WhatsApp cuando el agente tiene `replyDebounceSeconds` > 0. OPCIONAL: sin
   * ella se usa `setTimeout`; los tests inyectan una espera controlada. Con la espera apagada (lo normal) nunca se llama. */
  readonly esperarRafaga?: (ms: number) => Promise<void>;
  /** PM-C5: reloj en ms del webhook de WhatsApp para recortar la espera de rafagas segun lo que ya llevo la funcion. OPCIONAL (por omision `Date.now`); los tests lo inyectan. */
  readonly relojMs?: () => number;
  /** "Chatea con tus datos" (restaurantes piloto). OPCIONAL: si falta, la ruta responde honesta
   * "no disponible" en vez de fingir. En produccion lo arma `buildProductionDataChat` (lector Postgres
   * sobre la sesion RLS del usuario, bitacora en `core.data_chat_query_log`, gateway LLM compartido con
   * su tope mensual por organizacion); los tests inyectan un guion sin red. Ver docs/DATA-CHAT.md. */
  readonly dataChat?: DataChatDeps;
  /** Backend propio de voz de restaurantes (migración 025). OPCIONALES: si faltan, las rutas de
   * voz responden 503 honesto en vez de fingir. En producción `vozRepo` es
   * `(db) => new PostgresVozRepository(db)` y `voiceProvider` el adaptador de Gemini 3.8 Live
   * (emite sesiones solo con `GEMINI_API_KEY`). */
  readonly vozRepo?: (db: TenantDbSession) => VozRepository;
  /** Ajustes del agente por organizacion (migración 055: modelo, temperatura, voz, fondo). OPCIONAL: sin él las rutas responden 503 honesto. En producción es
   * `(db) => new PostgresAjustesAgenteRepository(db)` (degrada con SAVEPOINT a los valores de siempre contra la base sin migrar). */
  readonly ajustesAgenteRepo?: (db: TenantDbSession) => AjustesAgenteRepository;
  /** R-13 (migración 035): KPI de voz, costo y alertas. OPCIONAL: sin él las rutas de KPI responden 503 honesto. En producción es
   * `(db) => new PostgresVozKpiRepository(db)` (cada consulta degrada con SAVEPOINT contra la base sin migrar). */
  readonly vozKpiRepo?: (db: TenantDbSession) => VozKpiRepository;
  /** Evaluacion de las alertas de voz (costo del dia, tasa de error) por el SISTEMA dentro del tick de promover-programados (QA R2 automatizacion-09; migración 076).
   * OPCIONAL: sin él el tick no evalua alertas de voz. En producción es `(db) => evaluarAlertasVozDelSistema(db)` (degrada con SAVEPOINT contra la base sin migrar). */
  readonly vozAlertasSistema?: (db: TenantDbSession) => Promise<ResultadoAlertasVozSistema>;
  /** Worker de telefonia de voz (migración 067): gasto del mes para el tope mensual, modo de entrada, costo por escalón y KPI de desborde/latencia.
   * OPCIONAL: sin él, el contexto de llamada no trae gasto (no bloquea) y las demás rutas responden 503 honesto. En producción es
   * `(db) => new PostgresVozLlamadaRepository(db)` (cada operación degrada con SAVEPOINT contra la base sin migrar). */
  readonly vozLlamadaRepo?: (db: TenantDbSession) => VozLlamadaRepository;
  /** R-31 (migración 040): KPI del agente de WhatsApp por día local. OPCIONAL: sin él la ruta responde 503 honesto. En producción es
   * `(db) => new PostgresWhatsappKpiRepository(db)` (degrada con SAVEPOINT a "no disponible" contra la base sin migrar). */
  readonly whatsappKpiRepo?: (db: TenantDbSession) => WhatsappKpiRepository;
  /** R-42 (migración 041): cierre del día y resumen semanal. OPCIONAL: sin él las rutas responden 503 honesto. En producción es
   * `(db) => new PostgresCierreRepository(db)` (degrada con SAVEPOINT a "no disponible" contra la base sin migrar). */
  readonly cierreRepo?: (db: TenantDbSession) => CierreRepository;
  /** Autopiloto del ciclo del pedido (migración 050): aprobaciones, estados sin clic, regreso del handoff, agotado por hoy. OPCIONAL: sin él las rutas
   * responden 503 honesto y el tick lo omite. En producción es `(db) => new PostgresAutopilotoRepository(db)` (degrada con SAVEPOINT a "no disponible"
   * contra la base sin migrar). */
  readonly autopilotoRepo?: (db: TenantDbSession) => AutopilotoRepository;
  /** R-15 (migración 044): perfil operativo del repartidor. OPCIONAL: sin él las rutas responden 503 honesto. En producción es
   * `(db) => new PostgresRepartidorPerfilRepository(db)` (degrada con SAVEPOINT a "no disponible" contra la base sin migrar). */
  readonly repartidorPerfilRepo?: (db: TenantDbSession) => RepartidorPerfilRepository;
  /** PM PR-9 -- privacidad de restaurantes (ARCO, aviso, retencion; migracion 030). OPCIONAL: ausente =
   * comportamiento anterior (el webhook de WhatsApp no antepone aviso ni atiende ARCO) y las rutas de
   * privacidad responden 503. En produccion es `(db) => new PostgresPrivacidadRepository(db)`. */
  readonly privacidadRepo?: (db: TenantDbSession) => PrivacidadRepository;
  readonly voiceProvider?: VoiceAgentProvider;
  /** R-21 (migración 028): bandeja de conversaciones, handoff a humano, turnos y callbacks. OPCIONALES: sin ellos las
   * rutas responden 503 honesto y el webhook de WhatsApp sigue como antes (el agente responde siempre). */
  readonly conversacionesRepo?: (db: TenantDbSession) => ConversacionesRepository;
  readonly handoffGate?: (db: TenantDbSession) => HandoffAgentGate;
  /** R-19 -- marca de organizacion demo (migracion 037) para el widget publico de chat sin Meta. OPCIONAL: sin ella el
   * widget responde "no disponible" (404) en vez de atender cualquier organizacion. En produccion es
   * `(db) => new PostgresDemoRepository(db)` (degrada con SAVEPOINT a "no es demo" contra la base sin migrar). */
  readonly demoRepo?: (db: TenantDbSession) => DemoRepository;
  readonly hotelesRepo: (db: TenantDbSession) => HotelesRepository;
  /** H-01 -- boveda de identidad de hoteles. OPCIONAL: en produccion no se define y las
   *  rutas usan `PostgresIdentityRepository` (fabrica por-request, RLS real); solo los
   *  tests lo sobreescriben con `InMemoryIdentityRepository`. */
  readonly hotelesIdentidadRepo?: (db: TenantDbSession) => IdentityRepository;
  /** H-04 -- housekeeping completo de hoteles (tareas, tablero, fuera de servicio). OPCIONAL: en
   *  produccion no se define y las rutas usan `PostgresHousekeepingRepository` (RLS real,
   *  SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben con el repo en memoria. */
  readonly hotelesHousekeepingRepo?: (db: TenantDbSession) => HousekeepingRepository;
  /** H-26 -- housekeeping residual (config, fotos de inspeccion, blancos, opt-out; migracion 039). OPCIONAL: en produccion no se define y las
   *  rutas usan `PostgresHousekeepingResidualRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben. */
  readonly hotelesHousekeepingResidualRepo?: (db: TenantDbSession) => HousekeepingResidualRepository;
  /** H-P3-04 -- arranque automatico del dia de housekeeping (cron, sesion de SISTEMA; migracion 045). OPCIONAL: en produccion no se define y el
   *  cron usa `PostgresHousekeepingDiaSistemaRepository` (funciones `hoteles.system_hk_*`, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben. */
  readonly hotelesHousekeepingDiaRepo?: (db: TenantDbSession) => HousekeepingDiaSistemaRepository;
  /** H-29 -- configuracion del canal WhatsApp y del agente de voz desde el panel (migracion 039). OPCIONAL: en produccion no se define y las
   *  rutas usan `PostgresMensajeriaConfigRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben. */
  readonly hotelesMensajeriaConfigRepo?: (db: TenantDbSession) => MensajeriaConfigRepository;
  /** H-05 -- tickets de huesped con SLA (migracion 034). OPCIONAL: en produccion no se define y las rutas usan
   *  `PostgresGuestTicketRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo
   *  sobreescriben con el repo en memoria. */
  readonly hotelesTicketsRepo?: (db: TenantDbSession) => GuestTicketRepository;
  /** H-03 -- catalogo de agentes, guardrails, aprobaciones humanas y plantillas (migracion 035). OPCIONAL: en produccion no se
   *  define y las rutas usan `PostgresAgentesRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo
   *  sobreescriben con el repo en memoria. */
  readonly hotelesAgentesRepo?: (db: TenantDbSession) => AgentesRepository;
  /** H-06 -- grupos: cotizacion, bloqueo de cuartos con cutoff, pickup, rooming y anticipos registrados (migracion 036). OPCIONAL:
   *  en produccion no se define y las rutas usan `PostgresGruposRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los
   *  tests lo sobreescriben con el repo en memoria. */
  readonly hotelesGruposRepo?: (db: TenantDbSession) => GruposRepository;
  /** H-28 -- recepcion (llegadas, salidas, en casa, cambio de habitacion; migracion 038). OPCIONAL: en produccion no se define y las rutas usan
   *  `PostgresRecepcionRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben con el repo en memoria. */
  readonly hotelesRecepcionRepo?: (db: TenantDbSession) => RecepcionRepository;
  /** H-28 -- cambio de fechas con recotizacion (migracion 041). OPCIONAL: en produccion no se define y las rutas usan
   *  `PostgresCambioFechasRepository` (SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben con el repo en memoria. */
  readonly hotelesFechasRepo?: (db: TenantDbSession) => CambioFechasRepository;
  /** H-12 -- lista de espera (migracion 041). OPCIONAL: en produccion no se define y las rutas usan `PostgresListaEsperaRepository`
   *  (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben con el repo en memoria. */
  readonly hotelesListaEsperaRepo?: (db: TenantDbSession) => ListaEsperaRepository;
  /** H-27 -- ficha de huesped (notas, preferencias, historial; migracion 038). OPCIONAL: en produccion no se define y las rutas usan
   *  `PostgresHuespedesRepository` (RLS real, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben con el repo en memoria. */
  readonly hotelesHuespedesRepo?: (db: TenantDbSession) => HuespedesRepository;
  /** H-20 -- bandeja de conversaciones de WhatsApp con handoff a humano (migracion 043). OPCIONAL: en produccion no se define y las rutas usan
   *  `PostgresConversacionesRepository` (funciones security definer, SAVEPOINT contra base sin migrar); solo los tests lo sobreescriben con el repo en memoria. */
  readonly hotelesConversacionesRepo?: (db: TenantDbSession) => HotelesConversacionesRepository;
  /** H-20 -- puerto de SISTEMA del webhook (registrar entrante, derivar a humano + notificacion; migracion 043). OPCIONAL: en produccion no se define y el
   *  webhook usa `PostgresConversacionesSistema`; solo los tests inyectan el espejo en memoria. */
  readonly hotelesConversacionesSistema?: (db: TenantDbSession) => HotelesConversacionesSistemaPort;
  /** H-25 -- agente de reservas (migracion 037): holds, aprobacion, politica. OPCIONAL: en produccion no se define y las rutas (staff y voz) usan
   *  `PostgresReservasAgenteRepository` (RLS real, SAVEPOINT contra base sin migrar); solo las pruebas HTTP inyectan el espejo en memoria. */
  readonly hotelesReservasAgenteRepo?: (db: TenantDbSession) => ReservasAgenteRepository;
  /** H-02 -- privacidad de hoteles (aviso, consentimientos, ARCO, retencion legal, incidentes). OPCIONAL:
   *  en produccion no se define y las rutas usan `PostgresPrivacyRepository` (fabrica por-request, RLS real);
   *  solo los tests lo sobreescriben con `InMemoryPrivacyRepository`. */
  readonly hotelesPrivacidadRepo?: (db: TenantDbSession) => PrivacyRepository;
  /** H-30 -- superficie PUBLICA de privacidad del huesped (aviso, ARCO publico verificado, "mis datos"; migracion 042), sesion de
   *  SISTEMA. OPCIONAL: en produccion no se define y las rutas usan `PostgresPublicPrivacyRepository`; solo los tests inyectan el espejo. */
  readonly hotelesPrivacidadPublicaRepo?: (db: TenantDbSession) => PublicPrivacyRepository;
  /** H-30 -- exportacion de datos del huesped y emision del enlace "mis datos" (staff owner/gm; migracion 042). OPCIONAL, igual que arriba. */
  readonly hotelesGuestDataRepo?: (db: TenantDbSession) => GuestDataRepository;
  /** Integración de cobro (Stripe/Conekta/etc.), NO un repositorio de datos
   * por-tenant — a diferencia de `hotelesRepo`, no depende de RLS por-request (no
   * lee/escribe directamente contra Postgres), así que no es una fábrica: el gap de
   * producción aquí es falta de credenciales/adaptador del procesador real, un
   * problema distinto de la sesión-por-request (ver production/not-ready.ts). */
  readonly hotelesPaymentsPort: PaymentsPort;
  /** Fase 2 hoteles §2/§3 — mismo patrón que `turnHandler` de restaurantes:
   * `acknowledgeOnlyTurnHandler` (sin LLM) o `createLlmHotelesWhatsAppTurnHandler`
   * (LLM real, ver production/deps.ts vs. tests). */
  readonly hotelesTurnHandler: HotelesWhatsAppTurnHandler;
  /** Fase 5 (H5/REQ-BO-001/002) — transporte PAC de CFDI de hospedaje
   * (`@atiende/mcp-cfdi::CfdiPort`, dual-PAC). En producción es
   * `DualPacCfdiPort(FinkokAdapter, SwSapienAdapter)` — ambos esqueletos HONESTOS
   * (fallan explícito sin CSD/credenciales verificadas, nunca fabrican un
   * timbrado); en tests, `DualPacCfdiPort(FakeFinkokAdapter, FakeSwSapienAdapter)`
   * o un fake directo, mismo criterio que `hotelesPaymentsPort`. No es una fábrica
   * por-request (no depende de RLS/sesión de Postgres, es una integración externa
   * igual que `hotelesPaymentsPort`). */
  readonly hotelesCfdiPort: CfdiPort;
  /** Fase 5 (H16-014/REQ-REC-014) — auditoría de decisiones de la cola de revisión
   * de fraude interno (confirmar/descartar una alerta). Reutiliza
   * `@atiende/core-authz::AuditSink`, MISMO patrón que `despachosAuditSink` (ver
   * comentario de ese campo abajo) — no una tabla de auditoría propia de hoteles. */
  readonly hotelesFraudeAuditSink: AuditSink;
  readonly citasRepo: (db: TenantDbSession) => CitasRepository;
  /** C-11 (migracion 031): bandeja de conversaciones de WhatsApp de citas con handoff a humano. OPCIONALES: sin ellos las rutas responden 503 honesto
   * y el webhook de WhatsApp sigue como antes (el agente responde siempre). En produccion son `PostgresConversacionesRepository` /
   * `PostgresHandoffAgentGate` (SAVEPOINT contra la base sin migrar); los tests inyectan el espejo en memoria. */
  readonly citasConversacionesRepo?: (db: TenantDbSession) => CitasConversacionesRepository;
  readonly citasHandoffGate?: (db: TenantDbSession) => CitasHandoffAgentGate;
  /** Fase 2 §2 — turn handler real del agente de WhatsApp de citas (LLM real sobre
   * @atiende/agent-core), inyectado igual que `turnHandler` de restaurantes. */
  readonly citasTurnHandler: CitasWhatsAppTurnHandler;
  /** Fase 2 §2.6-b — lock distribuido + máquina de estados de
   * @atiende/core-conversation que serializa mensajes casi-simultáneos del mismo
   * teléfono (ver whatsapp/inbound.ts de domain-citas). Construible una sola vez
   * por proceso. `createDefaultConversationGuard()` (fix/conversation-lock-upstash)
   * ya elige por sí sola: RedisLockStore si UPSTASH_REDIS_REST_URL/_TOKEN están
   * configuradas (mismas variables que @atiende/core-ratelimit), InMemoryLockStore
   * si no — nunca hace falta pasarle un LockStore distinto a mano solo por esto. */
  readonly citasConversationGuard: CitasConversationGuard;
  /** Fase 3 §4/§5 — resuelve el GoogleCalendarPort real para UN provider_id
   * concreto (o `null` si no puede sincronizar todavía, ver diseño §4/§9).
   * Inyectado (no construido dentro de una ruta) para que producción use
   * `createGoogleCalendarPortResolver(citasRepo, env.googleOAuth)` y las pruebas de
   * apps/api sustituyan el `createPort` real por un `FakeGoogleCalendarPort`
   * compartido, sin reescribir la lógica de resolución/rotación de token. */
  readonly citasGoogleCalendarPortResolver: ResolveCalendarPort;
  /** Fase 6 §2 (seguimiento) — resolver GENÉRICO multi-proveedor
   * (Google/Cal.com/CalDAV, ver @atiende/domain-citas::ResolveCalendarSyncPort/
   * createCalendarSyncPortResolver): el que las rutas de citas usan HOY para el
   * intento inmediato best-effort (`tryTriggerCalendarSync`) y el cron de
   * reconciliación (`syncPendingAppointmentsMultiProvider`) — `citasGoogleCalendarPortResolver`
   * de arriba sigue existiendo SOLO porque `@atiende/domain-citas::tryTriggerGoogleSync`/
   * `syncPendingAppointments` (Fase 3, sin tocar) todavía lo piden en su firma;
   * ningún código de producción en apps/api lo invoca ya directamente. En
   * producción, `createCalendarSyncPortResolver(citasRepo, env.googleOAuth)`
   * (mismo patrón de "singleton de proceso, abre su propia sesión por invocación"
   * que el resolver de Google, ver production/deps.ts). */
  readonly citasCalendarSyncPortResolver: ResolveCalendarSyncPort;
  /** Fase 6 §2 (seguimiento) — construye un `CalendarSyncPort` de Cal.com/CalDAV
   * para UNA cuenta ya resuelta (con sus credenciales/URL ya en mano), usado SOLO
   * por `POST .../{calcom,caldav}/test-connection` (calendar-providers.ts): esa
   * ruta ya sabe de qué plataforma se trata (viene en el path) y ya resolvió la
   * cuenta correcta vía `findProviderCalComAccount`/`findProviderCalDavAccount` —
   * a diferencia de `citasCalendarSyncPortResolver` (que decide POR SÍ SOLO qué
   * plataforma está conectada, con prioridad Google > Cal.com > CalDAV), aquí no
   * hay ambigüedad que resolver, solo un punto de inyección para que las pruebas
   * de apps/api sustituyan `RealCalComPort`/`RealCalDavPort` por un
   * `FakeCalendarSyncPort` sin tocar la red. En producción son
   * `(cfg) => new RealCalComPort(cfg)`/`(cfg) => new RealCalDavPort(cfg)`. */
  readonly citasCalComPortFactory: (cfg: CalComPortConfig) => CitasCalendarSyncPort;
  readonly citasCalDavPortFactory: (cfg: CalDavPortConfig) => CitasCalendarSyncPort;
  /** Fase 3 §4 paso 3 — intercambio real `code -> {access_token, refresh_token}`
   * contra Google, inyectado por el mismo motivo que el resolver de arriba: en
   * producción es `exchangeGoogleAuthorizationCode` real; en pruebas, un doble que
   * nunca toca la red. */
  readonly citasGoogleTokenExchange: (input: ExchangeAuthorizationCodeInput) => Promise<ExchangeAuthorizationCodeResult>;
  /** Hallazgo de auditoría (ALTO, SSRF) — valida la URL de colección CalDAV que un
   * staff pega al conectar un proveedor (routes/verticals/citas/
   * calendar-providers.ts) resolviendo su hostname por DNS y rechazando toda IP
   * privada/loopback/link-local/metadata de nube (ver
   * @atiende/domain-citas::crearValidadorUrlCaldav / net/ssrf.ts) — nunca un
   * chequeo de string sobre el prefijo de la URL. Inyectado por el mismo motivo
   * que `citasGoogleTokenExchange`/`rentasIcalFeedPort`: en producción resuelve
   * DNS real; en pruebas, un resolver fijo que no toca la red ni depende de que
   * un dominio público real siga resolviendo igual mañana. */
  readonly citasCaldavUrlValidator: (url: string) => Promise<{ readonly permitida: boolean; readonly motivo?: string }>;
  readonly licitacionesRepo: (db: TenantDbSession) => LicitacionesRepository;
  /** L-04: sala de guerra + junta de aclaraciones. `production/deps.ts` lo cablea a `PostgresSalaGuerraRepository`; las pruebas de esta pieza inyectan la version en memoria. OPCIONAL a proposito para no tocar cada fixture de AppDeps: si falta, las rutas responden 503 ("no configurado") y el barrido de recordatorios de junta se omite. */
  readonly licitacionesSalaGuerraRepo?: (db: TenantDbSession) => SalaGuerraRepository;
  /** L-05: WhatsApp de licitaciones (contactos, tokens de un solo uso, outbox, bitacora). `production/deps.ts` lo cablea a `PostgresWhatsAppRepository`; OPCIONAL a proposito: si falta, las rutas responden 503, el webhook acusa recibo sin procesar y el despacho se omite. */
  readonly licitacionesWhatsAppRepo?: (db: TenantDbSession) => WhatsAppRepository;
  /** L-08: KYC negativo 69-B (fichas, consulta con bitacora por tenant). `production/deps.ts` lo cablea a `PostgresKyc69bRepository`; OPCIONAL a proposito: si falta, las lecturas responden `available: false` y las escrituras 503. */
  readonly licitacionesKycRepo?: (db: TenantDbSession) => Kyc69bRepository;
  /** L-30/L-32: lecturas/escrituras de SISTEMA de la migracion 034 (re-tamizado de la cartera KYC y conteo de documentos por vencer). `production/deps.ts` lo cablea a `PostgresAvisosSistemaRepository`; OPCIONAL a proposito: si falta, ni el re-tamizado ni el aviso de documentos hacen nada (nunca un error). */
  readonly licitacionesAvisosRepo?: (db: TenantDbSession) => AvisosSistemaRepository;
  /** L-22: dias inhabiles que declara cada organizacion o convocatoria (migracion 032). `production/deps.ts` lo cablea a `PostgresDiasInhabilesRepository`; OPCIONAL a proposito: si falta (o falta la migracion), los plazos se calculan con los dias OFICIALES de plataforma, la lectura responde `available: false` y las escrituras 503. */
  readonly licitacionesDiasInhabilesRepo?: (db: TenantDbSession) => DiasInhabilesRepository;
  /** L-27: garantias, hitos, convenios modificatorios y plazos de la post-adjudicacion (migracion 035). `production/deps.ts` lo cablea a `PostgresPostAdjudicacionRepository`; OPCIONAL a proposito: si falta (o falta la migracion), las lecturas responden `available: false`, las escrituras 503 y el barrido de alertas no emite nada (nunca un 500). */
  readonly licitacionesPostAdjudicacionRepo?: (db: TenantDbSession) => PostAdjudicacionRepository;
  readonly despachosRepo: (db: TenantDbSession) => DespachosRepository;
  /** D-08 -- portal del cliente final (migracion 016). OPCIONAL a proposito (mismo criterio que `rentasAccesoRepo`): las rutas caen a `PostgresPortalClienteRepository` sobre la sesion del request y los tests inyectan el doble en memoria. */
  readonly portalClienteRepo?: (db: TenantDbSession) => PortalClienteRepository;
  /** D-21 -- cartera de clientes (ficha fiscal por property, migracion 018). OPCIONAL a proposito (mismo criterio que `portalClienteRepo`): las rutas caen a `PostgresCarteraRepository` sobre la sesion del request y los tests inyectan el doble en memoria. */
  readonly carteraRepo?: (db: TenantDbSession) => CarteraRepository;
  /** D-24 -- libro contable persistido (migracion 020). OPCIONAL a proposito (mismo criterio que `carteraRepo`): las rutas caen a `PostgresLibroRepository` sobre la sesion del request y los tests inyectan el doble en memoria. */
  readonly libroRepo?: (db: TenantDbSession) => LibroRepository;
  /** D-35 + D-02 -- conciliacion bancaria persistida (sesiones, matches, sugerencias del nivel 4; migracion 021). OPCIONAL a proposito (mismo criterio que `libroRepo`): las rutas caen a `PostgresConciliacionPersistidaRepository` sobre la sesion del request y los tests inyectan el doble en memoria. */
  readonly conciliacionRepo?: (db: TenantDbSession) => ConciliacionPersistidaRepository;
  /** D-25 -- pagos provisionales ISR/IVA (migraciones 018 y 020). OPCIONAL a proposito: las rutas caen a `PostgresPagosProvisionalesRepository`; los tests inyectan el doble en memoria. */
  readonly pagosProvisionalesRepo?: (db: TenantDbSession) => PagosProvisionalesRepository;
  /** D-27 -- consulta publica del estatus de un CFDI ante el SAT (puerto). OPCIONAL a proposito: sin el, las rutas usan el adaptador SOAP real (`ConsultaCfdiSatSoap`); los tests inyectan un doble (jamas se llama al SAT en pruebas). */
  readonly consultaCfdiSat?: ConsultaCfdiSatPort;
  /** D-26/D-27/D-28 -- repositorio de SOLO SISTEMA de los crons de despachos (migracion 022). OPCIONAL a proposito: los crons caen a `PostgresCronSatRepository` sobre la sesion de sistema y los tests inyectan el doble en memoria. */
  readonly cronSatRepo?: (db: TenantDbSession) => CronSatRepository;
  /** paridad3 D-31/D-P3-15/D-P3-21 -- piloto automatico de cierre y entrega al cliente (migracion 027: solicitudes de documentos, estado de modulos, cierre forzado, entrega, portal). OPCIONAL a proposito: las rutas y el cron caen a `PostgresPilotoRepository` sobre la sesion del request/de sistema y los tests inyectan el doble en memoria. */
  readonly pilotoRepo?: (db: TenantDbSession) => PilotoRepository;
  /** D-28 -- fuente de la lista 69-B del SAT para el cron mensual. OPCIONAL a proposito: sin ella el cron usa `HttpEfos69bSource` (URL de `EFOS_69B_URL`); los tests inyectan una fuente fija. */
  readonly efos69bSource?: Efos69bSource;
  /** D-11 -- cola de cobranza (migracion 017: gestiones, consentimiento de WhatsApp y outbox). OPCIONAL a proposito (mismo criterio que `portalClienteRepo`): las rutas caen a `PostgresColaCobranzaRepository` sobre la sesion del request y los tests inyectan el doble en memoria. */
  readonly colaCobranzaRepo?: (db: TenantDbSession) => ColaCobranzaRepository;
  /** Auditoría de acciones de escritura de despachos: completar tarea/cerrar un
   * período de cierre mensual (cierre-mensual.ts) y aprobar/rechazar/editar un
   * mapeo de migración de catálogo (migracion-catalogo.ts). Implementa
   * `@atiende/core-authz::AuditSink` — tipo compartido, pero el adaptador de
   * producción SÍ es una tabla propia de despachos (`despachos.audit_log`, ver
   * `packages/domain-despachos/migrations/008_despachos_audit_log.sql` para por
   * qué se apartó del comentario original de la migración 001 que preveía un
   * `core.authz_audit_log` genérico). A diferencia de los repos de arriba, NO es
   * una fábrica por-request: es una integración transversal que escribe desde la
   * sesión de SISTEMA (`ProductionDespachosAuditSink`, mismo patrón que `coreRepo`
   * — ver `apps/api/src/production/despachos-audit-sink.ts`), nunca depende del
   * gap de sesión-por-request de los repos de dominio de arriba. */
  readonly despachosAuditSink: AuditSink;
  readonly rentasRepo: (db: TenantDbSession) => RentasRepository;
  /** Fase 3 rentas -- portal de propietario (solo lectura), identidad/sesión propias
   * (nunca `core.membership`/`requirePropertyMembership`, ver diseño Fase 3 §1). Puerto
   * separado de `rentasRepo` a propósito: un actor distinto, tablas nuevas
   * (`rentas.owner_credential`), RLS nueva y aditiva -- nunca comparte código de
   * autorización con las rutas de staff. */
  readonly rentasOwnerPortalRepo: (db: TenantDbSession) => RentasOwnerPortalRepository;
  /** Fase 5 -- bookkeeping de sincronización de calendario por canal (feeds iCal
   * externos, versión por UID, anti-eco) -- puerto separado de `rentasRepo` a
   * propósito, mismo criterio que `rentasOwnerPortalRepo`: tablas nuevas
   * (`rentas.canal_feed_externo`/`rentas.evento_canal_importado`/
   * `rentas.bloqueo_exportado`, ver migrations/008_ical_sync_schema.sql), actor
   * distinto (el motor de sync -- ver @atiende/domain-rentas::ejecutarCicloImportacion
   * -- corre tanto desde una sesión de staff como desde el cron interno de sistema). */
  readonly rentasCalendarSyncRepo: (db: TenantDbSession) => RentasCalendarSyncRepository;
  /** Rn-03 -- lectura del reporte de ocupación e ingresos. OPCIONAL a propósito: es solo
   * lectura sobre tablas que ya existen y las rutas caen a `PostgresRentasReportesRepository`
   * sobre la sesión del request cuando no se inyecta (los fixtures de los demás verticales
   * no lo necesitan); los tests de ruta inyectan el doble en memoria. */
  readonly rentasReportesRepo?: (db: TenantDbSession) => RentasReportesRepository;
  /** Rn-26 -- agregados del Resumen operativo de rentas. OPCIONAL por la misma razón que `rentasReportesRepo`: la ruta cae a `PostgresRentasResumenRepository` sobre la sesión del request y los tests inyectan el doble en memoria. */
  readonly rentasResumenRepo?: (db: TenantDbSession) => RentasResumenRepository;
  /** Rn-04 -- liberación de instrucciones de acceso al huésped (migración 025). OPCIONAL por la
   * misma razón que `rentasReportesRepo`: las rutas caen a `PostgresRentasAccesoRepository` y
   * los tests inyectan el doble en memoria. */
  readonly rentasAccesoRepo?: (db: TenantDbSession) => RentasAccesoRepository;
  /** Rn-24 / Rn-25 -- programación de mensajes automáticos por evento y su cron (migración 029). OPCIONAL por la misma razón que `rentasAccesoRepo`: las rutas caen a `PostgresRentasMensajesAutomaticosRepository` y los tests inyectan el doble en memoria. */
  readonly rentasMensajesAutomaticosRepo?: (db: TenantDbSession) => RentasMensajesAutomaticosRepository;
  /** Rn-07 -- solicitudes ARCO propias de rentas (migración 028). OPCIONAL por la misma razón que `rentasAccesoRepo`: la ruta cae a `PostgresRentasPrivacidadRepository` sobre la sesión del request y los tests inyectan el doble en memoria. */
  readonly rentasPrivacidadRepo?: (db: TenantDbSession) => RentasPrivacidadRepository;
  /** Rn-18 / Rn-19 -- reglas de comisión de canal y catálogo (propiedades, unidades, propietarios; migración 027).
   * OPCIONAL por la misma razón que `rentasAccesoRepo`: las rutas caen a `PostgresRentasCatalogoRepository` y los
   * tests inyectan el doble en memoria. */
  readonly rentasCatalogoRepo?: (db: TenantDbSession) => RentasCatalogoRepository;
  /** Fase 5 -- obtiene el contenido de un feed iCal externo (Airbnb/Booking/VRBO/...).
   * A diferencia de `citasGoogleCalendarPortResolver` (por-proveedor, requiere OAuth),
   * este puerto es ÚNICO para toda la plataforma: un feed iCal de canal es una URL
   * pública sin credenciales, así que no hay nada que resolver por tenant -- en
   * producción es `RealIcalFeedPort` real (SSRF-safe), en tests un
   * `FakeIcalFeedPort` compartido. */
  readonly rentasIcalFeedPort: CalendarSyncPort;
  /** Fase 7 -- mensajería con huésped (borrador de IA + aprobación humana obligatoria,
   * ver @atiende/domain-rentas::mensajeria/*, agentes/*). Puerto separado de
   * `rentasRepo` a propósito, mismo criterio que `rentasOwnerPortalRepo`/
   * `rentasCalendarSyncRepo`: tablas nuevas (`rentas.conversacion`/`rentas.mensaje`/
   * `rentas.borrador_mensaje`/`rentas.plantilla_mensaje`, ver
   * migrations/009_rentas_mensajeria_schema.sql), sin depender del repositorio
   * gigante de calendario/pricing/finanzas para leerse/probarse. */
  readonly rentasMensajeriaRepo: (db: TenantDbSession) => RentasMensajeriaRepository;
  /** Hallazgo de auditoría (severidad CRÍTICA, "la mensajería de rentas es un
   * simulador que nunca toca un canal real") -- resuelve el `CanalMensajeria` real
   * para UN código de canal concreto (`airbnb`/`vrbo`/`booking`), inyectado igual que
   * `citasGoogleCalendarPortResolver`/`hotelesCfdiPort`: NUNCA construido inline
   * dentro de una ruta (antes de este cambio, `mensajeria-borradores.ts` hacía `new
   * SimuladorCanalMensajeria(canal)` directo, así que producción "enviaba" con el
   * mismo simulador que las pruebas). En producción resuelve a
   * `CanalMensajeriaPartnerPendiente` -- esqueleto HONESTO (mismo criterio que
   * `hotelesCfdiPort`/`FinkokAdapter`): sin credencial de partner de Airbnb/Vrbo/
   * Booking.com (ninguna está configurada en este monorepo, a diferencia de
   * WhatsApp Graph API), `enviarMensajeAprobado` SIEMPRE lanza
   * `CanalMensajeriaNoConfiguradoError` -- la ruta lo traduce a 503, el borrador se
   * queda en `aprobado`, NUNCA se marca `enviado` sin confirmación real. En tests es
   * `SimuladorCanalMensajeria` (ver apps/api/tests/rentas-fixtures.ts), que sí
   * completa la transición para poder probar el resto del flujo de aprobación sin
   * depender de un canal real. */
  readonly rentasCanalMensajeria: (canal: CanalMensajeriaCodigo) => CanalMensajeria;
  /** Fase 11 -- onboarding self-serve del tenant (alta de organización/primera
   * propiedad/admin desde el producto, ver @atiende/domain-rentas::onboarding/*).
   * Fábrica por-request, mismo criterio que `rentasOwnerPortalRepo`/
   * `rentasCalendarSyncRepo` -- aunque `registrarTenant` corre SIEMPRE sobre
   * `engine.withAppSession({userId: null}, ...)` (nunca hay `auth.uid()` real
   * todavía, ver routes/verticals/rentas/onboarding.ts), se mantiene como fábrica
   * (no un objeto fijo) por consistencia con el resto de puertos de dominio y para
   * que `production/deps.ts` pueda decidir con qué tipo de sesión construirlo el día
   * que el gap de plataforma se resuelva. En producción hoy es
   * `notProductionReady` completo (puerto ENTERO bloqueado, no solo 3 métodos como
   * `rentasOwnerPortalRepo` -- ver production/rentas-onboarding-repository.ts). */
  readonly rentasOnboardingRepo: (db: TenantDbSession) => RentasOnboardingRepository;
  /** Fase 10b -- "romper cristal" (break-glass): abrir/listar/cerrar una ventana de
   * acceso de emergencia (`rentas.break_glass_session`) y auditar cada lectura de
   * tenant que ocurre mientras esa ventana está vigente (`rentas.
   * break_glass_access_log`, inmutable desde `012_break_glass_audit.sql`). 3 fábricas
   * por-request, MISMO criterio que `rentasOwnerPortalRepo`: la sesión con la que
   * `apps/api` las construye debe ser SIEMPRE la del superadmin real
   * (`engine.withAppSession({ userId: callerId })`, ver routes/superadmin-break-
   * glass.ts) -- las 5 funciones `security definer` que estos 3 puertos consumen
   * (`rentas.open_break_glass_session`/`list_break_glass_sessions_for_superadmin`/
   * `close_break_glass_session`/`list_reservas_for_break_glass`, más el INSERT de
   * `break_glass_access_log`) exigen `auth.uid() = p_caller_id` por dentro -- una
   * sesión de sistema siempre sería rechazada con 42501, nunca "0 resultados"
   * silencioso (ver packages/domain-rentas/migrations/018_break_glass_wiring.sql). */
  readonly rentasBreakGlassSessionRepo: (db: TenantDbSession) => BreakGlassSessionRepository;
  readonly rentasBreakGlassAuditRepo: (db: TenantDbSession) => BreakGlassAuditRepository;
  readonly rentasBreakGlassDataRepo: (db: TenantDbSession) => BreakGlassRentasDataRepository;
  /** Impersonación de superadmin con bitácora (Bloque C, ver
   *  packages/db/migrations/0020_superadmin_impersonacion.sql +
   *  routes/superadmin-impersonacion.ts). MISMO criterio que
   *  `rentasBreakGlassSessionRepo` arriba: fábrica por-request, nunca una
   *  instancia fija -- `core.start_impersonation_session`/`end_*`/`get_active_*`
   *  exigen `auth.uid() = p_caller_id`, así que SIEMPRE debe construirse sobre
   *  `engine.withAppSession({ userId: callerId }, ...)`, jamás sobre `coreRepo`
   *  (ese sí es de sesión de sistema). */
  readonly impersonationRepo: (db: TenantDbSession) => ImpersonationRepository;
  /** Sink persistente de `requireAdminAccess` (audit-on-denial de TODA
   *  `/superadmin/*`, ver routes/superadmin.ts) -- pendiente declarado
   *  explícitamente en el PR #162 ("Huecos conocidos": el sink seguía siendo
   *  `InMemoryAuditSink`, por-proceso). Implementa `@atiende/core-authz::AuditSink`
   *  -- tipo compartido, MISMO patrón que `despachosAuditSink`/
   *  `hotelesFraudeAuditSink` (integración transversal desde sesión de
   *  SISTEMA, NO una fábrica por-request): en producción,
   *  `PersistentAuthzAuditSink` (production/authz-audit-sink.ts), que cae a
   *  un `InMemoryAuditSink` interno mientras
   *  `packages/db/migrations/0021_superadmin_authz_audit_log.sql` no esté
   *  aplicada; en tests, un `InMemoryAuditSink` liso -- mismo comportamiento
   *  que ESTE campo reemplaza (antes un `export const` module-level en
   *  superadmin.ts, ahora inyectado para que tests y producción puedan variar
   *  de verdad qué implementación usan). */
  readonly authzAuditSink: AuditSink;
  /** Lectura paginada de `core.authz_audit_log` para el panel de superadmin
   *  (`GET /superadmin/authz-auditoria`, ver routes/superadmin.ts) -- MISMO
   *  criterio que `impersonationRepo`: fábrica por-request, SIEMPRE sobre
   *  `engine.withAppSession({ userId: callerId }, ...)`
   *  (`core.list_authz_audit_log_for_superadmin` exige `auth.uid() = p_caller_id`).
   *  La ESCRITURA (audit-on-denial) no pasa por aquí -- ver `authzAuditSink`
   *  arriba, que abre su PROPIA sesión de sistema. */
  readonly authzAuditRepo: (db: TenantDbSession) => AuthzAuditRepository;
  /** Gateway LLM real compartido (packages/agent-core::LlmGateway), construido por
   * `production/llm-gateway.ts::buildProductionLlmGateway` SOLO SI al menos un
   * proveedor (Anthropic/OpenAI/OpenRouter) tiene API key configurada -- ver ese
   * archivo para el detalle completo. `undefined` explícito cuando ninguna lo está:
   * hoy solo lo usa la ruta de licitaciones `POST .../requirements/extract`
   * (`technicalProposal.ts`) para decidir si suma `LlmRequirementExtractor` junto a
   * `RuleBasedExtractor` -- los turn handlers de WhatsApp (restaurantes/hoteles/
   * citas) NO leen este campo directamente porque necesitan una sesión de Postgres
   * por-request para su propio repo (ver comentario de `turnHandler` arriba); ellos
   * reciben el mismo gateway ya cerrado en el closure que arma `production/deps.ts`. */
  readonly llmGateway: LlmGateway | undefined;
  /** Control de gasto de API de LLM (back office de plataforma, ver
   *  `routes/superadmin-llm-usage.ts`) — objeto FIJO (sesión de sistema),
   *  MISMO patrón que `coreRepo`: las funciones SQL que consume
   *  (`core.list_llm_usage_by_organization_for_superadmin`/etc.) son
   *  `security definer` con `p_caller_id` explícito, nunca dependen de
   *  `auth.uid()`. DISTINTO de `llmGateway` de arriba (ese es el motor de
   *  llamadas real; este es el puerto de lectura/escritura del back office
   *  sobre el gasto YA registrado + los topes configurables) — ambos comparten
   *  la misma fuente de datos en Postgres (`core.llm_usage_daily`/
   *  `core.llm_org_budget`/`core.llm_platform_budget`) pero nunca la misma
   *  instancia de objeto (`llmGateway` corre dentro de agent-core, agnóstico
   *  de Postgres a propósito). */
  readonly llmUsageRepo: LlmUsageRepository;
  /** "Salud operativa" (back office de plataforma, ver
   *  `routes/superadmin-salud.ts` + `salud/with-heartbeat.ts`) — objeto FIJO
   *  (sesión de sistema para `recordCronHeartbeat`, sesión del caller para
   *  las 3 lecturas `*ForSuperadmin`), MISMO patrón EXACTO que
   *  `llmUsageRepo` (ver `packages/db/src/salud-repository.ts` y
   *  `packages/db/migrations/0014_superadmin_salud_operativa.sql`).
   *  `salud/with-heartbeat.ts::withHeartbeat` (aplicado a los 17 handlers
   *  `/internal/*`) es el ÚNICO llamador real de `recordCronHeartbeat`. */
  readonly saludRepo: SaludRepository;
  /** Resumen diario automático (back office de plataforma, ver
   *  `routes/superadmin-resumen.ts` + `routes/internal/resumen-diario.ts` +
   *  `resumen-diario/agregador.ts`) — objeto FIJO, MISMO patrón EXACTO que
   *  `saludRepo` (ver `packages/db/src/resumen-diario-repository.ts` y
   *  `packages/db/migrations/0015_superadmin_resumen_diario.sql`): sesión de
   *  SISTEMA para las 10 lecturas de fuente `*ForSystem` + las 2 escrituras
   *  sobre `core.daily_ops_summary`, sesión del caller para las 2 lecturas
   *  `*ForSuperadmin` que alimentan la pantalla. */
  readonly resumenDiarioRepo: ResumenDiarioRepository;
  /** Acciones sugeridas con confirmación + automatizaciones (back office de
   *  plataforma, ver `routes/superadmin-acciones.ts` +
   *  `routes/internal/superadmin-mantenimiento.ts` +
   *  `superadmin-acciones/*`) — objeto FIJO, MISMO patrón EXACTO que
   *  `saludRepo`/`resumenDiarioRepo` (ver
   *  `packages/db/src/superadmin-acciones-repository.ts` y
   *  `packages/db/migrations/0016_superadmin_acciones.sql`): sesión de
   *  SISTEMA para las dos automatizaciones (`desatascarOutboxColgadosForSystem`/
   *  `marcarProspectosSinMovimientoForSystem`, invocadas SOLO por el cron
   *  `/internal/superadmin/mantenimiento`), sesión del caller para la
   *  máquina de estados del intent y las 4 lecturas `*ForSuperadmin`. */
  readonly accionesRepo: SuperadminAccionesRepository;
  /** Gateway LLM DEDICADO a la escalera `resumen-diario` -- DISTINTO de
   *  `llmGateway` de arriba (ese ata cada llamada a un `organization_id`
   *  real; el resumen diario es un gasto de PLATAFORMA, ver el comentario
   *  largo de `resumen-diario/redaccion.ts` y `production/llm-gateway.ts::
   *  buildResumenDiarioLlmGateway`). `undefined` con el mismo criterio
   *  fail-closed que `llmGateway`: sin ningún proveedor configurado, el
   *  resumen se redacta con la plantilla determinista, nunca finge una
   *  llamada al LLM. */
  readonly resumenDiarioLlmGateway: LlmGateway | undefined;
  /** Copiloto de superadmin (CHAT-16): `POST /superadmin/copiloto` y `GET /superadmin/copiloto/estado`. OPCIONAL: sin el las rutas responden "no
   *  activado". En produccion lo arma `buildProductionSuperadminCopiloto` con un gateway DEDICADO (no el de los tenants); las pruebas inyectan un LLM
   *  guionado y fuentes en memoria. Ver `superadmin-copiloto/deps.ts`. */
  readonly superadminCopiloto?: SuperadminCopilotoDeps;
  /** Dispatcher REAL compartido de WhatsApp saliente (@atiende/whatsapp-gateway) —
   *  drena `messaging_outbox` de las 3 verticales (citas/hoteles/restaurantes) vía
   *  Graph API real, consumido SOLO por `POST /internal/whatsapp/dispatch`
   *  (routes/internal/whatsapp-dispatch.ts). `undefined` cuando
   *  `WHATSAPP_ACCESS_TOKEN` no está configurado (ver `env.whatsappAccessToken`) —
   *  esa ruta responde 503 explícito, nunca finge un envío.
   *
   *  A diferencia de `llmGateway` (que SÍ es `X | undefined` obligatorio en TODOS
   *  los fixtures porque alimenta 3 turn handlers ya cableados en cada uno),
   *  este campo es OPCIONAL (`?:`) a propósito: solo la ruta de dispatch lo lee, así
   *  que ningún fixture existente necesita tocarse para seguir compilando — se
   *  construye únicamente en los tests que ejercitan esa ruta
   *  (apps/api/tests/whatsapp-dispatch.spec.ts) y en producción real
   *  (production/deps.ts, cuando `WHATSAPP_ACCESS_TOKEN` está presente). */
  readonly whatsAppDispatcher?: WhatsAppOutboundDispatcher;
  /** R-32: transcripcion de notas de voz de WhatsApp de restaurantes (descarga de media de Meta + rol `restaurantes:transcripcion` del gateway LLM).
   *  `undefined` sin `WHATSAPP_ACCESS_TOKEN` o sin gateway LLM: el webhook conserva el comportamiento anterior (pedir al cliente que escriba, con el
   *  motivo en un log sin PII). Opcional (`?:`) para no tocar los fixtures existentes. */
  readonly notasDeVoz?: PuertoNotasDeVoz;
  /** Suscripción SaaS propia de Atiende a sus organizaciones clientes (auditoría
   * de 22 rubros, hallazgo P1 #6) -- `@atiende/billing::StripeClient` real
   * (Checkout Sessions per-seat, ver `production/saas-billing-stripe-port.ts`
   * para el adaptador `fetch` sin SDK, mismo patrón que
   * `production/hoteles-payments-port.ts`). `undefined`/`null` cuando
   * `STRIPE_SECRET_KEY` no está configurada -- `POST /billing/checkout`
   * responde 503 explícito, NUNCA finge una URL de checkout. Opcional (`?:`,
   * mismo criterio que `whatsAppDispatcher`) para que ningún fixture existente
   * de las otras 6 verticales tenga que tocarse solo por agregar este campo. */
  readonly saasBillingStripeClient?: StripeClient | null;
  /** Portal de cliente de Stripe (PL-16, `POST /billing/portal`). `undefined`/`null` cuando `STRIPE_SECRET_KEY` no esta configurada:
   *  la ruta responde 503 honesto y `GET /billing/uso` lo reporta como no disponible. */
  readonly saasBillingPortalClient?: StripeBillingPortalClient | null;
  /** Secreto de firma del webhook de Stripe (`whsec_...`, DISTINTO de
   * `env.stripe.secretKey` -- ver el comentario de `ApiEnv.stripe` en env.ts).
   * `undefined`/`null` cuando `STRIPE_WEBHOOK_SECRET` no está configurado --
   * `POST /billing/webhook` responde 503 explícito, NUNCA procesa un evento sin
   * poder verificar su firma. */
  readonly saasBillingWebhookSecret?: string | null;
  /** Adaptador real de `@atiende/billing::CustomerLookup` (consulta el email de
   * un customer de Stripe) -- usado por `verificarTenantDelWebhook` SOLO en el
   * primer checkout de un tenant (caso 2 de `tenant-verification.ts`).
   * `undefined`/`null` = sin credenciales de Stripe configuradas; el webhook
   * sigue funcionando (esa función ya trata "sin datos para cruzar" como
   * "no bloquea", ver su comentario de cabecera), solo pierde ese cruce
   * adicional de defensa en profundidad. */
  readonly saasBillingCustomerLookup?: CustomerLookup | null;
  /** MFA TOTP del superadmin (packages/db/migrations/0025_...sql, ver
   *  routes/superadmin-mfa.ts). Fabrica por sesion: las funciones que reciben el
   *  resultado de la verificacion se llaman en `withAppSession({ userId: null })`
   *  (SOLO sistema); reset/bitacora en la sesion del caller. OPCIONAL (`?:`, mismo
   *  criterio que `whatsAppDispatcher`): ausente -> las rutas responden 503 honesto
   *  y el step-up no se exige (salvo SUPERADMIN_MFA_REQUIRED, que entonces es
   *  fail-closed). */
  readonly mfaRepo?: (db: TenantDbSession) => MfaRepository;
  /** Interruptores de plataforma (routes/superadmin-interruptores.ts). Fabrica por
   *  sesion del caller para set/list; `getBlocked` (sistema) lo usa el guard. */
  readonly platformSwitchRepo?: (db: TenantDbSession) => PlatformSwitchRepository;
  /** Gestion de organizaciones con solicitar -> confirmar (routes/superadmin-organizaciones.ts). */
  readonly orgAdminRepo?: (db: TenantDbSession) => OrgAdminRepository;
  /** Costo por evento por organizacion, margen, tipo de cambio y catalogo de planes
   *  (packages/db/migrations/0028_superadmin_costos_planes.sql, ver
   *  routes/superadmin-costos.ts y routes/superadmin-planes.ts). Fabrica por sesion:
   *  `recordEvent` es SOLO-SISTEMA (`withAppSession({ userId: null })`); lo demas, la
   *  sesion del caller. OPCIONAL: ausente -> las rutas responden `disponible: false`/503. */
  readonly costosPlanesRepo?: (db: TenantDbSession) => CostosPlanesRepository;
  /** Dashboard ejecutivo CFO, foto mensual de ingreso (NRR) y entradas de las alertas CFO
   *  (packages/db/migrations/0030_superadmin_cfo_dashboard.sql, ver routes/superadmin-cfo.ts y
   *  routes/internal/superadmin-alertas-cfo.ts). Fabrica por sesion: lectura del dashboard con la
   *  sesion del caller; el cron usa `withAppSession({ userId: null })` (SOLO sistema). OPCIONAL:
   *  ausente -> `disponible: false` / el cron responde `migracion_pendiente`. */
  readonly cfoRepo?: (db: TenantDbSession) => CfoRepository;
  /** Infraestructura compartida capturada para el P&L por vertical y cliente
   *  (packages/db/migrations/0032_superadmin_pyl_infra.sql, ver routes/superadmin-pyl.ts). Fabrica por
   *  sesion del caller. OPCIONAL: ausente -> el P&L se calcula sin infra ("sin_infra_capturada") y la
   *  captura responde 503. El ingreso y el costo del P&L salen de `cfoRepo`. */
  readonly pylRepo?: (db: TenantDbSession) => PylRepository;
  /** Zona CFO segura (SA-41): rol `finanzas` de solo lectura y bitacora de cada consulta financiera
   *  (packages/db/migrations/0034_superadmin_zona_cfo.sql, ver superadmin-seguridad/zona-cfo.ts y
   *  routes/superadmin-zona-cfo.ts). Fabrica por sesion del caller. OPCIONAL: ausente o migracion sin
   *  aplicar -> sin rol restringido y sin bitacora (el comportamiento anterior, nunca un 500). */
  readonly cfoZoneRepo?: (db: TenantDbSession) => CfoZoneRepository;
  /** Resumen y actividad de agentes de la consola de superadmin (SA-L-05/SA-L-06; ver
   *  packages/db/migrations/0042_superadmin_consola_resumen.sql y routes/superadmin-consola.ts). Fabrica por sesion
   *  del caller; cada fuente corre bajo su propio SAVEPOINT. OPCIONAL: ausente o migracion sin aplicar -> los campos
   *  salen `null` con su razon y `disponible: false` (200), nunca un 500. */
  readonly consolaRepo?: (db: TenantDbSession) => ConsolaRepository;
  /** Tabla de Organizaciones con metricas, Ficha 360 y onboarding medido (SA-L-20/SA-07/SA-18; ver
   *  packages/db/migrations/0049_superadmin_organizaciones_ficha_onboarding.sql y routes/superadmin-organizaciones-ficha.ts). Fabrica por
   *  sesion; cada fuente corre bajo su propio SAVEPOINT. El aviso 'organizacion lista' es SOLO-SISTEMA (cron de mantenimiento, sesion propia).
   *  OPCIONAL: ausente o migracion sin aplicar -> `disponible: false` (200) o campos null con su razon, nunca un 500. */
  readonly orgFichaRepo?: (db: TenantDbSession) => OrgFichaRepository;
  /** Alta del equipo inicial de una organizacion por un superadmin: invitar, reenviar, revocar y leer miembros/invitaciones (SA-L-26 minimo;
   *  ver packages/db/migrations/0053_superadmin_alta_equipo.sql y routes/superadmin-organizaciones-equipo.ts). Fabrica por sesion del caller;
   *  `aceptacionParaSistema` es SOLO-SISTEMA (sesion propia en POST /auth/accept-invite). OPCIONAL: ausente o migracion sin aplicar -> la
   *  lectura responde `disponible: false` y las mutaciones 503 honesto, nunca un 500. */
  readonly orgEquipoRepo?: (db: TenantDbSession) => OrgEquipoRepository;
  /** Fichas de agente y Model Ops de la consola (SA-L-09/SA-L-10; ver packages/db/migrations/0049_superadmin_fichas_agente.sql y
   *  routes/superadmin-agentes-fichas.ts). Fabrica por sesion del caller; cada fuente corre bajo su propio SAVEPOINT. OPCIONAL:
   *  ausente o migracion sin aplicar -> los campos salen `null` con su razon y `disponible: false` (200), nunca un 500. */
  readonly fichasAgenteRepo?: (db: TenantDbSession) => FichasAgenteRepository;
  /** Ruta vigente (defaults + LLM_MODELS_JSON) de un rol del gateway: escalera de modelos y proveedores. Solo lectura, sin secretos.
   *  OPCIONAL: ausente -> Model Ops resuelve contra los defaults del repo. */
  readonly rutaLlmDeRol?: (role: string) => LlmRouteConfig;
  /** Bitacora de corridas de agentes y panel de agentes (SA-L-07/SA-L-08; ver
   *  packages/db/migrations/0044_superadmin_corridas_y_panel_agentes.sql, routes/superadmin-agentes.ts y
   *  agentes/corridas.ts). Fabrica por sesion: la escritura y la purga son SOLO-SISTEMA (una transaccion PROPIA por
   *  llamada, `withAppSession({ userId: null })`); las lecturas, con la sesion del caller. OPCIONAL: ausente o migracion
   *  sin aplicar -> `disponible: false` (200) y la escritura se omite en silencio; withHeartbeat sigue como siempre. */
  readonly agentRunRepo?: (db: TenantDbSession) => AgentRunRepository;
  /** Modelo principal (id de OpenRouter) de un rol del gateway segun la ruta vigente (defaults + LLM_MODELS_JSON).
   *  `null` = el rol no tiene ruta. OPCIONAL: ausente -> el panel resuelve contra los defaults del repo. */
  readonly modeloPrincipalDeRol?: (role: string) => string | null;
  /** Contrato por cliente (SA-43): alta, enmienda inmutable, historial y insumos de la facturacion estimada
   *  (packages/db/migrations/0037_superadmin_contrato_cliente.sql, ver routes/superadmin-contratos.ts). Fabrica por
   *  sesion del caller. OPCIONAL: ausente o migracion sin aplicar -> lecturas `disponible: false`, escrituras 503,
   *  nunca un 500. */
  readonly contratosRepo?: (db: TenantDbSession) => ContratosRepository;
  /** Privacidad de plataforma y por organizacion (PL-13): solicitudes ARCO unificadas, retencion, bloqueo y registro
   *  de purgas y aviso versionado (packages/db/migrations/0036_plataforma_arco_retencion_aviso.sql, ver
   *  routes/superadmin-privacidad.ts, routes/privacidad-org.ts y routes/internal/plataforma-retencion.ts). Fabrica por
   *  sesion: lecturas/escrituras con la sesion del usuario; la purga y su lista de objetivos SOLO con sesion de
   *  sistema (`userId: null`). OPCIONAL: ausente o migracion sin aplicar -> `disponible: false` / 503, nunca un 500. */
  readonly privacidadPlataformaRepo?: (db: TenantDbSession) => PlataformaPrivacidadRepository;
  /** Guard con cache que consultan el gateway LLM (via GatewayKillSwitch) y
   *  `salud/with-heartbeat.ts` antes de correr un cron. Ausente = nada se detiene. */
  readonly platformSwitchGuard?: PlatformSwitchGuard;
  /** Alertas salientes (correo/webhook/Sentry, piso por hora, datos redactados). Ausente = no se
   *  envia nada; `salud/with-heartbeat.ts` y el resumen diario lo usan de forma best-effort. */
  readonly alertas?: DespachadorAlertas;
}

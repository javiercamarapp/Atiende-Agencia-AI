import type { CoreRepository, CoreStaffRepository } from "@atiende/db";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import type { AuditSink } from "@atiende/core-authz";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { HotelesRepository, HotelesWhatsAppTurnHandler, PaymentsPort } from "@atiende/domain-hoteles";
import type { CfdiPort } from "@atiende/mcp-cfdi";
import type { CitasConversationGuard, CitasRepository, ExchangeAuthorizationCodeInput, ExchangeAuthorizationCodeResult, ResolveCalendarPort, WhatsAppTurnHandler as CitasWhatsAppTurnHandler } from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import type { CalendarSyncPort, RentasCalendarSyncRepository, RentasMensajeriaRepository, RentasOnboardingRepository, RentasOwnerPortalRepository, RentasRepository } from "@atiende/domain-rentas";
import type { LlmGateway } from "@atiende/agent-core";
import type { WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import type { ApiEnv } from "./env.ts";

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
  readonly env: ApiEnv;
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
  readonly engine: TenancyEngine;
  readonly restaurantesRepo: (db: TenantDbSession) => RestaurantesRepository;
  readonly turnHandler: WhatsAppTurnHandler;
  readonly hotelesRepo: (db: TenantDbSession) => HotelesRepository;
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
  /** Fase 2 §2 — turn handler real del agente de WhatsApp de citas (LLM real sobre
   * @atiende/agent-core), inyectado igual que `turnHandler` de restaurantes. */
  readonly citasTurnHandler: CitasWhatsAppTurnHandler;
  /** Fase 2 §2.6-b — lock distribuido + máquina de estados de
   * @atiende/core-conversation que serializa mensajes casi-simultáneos del mismo
   * teléfono (ver whatsapp/inbound.ts de domain-citas). Construible una sola vez
   * por proceso; producción real debe pasar un RedisLockStore en vez del
   * InMemoryLockStore por defecto de `createDefaultConversationGuard()`. */
  readonly citasConversationGuard: CitasConversationGuard;
  /** Fase 3 §4/§5 — resuelve el GoogleCalendarPort real para UN provider_id
   * concreto (o `null` si no puede sincronizar todavía, ver diseño §4/§9).
   * Inyectado (no construido dentro de una ruta) para que producción use
   * `createGoogleCalendarPortResolver(citasRepo, env.googleOAuth)` y las pruebas de
   * apps/api sustituyan el `createPort` real por un `FakeGoogleCalendarPort`
   * compartido, sin reescribir la lógica de resolución/rotación de token. */
  readonly citasGoogleCalendarPortResolver: ResolveCalendarPort;
  /** Fase 3 §4 paso 3 — intercambio real `code -> {access_token, refresh_token}`
   * contra Google, inyectado por el mismo motivo que el resolver de arriba: en
   * producción es `exchangeGoogleAuthorizationCode` real; en pruebas, un doble que
   * nunca toca la red. */
  readonly citasGoogleTokenExchange: (input: ExchangeAuthorizationCodeInput) => Promise<ExchangeAuthorizationCodeResult>;
  readonly licitacionesRepo: (db: TenantDbSession) => LicitacionesRepository;
  readonly despachosRepo: (db: TenantDbSession) => DespachosRepository;
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
}

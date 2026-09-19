// buildProductionDeps — ensambla el `AppDeps` real que consume el handler de Vercel
// (`../../api/index.ts` en la raíz del repo). Ver `not-ready.ts` para el detalle
// completo de qué NO es un adaptador de producción todavía y por qué.
// `coreRepo`/`engine` y ahora también
// `restaurantesRepo`/`hotelesRepo`/`citasRepo`/`licitacionesRepo`/`despachosRepo`/
// `rentasRepo`/`rentasOwnerPortalRepo` SÍ son reales de punta a punta contra
// Supabase en cuanto `DATABASE_URL` apunte al proyecto consolidado — estos 7
// últimos como FÁBRICAS `(db) => new PostgresXRepository(db)`, nunca un objeto ya
// construido (ver `../deps.ts` para por qué). `despachosAuditSink` TAMPOCO es ya
// `notProductionReady` — corrige una regresión real de la Ronda 12, ver
// `./despachos-audit-sink.ts` y `packages/domain-despachos/migrations/
// 008_despachos_audit_log.sql`. `hotelesFraudeAuditSink` TAMPOCO — ver
// `./hoteles-fraude-audit-sink.ts` y `packages/domain-hoteles/migrations/
// 017_fraude_audit_log.sql` (mismo patrón, gap propio de hoteles cerrado aparte).
// `hotelesPaymentsPort` TAMPOCO — ver `./hoteles-payments-port.ts`: era el único
// puerto externo de todo el monorepo sin NINGÚN adaptador real (ni siquiera
// gateado por una credencial faltante) — ahora sigue el mismo criterio que
// `resend`/`llmProviders`: real en cuanto `STRIPE_SECRET_KEY` esté configurada,
// `notProductionReady` (503 honesto) mientras no lo esté.
//
// `turnHandler`/`hotelesTurnHandler`/`citasTurnHandler`/`llmGateway`: el
// bloqueante que quedaba (ningún proveedor LLM real registrado, ver
// `./llm-gateway.ts`) ya se resuelve aquí. `buildProductionLlmGateway(env)`
// construye el `LlmGateway` real SOLO SI al menos una API key de proveedor está
// configurada; con gateway real, los 3 turn handlers se construyen con el
// turn-handler factory real de cada dominio (`createLlmWhatsAppTurnHandler`/
// `createLlmHotelesWhatsAppTurnHandler`) alimentado por ese gateway compartido.
// Sin NINGUNA API key configurada, los 3 siguen siendo `notProductionReady`
// explícito — fail-closed, nunca silencioso (mismo criterio que el resto de este
// archivo).
//
// DETALLE que sí importa (por qué no es un simple `createXTurnHandler(repo,
// gateway, opts)` de una vez, como en los tests): `restaurantesRepo`/`hotelesRepo`/
// `citasRepo` son FÁBRICAS por-request (`(db) => new PostgresXRepository(db)`,
// ver comentario de `../deps.ts`) porque cada `TenantDbSession` real es una
// transacción de Postgres abierta y cerrada por UNA sola llamada a
// `engine.withAppSession(...)` (ver `@atiende/db::openManagedPostgres` —
// `pool.connect()` + `begin`/`commit` + `client.release()` por invocación).
// Construir el turn handler UNA sola vez en este archivo con un repo ya baked-in
// dejaría ese repo atado a una transacción ya cerrada desde la primera request —
// exactamente el mismo tipo de gap que ya está documentado para
// `citasGoogleCalendarPortResolver` más abajo. La solución aquí es la misma que
// ese comentario describe: el objeto `WhatsAppTurnHandler`/`HotelesWhatsAppTurnHandler`/
// `CitasWhatsAppTurnHandler` SÍ es un singleton de proceso (mismo tipo que
// `AppDeps` espera, ninguna ruta HTTP cambia), pero su método
// `handleInboundMessage` abre su PROPIA sesión (`engine.withAppSession({userId:
// null}, ...)`) en cada llamada y construye el repo real DENTRO de ese callback
// — misma granularidad "una sesión por operación de negocio" que ya usa la ruta
// del webhook para su propio `repo` de dedupe/lease (ver
// `routes/verticals/{restaurantes,hoteles,citas}/whatsapp.ts`), nunca comparte
// una sesión entre requests.
import type { HotelesWhatsAppTurnHandler, PaymentsPort } from "@atiende/domain-hoteles";
import { PostgresHotelesRepository, createLlmHotelesWhatsAppTurnHandler } from "@atiende/domain-hoteles";
import { DualPacCfdiPort, FinkokAdapter, SwSapienAdapter } from "@atiende/mcp-cfdi";
import type { WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { PostgresRestaurantesRepository, createLlmWhatsAppTurnHandler as createRestaurantesLlmWhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { GoogleOAuthPlatformConfig, ResolveCalendarPort, ResolveCalendarSyncPort, WhatsAppTurnHandler as CitasWhatsAppTurnHandler } from "@atiende/domain-citas";
import {
  PostgresCitasRepository,
  RealCalComPort,
  RealCalDavPort,
  createCalendarSyncPortResolver,
  createDefaultConversationGuard,
  createGoogleCalendarPortResolver,
  createLlmWhatsAppTurnHandler as createCitasLlmWhatsAppTurnHandler,
  crearValidadorUrlCaldav,
  exchangeGoogleAuthorizationCode,
} from "@atiende/domain-citas";
import { PostgresLicitacionesRepository } from "@atiende/domain-licitaciones";
import { PostgresDespachosRepository } from "@atiende/domain-despachos";
import {
  CanalMensajeriaPartnerPendiente,
  PostgresBreakGlassAuditRepository,
  PostgresBreakGlassRentasDataRepository,
  PostgresBreakGlassSessionRepository,
  PostgresRentasRepository,
  PostgresRentasCalendarSyncRepository,
  PostgresRentasMensajeriaRepository,
  RealIcalFeedPort,
} from "@atiende/domain-rentas";
import { openManagedPostgres, PostgresCoreRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { MetaGraphWhatsAppClient, WhatsAppOutboundDispatcher } from "@atiende/whatsapp-gateway";
import { loadApiEnv } from "../env.ts";
import type { AppDeps } from "../deps.ts";
import { ProductionCoreRepository } from "./core-repository.ts";
import { ProductionRentasOwnerPortalRepository } from "./rentas-owner-portal-repository.ts";
import { createProductionRentasOnboardingRepo } from "./rentas-onboarding-repository.ts";
import { ProductionDespachosAuditSink } from "./despachos-audit-sink.ts";
import { ProductionHotelesFraudeAuditSink } from "./hoteles-fraude-audit-sink.ts";
import { ProductionCfdiFolioReservationStore } from "./cfdi-folio-reservation-store.ts";
import { ProductionLlmUsageRepository } from "./llm-usage-repository.ts";
import { ProductionSaludRepository } from "./salud-repository.ts";
import { ProductionResumenDiarioRepository } from "./resumen-diario-repository.ts";
import { StripeHotelesPaymentsPort } from "./hoteles-payments-port.ts";
import { StripeSaasBillingCheckoutPort, StripeSaasBillingCustomerLookup } from "./saas-billing-stripe-port.ts";
import { notProductionReady } from "./not-ready.ts";
import {
  buildProductionLlmGateway,
  buildResumenDiarioLlmGateway,
  CITAS_WHATSAPP_AGENT_ESCALATED_ROLE,
  CITAS_WHATSAPP_AGENT_ROLE,
  HOTELES_WHATSAPP_AGENT_ESCALATED_ROLE,
  HOTELES_WHATSAPP_AGENT_ROLE,
  RESTAURANTES_WHATSAPP_AGENT_ESCALATED_ROLE,
  RESTAURANTES_WHATSAPP_AGENT_ROLE,
} from "./llm-gateway.ts";

/**
 * `turnHandler`/`hotelesTurnHandler`/`citasTurnHandler` reales: cada llamada a
 * `handleInboundMessage` abre su propia `TenantDbSession` de sistema
 * (`userId: null`, mismo criterio que las rutas de webhook que los invocan) y
 * construye el repo real de Postgres DENTRO de ese callback — ver comentario de
 * cabecera de este archivo para por qué no puede ser un repo baked-in de una
 * sola vez.
 */
function buildRealRestaurantesTurnHandler(engine: TenancyEngine, gateway: NonNullable<AppDeps["llmGateway"]>): WhatsAppTurnHandler {
  return {
    handleInboundMessage: (args) =>
      engine.withAppSession({ userId: null }, (db) =>
        createRestaurantesLlmWhatsAppTurnHandler(new PostgresRestaurantesRepository(db), gateway, {
          defaultRole: RESTAURANTES_WHATSAPP_AGENT_ROLE,
          escalatedRole: RESTAURANTES_WHATSAPP_AGENT_ESCALATED_ROLE,
        }).handleInboundMessage(args),
      ),
  };
}

function buildRealHotelesTurnHandler(engine: TenancyEngine, gateway: NonNullable<AppDeps["llmGateway"]>): HotelesWhatsAppTurnHandler {
  return {
    handleInboundMessage: (args) =>
      engine.withAppSession({ userId: null }, (db) =>
        createLlmHotelesWhatsAppTurnHandler(new PostgresHotelesRepository(db), gateway, {
          defaultRole: HOTELES_WHATSAPP_AGENT_ROLE,
          escalatedRole: HOTELES_WHATSAPP_AGENT_ESCALATED_ROLE,
        }).handleInboundMessage(args),
      ),
  };
}

function buildRealCitasTurnHandler(engine: TenancyEngine, gateway: NonNullable<AppDeps["llmGateway"]>): CitasWhatsAppTurnHandler {
  return {
    handleInboundMessage: (args) =>
      engine.withAppSession({ userId: null }, (db) =>
        createCitasLlmWhatsAppTurnHandler(new PostgresCitasRepository(db), gateway, {
          defaultRole: CITAS_WHATSAPP_AGENT_ROLE,
          escalatedRole: CITAS_WHATSAPP_AGENT_ESCALATED_ROLE,
        }).handleInboundMessage(args),
      ),
  };
}

/**
 * Hallazgo de auditoría (ALTO, "El puerto de Google Calendar sigue
 * notProductionReady (muerto)"): ANTES de este cambio, `citasGoogleCalendarPortResolver`
 * se construía con `createGoogleCalendarPortResolver(citasRepoForCalendarResolver,
 * env.googleOAuth)` donde `citasRepoForCalendarResolver` era un
 * `notProductionReady<CitasRepository>` FIJO -- así que, incluso el día en que
 * alguien configure GOOGLE_CLIENT_ID/SECRET/OAUTH_REDIRECT_BASE_URL reales, la
 * PRIMERA llamada real a `repo.findProviderCalendarAccount(...)` dentro del
 * resolver (google-calendar-factory.ts) habría lanzado "sin adaptador de
 * producción todavía" -- el puerto quedaba estructuralmente MUERTO, sin ninguna
 * combinación de variables de entorno capaz de activarlo. Mismo patrón EXACTO que
 * `buildRealCitasTurnHandler` de arriba (el mismo gap de "sesión por-request", ya
 * resuelto ahí): el resolver es un singleton de PROCESO (`ResolveCalendarPort`,
 * sin parámetro de sesión), pero cada invocación abre su PROPIA sesión de sistema
 * (`engine.withAppSession({userId: null}, ...)`, nunca `service_role` -- este
 * monorepo no lo aprovisiona) y construye el repo real DENTRO de ese callback.
 *
 * Sin `GOOGLE_CLIENT_ID/SECRET/OAUTH_REDIRECT_BASE_URL` configuradas en este
 * entorno (`env.googleOAuth === null`, el estado real de desarrollo hoy) el
 * resolver sigue devolviendo `null` de inmediato -- exactamente "sin conectar",
 * NUNCA un error, NUNCA un 500 silencioso (`calendar-sync.ts::syncOneAppointmentRow`
 * ya trata cualquier `null` como skip permanente) -- se evita abrir una sesión de
 * Postgres cuando ni siquiera hay credenciales de plataforma que resolver. Con
 * credenciales reales configuradas, la resolución (`findProviderCalendarAccount`/
 * `resolveProviderCalendarRefreshToken`/`rotateProviderCalendarRefreshToken`) SÍ
 * corre contra un `PostgresCitasRepository` real -- el puerto completo (contrato +
 * dos adaptadores + `RealGoogleCalendarPort` sobre `fetch`, ver
 * google-calendar-port.ts) queda de punta a punta funcional, no solo "menos roto".
 */
function buildRealGoogleCalendarPortResolver(engine: TenancyEngine, config: GoogleOAuthPlatformConfig | null): ResolveCalendarPort {
  if (!config) return async () => null; // credenciales de plataforma pendientes -- ver env.ts::googleOAuth
  return (providerId) => engine.withAppSession({ userId: null }, (db) => createGoogleCalendarPortResolver(new PostgresCitasRepository(db), config)(providerId));
}

/**
 * Fase 6 §2 (seguimiento) — mismo patrón EXACTO que `buildRealGoogleCalendarPortResolver`
 * de arriba (singleton de proceso, `ResolveCalendarSyncPort` sin parámetro de
 * sesión, cada invocación abre su PROPIA sesión de sistema), pero generalizado a
 * las tres plataformas vía `createCalendarSyncPortResolver`
 * (@atiende/domain-citas::calendar-sync-resolver-factory.ts). Sin
 * `GOOGLE_CLIENT_ID/SECRET` configuradas, Google simplemente nunca resuelve
 * (`createCalendarSyncPortResolver` ya lo trata como "sin conectar" internamente,
 * ver ese archivo) -- Cal.com/CalDAV SÍ funcionan igual con `config: null`, porque
 * sus credenciales son del TENANT, nunca de la plataforma.
 */
function buildRealCalendarSyncPortResolver(engine: TenancyEngine, config: GoogleOAuthPlatformConfig | null): ResolveCalendarSyncPort {
  return (providerId) => engine.withAppSession({ userId: null }, (db) => createCalendarSyncPortResolver(new PostgresCitasRepository(db), config)(providerId));
}

let cached: AppDeps | undefined;

/**
 * Reutiliza el `AppDeps` (y su `pg.Pool` subyacente) entre invocaciones de la MISMA
 * instancia de función serverless — Vercel puede reciclar el contenedor entre
 * requests ("warm start"); abrir un pool nuevo por invocación agotaría las conexiones
 * disponibles del Postgres gestionado bajo tráfico real. Cada request sigue abriendo
 * su propia transacción vía `engine.withAppSession(...)` — nada de estado se comparte
 * entre requests, solo el pool de conexiones TCP.
 */
export function buildProductionDeps(): AppDeps {
  if (cached) return cached;

  const env = loadApiEnv();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "Falta la variable de entorno DATABASE_URL (cadena de conexión de Supabase — " +
        "Project Settings → Database → Connection string, usa el pooler de transacción " +
        "para serverless). Sin ella no hay motor de Postgres que abrir.",
    );
  }

  const engine = openManagedPostgres({ connectionString: databaseUrl });

  // Gateway LLM real — `undefined` si NINGÚN proveedor (Anthropic/OpenAI/
  // OpenRouter) tiene API key configurada, ver ./llm-gateway.ts. Se construye UNA
  // sola vez aquí (esta función entera ya está cacheada en `cached` de arriba) y
  // se comparte entre los 3 turn handlers de WhatsApp y (vía `AppDeps.llmGateway`)
  // la ruta de extracción de requisitos de licitaciones.
  const llmGateway = buildProductionLlmGateway(env, engine);

  // Gateway LLM DEDICADO al resumen diario -- SEPARADO del gateway de arriba
  // a propósito (nunca ata la narrativa del resumen a un `organization_id`
  // real, ver el comentario largo de `../resumen-diario/redaccion.ts` y
  // `./llm-gateway.ts::buildResumenDiarioLlmGateway`). Mismo criterio
  // fail-closed: `undefined` sin ningún proveedor configurado.
  const resumenDiarioLlmGateway = buildResumenDiarioLlmGateway(env);

  // Dispatcher real de WhatsApp saliente — `undefined` si `WHATSAPP_ACCESS_TOKEN` no
  // está configurado (ver env.ts), mismo criterio fail-closed que `llmGateway`
  // arriba: la ruta que lo consume (routes/internal/whatsapp-dispatch.ts) responde
  // 503 explícito en vez de fingir un envío. Ningún token real de Meta se usa en
  // tests/CI — este constructor solo corre en producción real.
  const whatsAppDispatcher = env.whatsappAccessToken ? new WhatsAppOutboundDispatcher({ graphClient: new MetaGraphWhatsAppClient({ accessToken: env.whatsappAccessToken }) }) : undefined;

  cached = {
    env,
    engine,
    coreRepo: new ProductionCoreRepository(engine),
    // Fase 10 — a diferencia de `coreRepo` (sesión de sistema, sin `auth.uid()`),
    // esta SÍ es la fábrica por-request real (`(db) => new
    // PostgresCoreRepository(db)`, mismo patrón que `restaurantesRepo` etc. abajo):
    // el `db` que le pasa cada ruta es la sesión ya abierta por `dbSession(engine)`
    // con `auth.uid()` = el staff autenticado que invita, para que la policy RLS de
    // `core.staff_invite` (owner/admin de la organización) sea la autoridad real.
    coreStaffRepo: (db) => new PostgresCoreRepository(db),
    restaurantesRepo: (db) => new PostgresRestaurantesRepository(db),
    turnHandler: llmGateway ? buildRealRestaurantesTurnHandler(engine, llmGateway) : notProductionReady<WhatsAppTurnHandler>("turnHandler (falta configurar ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY)"),
    hotelesRepo: (db) => new PostgresHotelesRepository(db),
    hotelesPaymentsPort: env.stripe.secretKey
      ? new StripeHotelesPaymentsPort(fetch, { secretKey: env.stripe.secretKey })
      : notProductionReady<PaymentsPort>("hotelesPaymentsPort (falta configurar STRIPE_SECRET_KEY)"),
    hotelesTurnHandler: llmGateway ? buildRealHotelesTurnHandler(engine, llmGateway) : notProductionReady<HotelesWhatsAppTurnHandler>("hotelesTurnHandler (falta configurar ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY)"),
    // Fase 5 (H5/REQ-BO-001/002) — Fix hallazgo auditoría (este comentario ANTES
    // afirmaba incorrectamente que "SÍ se conecta un CfdiPort real de punta a
    // punta"; es falso en este monorepo, se corrige aquí). `FinkokAdapter`/
    // `SwSapienAdapter` son esqueletos HONESTOS -- código de integración real
    // documentado (rutas SOAP/REST, forma del payload) pero SIN CSD/credenciales
    // reales de Finkok/SW Sapien configuradas en este entorno (no hay cuenta de
    // ningún PAC dada de alta): `timbrar`/`cancelar`/`consultarEstado` lanzan
    // `PortUnavailableError` de forma INCONDICIONAL, nunca fabrican un timbrado
    // falso. En otras palabras: NO hay ningún `CfdiPort` real de punta a punta
    // conectado hoy -- timbrar/cancelar un CFDI de hospedaje real de un hotel es
    // imposible en este ambiente hasta que alguien configure las variables de
    // entorno de credenciales/CSD de un PAC real (ver @atiende/mcp-cfdi/README.md).
    // No hace falta `notProductionReady` aquí porque el propio adaptador ya es
    // honesto sobre su disponibilidad vía `status()`, Y (fix de este mismo
    // hallazgo) `apps/api/.../hoteles/cfdi.ts` ahora traduce ese
    // `PortUnavailableError`/`AggregateError` a un 503 `service_unavailable`
    // explícito en vez de dejar que `app.onError` lo aplane a un 500 genérico.
    //
    // Fix hallazgo auditoría (rubro 6, ALTA) — `DualPacCfdiPort` ya NO usa un `Map`
    // de proceso para su idempotencia por folio (TOCTOU real: doble timbrado
    // fiscal si dos requests concurrentes tocan el mismo folio, agravado por Fluid
    // Compute, que reutiliza esta MISMA instancia -- y por tanto el mismo `Map` --
    // entre requests concurrentes de tenants distintos). `ProductionCfdiFolioReservationStore`
    // (`./cfdi-folio-reservation-store.ts`) reserva el folio atómicamente en
    // Postgres (`mcp_cfdi.folio_stamp_reservation`, ver
    // `packages/mcp-servers/cfdi/migrations/001_folio_stamp_reservation.sql`)
    // ANTES de invocar al PAC -- la única forma correcta de cerrar esa carrera.
    hotelesCfdiPort: new DualPacCfdiPort(new FinkokAdapter(), new SwSapienAdapter(), { reservationStore: new ProductionCfdiFolioReservationStore(engine) }),
    // Adaptador real (ya NO `notProductionReady`) — cierra el gap propio de hoteles
    // que la migración 008 de domain-despachos dejaba explícitamente pendiente (ver
    // `packages/domain-hoteles/migrations/017_fraude_audit_log.sql`): mientras este
    // puerto siguiera lanzando siempre, `POST .../fraude/escaneos` (hallazgo nuevo) y
    // `POST .../fraude/alertas/:id/{confirmar,descartar}` tumbaban el request con un
    // 500 DESPUÉS de que `recordFraudAlert`/`resolveFraudAlert` ya habían hecho
    // commit. `ProductionHotelesFraudeAuditSink` (`./hoteles-fraude-audit-sink.ts`)
    // escribe a `hoteles.fraude_audit_log` desde la sesión de SISTEMA (mismo patrón
    // que `despachosAuditSink` de abajo) y nunca lanza — ese 500-después-del-commit
    // ya no puede ocurrir por este puerto.
    hotelesFraudeAuditSink: new ProductionHotelesFraudeAuditSink(engine),
    citasRepo: (db) => new PostgresCitasRepository(db),
    // El turn handler real (LLM real vía @atiende/agent-core::LlmGateway con
    // roles/proveedores registrados, ver ./llm-gateway.ts) ya se construye aquí en
    // cuanto `llmGateway` exista — cada llamada abre su propia sesión de Postgres
    // (ver `buildRealCitasTurnHandler`), sin relación con la sesión-por-request de
    // `citasRepo` de arriba. `citasConversationGuard` sí se construye real (en
    // memoria): es infraestructura pura de lock/estado, no un adaptador de datos de
    // negocio — su límite real (single-process, no distribuido entre instancias
    // serverless) queda cubierto en profundidad por el EXCLUDE USING gist de
    // Postgres (autoridad final anti-traslape, Fase 1 §0.7), así que no finge una
    // garantía que no tiene: sustituir este guard por uno con RedisLockStore es una
    // decisión de infraestructura aparte, no un requisito para que el resto
    // funcione correctamente.
    citasTurnHandler: llmGateway ? buildRealCitasTurnHandler(engine, llmGateway) : notProductionReady<CitasWhatsAppTurnHandler>("citasTurnHandler (falta configurar ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY)"),
    citasConversationGuard: createDefaultConversationGuard(),
    // Hallazgo de auditoría (ALTO, "El puerto de Google Calendar sigue
    // notProductionReady (muerto)") -- ver buildRealGoogleCalendarPortResolver más
    // arriba para el detalle completo: el resolver ya NO está ligado a un repo
    // permanentemente `notProductionReady` -- cada invocación abre su propia
    // sesión de sistema real (mismo patrón que `citasTurnHandler`). Sin
    // `GOOGLE_CLIENT_ID/SECRET/OAUTH_REDIRECT_BASE_URL` configuradas (estado real
    // de este entorno, ver env.ts) sigue devolviendo `null` de inmediato -- "sin
    // conectar" honesto, nunca un error. El intercambio de código SÍ es real y no
    // depende de citasRepo (solo llama a Google).
    citasGoogleCalendarPortResolver: buildRealGoogleCalendarPortResolver(engine, env.googleOAuth),
    // Fase 6 §2 (seguimiento) — el resolver que las rutas de citas usan hoy (ver
    // buildRealCalendarSyncPortResolver arriba): cubre Google + Cal.com + CalDAV,
    // cualquiera que el proveedor tenga conectado.
    citasCalendarSyncPortResolver: buildRealCalendarSyncPortResolver(engine, env.googleOAuth),
    // Fase 6 §2 (seguimiento) — ver el comentario de estos dos campos en deps.ts:
    // construcción real, sin credenciales de plataforma que resolver (son del
    // TENANT, ya vienen en `cfg`).
    citasCalComPortFactory: (cfg) => new RealCalComPort(cfg),
    citasCalDavPortFactory: (cfg) => new RealCalDavPort(cfg),
    citasGoogleTokenExchange: exchangeGoogleAuthorizationCode,
    // Hallazgo de auditoría (ALTO, SSRF) — DNS real (sin resolver inyectado), ver
    // @atiende/domain-citas::crearValidadorUrlCaldav.
    citasCaldavUrlValidator: crearValidadorUrlCaldav(),
    licitacionesRepo: (db) => new PostgresLicitacionesRepository(db),
    despachosRepo: (db) => new PostgresDespachosRepository(db),
    // Adaptador real (ya NO `notProductionReady`) -- corrige la regresión real de
    // la Ronda 12 documentada en `packages/domain-despachos/migrations/
    // 008_despachos_audit_log.sql`: `cierre-mensual.ts`/`migracion-catalogo.ts`
    // llamaban a este puerto DESPUÉS de que su escritura de negocio (completar
    // tarea/cerrar un período fiscal/decidir un mapeo) ya había hecho commit, así
    // que el stub que SIEMPRE lanzaba tumbaba esos 5 endpoints con un 500 sobre un
    // cambio que ya había quedado persistido. `ProductionDespachosAuditSink`
    // (`./despachos-audit-sink.ts`) escribe a `despachos.audit_log` desde la
    // sesión de SISTEMA (mismo patrón que `coreRepo` arriba) y nunca lanza (ver
    // cabecera de ese archivo) -- ese 500-después-del-commit ya no puede ocurrir
    // por este puerto.
    despachosAuditSink: new ProductionDespachosAuditSink(engine),
    rentasRepo: (db) => new PostgresRentasRepository(db),
    // Fase 5 -- ambos son código real de producción, no un stub: un feed iCal de
    // canal es una URL pública sin credenciales, así que a diferencia de
    // `citasGoogleCalendarPortResolver` (bloqueado en producción hasta tener
    // GOOGLE_CLIENT_ID/SECRET), este puerto funciona hoy sin ninguna credencial de
    // plataforma pendiente.
    rentasCalendarSyncRepo: (db) => new PostgresRentasCalendarSyncRepository(db),
    rentasIcalFeedPort: new RealIcalFeedPort(),
    // Fase 7 -- mismo criterio que rentasRepo/rentasCalendarSyncRepo: sesión RLS
    // por-request real, ningún stub (ver migrations/009_rentas_mensajeria_schema.sql).
    rentasMensajeriaRepo: (db) => new PostgresRentasMensajeriaRepository(db),
    // Hallazgo de auditoría (severidad CRÍTICA, "la mensajería de rentas es un
    // simulador que nunca toca un canal real") -- `CanalMensajeriaPartnerPendiente`
    // es un esqueleto HONESTO (mismo criterio que `hotelesCfdiPort` justo arriba):
    // sin credencial real de partner de Airbnb/Vrbo/Booking.com (ninguna está
    // configurada en este entorno), `enviarMensajeAprobado` SIEMPRE lanza en vez de
    // fingir un envío -- la ruta (`mensajeria-borradores.ts`) responde 503 explícito.
    rentasCanalMensajeria: (canal) => new CanalMensajeriaPartnerPendiente(canal),
    // Los 5 métodos de solo lectura del portal SÍ quedan reales aquí (sesión RLS
    // por-request, igual que el resto). Los otros 3 (credenciales/invitaciones)
    // requieren una sesión de `service_role` que este monorepo no aprovisiona
    // todavía -- fallan explícito en vez de golpear Postgres real sin el privilegio
    // correcto (ver production/rentas-owner-portal-repository.ts para el detalle
    // completo, incluida la confirmación de que `engine.admin` NO es service_role).
    rentasOwnerPortalRepo: (db) => new ProductionRentasOwnerPortalRepository(db),
    // Fase 11 -- onboarding self-serve del tenant, puerto ENTERO bloqueado (ver
    // production/rentas-onboarding-repository.ts para el detalle completo del gap y
    // su solución real conocida).
    rentasOnboardingRepo: createProductionRentasOnboardingRepo(),
    // Fase 10b -- "romper cristal" (ver packages/domain-rentas/migrations/
    // 018_break_glass_wiring.sql). Las 3 fábricas reciben la sesión RLS por-request
    // (`c.get("db")`, abierta como el superadmin real por
    // routes/superadmin-break-glass.ts) -- nunca `engine.admin`/sistema; la
    // autorización real vive dentro de las funciones `security definer` que cada
    // adaptador invoca.
    rentasBreakGlassSessionRepo: (db) => new PostgresBreakGlassSessionRepository(db),
    rentasBreakGlassAuditRepo: (db) => new PostgresBreakGlassAuditRepository(db),
    rentasBreakGlassDataRepo: (db) => new PostgresBreakGlassRentasDataRepository(db),
    llmGateway,
    // Control de gasto de API de LLM (back office de plataforma) — sesión de
    // sistema igual que `coreRepo`, ver ./llm-usage-repository.ts.
    llmUsageRepo: new ProductionLlmUsageRepository(engine),
    // Salud operativa (back office de plataforma) — mismo criterio EXACTO
    // que `llmUsageRepo` de arriba, ver ./salud-repository.ts.
    saludRepo: new ProductionSaludRepository(engine),
    resumenDiarioRepo: new ProductionResumenDiarioRepository(engine),
    resumenDiarioLlmGateway,
    whatsAppDispatcher,
    // Suscripción SaaS propia de Atiende (auditoría de 22 rubros, hallazgo P1
    // #6) -- mismo criterio EXACTO que `hotelesPaymentsPort` arriba: real en
    // cuanto `STRIPE_SECRET_KEY` esté configurada, `undefined` (503 honesto en
    // la ruta, ver `routes/billing.ts`) mientras no lo esté. Comparte la MISMA
    // cuenta de Stripe que `hotelesPaymentsPort` (un solo `STRIPE_SECRET_KEY`,
    // ver el comentario de cabecera de `hoteles-payments-port.ts`) -- dos
    // productos distintos de la misma cuenta, nunca dos integraciones
    // separadas.
    saasBillingStripeClient: env.stripe.secretKey ? new StripeSaasBillingCheckoutPort(fetch, { secretKey: env.stripe.secretKey }) : undefined,
    saasBillingCustomerLookup: env.stripe.secretKey ? new StripeSaasBillingCustomerLookup(fetch, { secretKey: env.stripe.secretKey }) : undefined,
    saasBillingWebhookSecret: env.stripe.webhookSecret,
  };
  return cached;
}

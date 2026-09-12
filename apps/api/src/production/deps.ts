// buildProductionDeps — ensambla el `AppDeps` real que consume el handler de Vercel
// (`../../api/index.ts` en la raíz del repo). Ver `not-ready.ts` para el detalle
// completo de qué NO es un adaptador de producción todavía y por qué:
// `hotelesPaymentsPort`/`despachosAuditSink` (integraciones sin adaptador/
// credenciales, no relacionadas con RLS). `coreRepo`/`engine` y ahora también
// `restaurantesRepo`/`hotelesRepo`/`citasRepo`/`licitacionesRepo`/`despachosRepo`/
// `rentasRepo`/`rentasOwnerPortalRepo` SÍ son reales de punta a punta contra
// Supabase en cuanto `DATABASE_URL` apunte al proyecto consolidado — estos 7
// últimos como FÁBRICAS `(db) => new PostgresXRepository(db)`, nunca un objeto ya
// construido (ver `../deps.ts` para por qué).
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
import type { HotelesRepository, HotelesWhatsAppTurnHandler, PaymentsPort } from "@atiende/domain-hoteles";
import { PostgresHotelesRepository, createLlmHotelesWhatsAppTurnHandler } from "@atiende/domain-hoteles";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import { PostgresRestaurantesRepository, createLlmWhatsAppTurnHandler as createRestaurantesLlmWhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { CitasRepository, WhatsAppTurnHandler as CitasWhatsAppTurnHandler } from "@atiende/domain-citas";
import {
  PostgresCitasRepository,
  createDefaultConversationGuard,
  createGoogleCalendarPortResolver,
  createLlmWhatsAppTurnHandler as createCitasLlmWhatsAppTurnHandler,
  exchangeGoogleAuthorizationCode,
} from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import { PostgresLicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import { PostgresDespachosRepository } from "@atiende/domain-despachos";
import type { AuditSink } from "@atiende/core-authz";
import type { RentasRepository } from "@atiende/domain-rentas";
import { PostgresRentasRepository } from "@atiende/domain-rentas";
import { openManagedPostgres } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { loadApiEnv } from "../env.ts";
import type { AppDeps } from "../deps.ts";
import { ProductionCoreRepository } from "./core-repository.ts";
import { ProductionRentasOwnerPortalRepository } from "./rentas-owner-portal-repository.ts";
import { notProductionReady } from "./not-ready.ts";
import {
  buildProductionLlmGateway,
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

  // Repo dedicado y SIN sesión real, solo para construir
  // `citasGoogleCalendarPortResolver` (ver comentario más abajo) — la resolución del
  // puerto de Google Calendar por-providerId es una función singleton
  // (`ResolveCalendarPort = (providerId) => Promise<...>`, sin parámetro de sesión),
  // así que no puede recibir un `TenantDbSession` por-request como el resto de
  // `citasRepo`. Ligarla al mismo `citasRepo` de abajo no es posible (una fábrica no
  // es un `CitasRepository`) y cambiar la forma de `ResolveCalendarPort` para que
  // reciba sesión por-llamada es una decisión de arquitectura aparte (mismo tipo de
  // gap que `turnHandler`/`citasTurnHandler`, fuera de alcance de este cambio) — así
  // que, igual que antes de este cambio, cualquier intento real de resolver un
  // calendario en producción sigue fallando explícito en vez de fingir que ya
  // funciona.
  const citasRepoForCalendarResolver = notProductionReady<CitasRepository>("citasRepo (usado por citasGoogleCalendarPortResolver)");

  // Gateway LLM real — `undefined` si NINGÚN proveedor (Anthropic/OpenAI/
  // OpenRouter) tiene API key configurada, ver ./llm-gateway.ts. Se construye UNA
  // sola vez aquí (esta función entera ya está cacheada en `cached` de arriba) y
  // se comparte entre los 3 turn handlers de WhatsApp y (vía `AppDeps.llmGateway`)
  // la ruta de extracción de requisitos de licitaciones.
  const llmGateway = buildProductionLlmGateway(env);

  cached = {
    env,
    engine,
    coreRepo: new ProductionCoreRepository(engine),
    restaurantesRepo: (db) => new PostgresRestaurantesRepository(db),
    turnHandler: llmGateway ? buildRealRestaurantesTurnHandler(engine, llmGateway) : notProductionReady<WhatsAppTurnHandler>("turnHandler (falta configurar ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY)"),
    hotelesRepo: (db) => new PostgresHotelesRepository(db),
    hotelesPaymentsPort: notProductionReady<PaymentsPort>("hotelesPaymentsPort"),
    hotelesTurnHandler: llmGateway ? buildRealHotelesTurnHandler(engine, llmGateway) : notProductionReady<HotelesWhatsAppTurnHandler>("hotelesTurnHandler (falta configurar ANTHROPIC_API_KEY/OPENAI_API_KEY/OPENROUTER_API_KEY)"),
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
    // Fase 3 §4/§9 — el resolver SÍ se construye real (misma lógica de
    // resolución/rotación de token que el resto de producción), pero ligado al repo
    // dedicado de arriba (ver ese comentario) en vez del `citasRepo` real de líneas
    // arriba — cualquier intento real de resolverlo sigue fallando con un error
    // explícito y accionable, nunca silenciosamente `null` fingiendo "sin conectar".
    // El intercambio de código SÍ es real y no depende de citasRepo (solo llama a
    // Google) — se activa en cuanto `GOOGLE_CLIENT_ID/SECRET/OAUTH_REDIRECT_BASE_URL`
    // estén configurados (ver env.ts).
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(citasRepoForCalendarResolver, env.googleOAuth),
    citasGoogleTokenExchange: exchangeGoogleAuthorizationCode,
    licitacionesRepo: (db) => new PostgresLicitacionesRepository(db, env.licitacionesStorageDir),
    despachosRepo: (db) => new PostgresDespachosRepository(db),
    despachosAuditSink: notProductionReady<AuditSink>("despachosAuditSink"),
    rentasRepo: (db) => new PostgresRentasRepository(db),
    // Los 5 métodos de solo lectura del portal SÍ quedan reales aquí (sesión RLS
    // por-request, igual que el resto). Los otros 3 (credenciales/invitaciones)
    // requieren una sesión de `service_role` que este monorepo no aprovisiona
    // todavía -- fallan explícito en vez de golpear Postgres real sin el privilegio
    // correcto (ver production/rentas-owner-portal-repository.ts para el detalle
    // completo, incluida la confirmación de que `engine.admin` NO es service_role).
    rentasOwnerPortalRepo: (db) => new ProductionRentasOwnerPortalRepository(db),
    llmGateway,
  };
  return cached;
}

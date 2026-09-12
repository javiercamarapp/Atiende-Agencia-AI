// buildProductionDeps — ensambla el `AppDeps` real que consume el handler de Vercel
// (`../../api/index.ts` en la raíz del repo). Ver `not-ready.ts` para por qué
// `restaurantesRepo`/`hotelesRepo`/`turnHandler`/`hotelesPaymentsPort`/`citasRepo`/
// `licitacionesRepo`/`despachosRepo`/`despachosAuditSink`/`rentasRepo` NO son adaptadores
// de Postgres todavía (gap de arquitectura real, documentado, no un
// stub-por-pereza) mientras `coreRepo`/`engine` sí lo son (login end-to-end contra
// Supabase real en cuanto `DATABASE_URL` apunte al proyecto consolidado).
import type { HotelesRepository, HotelesWhatsAppTurnHandler, PaymentsPort } from "@atiende/domain-hoteles";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { CitasRepository, WhatsAppTurnHandler as CitasWhatsAppTurnHandler } from "@atiende/domain-citas";
import { createDefaultConversationGuard, createGoogleCalendarPortResolver, exchangeGoogleAuthorizationCode } from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import type { AuditSink } from "@atiende/core-authz";
import type { RentasRepository } from "@atiende/domain-rentas";
import { openManagedPostgres } from "@atiende/db";
import { loadApiEnv } from "../env.ts";
import type { AppDeps } from "../deps.ts";
import { ProductionCoreRepository } from "./core-repository.ts";
import { notProductionReady } from "./not-ready.ts";

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
  const citasRepo = notProductionReady<CitasRepository>("citasRepo");

  cached = {
    env,
    engine,
    coreRepo: new ProductionCoreRepository(engine),
    restaurantesRepo: notProductionReady<RestaurantesRepository>("restaurantesRepo"),
    turnHandler: notProductionReady<WhatsAppTurnHandler>("turnHandler"),
    hotelesRepo: notProductionReady<HotelesRepository>("hotelesRepo"),
    hotelesPaymentsPort: notProductionReady<PaymentsPort>("hotelesPaymentsPort"),
    hotelesTurnHandler: notProductionReady<HotelesWhatsAppTurnHandler>("hotelesTurnHandler"),
    citasRepo,
    // El turn handler real (LLM real vía @atiende/agent-core::LlmGateway con
    // roles/proveedores registrados) requiere la misma decisión de arquitectura
    // pendiente que citasRepo — nunca se marca listo con un LlmGateway sin
    // proveedores reales configurados. `citasConversationGuard` sí se construye
    // real (en memoria): es infraestructura pura de lock/estado, no un adaptador
    // de datos de negocio — su límite real (single-process, no distribuido entre
    // instancias serverless) queda cubierto en profundidad por el EXCLUDE USING
    // gist de Postgres (autoridad final anti-traslape, Fase 1 §0.7), así que no
    // finge una garantía que no tiene: si algún día citasRepo se conecta a
    // Postgres real, sustituir este guard por uno con RedisLockStore es la
    // siguiente decisión de infraestructura, no un requisito para que el resto
    // funcione correctamente.
    citasTurnHandler: notProductionReady<CitasWhatsAppTurnHandler>("citasTurnHandler"),
    citasConversationGuard: createDefaultConversationGuard(),
    // Fase 3 §4/§9 — el resolver SÍ se construye real (misma lógica de
    // resolución/rotación de token que producción usará el día que citasRepo tenga
    // un adaptador de Postgres real, ver comentario de arriba): como `citasRepo`
    // sigue siendo `notProductionReady` mientras esa decisión de arquitectura no se
    // tome, cualquier intento real de resolverlo falla con el mismo error explícito
    // y accionable — nunca silenciosamente `null` fingiendo "sin conectar". El
    // intercambio de código SÍ es real y no depende de citasRepo (solo llama a
    // Google) — se activa en cuanto `GOOGLE_CLIENT_ID/SECRET/OAUTH_REDIRECT_BASE_URL`
    // estén configurados (ver env.ts).
    citasGoogleCalendarPortResolver: createGoogleCalendarPortResolver(citasRepo, env.googleOAuth),
    citasGoogleTokenExchange: exchangeGoogleAuthorizationCode,
    licitacionesRepo: notProductionReady<LicitacionesRepository>("licitacionesRepo"),
    despachosRepo: notProductionReady<DespachosRepository>("despachosRepo"),
    despachosAuditSink: notProductionReady<AuditSink>("despachosAuditSink"),
    rentasRepo: notProductionReady<RentasRepository>("rentasRepo"),
  };
  return cached;
}

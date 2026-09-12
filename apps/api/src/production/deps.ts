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
import { createDefaultConversationGuard } from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import type { AuditSink } from "@atiende/core-authz";
import type { RentasOwnerPortalRepository, RentasRepository } from "@atiende/domain-rentas";
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

  cached = {
    env,
    engine,
    coreRepo: new ProductionCoreRepository(engine),
    restaurantesRepo: notProductionReady<RestaurantesRepository>("restaurantesRepo"),
    turnHandler: notProductionReady<WhatsAppTurnHandler>("turnHandler"),
    hotelesRepo: notProductionReady<HotelesRepository>("hotelesRepo"),
    hotelesPaymentsPort: notProductionReady<PaymentsPort>("hotelesPaymentsPort"),
    hotelesTurnHandler: notProductionReady<HotelesWhatsAppTurnHandler>("hotelesTurnHandler"),
    citasRepo: notProductionReady<CitasRepository>("citasRepo"),
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
    licitacionesRepo: notProductionReady<LicitacionesRepository>("licitacionesRepo"),
    despachosRepo: notProductionReady<DespachosRepository>("despachosRepo"),
    despachosAuditSink: notProductionReady<AuditSink>("despachosAuditSink"),
    rentasRepo: notProductionReady<RentasRepository>("rentasRepo"),
    // Mismo gap documentado que rentasRepo -- ver además la advertencia de privilegio
    // en owner-portal/postgres-repository.ts (findOwnerCredentialByEmail/
    // createPortalInvite/consumePortalInvite exigen una sesión administrativa distinta
    // de la sesión RLS por-request que sí basta para los métodos de solo lectura).
    rentasOwnerPortalRepo: notProductionReady<RentasOwnerPortalRepository>("rentasOwnerPortalRepo"),
  };
  return cached;
}

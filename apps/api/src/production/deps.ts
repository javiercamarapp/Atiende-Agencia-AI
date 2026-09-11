// buildProductionDeps — ensambla el `AppDeps` real que consume el handler de Vercel
// (`../../api/index.ts` en la raíz del repo). Ver `not-ready.ts` para por qué
// `restaurantesRepo`/`hotelesRepo`/`turnHandler`/`hotelesPaymentsPort` NO son
// adaptadores de Postgres todavía (gap de arquitectura real, documentado, no un
// stub-por-pereza) mientras `coreRepo`/`engine` sí lo son (login end-to-end contra
// Supabase real en cuanto `DATABASE_URL` apunte al proyecto consolidado).
import type { HotelesRepository, PaymentsPort } from "@atiende/domain-hoteles";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
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
  };
  return cached;
}

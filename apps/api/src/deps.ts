import type { CoreRepository } from "@atiende/db";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { ApiEnv } from "./env.ts";

/** Todo lo que las rutas necesitan, inyectado — nunca construido dentro de una ruta.
 * En tests, `coreRepo`/`restaurantesRepo` son los adaptadores en memoria de
 * @atiende/db/@atiende/domain-restaurantes; en producción (cuando packages/db tenga
 * un motor de conexión real, ver packages/db/README.md) serán los adaptadores de
 * Postgres — las rutas no cambian ni una línea entre ambos. */
export interface AppDeps {
  readonly env: ApiEnv;
  readonly coreRepo: CoreRepository;
  readonly restaurantesRepo: RestaurantesRepository;
  readonly turnHandler: WhatsAppTurnHandler;
}

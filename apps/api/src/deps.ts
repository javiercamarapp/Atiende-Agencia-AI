import type { CoreRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";
import type { AuditSink } from "@atiende/core-authz";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { HotelesRepository, PaymentsPort } from "@atiende/domain-hoteles";
import type { CitasRepository } from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import type { ApiEnv } from "./env.ts";

/** Todo lo que las rutas necesitan, inyectado — nunca construido dentro de una ruta.
 * En tests, `coreRepo`/`restaurantesRepo`/`hotelesRepo` son los adaptadores en memoria
 * de @atiende/db/@atiende/domain-restaurantes/@atiende/domain-hoteles; en producción
 * (cuando packages/db tenga un motor de conexión real, ver packages/db/README.md)
 * serán los adaptadores de Postgres — las rutas no cambian ni una línea entre ambos.
 *
 * `engine` (@atiende/core-tenancy::TenancyEngine) es lo que `dbSession()` de
 * @atiende/core-auth usa para abrir la sesión de BD por request que
 * `requirePropertyMembership()` necesita para resolver membership en vivo contra
 * `core.membership` — genérico, compartido por cualquier vertical con rutas
 * autenticadas de staff (folios/pedidos-fnb/quotes de hoteles son las primeras). */
export interface AppDeps {
  readonly env: ApiEnv;
  readonly coreRepo: CoreRepository;
  readonly engine: TenancyEngine;
  readonly restaurantesRepo: RestaurantesRepository;
  readonly turnHandler: WhatsAppTurnHandler;
  readonly hotelesRepo: HotelesRepository;
  readonly hotelesPaymentsPort: PaymentsPort;
  readonly citasRepo: CitasRepository;
  readonly licitacionesRepo: LicitacionesRepository;
  readonly despachosRepo: DespachosRepository;
  /** Auditoría de decisiones de la cola de revisión humana (aprobar/rechazar un CFDI)
   * — reutiliza `@atiende/core-authz::AuditSink` en vez de una tabla propia de
   * despachos (ver diseño Fase 1 despachos §3, tabla de mapeo: "lo compartido vive
   * en core, no se repite por vertical"). */
  readonly despachosAuditSink: AuditSink;
}

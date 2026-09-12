import type { CoreRepository } from "@atiende/db";
import type { TenancyEngine } from "@atiende/core-tenancy";
import type { AuditSink } from "@atiende/core-authz";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { HotelesRepository, HotelesWhatsAppTurnHandler, PaymentsPort } from "@atiende/domain-hoteles";
import type { CitasConversationGuard, CitasRepository, ExchangeAuthorizationCodeInput, ExchangeAuthorizationCodeResult, ResolveCalendarPort, WhatsAppTurnHandler as CitasWhatsAppTurnHandler } from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import type { RentasOwnerPortalRepository, RentasRepository } from "@atiende/domain-rentas";
import type { ApiEnv } from "./env.ts";

/** Todo lo que las rutas necesitan, inyectado — nunca construido dentro de una ruta.
 * En tests, `coreRepo`/`restaurantesRepo`/`hotelesRepo`/`rentasRepo` son los
 * adaptadores en memoria de @atiende/db/@atiende/domain-restaurantes/
 * @atiende/domain-hoteles/@atiende/domain-rentas; en producción (cuando packages/db
 * tenga un motor de conexión real, ver packages/db/README.md) serán los adaptadores
 * de Postgres — las rutas no cambian ni una línea entre ambos.
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
 * queries crudas resuelvan (ver apps/api/tests/rentas-fixtures.ts). */
export interface AppDeps {
  readonly env: ApiEnv;
  readonly coreRepo: CoreRepository;
  readonly engine: TenancyEngine;
  readonly restaurantesRepo: RestaurantesRepository;
  readonly turnHandler: WhatsAppTurnHandler;
  readonly hotelesRepo: HotelesRepository;
  readonly hotelesPaymentsPort: PaymentsPort;
  /** Fase 2 hoteles §2/§3 — mismo patrón que `turnHandler` de restaurantes:
   * `acknowledgeOnlyTurnHandler` (sin LLM) o `createLlmHotelesWhatsAppTurnHandler`
   * (LLM real, ver production/deps.ts vs. tests). */
  readonly hotelesTurnHandler: HotelesWhatsAppTurnHandler;
  readonly citasRepo: CitasRepository;
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
  readonly licitacionesRepo: LicitacionesRepository;
  readonly despachosRepo: DespachosRepository;
  /** Auditoría de decisiones de la cola de revisión humana (aprobar/rechazar un CFDI)
   * — reutiliza `@atiende/core-authz::AuditSink` en vez de una tabla propia de
   * despachos (ver diseño Fase 1 despachos §3, tabla de mapeo: "lo compartido vive
   * en core, no se repite por vertical"). */
  readonly despachosAuditSink: AuditSink;
  readonly rentasRepo: RentasRepository;
  /** Fase 3 rentas -- portal de propietario (solo lectura), identidad/sesión propias
   * (nunca `core.membership`/`requirePropertyMembership`, ver diseño Fase 3 §1). Puerto
   * separado de `rentasRepo` a propósito: un actor distinto, tablas nuevas
   * (`rentas.owner_credential`), RLS nueva y aditiva -- nunca comparte código de
   * autorización con las rutas de staff. */
  readonly rentasOwnerPortalRepo: RentasOwnerPortalRepository;
}

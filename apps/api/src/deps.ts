import type { CoreRepository } from "@atiende/db";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import type { AuditSink } from "@atiende/core-authz";
import type { RestaurantesRepository, WhatsAppTurnHandler } from "@atiende/domain-restaurantes";
import type { HotelesRepository, HotelesWhatsAppTurnHandler, PaymentsPort } from "@atiende/domain-hoteles";
import type { CitasConversationGuard, CitasRepository, ExchangeAuthorizationCodeInput, ExchangeAuthorizationCodeResult, ResolveCalendarPort, WhatsAppTurnHandler as CitasWhatsAppTurnHandler } from "@atiende/domain-citas";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import type { DespachosRepository } from "@atiende/domain-despachos";
import type { RentasOwnerPortalRepository, RentasRepository } from "@atiende/domain-rentas";
import type { LlmGateway } from "@atiende/agent-core";
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
  /** Auditoría de decisiones de la cola de revisión humana (aprobar/rechazar un CFDI)
   * — reutiliza `@atiende/core-authz::AuditSink` en vez de una tabla propia de
   * despachos (ver diseño Fase 1 despachos §3, tabla de mapeo: "lo compartido vive
   * en core, no se repite por vertical"). A diferencia de los repos de arriba, NO es
   * una fábrica por-request: es una integración transversal (aún sin adaptador de
   * producción por falta de una tabla/servicio de auditoría dedicado, no por el gap
   * de sesión-por-request de los repos de dominio) — ver production/not-ready.ts. */
  readonly despachosAuditSink: AuditSink;
  readonly rentasRepo: (db: TenantDbSession) => RentasRepository;
  /** Fase 3 rentas -- portal de propietario (solo lectura), identidad/sesión propias
   * (nunca `core.membership`/`requirePropertyMembership`, ver diseño Fase 3 §1). Puerto
   * separado de `rentasRepo` a propósito: un actor distinto, tablas nuevas
   * (`rentas.owner_credential`), RLS nueva y aditiva -- nunca comparte código de
   * autorización con las rutas de staff. */
  readonly rentasOwnerPortalRepo: (db: TenantDbSession) => RentasOwnerPortalRepository;
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
}

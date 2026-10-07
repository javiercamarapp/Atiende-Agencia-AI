// buildProductionLlmGateway — construye el `LlmGateway` REAL (packages/agent-core)
// compartido por las 5 escaleras de producción que hoy lo necesitan:
//   - restaurantesTurnHandler / hotelesTurnHandler / citasTurnHandler (agentes de
//     WhatsApp con tool-calling real, ver domain-{restaurantes,hoteles,citas}/src/
//     whatsapp/llm-turn-handler.ts).
//   - LlmRequirementExtractor (extracción de requisitos de licitación vía
//     tool-calling, ver domain-licitaciones/src/llm-requirement-extractor.ts),
//     invocado desde la ruta POST .../requirements/extract (technicalProposal.ts).
//   - GeneradorBorradorIA (borrador de mensajería de rentas respaldado por
//     IA, ver domain-rentas/src/agentes/generadorBorradorIA.ts).
//   - TechnicalProposalDraftAgent (Fase 9 -- asistente de redacción/revisión
//     de texto de propuesta técnica de licitaciones con guardrails
//     anticorrupción/no-cifras-económicas/no-decisión-de-negocio y
//     aprobación humana obligatoria, ver domain-licitaciones/src/
//     technical-proposal-draft-agent.ts).
//   - sugerirMatchesLLM (Fase 11 -- nivel 4 de conciliación bancaria de despachos:
//     propone un match candidato sobre lo que niveles 1-3 deterministas no
//     resolvieron, SIEMPRE con aprobación humana obligatoria antes de aplicarse,
//     ver domain-despachos/src/conciliacion/llm-matching-agent.ts).
//
// Hasta el cambio original de este módulo, ninguna de las escaleras tenía proveedores registrados —
// ese era el bloqueante real para "listo a producción, solo pegar API keys" que
// dejó pendiente `production/deps.ts` (turnHandler/hotelesTurnHandler/
// citasTurnHandler marcados `notProductionReady`) y `technicalProposal.ts`
// (LlmRequirementExtractor probado pero sin escalera real, ver su comentario de
// cabecera).
//
// FAIL-CLOSED explícito, mismo principio que `notProductionReady` (../not-ready.ts):
// este módulo NUNCA finge un gateway funcional sin proveedores reales detrás. Se
// construye SOLO SI hay OPENROUTER_API_KEY (proveedor PRIMARIO y ÚNICO por defecto; basta la
// llave, los modelos por rol salen de `./llm-models.ts`) o, como legado, OPENAI_API_KEY +
// OPENAI_MODEL cuando NO hay llave de OpenRouter. Si ninguno está configurado, devuelve
// `undefined` — el llamador (`production/deps.ts`, `technicalProposal.ts`) decide el fallback
// explícito (`notProductionReady` / solo `RuleBasedExtractor`), nunca este módulo. El proveedor
// directo de Anthropic se RETIRÓ (ignoraba tools): los modelos Anthropic pasan por OpenRouter.
//
// ESCALERA POR ROL: cada rol tiene su lista ordenada de modelos (`resolveRoleRoute`); cada modelo
// es un escalón (`OpenRouterProvider` con id `openrouter:<modelo>`, su propio circuit breaker y
// sus parámetros). Ver docs/LLM-GATEWAY.md.
//
// SINGLETON: a diferencia de `buildProductionDeps()` (que cachea en un `let
// cached` de módulo porque se invoca en cada request), esta función es pura
// (mismo `env` de entrada → mismo resultado) y se llama UNA sola vez, dentro de
// `buildProductionDeps()`, que ya está cacheada a nivel de proceso — no hace
// falta un segundo cache aquí (ver `../production/deps.ts::cached`).
import {
  CircuitBreaker,
  InMemoryBudgetLedgerStore,
  InMemoryCircuitBreakerStore,
  LlmGateway,
  OpenAiProvider,
  OpenRouterProvider,
  RedisCircuitBreakerStore,
  UpstashRestClient,
  type CircuitBreakerStore,
  type GatewayBudgetLimits,
  type GatewayKillSwitch,
  type LlmProvider,
} from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { emitirNotificacion } from "@atiende/db";
import { ProductionLlmUsageRecorder, ProductionOrgMonthlyBudgetStore, ProductionRoleDailyTurnStore } from "./llm-usage-gateway-adapters.ts";
import { RESUMEN_DIARIO_LLM_ROLE } from "../resumen-diario/redaccion.ts";
import type { ApiEnv } from "../env.ts";
import { COMPACTACION_HISTORIAL_ROLE, COMPUERTA_ESCALAMIENTO_ROLE, DATA_CHAT_RETRY_SUFFIX, ENRUTADOR_TURNO_ROLE, NEW_PLATFORM_LLM_ROLES, REPORTE_ANALISIS_FINANCIERO_ROLE, REPORTE_ANALISIS_GENERAL_ROLE, REPORTE_REDACCION_FINANCIERO_ROLE, REPORTE_REDACCION_GENERAL_ROLE, RESTAURANTES_TRANSCRIPCION_ROLE, TITULOS_RESUMENES_ROLE, parseLlmModelsJson, resolveRoleRoute, routingForModel, rungsDeModelosAgente, SUPERADMIN_COPILOTO_ROLE, type LlmModelsConfig } from "./llm-models.ts";

export const RESTAURANTES_WHATSAPP_AGENT_ROLE = "restaurantes:whatsapp_agent";
export const RESTAURANTES_WHATSAPP_AGENT_ESCALATED_ROLE = "restaurantes:whatsapp_agent_escalated";
/** "Chatea con tus datos" de restaurantes (ver apps/api/src/data-chat/deps.ts). Un rol por vertical:
 *  cada vertical que enchufe su catalogo registra el suyo (docs/DATA-CHAT.md). Sin *_escalated: un turno
 *  del chat es una conversacion corta con tope de rondas propio. */
export const RESTAURANTES_DATA_CHAT_ROLE = "restaurantes:data_chat";
/** "Chatea con tus datos" de hoteles y de rentas (ver apps/api/src/data-chat/vertical-routes.ts): un rol por
 *  vertical, apagable y con su propio registro de uso. */
export const HOTELES_DATA_CHAT_ROLE = "hoteles:data_chat";
export const RENTAS_DATA_CHAT_ROLE = "rentas:data_chat";
/** "Chatea con tus datos" de despachos y licitaciones (mismo motor y mismo tope mensual por organizacion). */
export const DESPACHOS_DATA_CHAT_ROLE = "despachos:data_chat";
export const LICITACIONES_DATA_CHAT_ROLE = "licitaciones:data_chat";
/** "Chatea con tus datos" de citas (C-10; mismo motor, mismo tope mensual por organizacion, rol propio apagable). */
export const CITAS_DATA_CHAT_ROLE = "citas:data_chat";
export const HOTELES_WHATSAPP_AGENT_ROLE = "hoteles:whatsapp_agent";
export const HOTELES_WHATSAPP_AGENT_ESCALATED_ROLE = "hoteles:whatsapp_agent_escalated";
export const CITAS_WHATSAPP_AGENT_ROLE = "citas:whatsapp_agent";
export const CITAS_WHATSAPP_AGENT_ESCALATED_ROLE = "citas:whatsapp_agent_escalated";
/** Debe coincidir EXACTO con el default de `LlmRequirementExtractorOptions.role`
 *  (`DEFAULT_ROLE` en domain-licitaciones/src/llm-requirement-extractor.ts) —
 *  nunca se inventa un nombre nuevo aquí. */
export const LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE = "licitaciones:requirement_extractor";
/** Fase 7 -- borrador de mensajería al huésped respaldado por IA (ver
 *  @atiende/domain-rentas::agentes/generadorBorradorIA.ts::GeneradorBorradorIAOptions.role).
 *  Sin rol *_escalated propio a propósito: a diferencia del loop de varios turnos de
 *  un agente de WhatsApp, un borrador es UNA sola invocación (nunca hay "turno
 *  siguiente" dentro de la misma llamada) -- la escalera de fallback entre
 *  proveedores del propio gateway ya cubre el caso de que el primer proveedor falle. */
export const RENTAS_MENSAJERIA_AGENT_ROLE = "rentas:mensajeria_agent";
/** Fase 9 -- asistente de redacción/revisión de texto de propuesta técnica de
 *  licitaciones, respaldado por IA con guardrails anticorrupción/no-cifras-
 *  económicas/no-decisión-de-negocio hardcoded y aprobación humana obligatoria
 *  (ver @atiende/domain-licitaciones::technical-proposal-draft-agent.ts::
 *  DEFAULT_TECHNICAL_PROPOSAL_DRAFT_AGENT_ROLE, que este nombre DEBE
 *  coincidir exacto -- mismo criterio que LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE
 *  arriba). Sin rol *_escalated propio, mismo argumento que
 *  RENTAS_MENSAJERIA_AGENT_ROLE: una redacción/revisión es UNA sola
 *  invocación, nunca un loop de varios turnos -- la escalera de fallback
 *  entre proveedores del propio gateway ya cubre que el primer proveedor
 *  falle. */
export const LICITACIONES_PROPOSAL_DRAFT_AGENT_ROLE = "licitaciones:proposal_draft_agent";
/** Fase 11 -- nivel 4 (LLM) de conciliación bancaria de despachos: propone un match
 *  candidato sobre los movimientos que niveles 1-3 (deterministas) no pudieron
 *  resolver, SIEMPRE pendiente de aprobación humana (ver
 *  @atiende/domain-despachos::conciliacion/llm-matching-agent.ts::
 *  DEFAULT_DESPACHOS_CONCILIACION_LLM_ROLE, que este nombre DEBE coincidir exacto --
 *  mismo criterio que LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE/
 *  LICITACIONES_PROPOSAL_DRAFT_AGENT_ROLE arriba). Sin rol *_escalated propio, mismo
 *  argumento que RENTAS_MENSAJERIA_AGENT_ROLE: una sugerencia de match es UNA sola
 *  invocación por movimiento, nunca un loop de varios turnos. */
export const DESPACHOS_CONCILIACION_LLM_ROLE = "despachos:conciliacion_llm_agent";
/** L-04 -- borradores de preguntas para la junta de aclaraciones de licitaciones (ver
 *  @atiende/domain-licitaciones::junta-question-draft-agent.ts::DEFAULT_JUNTA_QUESTION_AGENT_ROLE,
 *  que este nombre DEBE coincidir exacto). Sin rol *_escalated propio, mismo argumento que
 *  LICITACIONES_PROPOSAL_DRAFT_AGENT_ROLE: una sola invocacion por solicitud. */
export const LICITACIONES_JUNTA_QUESTION_AGENT_ROLE = "licitaciones:junta_question_agent";

export const ALL_PRODUCTION_ROLES: readonly string[] = [
  RESTAURANTES_WHATSAPP_AGENT_ROLE,
  RESTAURANTES_WHATSAPP_AGENT_ESCALATED_ROLE,
  RESTAURANTES_DATA_CHAT_ROLE,
  // R-32: transcripcion de notas de voz (llamador: apps/api/src/routes/verticals/restaurantes/transcripcion-voz.ts). Apagable.
  RESTAURANTES_TRANSCRIPCION_ROLE,
  HOTELES_DATA_CHAT_ROLE,
  RENTAS_DATA_CHAT_ROLE,
  DESPACHOS_DATA_CHAT_ROLE,
  LICITACIONES_DATA_CHAT_ROLE,
  CITAS_DATA_CHAT_ROLE,
  HOTELES_WHATSAPP_AGENT_ROLE,
  HOTELES_WHATSAPP_AGENT_ESCALATED_ROLE,
  CITAS_WHATSAPP_AGENT_ROLE,
  CITAS_WHATSAPP_AGENT_ESCALATED_ROLE,
  LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE,
  RENTAS_MENSAJERIA_AGENT_ROLE,
  LICITACIONES_PROPOSAL_DRAFT_AGENT_ROLE,
  DESPACHOS_CONCILIACION_LLM_ROLE,
  LICITACIONES_JUNTA_QUESTION_AGENT_ROLE,
  // CHAT-14: reporte PDF del Copiloto (analista y redactor, por tipo: financiero/general). Cada uno es apagable.
  REPORTE_ANALISIS_FINANCIERO_ROLE,
  REPORTE_ANALISIS_GENERAL_ROLE,
  REPORTE_REDACCION_FINANCIERO_ROLE,
  REPORTE_REDACCION_GENERAL_ROLE,
  // MOD-12: roles auxiliares del Copiloto (enrutador de turno, compuerta de escalamiento, titulos de conversaciones, compactacion de historial).
  // Cada uno tiene llamador real (data-chat/conversaciones.ts y el motor) y es apagable desde el panel de interruptores.
  ENRUTADOR_TURNO_ROLE,
  COMPUERTA_ESCALAMIENTO_ROLE,
  TITULOS_RESUMENES_ROLE,
  COMPACTACION_HISTORIAL_ROLE,
  // CHAT-16: Copiloto de superadmin (plataforma). Su llamador real es routes/superadmin-copiloto.ts, con un gateway DEDICADO (ver `buildSuperadminCopilotoLlmGateway`).
  SUPERADMIN_COPILOTO_ROLE,
];

/** Reintento por guardia de cifras: un rol "<vertical>:data_chat_retry" por cada rol de data-chat. */
export const DATA_CHAT_RETRY_ROLES: readonly string[] = ALL_PRODUCTION_ROLES.filter((r) => r.endsWith(":data_chat")).map((r) => `${r.slice(0, r.indexOf(":"))}:${DATA_CHAT_RETRY_SUFFIX}`);

/** Topes conservadores de defensa en profundidad, no una promesa de costo real
 *  (ver nota de `defaultCostEstimator` en gateway.ts: sobre-reservar es seguro,
 *  sub-reservar no) — $2 por corrida (un turno de WhatsApp o una página de
 *  extracción de requisitos) y $50/día compartidos entre las 3 verticales que
 *  usan el mismo tenant/organización. Un operador con tráfico real más alto
 *  ajusta estos números; no son un límite técnico del gateway. */
export const DEFAULT_LLM_GATEWAY_BUDGET_LIMITS: GatewayBudgetLimits = {
  maxRunUsd: 2,
  maxTenantDailyUsd: 50,
};

/** Atribucion hacia OpenRouter (cabeceras HTTP-Referer / X-Title). */
const OPENROUTER_APP_NAME = "Atiende";

/** Carga y valida LLM_MODELS_JSON. Nunca lanza: una configuracion invalida se ignora (rol por rol) y
 *  queda registrada como error estructurado -- los defaults versionados siguen vigentes. */
export function loadLlmModelsConfig(env: ApiEnv): LlmModelsConfig {
  const { config, errors } = parseLlmModelsJson(env.llmProviders.openrouter?.modelsJson);
  for (const message of errors) console.error(JSON.stringify({ level: "error", event: "llm_models_json_invalid", message }));
  return config;
}

/** Breaker COMPARTIDO entre instancias si hay Upstash (mismas variables que el rate limit); si no,
 *  en memoria por instancia (limite documentado en docs/LLM-GATEWAY.md). */
export function buildBreakerStore(env: ApiEnv): CircuitBreakerStore {
  const shared = env.llmProviders.openrouter?.sharedBreaker;
  if (shared) return new RedisCircuitBreakerStore(new UpstashRestClient({ url: shared.url, token: shared.token }));
  return new InMemoryCircuitBreakerStore();
}

/** Escalera de un rol: un escalon por modelo de su ruta. `undefined` si no hay ningun proveedor. */
export function buildRoleLadder(env: ApiEnv, role: string, models: LlmModelsConfig): LlmProvider[] | undefined {
  const { openrouter, openai } = env.llmProviders;
  if (openrouter) {
    const route = resolveRoleRoute(role, models);
    return route.models.map(
      (rung) =>
        new OpenRouterProvider({
          id: `openrouter:${rung.model}`,
          apiKey: openrouter.apiKey,
          model: rung.model,
          params: rung,
          routing: routingForModel(route, rung.model, openrouter.zdr),
          countryOfResidence: openrouter.countryOfResidence ?? undefined,
          appUrl: env.appBaseUrl,
          appName: OPENROUTER_APP_NAME,
        }),
    );
  }
  // LEGADO: sin llave de OpenRouter, el proveedor directo de OpenAI (un solo modelo para todos los roles).
  if (openai) return [new OpenAiProvider({ apiKey: openai.apiKey, model: openai.model })];
  return undefined;
}

/** Notificacion in-app a los superadmins cuando el breaker de un modelo se abre (`superadmin.llm.modelo_caido`; solo el
 *  id del modelo, sin PII; dedupe por modelo y dia en la base). Best-effort: nunca lanza ni altera la escalera. */
export async function notificarModeloCaidoBestEffort(engine: TenancyEngine, providerId: string, ahora: Date = new Date()): Promise<void> {
  try {
    const modelo = providerId.replace(/^openrouter:/, "").replace(/\//g, ":").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40);
    await engine.withAppSession({ userId: null }, (session) =>
      emitirNotificacion(session, { evento: "superadmin.llm.modelo_caido", organizationId: null, clave: `${modelo}:${ahora.toISOString().slice(0, 10)}`, parametros: { modelo } }),
    );
  } catch {
    // best-effort
  }
}

/** Circuit breaker del gateway: el store compartido (o en memoria) con las claves prefijadas por entorno. Con `engine`,
 *  avisa a los superadmins cuando un modelo se cae. */
export function buildCircuitBreaker(env: ApiEnv, engine?: TenancyEngine): CircuitBreaker {
  return new CircuitBreaker(buildBreakerStore(env), {
    ...(env.llmProviders.openrouter?.breakerEnv ? { keyPrefix: env.llmProviders.openrouter.breakerEnv } : {}),
    ...(engine ? { onOpen: (providerId: string) => notificarModeloCaidoBestEffort(engine, providerId) } : {}),
  });
}

function hasAnyProvider(env: ApiEnv): boolean {
  return Boolean(env.llmProviders.openrouter || env.llmProviders.openai);
}

/** Modelos que una organizacion de restaurantes puede ELEGIR para un rol (lista permitida de domain-restaurantes). Se registran como alternativas del
 *  rol (`LlmGateway.registerAlternatives`): no entran a la escalera por defecto y pasan por la MISMA politica de proveedores de EE.UU. (`routingForModel`),
 *  con el mismo id de escalon (`openrouter:<modelo>`) para compartir el circuit breaker. Sin llave de OpenRouter no hay alternativas (el legado de un
 *  solo modelo de OpenAI no puede elegir). */
export function buildAgentModelAlternatives(env: ApiEnv, role: string, models: LlmModelsConfig): LlmProvider[] {
  const { openrouter } = env.llmProviders;
  if (!openrouter) return [];
  const route = resolveRoleRoute(role, models);
  return rungsDeModelosAgente().map(
    (rung) =>
      new OpenRouterProvider({
        id: `openrouter:${rung.model}`,
        apiKey: openrouter.apiKey,
        model: rung.model,
        params: rung,
        routing: routingForModel(route, rung.model, openrouter.zdr),
        countryOfResidence: openrouter.countryOfResidence ?? undefined,
        appUrl: env.appBaseUrl,
        appName: OPENROUTER_APP_NAME,
      }),
  );
}

/**
 * Devuelve el `LlmGateway` real con las 8 escaleras (3 pares default/escalated de
 * WhatsApp + 1 de licitaciones + 1 de mensajería de rentas) registradas contra la
 * MISMA lista de proveedores configurados, o `undefined` si NINGÚN proveedor tiene
 * API key + modelo configurados — fail-closed explícito, nunca un gateway que finge
 * funcionar sin credenciales reales detrás.
 *
 * `engine` alimenta el registro de uso (control de gasto de API de LLM) + el
 * tope MENSUAL persistente (`ProductionLlmUsageRecorder`/
 * `ProductionOrgMonthlyBudgetStore`, ver `./llm-usage-gateway-adapters.ts`) —
 * ambos abren su propia sesión de sistema por llamada, MISMO patrón que
 * `hotelesFraudeAuditSink`/`despachosAuditSink` en `./deps.ts`. Se pasan
 * SIEMPRE que hay `engine` (que siempre lo hay en producción real, ver
 * `buildProductionDeps`) — sin `DATABASE_URL` no hay ni `engine` ni gateway
 * real que construir (ver el `throw` explícito al inicio de
 * `buildProductionDeps`).
 */
export function buildProductionLlmGateway(env: ApiEnv, engine: TenancyEngine, killSwitch?: GatewayKillSwitch): LlmGateway | undefined {
  if (!hasAnyProvider(env)) return undefined;
  const models = loadLlmModelsConfig(env);

  const gateway = new LlmGateway({
    breaker: buildCircuitBreaker(env, engine),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: DEFAULT_LLM_GATEWAY_BUDGET_LIMITS,
    usageRecorder: new ProductionLlmUsageRecorder(engine),
    orgMonthlyBudgetStore: new ProductionOrgMonthlyBudgetStore(engine),
    // Tope diario de turnos por rol (CHAT-07): sin tope por defecto para los roles que no lo declaran.
    roleTurnStore: new ProductionRoleDailyTurnStore(engine),
    // Interruptor de plataforma (kill switch por agente/global) -- opcional.
    killSwitch,
  });

  // El Copiloto de superadmin (CHAT-16) NO usa este gateway (su gasto es de plataforma, no de una organizacion): tiene el suyo
  // (`buildSuperadminCopilotoLlmGateway`). Su rol se mantiene registrado aqui para que la escalera exista tambien en este gateway.
  for (const role of new Set([...ALL_PRODUCTION_ROLES, SUPERADMIN_COPILOTO_ROLE, ...DATA_CHAT_RETRY_ROLES, ...NEW_PLATFORM_LLM_ROLES])) {
    gateway.registerLadder(role, buildRoleLadder(env, role, models)!);
  }
  // Modelo elegido por la organizacion para el agente de WhatsApp de restaurantes (ajustes del agente): alternativas del MISMO rol, asi el interruptor
  // de plataforma, el tope y el registro de uso siguen siendo los del rol.
  gateway.registerAlternatives(RESTAURANTES_WHATSAPP_AGENT_ROLE, buildAgentModelAlternatives(env, RESTAURANTES_WHATSAPP_AGENT_ROLE, models));

  return gateway;
}

/** Tope MUY bajo, dedicado a `resumen-diario` -- una sola llamada al día,
 *  sin `usageRecorder`/`orgMonthlyBudgetStore` (ver el comentario largo en
 *  `../resumen-diario/redaccion.ts` para la decisión completa de atribución
 *  de gasto de plataforma). Deliberadamente más bajo que
 *  `DEFAULT_LLM_GATEWAY_BUDGET_LIMITS` (turnos de WhatsApp/extracción real,
 *  potencialmente varias llamadas por minuto): esto es un párrafo narrativo,
 *  una corrida diaria. */
export const RESUMEN_DIARIO_LLM_BUDGET_LIMITS: GatewayBudgetLimits = {
  maxRunUsd: 0.5,
  maxTenantDailyUsd: 1,
};

/**
 * Gateway DEDICADO a la escalera `resumen-diario` (`apps/api/src/resumen-
 * diario/redaccion.ts::RESUMEN_DIARIO_LLM_ROLE`) -- SEPARADO del gateway
 * compartido de `buildProductionLlmGateway` a propósito: ese gateway ata
 * `usageRecorder`/`orgMonthlyBudgetStore` a `core.llm_usage_daily`/`core.
 * llm_org_budget`, que EXIGEN `organization_id uuid not null references
 * core.organization` -- el resumen diario es un gasto de PLATAFORMA, nunca
 * de un tenant, y el diseño es explícito en NO inventar una organización
 * falsa solo para reusar esas tablas (ver el comentario largo de
 * `../resumen-diario/redaccion.ts`, que documenta la decisión completa).
 *
 * MISMA llave de OpenRouter que `buildProductionLlmGateway`
 * (escalera de reportes de `./llm-models.ts`), pero con su PROPIO circuit
 * breaker/budget ledger en memoria (aislados del gateway de tenants) y sin
 * `usageRecorder`/`orgMonthlyBudgetStore` -- el costo/modelo/proveedor real
 * que el proveedor reportó se guarda directamente en la fila de `core.
 * daily_ops_summary` que produce el propio agregador (columnas `costo_llm_
 * micro_usd`/`modelo_llm`/`proveedor_llm`), nunca en una tabla de gasto
 * por-organización. `undefined` con el MISMO criterio fail-closed que
 * `buildProductionLlmGateway`: sin ningún proveedor configurado, no hay
 * narrativa por LLM -- se usa la plantilla determinista, nunca se finge una
 * llamada.
 */
export function buildResumenDiarioLlmGateway(env: ApiEnv, killSwitch?: GatewayKillSwitch): LlmGateway | undefined {
  if (!hasAnyProvider(env)) return undefined;

  const gateway = new LlmGateway({
    breaker: buildCircuitBreaker(env),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: RESUMEN_DIARIO_LLM_BUDGET_LIMITS,
    killSwitch,
  });
  gateway.registerLadder(RESUMEN_DIARIO_LLM_ROLE, buildRoleLadder(env, RESUMEN_DIARIO_LLM_ROLE, loadLlmModelsConfig(env))!);
  return gateway;
}

/** Topes de defensa en profundidad del gateway DEDICADO del Copiloto de superadmin: en memoria de proceso, por corrida y por dia. El tope MENSUAL propio
 *  (que si es persistente) lo aplica la ruta contra la bitacora (`core.get_copiloto_plataforma_gasto_mes`). Deliberadamente bajos: un turno son 2
 *  llamadas con un modelo premium y el uso es de un puñado de superadmins. */
export const SUPERADMIN_COPILOTO_LLM_BUDGET_LIMITS: GatewayBudgetLimits = {
  maxRunUsd: 1,
  maxTenantDailyUsd: 10,
};

/**
 * Gateway DEDICADO al Copiloto de superadmin (CHAT-16) -- SEPARADO del de los tenants por la misma razon que `buildResumenDiarioLlmGateway`: el gateway
 * compartido ata `usageRecorder`/`orgMonthlyBudgetStore` a `core.llm_usage_daily`/`core.llm_org_budget`, que EXIGEN una organizacion real, y este gasto es
 * de PLATAFORMA. Tiene su PROPIO circuit breaker y presupuesto en memoria, el interruptor de plataforma (rol `superadmin:copiloto`) y sin registro de uso
 * por organizacion: el costo real de cada turno lo guarda la bitacora del Copiloto (migracion 0048). `undefined` sin ningun proveedor (fail-closed).
 */
export function buildSuperadminCopilotoLlmGateway(env: ApiEnv, engine?: TenancyEngine, killSwitch?: GatewayKillSwitch): LlmGateway | undefined {
  if (!hasAnyProvider(env)) return undefined;
  const gateway = new LlmGateway({
    breaker: buildCircuitBreaker(env, engine),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: SUPERADMIN_COPILOTO_LLM_BUDGET_LIMITS,
    killSwitch,
  });
  gateway.registerLadder(SUPERADMIN_COPILOTO_ROLE, buildRoleLadder(env, SUPERADMIN_COPILOTO_ROLE, loadLlmModelsConfig(env))!);
  return gateway;
}

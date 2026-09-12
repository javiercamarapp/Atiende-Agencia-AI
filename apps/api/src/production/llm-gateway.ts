// buildProductionLlmGateway — construye el `LlmGateway` REAL (packages/agent-core)
// compartido por las 4 escaleras de producción que hoy lo necesitan:
//   - restaurantesTurnHandler / hotelesTurnHandler / citasTurnHandler (agentes de
//     WhatsApp con tool-calling real, ver domain-{restaurantes,hoteles,citas}/src/
//     whatsapp/llm-turn-handler.ts).
//   - LlmRequirementExtractor (extracción de requisitos de licitación vía
//     tool-calling, ver domain-licitaciones/src/llm-requirement-extractor.ts),
//     invocado desde la ruta POST .../requirements/extract (technicalProposal.ts).
//
// Hasta este cambio, ninguna de las 4 escaleras tenía proveedores registrados —
// ese era el bloqueante real para "listo a producción, solo pegar API keys" que
// dejó pendiente `production/deps.ts` (turnHandler/hotelesTurnHandler/
// citasTurnHandler marcados `notProductionReady`) y `technicalProposal.ts`
// (LlmRequirementExtractor probado pero sin escalera real, ver su comentario de
// cabecera).
//
// FAIL-CLOSED explícito, mismo principio que `notProductionReady` (../not-ready.ts):
// este módulo NUNCA finge un gateway funcional sin proveedores reales detrás. Se
// construye SOLO SI al menos un proveedor tiene su API key Y su modelo
// configurados vía env.ts (`ApiEnv.llmProviders`, leído de
// `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`, `OPENAI_API_KEY`/`OPENAI_MODEL`,
// `OPENROUTER_API_KEY`/`OPENROUTER_MODEL`+`OPENROUTER_COUNTRY_OF_RESIDENCE`
// opcional — ver providers/{anthropic,openai,openrouter}.ts para qué opciones
// espera cada uno). Si NINGUNO está configurado, devuelve `undefined` — el
// llamador (`production/deps.ts`, `technicalProposal.ts`) decide el fallback
// explícito (`notProductionReady` / solo `RuleBasedExtractor`), nunca este módulo.
//
// SINGLETON: a diferencia de `buildProductionDeps()` (que cachea en un `let
// cached` de módulo porque se invoca en cada request), esta función es pura
// (mismo `env` de entrada → mismo resultado) y se llama UNA sola vez, dentro de
// `buildProductionDeps()`, que ya está cacheada a nivel de proceso — no hace
// falta un segundo cache aquí (ver `../production/deps.ts::cached`).
//
// UNA escalera de proveedores compartida por las 4 (más el rol *_escalated de
// cada turn handler, que usa la MISMA escalera): hoy no hay una variable de
// entorno que distinga un modelo "barato" (rol default) de uno "caro" (rol
// escalado) — el fallback REAL entre proveedores (Anthropic → OpenAI →
// OpenRouter, con circuit breaker y presupuesto) sigue aplicando dentro de cada
// llamada. Separar barato/caro con más variables de entorno es una extensión
// futura legítima (agregar otra ladder), no un requisito para que esta pieza
// deje de fingir.
import {
  AnthropicProvider,
  CircuitBreaker,
  InMemoryBudgetLedgerStore,
  InMemoryCircuitBreakerStore,
  LlmGateway,
  OpenAiProvider,
  OpenRouterProvider,
  type GatewayBudgetLimits,
  type LlmProvider,
} from "@atiende/agent-core";
import type { ApiEnv } from "../env.ts";

export const RESTAURANTES_WHATSAPP_AGENT_ROLE = "restaurantes:whatsapp_agent";
export const RESTAURANTES_WHATSAPP_AGENT_ESCALATED_ROLE = "restaurantes:whatsapp_agent_escalated";
export const HOTELES_WHATSAPP_AGENT_ROLE = "hoteles:whatsapp_agent";
export const HOTELES_WHATSAPP_AGENT_ESCALATED_ROLE = "hoteles:whatsapp_agent_escalated";
export const CITAS_WHATSAPP_AGENT_ROLE = "citas:whatsapp_agent";
export const CITAS_WHATSAPP_AGENT_ESCALATED_ROLE = "citas:whatsapp_agent_escalated";
/** Debe coincidir EXACTO con el default de `LlmRequirementExtractorOptions.role`
 *  (`DEFAULT_ROLE` en domain-licitaciones/src/llm-requirement-extractor.ts) —
 *  nunca se inventa un nombre nuevo aquí. */
export const LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE = "licitaciones:requirement_extractor";

const ALL_PRODUCTION_ROLES: readonly string[] = [
  RESTAURANTES_WHATSAPP_AGENT_ROLE,
  RESTAURANTES_WHATSAPP_AGENT_ESCALATED_ROLE,
  HOTELES_WHATSAPP_AGENT_ROLE,
  HOTELES_WHATSAPP_AGENT_ESCALATED_ROLE,
  CITAS_WHATSAPP_AGENT_ROLE,
  CITAS_WHATSAPP_AGENT_ESCALATED_ROLE,
  LICITACIONES_REQUIREMENT_EXTRACTOR_ROLE,
];

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

function buildProviderLadder(env: ApiEnv): LlmProvider[] {
  const providers: LlmProvider[] = [];
  const { anthropic, openai, openrouter } = env.llmProviders;

  // Orden de preferencia: integraciones DIRECTAS primero (residencia declarada
  // y fija, ver providers/{anthropic,openai}.ts), el agregador OpenRouter al
  // final (residencia 'unknown' salvo que el operador la confirme vía
  // OPENROUTER_COUNTRY_OF_RESIDENCE).
  if (anthropic) providers.push(new AnthropicProvider({ apiKey: anthropic.apiKey, model: anthropic.model }));
  if (openai) providers.push(new OpenAiProvider({ apiKey: openai.apiKey, model: openai.model }));
  if (openrouter) {
    providers.push(
      new OpenRouterProvider({
        apiKey: openrouter.apiKey,
        model: openrouter.model,
        countryOfResidence: openrouter.countryOfResidence ?? undefined,
      }),
    );
  }
  return providers;
}

/**
 * Devuelve el `LlmGateway` real con las 7 escaleras (4 roles default/escalated
 * de WhatsApp + 1 de licitaciones) registradas contra la MISMA lista de
 * proveedores configurados, o `undefined` si NINGÚN proveedor tiene API key +
 * modelo configurados — fail-closed explícito, nunca un gateway que finge
 * funcionar sin credenciales reales detrás.
 */
export function buildProductionLlmGateway(env: ApiEnv): LlmGateway | undefined {
  const providers = buildProviderLadder(env);
  if (providers.length === 0) return undefined;

  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: DEFAULT_LLM_GATEWAY_BUDGET_LIMITS,
  });

  for (const role of ALL_PRODUCTION_ROLES) {
    gateway.registerLadder(role, providers);
  }

  return gateway;
}

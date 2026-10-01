// Adaptador: el motor pide una `DataChatCompletion`; en producción sale del `LlmGateway`
// compartido (carril interactivo), así que hereda residencia, circuit breaker, tope por
// corrida/diario y el tope MENSUAL por organización (core.llm_org_budget) + el registro de
// uso (core.llm_usage_daily). El tope por tenant NO se reimplementa aquí.
import type { GatewayCallResult, LlmGateway } from "../gateway/gateway.js";
import type { DataChatCompletion } from "./types.js";

export const DATA_CHAT_ROLE_SUFFIX = "data_chat";

export function gatewayCompletion(gateway: Pick<LlmGateway, "complete">, opts: { tenantId: string; role: string; runId?: string }): DataChatCompletion {
  const runId = opts.runId ?? `data_chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return async (request) => {
    const r: GatewayCallResult = await gateway.complete({ tenantId: opts.tenantId, runId, lane: "interactive", role: opts.role, request });
    return r;
  };
}

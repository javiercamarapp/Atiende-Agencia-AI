// Adaptador de produccion del clasificador LLM de derechos ARCO (red de seguridad de la capa regex, ver packages/domain-restaurantes/src/privacidad/clasificador-arco.ts).
// Va por el gateway LLM unico con el rol `restaurantes:clasificador_arco`: proveedores de EE.UU. con ZDR, interruptor de plataforma, tope diario por organizacion y por rol,
// tope mensual y registro del costo real por rol en core.llm_usage_daily (el costo queda como componente propio en el control de gasto de API). Cualquier falla degrada a la capa
// regex y NUNCA bloquea el pedido. Los eventos que se registran no llevan texto del cliente.
import { randomUUID } from "node:crypto";
import type { LlmGateway } from "@atiende/agent-core";
import { crearClasificadorArco, type ClasificadorArco, type CompletarJson, type EventoClasificador } from "@atiende/domain-restaurantes";
import { RESTAURANTES_CLASIFICADOR_ARCO_ROLE } from "../production/llm-models.ts";

export const CLASIFICADOR_ARCO_TIMEOUT_MS = 2000;

export interface OpcionesClasificadorArcoGateway {
  readonly gateway: LlmGateway;
  readonly timeoutMs?: number;
  /** Por omision, una linea JSON a la consola (sin PII). */
  readonly alFinalizar?: (evento: EventoClasificador) => void;
}

export function registrarEventoClasificador(e: EventoClasificador): void {
  console.info(JSON.stringify({ level: e.ok ? "info" : "warn", event: "arco_clasificador", ...e }));
}

export function crearClasificadorArcoConGateway(opts: OpcionesClasificadorArcoGateway): ClasificadorArco {
  const completar: CompletarJson = async (e) => {
    const r = await opts.gateway.complete({
      tenantId: e.organizationId,
      runId: randomUUID(),
      lane: "interactive",
      role: RESTAURANTES_CLASIFICADOR_ARCO_ROLE,
      request: {
        system: e.system,
        messages: [{ role: "user", content: e.user }],
        maxOutputTokens: e.maxOutputTokens,
        responseFormat: { name: e.schemaName, schema: e.schema },
        signal: e.signal,
      },
    });
    return { text: r.text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd };
  };
  return crearClasificadorArco({ completar, timeoutMs: opts.timeoutMs ?? CLASIFICADOR_ARCO_TIMEOUT_MS, alFinalizar: opts.alFinalizar ?? registrarEventoClasificador });
}

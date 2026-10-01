// H-03 -- gobierno de un agente en tiempo de ejecucion: kill switch por property + presupuesto mensual propio
// + registro del costo de cada llamada. Lo usa quien corre un agente en SESION DE SISTEMA (el turno de WhatsApp,
// el barrido de revenue). Compatible con la base sin migrar: sin la migracion 035 `gate` devuelve null y el
// agente corre exactamente como antes; un fallo de lectura/escritura del acumulado nunca tumba el turno.
import type { AgentesRepository } from "./repository.ts";
import { agentRunState, currentUsageMonth, usdToMicroUsd } from "./guardrails.ts";
import type { AgentRunState } from "./guardrails.ts";
import type { AgentKey } from "./tipos.ts";

/** Acumula el costo/tokens de las llamadas de un turno. */
export class AgentCostMeter {
  tokensIn = 0;
  tokensOut = 0;
  costMicroUsd = 0;
  calls = 0;

  add(r: { tokensIn?: number; tokensOut?: number; costUsd?: number }): void {
    this.tokensIn += Math.max(0, Math.trunc(r.tokensIn ?? 0));
    this.tokensOut += Math.max(0, Math.trunc(r.tokensOut ?? 0));
    this.costMicroUsd += Math.max(0, usdToMicroUsd(r.costUsd ?? 0));
    this.calls += 1;
  }
}

/** Envuelve un gateway (cualquier objeto con `complete`) para medir el costo de cada llamada sin cambiar su contrato. */
export function meterGateway<A extends unknown[], R extends { tokensIn: number; tokensOut: number; costUsd: number }>(
  gateway: { complete: (...args: A) => Promise<R> },
  meter: AgentCostMeter,
): { complete: (...args: A) => Promise<R> } {
  return {
    complete: async (...args: A) => {
      const result = await gateway.complete(...args);
      meter.add(result);
      return result;
    },
  };
}

export interface GovernedRunArgs<T> {
  readonly repo: AgentesRepository;
  readonly propertyId: string;
  readonly agentKey: AgentKey;
  readonly now: Date;
  /** Camino normal (el agente corre). Recibe el medidor para envolver su gateway. */
  readonly run: (meter: AgentCostMeter) => Promise<T>;
  /** Camino cuando el agente esta pausado o sin presupuesto: debe llevar el caso a una persona. */
  readonly blocked: (state: Exclude<AgentRunState, "activo">) => Promise<T>;
  readonly onError?: (err: unknown) => void;
}

/**
 * Consulta la compuerta del agente; si esta activo lo corre y registra su costo; si esta pausado o agoto su
 * presupuesto, NO lo corre y ejecuta `blocked` (derivar a una persona). Un error de la compuerta o del
 * registro de costo es fail-open (se loguea y el turno sigue): es un control operativo, los topes de gasto
 * de la organizacion y de la plataforma siguen aplicando en el gateway.
 */
export async function runGovernedAgent<T>(a: GovernedRunArgs<T>): Promise<T> {
  const month = currentUsageMonth(a.now);
  let state: AgentRunState = "activo";
  try {
    state = agentRunState(await a.repo.gate(a.propertyId, a.agentKey, month));
  } catch (err) {
    a.onError?.(err);
  }
  if (state !== "activo") return a.blocked(state);
  const meter = new AgentCostMeter();
  try {
    return await a.run(meter);
  } finally {
    if (meter.calls > 0) {
      try {
        await a.repo.recordUsage(a.propertyId, a.agentKey, month, { tokensIn: meter.tokensIn, tokensOut: meter.tokensOut, costMicroUsd: meter.costMicroUsd, calls: meter.calls });
      } catch (err) {
        a.onError?.(err);
      }
    }
  }
}

// RunBudget: portado sin cambios de hoteles/packages/agent-core/src/budget.ts — un
// solo reloj compartido por tokens/tiempo/costo estimado, consultado por cada etapa de
// una corrida.
//
// LaneBudgetTracker: NUEVO. A diferencia de RunBudget (en memoria, vive y muere con
// una corrida), el presupuesto por carril es persistente y compartido entre instancias
// de `apps/api` — necesita respaldo en Postgres. Mismo patrón que
// `postgresApproval.ts` de hoteles (una interfaz aquí, una implementación Postgres
// separada): esta interfaz vive en `@atiende/agent-core`, una implementación real
// (`PostgresLaneBudgetStore`) vive en `packages/db` cuando se construya (fuera de
// alcance de este esqueleto). `createInMemoryLaneBudgetTracker` es SOLO para pruebas y
// desarrollo local — nunca compartido entre procesos, se dice explícito en su nombre.
import type { AgentLane } from "./router.ts";
import { laneKey } from "./router.ts";

export interface BudgetLimits {
  readonly maxTokens?: number;
  readonly maxMs?: number;
  readonly maxUsd?: number;
}

export interface BudgetSnapshot {
  readonly tokensUsed: number;
  readonly elapsedMs: number;
  readonly usdSpent: number;
}

export interface RunBudget {
  readonly limits: BudgetLimits;
  snapshot(): BudgetSnapshot;
  remainingMs(): number | undefined;
  remainingTokens(): number | undefined;
  remainingUsd(): number | undefined;
  /** true si CUALQUIER dimensión configurada ya llegó a su tope. */
  agotado(): boolean;
  registrarTokens(inputTokens: number, outputTokens: number): void;
  registrarCostoUsd(usd: number): void;
}

export function createRunBudget(limits: BudgetLimits, now: () => number = Date.now): RunBudget {
  const start = now();
  let tokensUsed = 0;
  let usdSpent = 0;

  return {
    limits,
    snapshot(): BudgetSnapshot {
      return { tokensUsed, elapsedMs: now() - start, usdSpent };
    },
    remainingMs(): number | undefined {
      if (limits.maxMs === undefined) return undefined;
      return Math.max(0, limits.maxMs - (now() - start));
    },
    remainingTokens(): number | undefined {
      if (limits.maxTokens === undefined) return undefined;
      return Math.max(0, limits.maxTokens - tokensUsed);
    },
    remainingUsd(): number | undefined {
      if (limits.maxUsd === undefined) return undefined;
      return Math.max(0, limits.maxUsd - usdSpent);
    },
    agotado(): boolean {
      if (limits.maxMs !== undefined && now() - start >= limits.maxMs) return true;
      if (limits.maxTokens !== undefined && tokensUsed >= limits.maxTokens) return true;
      if (limits.maxUsd !== undefined && usdSpent >= limits.maxUsd) return true;
      return false;
    },
    registrarTokens(inputTokens: number, outputTokens: number): void {
      tokensUsed += inputTokens + outputTokens;
    },
    registrarCostoUsd(usd: number): void {
      usdSpent += usd;
    },
  };
}

export interface LaneBudgetLimits {
  readonly maxUsdPerDay?: number;
  readonly maxUsdPerMonth?: number;
}

export interface LaneBudgetTracker {
  remainingUsd(lane: AgentLane): Promise<number | undefined>;
  agotado(lane: AgentLane): Promise<boolean>;
  registrarCostoUsd(lane: AgentLane, usd: number): Promise<void>;
}

/** El presupuesto por carril (persistente, ver LaneBudgetTracker) ya se agotó — la
 * llamada NUNCA se intenta contra ningún proveedor. */
export class LaneBudgetExceededError extends Error {
  readonly lane: AgentLane;

  constructor(lane: AgentLane) {
    super(`el carril "${laneKey(lane)}" agotó su presupuesto de costo — la llamada se bloqueó antes de intentarse.`);
    this.name = "LaneBudgetExceededError";
    this.lane = lane;
  }
}

/**
 * Implementación SOLO para pruebas/desarrollo local: en memoria de proceso, se pierde
 * al reiniciar, NUNCA se comparte entre instancias de `apps/api` — nunca usar en
 * producción real (ahí corresponde `PostgresLaneBudgetStore` de `packages/db`, aún no
 * construido). `limits` es por carril (clave = `laneKey(lane)`): un carril sin límite
 * configurado nunca se considera agotado.
 */
export function createInMemoryLaneBudgetTracker(
  limitsByLane: Readonly<Record<string, LaneBudgetLimits>> = {},
): LaneBudgetTracker {
  const spentByLane = new Map<string, number>();

  function limitFor(key: string): number | undefined {
    const limits = limitsByLane[key];
    if (!limits) return undefined;
    const candidates = [limits.maxUsdPerDay, limits.maxUsdPerMonth].filter(
      (v): v is number => v !== undefined,
    );
    if (candidates.length === 0) return undefined;
    return Math.min(...candidates);
  }

  return {
    async remainingUsd(lane: AgentLane): Promise<number | undefined> {
      const key = laneKey(lane);
      const limit = limitFor(key);
      if (limit === undefined) return undefined;
      return Math.max(0, limit - (spentByLane.get(key) ?? 0));
    },
    async agotado(lane: AgentLane): Promise<boolean> {
      const key = laneKey(lane);
      const limit = limitFor(key);
      if (limit === undefined) return false;
      return (spentByLane.get(key) ?? 0) >= limit;
    },
    async registrarCostoUsd(lane: AgentLane, usd: number): Promise<void> {
      const key = laneKey(lane);
      spentByLane.set(key, (spentByLane.get(key) ?? 0) + usd);
    },
  };
}

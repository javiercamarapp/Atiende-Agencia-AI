import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { InMemoryOrgMonthlyBudgetStore } from '../../src/gateway/org-monthly-budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { isMonthlyBudgetExceededError, MonthlyBudgetExceededError } from '../../src/gateway/errors.js';
import type { LlmCompletionRequest } from '../../src/gateway/types.js';

const FIXED_COST_USD = 0.01; // 10_000 micro-USD

function req(): LlmCompletionRequest {
  return { system: 'eres un asistente', messages: [{ role: 'user', content: 'hola' }] };
}

function fixedCostProvider(id: string): FakeLlmProvider {
  return new FakeLlmProvider({
    id,
    script: async () => ({ text: `ok-${id}`, model: `${id}/m`, tokensIn: 10, tokensOut: 10, costUsd: FIXED_COST_USD }),
  });
}

function buildGateway(store: InMemoryOrgMonthlyBudgetStore, provider: FakeLlmProvider): LlmGateway {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    // Techos diario/de-corrida generosos a propósito: estos tests solo
    // ejercitan el tope MENSUAL, nunca deben chocar con el diario.
    budgetLimits: { maxRunUsd: 1000, maxTenantDailyUsd: 1000 },
    costEstimator: () => FIXED_COST_USD,
    orgMonthlyBudgetStore: store,
  });
  gateway.registerLadder('chat', [provider]);
  return gateway;
}

describe('LlmGateway — tope MENSUAL por organización y de plataforma', () => {
  it('bloquea por tope MENSUAL de la organización antes de llamar al proveedor: no se cobra nada', async () => {
    const provider = fixedCostProvider('p1');
    const store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 15_000, platformCapMicroUsd: 1_000_000 });
    const gateway = buildGateway(store, provider);

    // Primera llamada cabe (10_000 <= 15_000).
    const first = await gateway.complete({ tenantId: 'org-A', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(first.providerId).toBe('p1');
    expect(provider.callCount).toBe(1);

    // Segunda llamada NO cabe (10_000 + 10_000 > 15_000).
    const second = gateway.complete({ tenantId: 'org-A', runId: 'r2', lane: 'interactive', role: 'chat', request: req() });
    await expect(second).rejects.toThrow(MonthlyBudgetExceededError);
    await second.catch((err) => {
      expect(isMonthlyBudgetExceededError(err)).toBe(true);
      expect((err as MonthlyBudgetExceededError).scope).toBe('organization');
    });
    expect(provider.callCount).toBe(1); // NUNCA se llamó al proveedor la segunda vez.
  });

  it('una organización DISTINTA no se ve afectada por el tope agotado de otra (topes independientes)', async () => {
    const provider = fixedCostProvider('p1');
    const store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 15_000, platformCapMicroUsd: 1_000_000 });
    const gateway = buildGateway(store, provider);

    await gateway.complete({ tenantId: 'org-A', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    await expect(gateway.complete({ tenantId: 'org-A', runId: 'r2', lane: 'interactive', role: 'chat', request: req() })).rejects.toThrow(MonthlyBudgetExceededError);

    const resultB = await gateway.complete({ tenantId: 'org-B', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(resultB.providerId).toBe('p1');
  });

  it('bloquea por tope GLOBAL de plataforma aunque cada organización individual siga por debajo de su propio tope', async () => {
    const provider = fixedCostProvider('p1');
    // Cada organización tiene margen de sobra (100_000) pero la plataforma
    // completa solo alcanza para 2 llamadas de FIXED_COST_USD (10_000 c/u).
    const store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 100_000, platformCapMicroUsd: 20_000 });
    const gateway = buildGateway(store, provider);

    await gateway.complete({ tenantId: 'org-A', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    await gateway.complete({ tenantId: 'org-B', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });

    const thirdOrgC = gateway.complete({ tenantId: 'org-C', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    await expect(thirdOrgC).rejects.toThrow(MonthlyBudgetExceededError);
    await thirdOrgC.catch((err) => {
      expect((err as MonthlyBudgetExceededError).scope).toBe('platform');
    });
    expect(provider.callCount).toBe(2);
  });

  it('el tope es COMPARTIDO entre dos instancias del gateway sobre el MISMO store (persistente, no por-instancia)', async () => {
    const store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 15_000, platformCapMicroUsd: 1_000_000 });
    const providerX = fixedCostProvider('px');
    const providerY = fixedCostProvider('py');
    const gatewayInstance1 = buildGateway(store, providerX);
    const gatewayInstance2 = buildGateway(store, providerY);

    // La primera llamada la hace la instancia 1 (simula una instancia de
    // Vercel Fluid Compute) — consume la mayor parte del tope de "org-shared".
    const first = await gatewayInstance1.complete({ tenantId: 'org-shared', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(first.providerId).toBe('px');

    // La SEGUNDA llamada la hace una instancia DISTINTA del gateway (mismo
    // store) — si el tope fuera en memoria de proceso (como el diario en
    // budget.ts), esta llamada pasaría sin problema porque "no lo sabe".
    // Persistente-entre-instancias significa que SÍ debe bloquearla.
    const second = gatewayInstance2.complete({ tenantId: 'org-shared', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    await expect(second).rejects.toThrow(MonthlyBudgetExceededError);
    expect(providerY.callCount).toBe(0);
  });

  it('el liquidado (settle) ajusta la reserva al costo real, liberando espacio para la siguiente llamada', async () => {
    const cheapResult = { text: 'ok', model: 'p1/m', tokensIn: 1, tokensOut: 1, costUsd: 0.001 }; // 1_000 micro-USD real
    const provider = new FakeLlmProvider({ id: 'p1', script: async () => cheapResult });
    const store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 15_000, platformCapMicroUsd: 1_000_000 });
    // Estimador sobre-reserva a 10_000 pero el costo real liquidado es 1_000 —
    // el settle debe liberar los 9_000 de diferencia.
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1000, maxTenantDailyUsd: 1000 },
      costEstimator: () => FIXED_COST_USD,
      orgMonthlyBudgetStore: store,
    });
    gateway.registerLadder('chat', [provider]);

    await gateway.complete({ tenantId: 'org-settle', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    // Si el settle NO liberara el sobrante, la reserva seguiría en 10_000 y
    // esta segunda llamada (que también estima 10_000) excedería 15_000.
    const second = await gateway.complete({ tenantId: 'org-settle', runId: 'r2', lane: 'interactive', role: 'chat', request: req() });
    expect(second.providerId).toBe('p1');
  });
});

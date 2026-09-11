import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { GatewayBudgetExceededError, isBudgetExceededError } from '../../src/gateway/errors.js';
import type { LlmCompletionRequest } from '../../src/gateway/types.js';

const FIXED_COST_USD = 0.006;

/** Estimador fijo: en estos tests la reserva y el costo real del proveedor
 *  son EL MISMO número, para poder razonar exactamente sobre cuántas
 *  llamadas caben en un techo dado sin depender del margen conservador del
 *  estimador por defecto (`defaultCostEstimator`), que sobre-reserva a
 *  propósito (ver gateway.ts) y haría el test dependiente de detalles de
 *  implementación en vez del comportamiento de bloqueo en sí. */
const fixedCostEstimator = () => FIXED_COST_USD;

function req(): LlmCompletionRequest {
  return { system: 'eres un asistente', messages: [{ role: 'user', content: 'hola' }] };
}

function fixedCostProvider(id: string): FakeLlmProvider {
  return new FakeLlmProvider({
    id,
    script: async () => ({ text: `ok-${id}`, model: `${id}/m`, tokensIn: 10, tokensOut: 10, costUsd: FIXED_COST_USD }),
  });
}

describe('LlmGateway — presupuesto con reserva-antes-de-gastar', () => {
  it('bloquea por techo de CORRIDA (run) antes de llamar al proveedor: no se cobra nada', async () => {
    const provider = fixedCostProvider('p1');
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 0.001, maxTenantDailyUsd: 5 }, // menor que FIXED_COST_USD
      costEstimator: fixedCostEstimator,
    });
    gateway.registerLadder('chat', [provider]);

    const promise = gateway.complete({ tenantId: 't-run', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    await expect(promise).rejects.toThrow(GatewayBudgetExceededError);
    await promise.catch((err) => {
      expect(isBudgetExceededError(err)).toBe(true);
      expect((err as GatewayBudgetExceededError).scope).toBe('run');
    });
    expect(provider.callCount).toBe(0); // NUNCA se llamó al proveedor: se bloqueó ANTES de gastar
  });

  it('bloquea por techo DIARIO del tenant en la segunda llamada, tras agotarlo en la primera', async () => {
    const provider = fixedCostProvider('p1');
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      // Techo diario alcanza para UNA llamada (0.006) pero no para dos (0.012).
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: FIXED_COST_USD * 1.5 },
      costEstimator: fixedCostEstimator,
    });
    gateway.registerLadder('chat', [provider]);

    const first = await gateway.complete({ tenantId: 't-daily', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(first.providerId).toBe('p1');
    expect(provider.callCount).toBe(1);

    const secondPromise = gateway.complete({ tenantId: 't-daily', runId: 'r2', lane: 'interactive', role: 'chat', request: req() });
    await expect(secondPromise).rejects.toThrow(GatewayBudgetExceededError);
    await secondPromise.catch((err) => {
      expect((err as GatewayBudgetExceededError).scope).toBe('tenant');
    });
    // La corrida bloqueada NUNCA llamó al proveedor una segunda vez.
    expect(provider.callCount).toBe(1);
  });

  it('un tenant DISTINTO no se ve afectado por el techo agotado de otro tenant', async () => {
    const provider = fixedCostProvider('p1');
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: FIXED_COST_USD * 1.5 },
      costEstimator: fixedCostEstimator,
    });
    gateway.registerLadder('chat', [provider]);

    await gateway.complete({ tenantId: 'tenant-A', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    await expect(
      gateway.complete({ tenantId: 'tenant-A', runId: 'r2', lane: 'interactive', role: 'chat', request: req() }),
    ).rejects.toThrow(GatewayBudgetExceededError);

    // tenant-B tiene su propio techo, intacto.
    const resultB = await gateway.complete({ tenantId: 'tenant-B', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(resultB.providerId).toBe('p1');
  });

  it('el carril "background" respeta la reserva protegida del carril "interactive" (no puede tocarla)', async () => {
    const provider = fixedCostProvider('p1');
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      // Techo diario 0.01; con 40% reservado a 'interactive' (default), la
      // parte que 'background' puede tocar es 0.006 — justo UNA llamada de
      // FIXED_COST_USD (0.006), la segunda ya no cabe en la porción no-interactiva.
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 0.01 },
      costEstimator: fixedCostEstimator,
    });
    gateway.registerLadder('chat', [provider]);

    const first = await gateway.complete({ tenantId: 't-lane', runId: 'r1', lane: 'background', role: 'chat', request: req() });
    expect(first.providerId).toBe('p1');

    const secondPromise = gateway.complete({ tenantId: 't-lane', runId: 'r2', lane: 'background', role: 'chat', request: req() });
    await expect(secondPromise).rejects.toThrow(GatewayBudgetExceededError);
    await secondPromise.catch((err) => {
      expect((err as GatewayBudgetExceededError).scope).toBe('lane');
    });

    // Pero el carril 'interactive' SÍ puede seguir gastando: tiene su 0.004
    // de reserva protegida intacta (0.01 - 0.006 de 'background') — aquí se
    // prueba con una llamada de costo menor a esa reserva para no chocar
    // también con el techo diario total.
    const cheapProvider = new FakeLlmProvider({
      id: 'p1',
      script: async () => ({ text: 'ok', model: 'p1/m', tokensIn: 1, tokensOut: 1, costUsd: 0.001 }),
    });
    const gateway2 = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 0.01 },
      costEstimator: () => 0.001,
    });
    gateway2.registerLadder('chat', [cheapProvider]);
    const interactiveResult = await gateway2.complete({
      tenantId: 't-lane-2',
      runId: 'r1',
      lane: 'interactive',
      role: 'chat',
      request: req(),
    });
    expect(interactiveResult.providerId).toBe('p1');
  });
});

import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { AllProvidersFailedError } from '../../src/gateway/errors.js';

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
  });
}

function req(text = 'hola') {
  return { system: 'eres un asistente', messages: [{ role: 'user' as const, content: text }] };
}

describe('LlmGateway — escalera de fallback', () => {
  it('cae al SEGUNDO proveedor cuando el primario falla con un error reintentable (502)', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({
      id: 'primary',
      // Mismo formato que los adaptadores reales (providers/openrouter.ts,
      // .../anthropic.ts, .../openai.ts): el status HTTP viaja tanto en el
      // mensaje como en `.status`, para que `isRetryableProviderError` lo
      // detecte por tipo y para que el mensaje sea diagnosticable en logs.
      failWith: () => Object.assign(new Error('OpenRouter 502: upstream caído'), { status: 502 }),
    });
    const fallback = new FakeLlmProvider({ id: 'fallback' });
    gateway.registerLadder('chat', [primary, fallback]);

    const result = await gateway.complete({ tenantId: 't1', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });

    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(1);
    expect(result.providerId).toBe('fallback');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts).toEqual([{ providerId: 'primary', error: expect.stringContaining('502') }]);
  });

  it('usa el primario directo (fallbackUsed=false) cuando responde bien', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({ id: 'primary' });
    const fallback = new FakeLlmProvider({ id: 'fallback' });
    gateway.registerLadder('chat', [primary, fallback]);

    const result = await gateway.complete({ tenantId: 't1', runId: 'r2', lane: 'interactive', role: 'chat', request: req() });

    expect(primary.callCount).toBe(1);
    expect(fallback.callCount).toBe(0);
    expect(result.providerId).toBe('primary');
    expect(result.fallbackUsed).toBe(false);
  });

  it('un error de red (timeout) también dispara el fallback', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({
      id: 'primary',
      failWith: () => new Error('fetch failed: network timeout'),
    });
    const fallback = new FakeLlmProvider({ id: 'fallback' });
    gateway.registerLadder('chat', [primary, fallback]);

    const result = await gateway.complete({ tenantId: 't1', runId: 'r3', lane: 'interactive', role: 'chat', request: req() });
    expect(result.providerId).toBe('fallback');
  });

  it('un error NO reintentable (400 de negocio) detiene la escalera de inmediato, sin probar el fallback', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({
      id: 'primary',
      failWith: () => Object.assign(new Error('input inválido'), { status: 400 }),
    });
    const fallback = new FakeLlmProvider({ id: 'fallback' });
    gateway.registerLadder('chat', [primary, fallback]);

    await expect(
      gateway.complete({ tenantId: 't1', runId: 'r4', lane: 'interactive', role: 'chat', request: req() }),
    ).rejects.toThrow('input inválido');
    expect(fallback.callCount).toBe(0);
  });

  it('lanza AllProvidersFailedError con el detalle de CADA intento cuando toda la escalera falla', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({ id: 'primary', failWith: () => Object.assign(new Error('caído'), { status: 503 }) });
    const fallback = new FakeLlmProvider({ id: 'fallback', failWith: () => Object.assign(new Error('también caído'), { status: 503 }) });
    gateway.registerLadder('chat', [primary, fallback]);

    const promise = gateway.complete({ tenantId: 't1', runId: 'r5', lane: 'interactive', role: 'chat', request: req() });
    await expect(promise).rejects.toThrow(AllProvidersFailedError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(AllProvidersFailedError);
      const e = err as InstanceType<typeof AllProvidersFailedError>;
      expect(e.attempts.map((a) => a.providerId)).toEqual(['primary', 'fallback']);
    }
  });
});

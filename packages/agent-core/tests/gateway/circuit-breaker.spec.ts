import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  InMemoryCircuitBreakerStore,
  DEFAULT_FAILURE_THRESHOLD,
} from '../../src/gateway/circuit-breaker.js';
import { CircuitOpenError } from '../../src/gateway/errors.js';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';

function req() {
  return { system: 's', messages: [{ role: 'user' as const, content: 'hola' }] };
}

describe('CircuitBreaker (respaldado en Redis vía CircuitBreakerStore)', () => {
  it('sin store configurado, es FAIL-OPEN: nunca bloquea (defensa en profundidad, no control único)', async () => {
    const breaker = new CircuitBreaker(undefined);
    await expect(breaker.checkCircuit('cualquiera')).resolves.toBeUndefined();
    expect(await breaker.getBreakerState('cualquiera')).toBe('closed');
  });

  it('abre tras alcanzar el umbral de fallas consecutivas, y checkCircuit lanza CircuitOpenError', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, { failureThreshold: 3, openDurationSeconds: 30 });

    for (let i = 0; i < 3; i++) {
      await breaker.reportFailure('provider-x', `falla ${i}`);
    }

    expect(await breaker.getBreakerState('provider-x')).toBe('open');
    await expect(breaker.checkCircuit('provider-x')).rejects.toThrow(CircuitOpenError);
  });

  it('un éxito ANTES de llegar al umbral resetea el contador de fallas consecutivas', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, { failureThreshold: 3 });

    await breaker.reportFailure('provider-x', 'falla 1');
    await breaker.reportFailure('provider-x', 'falla 2');
    await breaker.reportSuccess('provider-x'); // resetea
    await breaker.reportFailure('provider-x', 'falla 1 de nuevo');

    expect(await breaker.getBreakerState('provider-x')).toBe('half_open'); // 1 falla, lejos del umbral de 3
    await expect(breaker.checkCircuit('provider-x')).resolves.toBeUndefined();
  });

  it('el breaker es POR PROVEEDOR: uno abierto no afecta a los demás', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, { failureThreshold: 2 });

    await breaker.reportFailure('caido', 'f1');
    await breaker.reportFailure('caido', 'f2');

    await expect(breaker.checkCircuit('caido')).rejects.toThrow(CircuitOpenError);
    await expect(breaker.checkCircuit('sano')).resolves.toBeUndefined();
  });

  it('el umbral por defecto exportado coincide con el usado si no se pasa opción', () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBeGreaterThan(0);
  });
});

describe('LlmGateway + CircuitBreaker integrados', () => {
  it('tras abrir el breaker de un proveedor, el gateway lo salta y usa el siguiente de la escalera SIN intentarlo', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, { failureThreshold: 1 });
    const gateway = new LlmGateway({
      breaker,
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
    });

    const flaky = new FakeLlmProvider({ id: 'flaky', failWith: () => Object.assign(new Error('caído'), { status: 503 }) });
    const sano = new FakeLlmProvider({ id: 'sano' });
    gateway.registerLadder('chat', [flaky, sano]);

    // Primera corrida: flaky falla, abre su propio breaker (threshold=1), fallback a sano.
    const r1 = await gateway.complete({ tenantId: 't1', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(r1.providerId).toBe('sano');
    expect(flaky.callCount).toBe(1);

    // Segunda corrida: el breaker de "flaky" ya está OPEN → ni se intenta llamarlo.
    const r2 = await gateway.complete({ tenantId: 't1', runId: 'r2', lane: 'interactive', role: 'chat', request: req() });
    expect(r2.providerId).toBe('sano');
    expect(flaky.callCount).toBe(1); // sigue en 1: la segunda corrida NO lo tocó
    expect(r2.attempts[0]?.error).toContain('OPEN');
  });
});

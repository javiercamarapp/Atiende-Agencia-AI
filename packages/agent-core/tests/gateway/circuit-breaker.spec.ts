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

describe('UpstashRestClient + RedisCircuitBreakerStore (breaker compartido entre instancias)', () => {
  it('abre el breaker tras N fallas consecutivas hablando comandos crudos de Upstash; dos "instancias" comparten el estado', async () => {
    const { UpstashRestClient } = await import('../../src/gateway/upstash-rest-client.js');
    const { RedisCircuitBreakerStore, CircuitBreaker } = await import('../../src/gateway/circuit-breaker.js');
    // Redis falso en memoria que entiende solo los comandos que usa el breaker.
    const kv = new Map<string, string>();
    const sent: unknown[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const cmd = JSON.parse(init.body as string) as (string | number)[];
      sent.push(cmd);
      const [op, key] = cmd as [string, string];
      let result: unknown = null;
      if (op === 'GET') result = kv.get(key) ?? null;
      else if (op === 'SET') kv.set(key, String(cmd[2]));
      else if (op === 'TTL') result = kv.has(key) ? 30 : -2;
      else if (op === 'DEL') result = kv.delete(key) ? 1 : 0;
      else if (op === 'EVAL') {
        const k = String(cmd[3]);
        const v = Number(kv.get(k) ?? 0) + 1;
        kv.set(k, String(v));
        result = v;
      }
      return { ok: true, status: 200, json: async () => ({ result }) } as Response;
    }) as unknown as typeof fetch;
    const client = new UpstashRestClient({ url: 'http://localhost:0', token: 'x', fetchImpl });
    const a = new CircuitBreaker(new RedisCircuitBreakerStore(client), { failureThreshold: 2 });
    const b = new CircuitBreaker(new RedisCircuitBreakerStore(client), { failureThreshold: 2 });

    await a.reportFailure('openrouter:m', 'x');
    await b.reportFailure('openrouter:m', 'x'); // otra instancia suma al MISMO contador
    await expect(a.checkCircuit('openrouter:m')).rejects.toThrow(/OPEN/);
    await expect(b.checkCircuit('openrouter:m')).rejects.toThrow(/OPEN/);
    expect(sent.some((c) => c[0] === 'EVAL')).toBe(true);
  });

  it('si Upstash falla, el breaker es fail-open (nunca tumba la llamada al modelo)', async () => {
    const { UpstashRestClient } = await import('../../src/gateway/upstash-rest-client.js');
    const { RedisCircuitBreakerStore, CircuitBreaker } = await import('../../src/gateway/circuit-breaker.js');
    const fetchImpl = (async () => {
      throw new Error('red caida');
    }) as unknown as typeof fetch;
    const breaker = new CircuitBreaker(new RedisCircuitBreakerStore(new UpstashRestClient({ url: 'http://localhost:0', token: 'x', fetchImpl })));
    await expect(breaker.checkCircuit('p')).resolves.toBeUndefined();
    await expect(breaker.reportFailure('p', 'x')).resolves.toBeUndefined();
  });
});

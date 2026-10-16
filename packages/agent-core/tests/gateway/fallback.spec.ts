import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { AllProvidersFailedError } from '../../src/gateway/errors.js';
import { OpenRouterError, classifyOpenRouterStatus } from '../../src/gateway/providers/openrouter.js';

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

describe('LlmGateway — streaming a medio camino', () => {
  const fail502 = () => Object.assign(new Error('OpenRouter 502: upstream cayo a medio stream'), { status: 502 });

  it('si el primer escalon ya entrego texto y falla, NO pasa al siguiente (no duplica la salida)', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({
      id: 'primary',
      script: (r) => {
        r.onTextDelta?.('Las ventas de ayer fueron ');
        throw fail502();
      },
    });
    const fallback = new FakeLlmProvider({ id: 'fallback', script: (r) => { r.onTextDelta?.('texto completo del respaldo'); return { text: 'texto completo del respaldo', model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 }; } });
    gateway.registerLadder('chat', [primary, fallback]);

    const received: string[] = [];
    await expect(
      gateway.complete({ tenantId: 't1', runId: 'r1', lane: 'interactive', role: 'chat', request: { ...req(), onTextDelta: (d) => received.push(d) } }),
    ).rejects.toThrow(/502/);

    expect(received).toEqual(['Las ventas de ayer fueron ']);
    expect(fallback.callCount).toBe(0);
  });

  it('si el primer escalon falla ANTES de emitir texto, el streaming sigue cayendo al siguiente', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({ id: 'primary', failWith: fail502 });
    const fallback = new FakeLlmProvider({ id: 'fallback', script: (r) => { r.onTextDelta?.('respuesta completa'); return { text: 'respuesta completa', model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 }; } });
    gateway.registerLadder('chat', [primary, fallback]);

    const received: string[] = [];
    const result = await gateway.complete({ tenantId: 't1', runId: 'r1', lane: 'interactive', role: 'chat', request: { ...req(), onTextDelta: (d) => received.push(d) } });

    expect(result.providerId).toBe('fallback');
    expect(received).toEqual(['respuesta completa']);
  });

  it('sin streaming (sin onTextDelta) el comportamiento de la escalera no cambia', async () => {
    const gateway = makeGateway();
    const primary = new FakeLlmProvider({ id: 'primary', script: () => { throw fail502(); } });
    const fallback = new FakeLlmProvider({ id: 'fallback' });
    gateway.registerLadder('chat', [primary, fallback]);
    const result = await gateway.complete({ tenantId: 't1', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(result.providerId).toBe('fallback');
  });
});

describe('LlmGateway — corte de credito (402 de OpenRouter, QA-PM-R6-whatsapp-02)', () => {
  const sinCredito = () => new OpenRouterError('OpenRouter 402 (m): sin credito', 402, { transient: false, ladderRetryable: classifyOpenRouterStatus(402).ladderRetryable });

  it('un 402 en el primer modelo prueba el siguiente (uno mas barato puede caber en el saldo) en vez de rendirse', async () => {
    const gateway = makeGateway();
    const caro = new FakeLlmProvider({ id: 'caro', failWith: sinCredito });
    const barato = new FakeLlmProvider({ id: 'barato' });
    gateway.registerLadder('chat', [caro, barato]);
    const result = await gateway.complete({ tenantId: 't1', runId: 'r402a', lane: 'interactive', role: 'chat', request: req() });
    expect(caro.callCount).toBe(1);
    expect(barato.callCount).toBe(1);
    expect(result.providerId).toBe('barato');
    expect(result.fallbackUsed).toBe(true);
  });

  it('si TODA la escalera da 402 se lanza AllProvidersFailedError con un intento por modelo (sin reintentar el mismo)', async () => {
    const gateway = makeGateway();
    const a = new FakeLlmProvider({ id: 'a', failWith: sinCredito });
    const b = new FakeLlmProvider({ id: 'b', failWith: sinCredito });
    gateway.registerLadder('chat', [a, b]);
    const err = await gateway.complete({ tenantId: 't1', runId: 'r402b', lane: 'interactive', role: 'chat', request: req() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AllProvidersFailedError);
    expect([a.callCount, b.callCount]).toEqual([1, 1]);
  });

  it('un 401 (llave invalida) sigue deteniendo la escalera: el siguiente modelo fallaria igual', async () => {
    const gateway = makeGateway();
    const a = new FakeLlmProvider({ id: 'a', failWith: () => new OpenRouterError('OpenRouter 401: llave', 401, classifyOpenRouterStatus(401)) });
    const b = new FakeLlmProvider({ id: 'b' });
    gateway.registerLadder('chat', [a, b]);
    const err = await gateway.complete({ tenantId: 't1', runId: 'r401', lane: 'interactive', role: 'chat', request: req() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(b.callCount).toBe(0);
  });

  it('el 402 NO cuenta fallos en el circuit breaker (recargar el credito no deja circuitos abiertos); un 502 si', async () => {
    const store = new InMemoryCircuitBreakerStore();
    const breaker = new CircuitBreaker(store, { failureThreshold: 2, openDurationSeconds: 60 });
    const gateway = new LlmGateway({ breaker, budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 } });
    const a = new FakeLlmProvider({ id: 'a', failWith: sinCredito });
    const b = new FakeLlmProvider({ id: 'b', failWith: sinCredito });
    gateway.registerLadder('chat', [a, b]);
    for (let i = 0; i < 4; i++) await gateway.complete({ tenantId: 't1', runId: `r402c${i}`, lane: 'interactive', role: 'chat', request: req() }).catch(() => undefined);
    expect(await breaker.getBreakerState('a')).toBe('closed');
    expect(await breaker.getBreakerState('b')).toBe('closed');
    expect(a.callCount).toBe(4);

    const c = new FakeLlmProvider({ id: 'c', failWith: () => Object.assign(new Error('OpenRouter 502'), { status: 502 }) });
    const d = new FakeLlmProvider({ id: 'd' });
    gateway.registerLadder('otro', [c, d]);
    for (let i = 0; i < 2; i++) await gateway.complete({ tenantId: 't1', runId: `r502${i}`, lane: 'interactive', role: 'otro', request: req() });
    expect(await breaker.getBreakerState('c')).toBe('open');
  });
});

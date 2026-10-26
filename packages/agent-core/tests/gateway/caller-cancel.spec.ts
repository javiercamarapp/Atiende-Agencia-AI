import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { esCancelacionDelLlamador, LlmCallCancelledError } from '../../src/gateway/errors.js';

// PM-R21: el hedging aborta la pata que pierde la carrera. Esa cancelacion NO es una falla del proveedor: no debe sumar al circuit breaker (5 fallas en 60 s lo abren
// 30 s y sacan al modelo de la escalera). Un tope de tiempo del llamador (abort sin motivo propio) SI sigue contando, como antes.
const colgado = new FakeLlmProvider({
  id: 'lento',
  model: 'a/lento',
  script: (req) =>
    new Promise((_resolve, reject) => {
      const abortar = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      if (req.signal?.aborted) abortar();
      else req.signal?.addEventListener('abort', abortar);
    }),
});

function build() {
  const store = new InMemoryCircuitBreakerStore();
  const breaker = new CircuitBreaker(store);
  const gateway = new LlmGateway({ breaker, budgetStore: new InMemoryBudgetLedgerStore(), budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 }, costEstimator: () => 0.001 });
  gateway.registerLadder('r:rol', [colgado]);
  return { gateway, breaker };
}

const llamar = (gateway: LlmGateway, signal: AbortSignal) =>
  gateway.complete({ tenantId: 'org-A', runId: 'r', lane: 'interactive', role: 'r:rol', request: { system: 's', messages: [{ role: 'user', content: 'hola' }], signal } });

describe('LlmGateway — cancelacion deliberada del llamador', () => {
  it('esCancelacionDelLlamador solo reconoce el motivo LlmCallCancelledError', () => {
    const a = new AbortController();
    expect(esCancelacionDelLlamador(a.signal)).toBe(false);
    a.abort();
    expect(esCancelacionDelLlamador(a.signal)).toBe(false);
    const b = new AbortController();
    b.abort(new LlmCallCancelledError());
    expect(esCancelacionDelLlamador(b.signal)).toBe(true);
    expect(esCancelacionDelLlamador(undefined)).toBe(false);
  });

  it('diez cancelaciones del llamador NO abren el circuit breaker del proveedor', async () => {
    const { gateway, breaker } = build();
    for (let i = 0; i < 10; i++) {
      const c = new AbortController();
      const p = llamar(gateway, c.signal);
      c.abort(new LlmCallCancelledError());
      await expect(p).rejects.toThrow();
    }
    expect(await breaker.getBreakerState('lento')).toBe('closed');
  });

  it('cinco topes de tiempo del llamador (abort sin motivo) siguen abriendo el breaker: el modelo que no contesta se saca de la escalera', async () => {
    const { gateway, breaker } = build();
    for (let i = 0; i < 5; i++) {
      const c = new AbortController();
      const p = llamar(gateway, c.signal);
      c.abort();
      await expect(p).rejects.toThrow();
    }
    expect(await breaker.getBreakerState('lento')).toBe('open');
  });
});

describe('LlmGateway — costo de la pata cancelada', () => {
  async function liquidacion(motivo: 'cancelada' | 'tope'): Promise<number[]> {
    const base = new InMemoryBudgetLedgerStore();
    const liquidados: number[] = [];
    const budgetStore = { reserve: base.reserve.bind(base), settle: async (t: string, id: string, usd: number) => { liquidados.push(usd); return base.settle(t, id, usd); } };
    const gateway = new LlmGateway({ breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()), budgetStore, budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 }, costEstimator: () => 0.5 });
    gateway.registerLadder('r:rol', [colgado]);
    const c = new AbortController();
    const p = llamar(gateway, c.signal);
    if (motivo === 'cancelada') c.abort(new LlmCallCancelledError());
    else c.abort();
    await expect(p).rejects.toThrow();
    return liquidados;
  }

  it('una pata cancelada por el llamador se liquida al estimado (el hedge cuenta como gasto), no a 0', async () => {
    expect(await liquidacion('cancelada')).toEqual([0.5]);
  });

  it('un fallo o tope normal sigue liberando la reserva a 0', async () => {
    expect(await liquidacion('tope')).toEqual([0]);
  });
});

import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { InMemoryOrgMonthlyBudgetStore } from '../../src/gateway/org-monthly-budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { isKillSwitchEngagedError, KillSwitchEngagedError, type GatewayKillSwitch } from '../../src/gateway/kill-switch.js';

function provider(): FakeLlmProvider {
  return new FakeLlmProvider({ id: 'p1', script: async () => ({ text: 'ok', model: 'p1/m', tokensIn: 1, tokensOut: 1, costUsd: 0.001 }) });
}

function build(killSwitch: GatewayKillSwitch | undefined, p: FakeLlmProvider, store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 1_000_000, platformCapMicroUsd: 1_000_000 })) {
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 },
    costEstimator: () => 0.001,
    orgMonthlyBudgetStore: store,
    killSwitch,
  });
  gateway.registerLadder('restaurantes:whatsapp_agent', [p]);
  gateway.registerLadder('hoteles:whatsapp_agent', [p]);
  return gateway;
}

const call = (gateway: LlmGateway, role: string) =>
  gateway.complete({ tenantId: 'org-A', runId: 'r', lane: 'interactive', role, request: { system: 's', messages: [{ role: 'user', content: 'hola' }] } });

describe('LlmGateway — interruptor de plataforma', () => {
  it('sin killSwitch el comportamiento es el de siempre', async () => {
    const p = provider();
    await expect(call(build(undefined, p), 'restaurantes:whatsapp_agent')).resolves.toMatchObject({ providerId: 'p1' });
  });

  it('un rol detenido NO llama al proveedor ni reserva presupuesto', async () => {
    const p = provider();
    const store = new InMemoryOrgMonthlyBudgetStore({ defaultOrgCapMicroUsd: 1_000_000, platformCapMicroUsd: 1_000_000 });
    const gateway = build({ blockedBy: async (role) => (role === 'restaurantes:whatsapp_agent' ? 'agente:restaurantes:whatsapp_agent' : null) }, p, store);
    const err = await call(gateway, 'restaurantes:whatsapp_agent').catch((e) => e);
    expect(err).toBeInstanceOf(KillSwitchEngagedError);
    expect(err.switchKey).toBe('agente:restaurantes:whatsapp_agent');
    expect(isKillSwitchEngagedError(err)).toBe(true);
    expect(p.callCount).toBe(0);
    // el otro rol sigue funcionando
    await expect(call(gateway, 'hoteles:whatsapp_agent')).resolves.toMatchObject({ providerId: 'p1' });
    expect(p.callCount).toBe(1);
  });

  it('un interruptor global detiene todos los roles', async () => {
    const p = provider();
    const gateway = build({ blockedBy: async () => 'global:llm' }, p);
    await expect(call(gateway, 'restaurantes:whatsapp_agent')).rejects.toThrow(KillSwitchEngagedError);
    await expect(call(gateway, 'hoteles:whatsapp_agent')).rejects.toThrow(KillSwitchEngagedError);
    expect(p.callCount).toBe(0);
  });

  it('si el propio puerto falla, es fail-open: la llamada procede y el fallo se registra', async () => {
    const p = provider();
    const gateway = build({ blockedBy: async () => { throw new Error('postgres caido'); } }, p);
    await expect(call(gateway, 'restaurantes:whatsapp_agent')).resolves.toMatchObject({ providerId: 'p1' });
  });

  it('isKillSwitchEngagedError reconoce el error envuelto en cause', () => {
    const inner = new KillSwitchEngagedError('global:llm', 'x');
    expect(isKillSwitchEngagedError(new Error('envuelto', { cause: inner }))).toBe(true);
    expect(isKillSwitchEngagedError(new Error('otro'))).toBe(false);
  });
});

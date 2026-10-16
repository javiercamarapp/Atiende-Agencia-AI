import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import type { GatewayKillSwitch } from '../../src/gateway/kill-switch.js';
import { KillSwitchEngagedError } from '../../src/gateway/kill-switch.js';

function proveedor(id: string, model: string, opts: { falla?: boolean } = {}): FakeLlmProvider {
  return new FakeLlmProvider({
    id,
    model,
    script: async () => {
      if (opts.falla) throw Object.assign(new Error('OpenRouter 502: upstream caido'), { status: 502 });
      return { text: id, model, tokensIn: 1, tokensOut: 1, costUsd: 0.001 };
    },
  });
}

function build(killSwitch?: GatewayKillSwitch) {
  const principal = proveedor('principal', 'a/principal');
  const respaldo = proveedor('respaldo', 'b/respaldo');
  const extra = proveedor('extra', 'c/extra');
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 },
    costEstimator: () => 0.001,
    killSwitch,
  });
  gateway.registerLadder('restaurantes:whatsapp_agent', [principal, respaldo]);
  gateway.registerAlternatives('restaurantes:whatsapp_agent', [extra]);
  return { gateway, principal, respaldo, extra };
}

const llamar = (gateway: LlmGateway, preferredModel?: string) =>
  gateway.complete({ tenantId: 'org-A', runId: 'r', lane: 'interactive', role: 'restaurantes:whatsapp_agent', request: { system: 's', messages: [{ role: 'user', content: 'hola' }] }, ...(preferredModel ? { preferredModel } : {}) });

describe('LlmGateway — modelo preferido por llamada', () => {
  it('sin modelo preferido usa la escalera del rol, como siempre', async () => {
    const { gateway, principal } = build();
    await expect(llamar(gateway)).resolves.toMatchObject({ providerId: 'principal', fallbackUsed: false });
    expect(principal.callCount).toBe(1);
  });

  it('un modelo de la escalera pasa al frente y el resto queda de respaldo', async () => {
    const { gateway, principal, respaldo } = build();
    await expect(llamar(gateway, 'b/respaldo')).resolves.toMatchObject({ providerId: 'respaldo', fallbackUsed: false });
    expect(respaldo.callCount).toBe(1);
    expect(principal.callCount).toBe(0);
  });

  it('una alternativa registrada se usa al frente y, si falla, cae a la escalera del rol', async () => {
    const { gateway, extra, principal } = build();
    await expect(llamar(gateway, 'c/extra')).resolves.toMatchObject({ providerId: 'extra' });
    expect(extra.callCount).toBe(1);
    expect(principal.callCount).toBe(0);

    const caida = proveedor('extra-caida', 'c/extra', { falla: true });
    const g2 = build().gateway;
    g2.registerAlternatives('restaurantes:whatsapp_agent', [caida]);
    await expect(llamar(g2, 'c/extra')).resolves.toMatchObject({ providerId: 'principal', fallbackUsed: true });
  });

  it('una alternativa con el mismo modelo que un escalon manda sobre el escalon (y no se repite en el respaldo)', async () => {
    const { gateway, principal } = build();
    const conTemperatura = proveedor('principal-con-temperatura', 'a/principal');
    gateway.registerAlternatives('restaurantes:whatsapp_agent', [conTemperatura]);
    await expect(llamar(gateway, 'a/principal')).resolves.toMatchObject({ providerId: 'principal-con-temperatura', fallbackUsed: false });
    expect(principal.callCount).toBe(0);
    // sin modelo preferido el escalon original sigue siendo el de la escalera
    await expect(llamar(gateway)).resolves.toMatchObject({ providerId: 'principal' });
  });

  it('un modelo no registrado se IGNORA: nunca se llama a un modelo no listado', async () => {
    const { gateway, principal, extra } = build();
    await expect(llamar(gateway, 'x/no-listado')).resolves.toMatchObject({ providerId: 'principal' });
    expect(principal.callCount).toBe(1);
    expect(extra.callCount).toBe(0);
  });

  it('las alternativas no entran a la escalera por defecto (un fallo no cae a ellas)', async () => {
    const { extra } = build();
    const g = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 },
      costEstimator: () => 0.001,
    });
    g.registerLadder('r', [proveedor('solo', 'a/solo', { falla: true })]);
    g.registerAlternatives('r', [extra]);
    await expect(g.complete({ tenantId: 't', runId: 'r', lane: 'interactive', role: 'r', request: { system: 's', messages: [{ role: 'user', content: 'x' }] } })).rejects.toThrow();
    expect(extra.callCount).toBe(0);
  });

  it('elegir modelo no esquiva el interruptor de plataforma del rol', async () => {
    const { gateway, extra } = build({ blockedBy: async (role) => (role === 'restaurantes:whatsapp_agent' ? 'agente:restaurantes:whatsapp_agent' : null) });
    await expect(llamar(gateway, 'c/extra')).rejects.toBeInstanceOf(KillSwitchEngagedError);
    expect(extra.callCount).toBe(0);
  });

  it('una alternativa sin modelo declarado se rechaza al registrar', () => {
    const { gateway } = build();
    const sinModelo = new FakeLlmProvider({ id: 'sin-modelo', script: async () => ({ text: 'x', model: 'm', tokensIn: 1, tokensOut: 1, costUsd: 0 }) });
    expect(() => gateway.registerAlternatives('restaurantes:whatsapp_agent', [sinModelo])).toThrow(/declarar su modelo/);
  });
});

import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';

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

function build(opts: { zdr?: boolean; lunaZdrFalla?: boolean } = {}) {
  const normal = proveedor('normal', 'openai/gpt-6-luna');
  const sinZdr = proveedor('sin-zdr', 'meta/muse-spark-1.3');
  const lunaZdr = proveedor('luna-zdr', 'openai/gpt-6-luna', { falla: opts.lunaZdrFalla });
  const haikuZdr = proveedor('haiku-zdr', 'anthropic/claude-haiku-5.5');
  const rapidoZdr = proveedor('rapido-zdr', 'google/gemini-3.5-flash-lite');
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 100, maxTenantDailyUsd: 100 },
    costEstimator: () => 0.001,
  });
  gateway.registerLadder('restaurantes:whatsapp_agent', [normal, sinZdr]);
  if (opts.zdr !== false) gateway.registerZdrLadder('restaurantes:whatsapp_agent', [lunaZdr, haikuZdr], [rapidoZdr]);
  return { gateway, normal, sinZdr, lunaZdr, haikuZdr, rapidoZdr };
}

const llamar = (gateway: LlmGateway, o: { zdrEstricto?: boolean; preferredModel?: string } = {}) =>
  gateway.complete({ tenantId: 'org-A', runId: 'r', lane: 'interactive', role: 'restaurantes:whatsapp_agent', request: { system: 's', messages: [{ role: 'user', content: 'hola' }] }, ...o });

describe('LlmGateway — retencion cero estricta (cerebro v2)', () => {
  it('sin zdrEstricto la llamada usa la escalera de siempre', async () => {
    const { gateway, normal, lunaZdr } = build();
    await expect(llamar(gateway)).resolves.toMatchObject({ providerId: 'normal' });
    expect(normal.callCount).toBe(1);
    expect(lunaZdr.callCount).toBe(0);
  });

  it('con zdrEstricto usa solo la escalera ZDR y su respaldo es Haiku, nunca un proveedor sin ZDR', async () => {
    const { gateway, haikuZdr, normal, sinZdr } = build({ lunaZdrFalla: true });
    await expect(llamar(gateway, { zdrEstricto: true })).resolves.toMatchObject({ providerId: 'haiku-zdr', fallbackUsed: true });
    expect(haikuZdr.callCount).toBe(1);
    expect(normal.callCount + sinZdr.callCount).toBe(0);
  });

  it('el modelo preferido se busca en la escalera ZDR o en sus alternativas ZDR', async () => {
    const { gateway, rapidoZdr, haikuZdr } = build();
    await expect(llamar(gateway, { zdrEstricto: true, preferredModel: 'google/gemini-3.5-flash-lite' })).resolves.toMatchObject({ providerId: 'rapido-zdr' });
    await expect(llamar(gateway, { zdrEstricto: true, preferredModel: 'anthropic/claude-haiku-5.5' })).resolves.toMatchObject({ providerId: 'haiku-zdr' });
    expect(rapidoZdr.callCount).toBe(1);
    expect(haikuZdr.callCount).toBe(1);
  });

  it('un modelo preferido que no es ZDR se ignora: sigue la escalera ZDR', async () => {
    const { gateway, lunaZdr, sinZdr } = build();
    await expect(llamar(gateway, { zdrEstricto: true, preferredModel: 'meta/muse-spark-1.3' })).resolves.toMatchObject({ providerId: 'luna-zdr' });
    expect(sinZdr.callCount).toBe(0);
    expect(lunaZdr.callCount).toBe(1);
  });

  it('sin escalera ZDR registrada falla cerrada (no cae a la escalera normal)', async () => {
    const { gateway, normal } = build({ zdr: false });
    await expect(llamar(gateway, { zdrEstricto: true })).rejects.toThrow(/retencion cero/);
    expect(normal.callCount).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { deriveVerticalFromRole, usdToMicroUsd, type LlmUsageEvent, type UsageRecorder } from '../../src/gateway/usage.js';
import type { LlmCompletionRequest } from '../../src/gateway/types.js';

function req(): LlmCompletionRequest {
  return { system: 'eres un asistente', messages: [{ role: 'user', content: 'hola' }] };
}

function fixedCostProvider(id: string, costUsd: number): FakeLlmProvider {
  return new FakeLlmProvider({
    id,
    script: async () => ({ text: `ok-${id}`, model: `${id}/modelo-x`, tokensIn: 12, tokensOut: 34, costUsd }),
  });
}

function fakeRecorder(): { recorder: UsageRecorder; events: LlmUsageEvent[]; record: ReturnType<typeof vi.fn> } {
  const events: LlmUsageEvent[] = [];
  const record = vi.fn(async (event: LlmUsageEvent) => {
    events.push(event);
  });
  return { recorder: { record }, events, record };
}

describe('deriveVerticalFromRole / usdToMicroUsd', () => {
  it('extrae la vertical del prefijo antes de ":"', () => {
    expect(deriveVerticalFromRole('hoteles:whatsapp_agent')).toBe('hoteles');
    expect(deriveVerticalFromRole('licitaciones:requirement_extractor')).toBe('licitaciones');
  });

  it('un rol sin ":" se devuelve tal cual (defensivo)', () => {
    expect(deriveVerticalFromRole('chat')).toBe('chat');
  });

  it('convierte USD (float) a micro-USD (entero), redondeando', () => {
    expect(usdToMicroUsd(0.000123)).toBe(123);
    expect(usdToMicroUsd(1)).toBe(1_000_000);
    expect(usdToMicroUsd(0)).toBe(0);
    expect(usdToMicroUsd(-5)).toBe(0);
    expect(usdToMicroUsd(Number.NaN)).toBe(0);
  });
});

describe('LlmGateway — registro de uso (control de gasto de API de LLM)', () => {
  it('registra tokens in/out, costo en micro-USD, proveedor, modelo y vertical tras una llamada exitosa', async () => {
    const { recorder, events } = fakeRecorder();
    const provider = fixedCostProvider('p1', 0.0042);
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
      usageRecorder: recorder,
    });
    gateway.registerLadder('hoteles:whatsapp_agent', [provider]);

    const result = await gateway.complete({ tenantId: 'org-1', runId: 'r1', lane: 'interactive', role: 'hoteles:whatsapp_agent', request: req() });

    expect(result.providerId).toBe('p1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: 'org-1',
      vertical: 'hoteles',
      role: 'hoteles:whatsapp_agent',
      lane: 'interactive',
      providerId: 'p1',
      model: 'p1/modelo-x',
      tokensIn: 12,
      tokensOut: 34,
      costMicroUsd: 4200,
      fallbackUsed: false,
    });
  });

  it('NUNCA registra un intento fallido (sin uso real que auditar)', async () => {
    const { recorder, events } = fakeRecorder();
    const failing = new FakeLlmProvider({
      id: 'p-fail',
      script: async () => {
        throw Object.assign(new Error('502 bad gateway'), { retryable: true });
      },
    });
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
      usageRecorder: recorder,
    });
    gateway.registerLadder('chat', [failing]);

    await expect(gateway.complete({ tenantId: 'org-1', runId: 'r1', lane: 'interactive', role: 'chat', request: req() })).rejects.toThrow();
    expect(events).toHaveLength(0);
  });

  it('un fallo del REGISTRO de uso nunca rompe ni cambia el resultado de una llamada al LLM que sí tuvo éxito', async () => {
    const provider = fixedCostProvider('p1', 0.001);
    const record = vi.fn(async () => {
      throw new Error('la base de datos de gasto está caída');
    });
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
      usageRecorder: { record },
    });
    gateway.registerLadder('chat', [provider]);

    const result = await gateway.complete({ tenantId: 'org-1', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });

    expect(result.providerId).toBe('p1');
    expect(result.text).toBe('ok-p1');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('sin `usageRecorder` configurado (NoopUsageRecorder por defecto), el gateway sigue funcionando exactamente igual', async () => {
    const provider = fixedCostProvider('p1', 0.001);
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
    });
    gateway.registerLadder('chat', [provider]);

    const result = await gateway.complete({ tenantId: 'org-1', runId: 'r1', lane: 'interactive', role: 'chat', request: req() });
    expect(result.providerId).toBe('p1');
  });
});

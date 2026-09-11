import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { applyResidencyGate, DEFAULT_RESIDENCY_POLICY } from '../../src/gateway/residency.js';
import { ResidencyGateBlockedError } from '../../src/gateway/errors.js';

function req() {
  return { system: 'eres un asistente', messages: [{ role: 'user' as const, content: 'hola' }] };
}

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
  });
}

describe('applyResidencyGate — unidad (puerto de licitaciones/router.ts)', () => {
  it('con el gate apagado devuelve la escalera intacta, en el mismo orden', () => {
    const a = new FakeLlmProvider({ id: 'a', countryOfResidence: 'DE' });
    const b = new FakeLlmProvider({ id: 'b', countryOfResidence: 'US' });
    const out = applyResidencyGate([a, b], { ...DEFAULT_RESIDENCY_POLICY, enabled: false });
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('con el gate prendido filtra a SOLO los proveedores del país exigido', () => {
    const nonUs = new FakeLlmProvider({ id: 'openrouter', countryOfResidence: 'unknown' });
    const us1 = new FakeLlmProvider({ id: 'anthropic', countryOfResidence: 'US' });
    const us2 = new FakeLlmProvider({ id: 'openai', countryOfResidence: 'US' });
    const out = applyResidencyGate([nonUs, us1, us2], { enabled: true, requiredCountry: 'US' });
    expect(out.map((p) => p.id)).toEqual(['anthropic', 'openai']); // preserva orden relativo, excluye al no conforme
  });

  it('lanza ResidencyGateBlockedError si NINGÚN proveedor de la escalera cumple', () => {
    const nonUs = new FakeLlmProvider({ id: 'openrouter', countryOfResidence: 'unknown' });
    expect(() => applyResidencyGate([nonUs], { enabled: true, requiredCountry: 'US' })).toThrow(ResidencyGateBlockedError);
  });

  it('el país exigido es configurable — no está hardcodeado a EE.UU.', () => {
    const mx = new FakeLlmProvider({ id: 'proveedor-mx', countryOfResidence: 'MX' });
    const us = new FakeLlmProvider({ id: 'proveedor-us', countryOfResidence: 'US' });
    const out = applyResidencyGate([us, mx], { enabled: true, requiredCountry: 'MX' });
    expect(out.map((p) => p.id)).toEqual(['proveedor-mx']);
  });
});

describe('LlmGateway — el gate de residencia bloquea de verdad a un proveedor no permitido', () => {
  it('con el gate ACTIVO, el proveedor no-US preferido (primero en la escalera) NUNCA es invocado; el gateway usa el US', async () => {
    const gateway = makeGateway();
    // openrouter primero en la escalera (preferencia normal de costo), pero
    // sin residencia US confirmada — con el gate activo debe quedar excluido
    // ANTES de intentar la llamada, no como un fallback tras fallar.
    const openrouter = new FakeLlmProvider({ id: 'openrouter', countryOfResidence: 'unknown' });
    const anthropic = new FakeLlmProvider({ id: 'anthropic', countryOfResidence: 'US' });
    gateway.registerLadder('licitacion_redactor_legal', [openrouter, anthropic]);

    const result = await gateway.complete({
      tenantId: 'gobierno-mx',
      runId: 'r1',
      lane: 'interactive',
      role: 'licitacion_redactor_legal',
      request: req(),
      residency: { enabled: true, requiredCountry: 'US' },
    });

    expect(openrouter.callCount).toBe(0); // EFECTIVAMENTE bloqueado: ni se intentó
    expect(anthropic.callCount).toBe(1);
    expect(result.providerId).toBe('anthropic');
  });

  it('con el gate APAGADO (default de la llamada), el mismo proveedor no-US SÍ se usa normalmente', async () => {
    const gateway = makeGateway();
    const openrouter = new FakeLlmProvider({ id: 'openrouter', countryOfResidence: 'unknown' });
    const anthropic = new FakeLlmProvider({ id: 'anthropic', countryOfResidence: 'US' });
    gateway.registerLadder('chat_general', [openrouter, anthropic]);

    const result = await gateway.complete({
      tenantId: 'hotel-cualquiera',
      runId: 'r1',
      lane: 'interactive',
      role: 'chat_general',
      request: req(),
      // sin `residency`: usa la política por defecto del gateway (apagada).
    });

    expect(openrouter.callCount).toBe(1);
    expect(anthropic.callCount).toBe(0);
    expect(result.providerId).toBe('openrouter');
  });

  it('con el gate activo por defecto del GATEWAY (no por llamada), TODAS las llamadas de ese gateway quedan protegidas', async () => {
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
      residencyPolicy: { enabled: true, requiredCountry: 'US' },
    });
    const nonUs = new FakeLlmProvider({ id: 'proveedor-no-us', countryOfResidence: 'CN' });
    gateway.registerLadder('licitacion_auditor', [nonUs]);

    await expect(
      gateway.complete({ tenantId: 'gobierno-mx', runId: 'r1', lane: 'interactive', role: 'licitacion_auditor', request: req() }),
    ).rejects.toThrow(ResidencyGateBlockedError);
    expect(nonUs.callCount).toBe(0);
  });

  it('el gate es plegable: con VARIOS proveedores US en la escalera, sigue habiendo fallback entre ellos', async () => {
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
      residencyPolicy: { enabled: true, requiredCountry: 'US' },
    });
    const anthropic = new FakeLlmProvider({
      id: 'anthropic',
      countryOfResidence: 'US',
      failWith: () => Object.assign(new Error('caído'), { status: 503 }),
    });
    const openaiDirecto = new FakeLlmProvider({ id: 'openai-directo', countryOfResidence: 'US' });
    gateway.registerLadder('licitacion_auditor', [anthropic, openaiDirecto]);

    const result = await gateway.complete({
      tenantId: 'gobierno-mx',
      runId: 'r1',
      lane: 'interactive',
      role: 'licitacion_auditor',
      request: req(),
    });
    expect(result.providerId).toBe('openai-directo');
    expect(result.fallbackUsed).toBe(true);
  });
});

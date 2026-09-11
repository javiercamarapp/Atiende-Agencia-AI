import { describe, expect, it } from 'vitest';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import { FakeLlmProvider } from '../../src/gateway/providers/fake-provider.js';
import { OpenRouterProvider } from '../../src/gateway/providers/openrouter.js';
import { OpenAiProvider } from '../../src/gateway/providers/openai.js';
import type { LlmToolDefinition } from '../../src/gateway/types.js';

function makeGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
  });
}

const buscarProductoTool: LlmToolDefinition = {
  name: 'buscar_producto',
  description: 'busca un producto',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

describe('Paso 0 — tool-calling en el gateway compartido', () => {
  it('un FakeLlmProvider puede responder con toolCalls y el gateway los propaga tal cual', async () => {
    const gateway = makeGateway();
    const provider = new FakeLlmProvider({
      id: 'primary',
      script: () => ({
        text: '',
        toolCalls: [{ id: 'call_1', name: 'buscar_producto', argumentsJson: '{"query":"pastor"}' }],
        model: 'primary/fake-model',
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0,
      }),
    });
    gateway.registerLadder('agente', [provider]);

    const result = await gateway.complete({
      tenantId: 't1',
      runId: 'r1',
      lane: 'interactive',
      role: 'agente',
      request: { system: 'eres un agente', messages: [{ role: 'user', content: 'quiero tacos de pastor' }], tools: [buscarProductoTool] },
    });

    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'buscar_producto', argumentsJson: '{"query":"pastor"}' }]);
  });

  it('un historial con mensajes assistant(toolCalls)/tool(resultado) es un LlmMessage[] válido de punta a punta', async () => {
    const gateway = makeGateway();
    const provider = new FakeLlmProvider({ id: 'primary' });
    gateway.registerLadder('agente', [provider]);

    const result = await gateway.complete({
      tenantId: 't1',
      runId: 'r2',
      lane: 'interactive',
      role: 'agente',
      request: {
        system: 'eres un agente',
        messages: [
          { role: 'user', content: 'quiero tacos de pastor' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'buscar_producto', argumentsJson: '{"query":"pastor"}' }] },
          { role: 'tool', toolCallId: 'call_1', content: '[{"id":"p1","name":"Tacos al Pastor","price":15}]' },
        ],
        tools: [buscarProductoTool],
      },
    });

    expect(provider.callCount).toBe(1);
    expect(result.providerId).toBe('primary');
  });

  it('OpenRouterProvider manda `tools` en el body y parsea `tool_calls` de la respuesta', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return {
        ok: true,
        json: async () => ({
          model: 'openai/gpt-5.6-luna',
          choices: [{ message: { content: null, tool_calls: [{ id: 'call_9', function: { name: 'buscar_producto', arguments: '{"query":"pastor"}' } }] } }],
          usage: { prompt_tokens: 50, completion_tokens: 12, cost: 0.001 },
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const provider = new OpenRouterProvider({ apiKey: 'sk-test', model: 'openai/gpt-5.6-luna', fetchImpl });
    const result = await provider.complete({
      system: 'eres un agente',
      messages: [{ role: 'user', content: 'quiero tacos de pastor' }],
      tools: [buscarProductoTool],
    });

    expect(capturedBody!.tools).toEqual([{ type: 'function', function: { name: 'buscar_producto', description: 'busca un producto', parameters: buscarProductoTool.parameters } }]);
    expect(result.text).toBe('');
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'buscar_producto', argumentsJson: '{"query":"pastor"}' }]);
  });

  it('sin `tools` en la petición, OpenAiProvider NO manda el campo `tools` (cero cambio de comportamiento para roles sin tool-calling)', async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ model: 'gpt-5.6', choices: [{ message: { content: 'hola' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) } as Response;
    }) as unknown as typeof fetch;

    const provider = new OpenAiProvider({ apiKey: 'sk-test', model: 'gpt-5.6', fetchImpl });
    const result = await provider.complete({ system: 'eres un asistente', messages: [{ role: 'user', content: 'hola' }] });

    expect(capturedBody!.tools).toBeUndefined();
    expect(result.text).toBe('hola');
    expect(result.toolCalls).toBeUndefined();
  });
});

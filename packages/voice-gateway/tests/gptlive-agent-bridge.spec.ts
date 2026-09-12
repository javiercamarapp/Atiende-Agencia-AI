// Confirma que `createGptLiveAgentBridge` está REALMENTE conectado al
// `LlmGateway` de agent-core — mismo gateway, mismo circuit breaker, mismo
// presupuesto que el resto del monorepo usa para texto. Se construye un
// `LlmGateway` real (no un mock del gateway completo) con un
// `FakeLlmProvider` determinista registrado en la escalera, exactamente el
// mismo patrón que usan los tests del propio agent-core — nunca contra la
// red real, nunca requiere una API key real.
import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  InMemoryBudgetLedgerStore,
  FakeLlmProvider,
  LlmGateway,
} from '@atiende/agent-core/gateway';
import { createGptLiveAgentBridge, VOICE_TOOL_PLANNER_ROLE } from '../src/bridge/gptlive-agent-bridge.js';

function buildGateway() {
  return new LlmGateway({
    breaker: new CircuitBreaker(undefined),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
}

describe('createGptLiveAgentBridge', () => {
  it('handleToolCall llama a LlmGateway.complete con tenantId/runId/lane/role reales y devuelve el texto como spokenResponse', async () => {
    const gateway = buildGateway();
    const fake = new FakeLlmProvider({
      id: 'fake-voice-backend',
      script: (req) => ({
        text: `respuesta para: ${req.messages[0]?.content}`,
        model: 'fake-voice-backend/model',
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.0001,
      }),
    });
    gateway.registerLadder(VOICE_TOOL_PLANNER_ROLE, [fake]);

    const bridge = createGptLiveAgentBridge(gateway);
    const result = await bridge.handleToolCall({
      conversationId: 'conv_1',
      tenantId: 'tenant_hotel_1',
      transcriptSoFar: 'huésped: ¿tienen disponibilidad para el viernes?',
    });

    expect(result.spokenResponse).toBe('respuesta para: huésped: ¿tienen disponibilidad para el viernes?');
    expect(fake.callCount).toBe(1);
  });

  it('usa el `role` custom cuando se pasa en las opciones, no el rol por defecto', async () => {
    const gateway = buildGateway();
    const fakeDefault = new FakeLlmProvider({ id: 'no-debe-llamarse' });
    const fakeCustom = new FakeLlmProvider({
      id: 'fake-custom',
      script: () => ({ text: 'ok-custom', model: 'x', tokensIn: 1, tokensOut: 1, costUsd: 0 }),
    });
    gateway.registerLadder(VOICE_TOOL_PLANNER_ROLE, [fakeDefault]);
    gateway.registerLadder('voice-tool-planner-restaurantes', [fakeCustom]);

    const bridge = createGptLiveAgentBridge(gateway, { role: 'voice-tool-planner-restaurantes' });
    const result = await bridge.handleToolCall({
      conversationId: 'conv_2',
      tenantId: 'tenant_rest_1',
      transcriptSoFar: 'algo',
    });

    expect(result.spokenResponse).toBe('ok-custom');
    expect(fakeDefault.callCount).toBe(0);
  });

  it('rechaza explícito sin tenantId o sin conversationId — nunca llama al gateway con datos vacíos', async () => {
    const gateway = buildGateway();
    gateway.registerLadder(VOICE_TOOL_PLANNER_ROLE, [new FakeLlmProvider({ id: 'x' })]);
    const bridge = createGptLiveAgentBridge(gateway);

    await expect(bridge.handleToolCall({ conversationId: 'c1', tenantId: '', transcriptSoFar: 't' })).rejects.toThrow(
      /tenantId requerido/,
    );
    await expect(bridge.handleToolCall({ conversationId: '', tenantId: 't1', transcriptSoFar: 't' })).rejects.toThrow(
      /conversationId requerido/,
    );
  });

  it('sin ladder registrado para el rol, el error real de LlmGateway se propaga tal cual (no se traga el fallo)', async () => {
    const gateway = buildGateway();
    const bridge = createGptLiveAgentBridge(gateway);
    await expect(
      bridge.handleToolCall({ conversationId: 'conv_3', tenantId: 'tenant_x', transcriptSoFar: 'algo' }),
    ).rejects.toThrow(/sin proveedores registrados/);
  });
});

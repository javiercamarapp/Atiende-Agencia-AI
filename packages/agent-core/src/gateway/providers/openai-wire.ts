// Mapeo compartido hacia/desde el wire format de Chat Completions estilo
// OpenAI (`tools`/`tool_calls`/`role:'tool'`) — usado por `openai.ts` Y
// `openrouter.ts` porque OpenRouter expone exactamente el mismo formato de
// request/response (es un proxy sobre la misma API shape). Vive en un
// archivo aparte para no duplicar la lógica de mapeo entre los dos
// adaptadores, ninguno de los dos la exporta públicamente — es un detalle de
// implementación de "cómo hablar con esta wire API", no parte del contrato
// `LlmProvider`.
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '../types.js';

export interface OpenAiWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface OpenAiWireTool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface OpenAiWireToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export function toOpenAiWireMessages(system: string, messages: readonly LlmMessage[]): OpenAiWireMessage[] {
  const wire: OpenAiWireMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'system') continue; // el system real ya se puso arriba, una sola vez.
    if (m.role === 'tool') {
      wire.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
      continue;
    }
    if (m.role === 'assistant') {
      wire.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.argumentsJson } })) }
          : {}),
      });
      continue;
    }
    wire.push({ role: 'user', content: m.content });
  }
  return wire;
}

export function toOpenAiWireTools(tools: readonly LlmToolDefinition[] | undefined): OpenAiWireTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function fromOpenAiWireToolCalls(toolCalls: readonly OpenAiWireToolCall[] | undefined): LlmToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, argumentsJson: tc.function.arguments }));
}

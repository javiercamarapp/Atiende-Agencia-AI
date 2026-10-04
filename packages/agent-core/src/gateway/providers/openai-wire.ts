// Mapeo compartido hacia/desde el wire format de Chat Completions estilo
// OpenAI (`tools`/`tool_calls`/`role:'tool'`) — usado por `openai.ts` Y
// `openrouter.ts` porque OpenRouter expone exactamente el mismo formato de
// request/response (es un proxy sobre la misma API shape). Vive en un
// archivo aparte para no duplicar la lógica de mapeo entre los dos
// adaptadores, ninguno de los dos la exporta públicamente — es un detalle de
// implementación de "cómo hablar con esta wire API", no parte del contrato
// `LlmProvider`.
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '../types.js';

/** Partes de contenido multimodal de Chat Completions (texto + audio de entrada). */
export type OpenAiWireContentPart = { type: 'text'; text: string } | { type: 'input_audio'; input_audio: { data: string; format: string } };

export interface OpenAiWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAiWireContentPart[] | null;
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
    if (m.role === 'user' && m.audio) {
      // Mensaje con nota de voz: texto (instruccion) + parte `input_audio`. Sin texto, solo el audio.
      wire.push({ role: 'user', content: [...(m.content ? [{ type: 'text' as const, text: m.content }] : []), { type: 'input_audio' as const, input_audio: { data: m.audio.data, format: m.audio.format } }] });
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

/** `tool_choice` forzado a una herramienta concreta. Devuelve `undefined` (no se
 *  manda el campo) cuando no se pidió, o cuando la herramienta pedida no está en
 *  `tools` -- un `tool_choice` que nombra una función ausente lo rechaza el proveedor
 *  con un 400, así que se degrada a "el modelo decide" en vez de romper el turno. */
export function toOpenAiWireToolChoice(
  tools: readonly LlmToolDefinition[] | undefined,
  toolChoice: { name: string } | undefined,
): { type: 'function'; function: { name: string } } | undefined {
  if (!toolChoice || !tools || !tools.some((t) => t.name === toolChoice.name)) return undefined;
  return { type: 'function', function: { name: toolChoice.name } };
}

export function fromOpenAiWireToolCalls(toolCalls: readonly OpenAiWireToolCall[] | undefined): LlmToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;
  return toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name, argumentsJson: tc.function.arguments }));
}

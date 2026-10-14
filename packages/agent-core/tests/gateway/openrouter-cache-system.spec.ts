// Punto de cache explicito del system prompt (`cacheSystemPrompt`, Anthropic en OpenRouter). Puro: solo arma el cuerpo, no hay red.
import { describe, expect, it } from 'vitest';
import { OpenRouterProvider } from '../../src/gateway/providers/openrouter.js';
import { toOpenAiWireMessages } from '../../src/gateway/providers/openai-wire.js';

const REQ = { system: 'Eres el agente.', messages: [{ role: 'user' as const, content: 'hola' }] };
const cuerpo = (params: ConstructorParameters<typeof OpenRouterProvider>[0]['params']) =>
  new OpenRouterProvider({ apiKey: 'k', model: 'anthropic/claude-sonnet-5.5', ...(params ? { params } : {}) }).buildBody(REQ);

describe('cacheSystemPrompt', () => {
  it('con la bandera, el system va como bloque de texto con cache_control ephemeral', () => {
    const m = cuerpo({ cacheSystemPrompt: true }).messages as { role: string; content: unknown }[];
    expect(m[0]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Eres el agente.', cache_control: { type: 'ephemeral' } }] });
    expect(m[1]).toEqual({ role: 'user', content: 'hola' });
  });

  it('sin la bandera (o en false) el system sigue siendo texto plano: el comportamiento de siempre', () => {
    for (const p of [undefined, {}, { cacheSystemPrompt: false }]) {
      expect((cuerpo(p).messages as { content: unknown }[])[0]!.content).toBe('Eres el agente.');
    }
  });

  it('toOpenAiWireMessages: sin opciones no marca nada', () => {
    expect(toOpenAiWireMessages('s', [])[0]).toEqual({ role: 'system', content: 's' });
    expect(toOpenAiWireMessages('s', [], { cacheSystem: true })[0]!.content).toEqual([{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }]);
  });

  it('la bandera no cambia el resto del cuerpo', () => {
    const { messages: _a, ...sin } = cuerpo({});
    const { messages: _b, ...con } = cuerpo({ cacheSystemPrompt: true });
    expect(con).toEqual(sin);
  });
});

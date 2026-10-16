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

describe('finishReason', () => {
  const sse = (chunks: unknown[]) =>
    (async () => new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`, { status: 200 })) as unknown as typeof fetch;
  it('el resultado trae finish_reason (streaming y no streaming): length con texto vacio es detectable', async () => {
    const stream = new OpenRouterProvider({ apiKey: 'k', model: 'anthropic/claude-sonnet-5.5', fetchImpl: sse([{ choices: [{ delta: { content: '' }, finish_reason: 'length' }] }]) });
    expect(await stream.complete({ ...REQ, onTextDelta: () => undefined })).toMatchObject({ text: '', finishReason: 'length' });
    const plano = new OpenRouterProvider({
      apiKey: 'k',
      model: 'anthropic/claude-sonnet-5.5',
      fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Hola' }, finish_reason: 'stop' }] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(await plano.complete(REQ)).toMatchObject({ text: 'Hola', finishReason: 'stop' });
  });
  it('sin motivo reportado no inventa uno', async () => {
    const p = new OpenRouterProvider({ apiKey: 'k', model: 'm', fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 })) as unknown as typeof fetch });
    expect(await p.complete(REQ)).not.toHaveProperty('finishReason');
  });
});

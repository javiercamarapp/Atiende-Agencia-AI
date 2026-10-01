// Contrato de OpenRouterProvider contra un servidor HTTP FALSO en loopback (127.0.0.1, puerto
// efimero): ninguna prueba toca la red real ni usa una llave real. La llave se genera en tiempo de
// ejecucion (sin literales con forma de credencial).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenRouterError, OpenRouterProvider, buildOpenRouterProviderPrefs, classifyOpenRouterStatus } from '../../src/gateway/providers/openrouter.js';
import { LlmGateway } from '../../src/gateway/gateway.js';
import { CircuitBreaker, InMemoryCircuitBreakerStore } from '../../src/gateway/circuit-breaker.js';
import { InMemoryBudgetLedgerStore } from '../../src/gateway/budget.js';
import type { LlmToolDefinition } from '../../src/gateway/types.js';

const FAKE_KEY = `test-${randomBytes(12).toString('hex')}`;

interface Captured {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Handler = (req: Captured, res: ServerResponse, n: number) => void;

let server: Server;
let url = '';
let captured: Captured[] = [];
let handler: Handler = (_req, res) => res.end('{}');

beforeEach(async () => {
  captured = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const cap: Captured = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
      captured.push(cap);
      handler(cap, res, captured.length);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/chat/completions`;
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const tool: LlmToolDefinition = { name: 'ventas', description: 'ventas del periodo', parameters: { type: 'object', properties: { periodo: { type: 'string' } } } };
const baseReq = { system: 'sistema', messages: [{ role: 'user' as const, content: 'hola' }] };
const noSleep = async () => {};

function provider(extra: Partial<ConstructorParameters<typeof OpenRouterProvider>[0]> = {}): OpenRouterProvider {
  return new OpenRouterProvider({ apiKey: FAKE_KEY, model: 'openai/gpt-6-luna', baseUrl: url, sleep: noSleep, ...extra });
}

describe('OpenRouterProvider: peticion', () => {
  it('manda cabeceras de atribucion, usage accounting y preferencias de privacidad por defecto', async () => {
    handler = (_r, res) => json(res, 200, { model: 'openai/gpt-6-luna-20260922', choices: [{ message: { content: ' hola ' } }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0000042 } });
    await provider({ appUrl: 'https://app.atiende.ai', appName: 'Atiende' }).complete(baseReq);
    const [c] = captured;
    expect(c!.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(c!.headers['http-referer']).toBe('https://app.atiende.ai');
    expect(c!.headers['x-title']).toBe('Atiende');
    expect(c!.body.usage).toEqual({ include: true });
    expect(c!.body.provider).toEqual({ data_collection: 'deny', require_parameters: true, allow_fallbacks: false });
    expect(c!.body.stream).toBeUndefined();
  });

  it('buildOpenRouterProviderPrefs: zdr, order, only e ignore solo viajan si se piden; data_collection solo cambia con allow explicito', () => {
    expect(buildOpenRouterProviderPrefs({ zdr: true, only: ['openai', 'azure'], order: ['openai'], ignore: ['x'], allowFallbacks: true })).toEqual({
      data_collection: 'deny',
      require_parameters: true,
      allow_fallbacks: true,
      zdr: true,
      order: ['openai'],
      only: ['openai', 'azure'],
      ignore: ['x'],
    });
    expect(buildOpenRouterProviderPrefs({ dataCollection: 'allow' }).data_collection).toBe('allow');
    expect(buildOpenRouterProviderPrefs(undefined).data_collection).toBe('deny');
  });

  it('parametros por modelo: temperature omitida, reasoning.effort y piso de max_tokens', async () => {
    handler = (_r, res) => json(res, 200, { choices: [{ message: { content: 'ok' } }], usage: {} });
    await provider({ params: { temperature: 'omit', reasoningEffort: 'low', minMaxTokens: 1500 } }).complete({ ...baseReq, temperature: 0, maxOutputTokens: 500 });
    expect(captured[0]!.body.temperature).toBeUndefined();
    expect(captured[0]!.body.reasoning).toEqual({ effort: 'low' });
    expect(captured[0]!.body.max_tokens).toBe(1500);
  });

  it('sin params, la temperature y el tope de la peticion se respetan; un tope fijo del modelo gana', async () => {
    handler = (_r, res) => json(res, 200, { choices: [{ message: { content: 'ok' } }], usage: {} });
    await provider().complete({ ...baseReq, temperature: 0.2, maxOutputTokens: 300 });
    await provider({ params: { maxTokens: 900 } }).complete({ ...baseReq, maxOutputTokens: 300 });
    expect(captured[0]!.body.temperature).toBe(0.2);
    expect(captured[0]!.body.max_tokens).toBe(300);
    expect(captured[1]!.body.max_tokens).toBe(900);
  });

  it('response_format json_schema estricto solo si el modelo lo soporta', async () => {
    handler = (_r, res) => json(res, 200, { choices: [{ message: { content: '{"a":1}' } }], usage: {} });
    const responseFormat = { name: 'salida', schema: { type: 'object', properties: { a: { type: 'number' } } } };
    await provider({ params: { supportsStructuredOutput: true } }).complete({ ...baseReq, responseFormat });
    await provider({ params: { supportsStructuredOutput: false } }).complete({ ...baseReq, responseFormat });
    expect(captured[0]!.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'salida', strict: true, schema: responseFormat.schema } });
    expect(captured[1]!.body.response_format).toBeUndefined();
  });
});

describe('OpenRouterProvider: respuesta', () => {
  it('normaliza tool calls y lee tokens (cache, razonamiento) y el costo REAL reportado', async () => {
    handler = (_r, res) =>
      json(res, 200, {
        model: 'openai/gpt-6-luna-20260922',
        choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'ventas', arguments: '{"periodo":"hoy"}' } }] } }],
        usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.000321, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 60 } },
      });
    const r = await provider().complete({ ...baseReq, tools: [tool], toolChoice: { name: 'ventas' } });
    expect(captured[0]!.body.tools).toEqual([{ type: 'function', function: { name: 'ventas', description: 'ventas del periodo', parameters: tool.parameters } }]);
    expect(captured[0]!.body.tool_choice).toEqual({ type: 'function', function: { name: 'ventas' } });
    expect(r.text).toBe('');
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'ventas', argumentsJson: '{"periodo":"hoy"}' }]);
    expect(r).toMatchObject({ model: 'openai/gpt-6-luna-20260922', tokensIn: 1200, tokensOut: 80, tokensCached: 1000, tokensReasoning: 60, costUsd: 0.000321, costSource: 'provider' });
  });

  it('un costo reportado de 0 es real (modelo gratuito): no se sustituye por la tabla', async () => {
    handler = (_r, res) => json(res, 200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 100, cost: 0 } });
    const r = await provider().complete(baseReq);
    expect(r.costUsd).toBe(0);
    expect(r.costSource).toBe('provider');
  });

  it('sin costo reportado usa la tabla de respaldo (con cache); sin precio conocido, un tope conservador', async () => {
    handler = (_r, res) => json(res, 200, { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, prompt_tokens_details: { cached_tokens: 500_000 } } });
    const known = await provider().complete(baseReq);
    // luna: 0.5M * 0.10 + 0.5M * 0.01 + 1M * 0.50
    expect(known.costUsd).toBeCloseTo(0.05 + 0.005 + 0.5, 6);
    expect(known.costSource).toBe('table');
    const unknown = await provider({ model: 'vendor/modelo-sin-precio' }).complete(baseReq);
    expect(unknown.costSource).toBe('conservative');
    expect(unknown.costUsd).toBeGreaterThan(known.costUsd);
  });

  it('un 200 con error del proveedor upstream se trata como error (no como respuesta vacia)', async () => {
    handler = (_r, res) => json(res, 200, { error: { code: 502, message: 'upstream caido' } });
    await expect(provider({ maxRetries: 0 }).complete(baseReq)).rejects.toMatchObject({ status: 502, retryable: true, transient: true });
  });
});

describe('OpenRouterProvider: streaming', () => {
  it('emite deltas de texto y arma el mismo resultado final (herramientas, tokens, costo real)', async () => {
    handler = (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': OPENROUTER PROCESSING\n\n');
      res.write(`data: ${JSON.stringify({ model: 'openai/gpt-6-luna', choices: [{ delta: { content: 'Hola ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'mundo' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'ventas', arguments: '{"per' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'iodo":"hoy"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 7, cost: 0.0001 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const deltas: string[] = [];
    const r = await provider().complete({ ...baseReq, tools: [tool], onTextDelta: (d) => deltas.push(d) });
    expect(captured[0]!.body.stream).toBe(true);
    expect(deltas).toEqual(['Hola ', 'mundo']);
    expect(r.text).toBe('Hola mundo');
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'ventas', argumentsJson: '{"periodo":"hoy"}' }]);
    expect(r).toMatchObject({ tokensIn: 20, tokensOut: 7, costUsd: 0.0001, costSource: 'provider' });
  });

  it('un error a medio stream NO se reintenta (ya se emitio texto al llamador)', async () => {
    handler = (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'parcial' } }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ error: { code: 502, message: 'se cayo' } })}\n\n`);
    };
    const deltas: string[] = [];
    await expect(provider({ maxRetries: 3 }).complete({ ...baseReq, onTextDelta: (d) => deltas.push(d) })).rejects.toBeInstanceOf(OpenRouterError);
    expect(captured).toHaveLength(1);
    expect(deltas).toEqual(['parcial']);
  });
});

describe('OpenRouterProvider: errores, reintentos y timeouts', () => {
  it('clasifica por status: transitorio (408/429/5xx), especifico del modelo (400/404/422) y de cuenta (401/402/403)', () => {
    for (const s of [408, 429, 500, 503]) expect(classifyOpenRouterStatus(s)).toEqual({ transient: true, ladderRetryable: true });
    for (const s of [400, 404, 422]) expect(classifyOpenRouterStatus(s)).toEqual({ transient: false, ladderRetryable: true });
    for (const s of [401, 402, 403]) expect(classifyOpenRouterStatus(s)).toEqual({ transient: false, ladderRetryable: false });
  });

  it('reintenta con backoff un 503 y un 429 (respetando Retry-After con tope) y termina bien', async () => {
    const waits: number[] = [];
    handler = (_r, res, n) => {
      if (n === 1) return json(res, 503, { error: { message: 'busy' } });
      if (n === 2) return json(res, 429, { error: { message: 'rate' } }, { 'retry-after': '1' });
      return json(res, 200, { choices: [{ message: { content: 'listo' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.1 } });
    };
    const r = await provider({ maxRetries: 2, backoffBaseMs: 10, sleep: async (ms) => void waits.push(ms) }).complete(baseReq);
    expect(r.text).toBe('listo');
    expect(captured).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]!).toBeGreaterThanOrEqual(10);
    expect(waits[1]!).toBeGreaterThanOrEqual(1000);
    expect(waits[1]!).toBeLessThanOrEqual(2000);
  });

  it('NO reintenta un 400/401/402 (un solo intento) y el error no contiene la llave', async () => {
    for (const status of [400, 401, 402]) {
      captured = [];
      handler = (_r, res) => json(res, status, { error: { message: 'no' } });
      const err = await provider({ maxRetries: 3 }).complete(baseReq).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OpenRouterError);
      expect((err as OpenRouterError).status).toBe(status);
      expect(String((err as Error).message)).not.toContain(FAKE_KEY);
      expect(captured).toHaveLength(1);
    }
  });

  it('un timeout se reporta como error transitorio', async () => {
    handler = () => {
      /* nunca responde */
    };
    const err = await provider({ timeoutMs: 50, maxRetries: 0 }).complete(baseReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenRouterError);
    expect(String((err as Error).message)).toMatch(/timeout/);
    expect((err as OpenRouterError).transient).toBe(true);
  });

  it('un fallo de red (conexion rechazada) es transitorio y reintentable por la escalera', async () => {
    const p = new OpenRouterProvider({ apiKey: FAKE_KEY, model: 'm', baseUrl: 'http://127.0.0.1:1/x', sleep: noSleep, maxRetries: 0 });
    await expect(p.complete(baseReq)).rejects.toMatchObject({ retryable: true, transient: true });
  });
});

describe('OpenRouterProvider dentro del LlmGateway: fallback entre modelos', () => {
  function gatewayWith(...providers: OpenRouterProvider[]): LlmGateway {
    const gateway = new LlmGateway({
      breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
      budgetStore: new InMemoryBudgetLedgerStore(),
      budgetLimits: { maxRunUsd: 1, maxTenantDailyUsd: 5 },
    });
    gateway.registerLadder('rol', providers);
    return gateway;
  }
  const call = (g: LlmGateway) => g.complete({ tenantId: 't', runId: 'r', lane: 'interactive', role: 'rol', request: baseReq });

  it('un 503 persistente del primer modelo cae al segundo y registra el costo real del que respondio', async () => {
    handler = (r, res) => {
      if (r.body.model === 'openai/gpt-6-luna') return json(res, 503, { error: { message: 'down' } });
      return json(res, 200, { model: 'google/gemini-3.5-flash-lite', choices: [{ message: { content: 'respaldo' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000777 } });
    };
    const g = gatewayWith(
      provider({ id: 'openrouter:openai/gpt-6-luna', maxRetries: 0 }),
      provider({ id: 'openrouter:google/gemini-3.5-flash-lite', model: 'google/gemini-3.5-flash-lite', maxRetries: 0 }),
    );
    const r = await call(g);
    expect(r.text).toBe('respaldo');
    expect(r.fallbackUsed).toBe(true);
    expect(r.providerId).toBe('openrouter:google/gemini-3.5-flash-lite');
    expect(r.costUsd).toBe(0.000777);
  });

  it('un 400 (parametro no soportado por ese modelo) tambien cae al siguiente modelo', async () => {
    handler = (r, res) => (r.body.model === 'openai/gpt-6-luna' ? json(res, 400, { error: { message: 'unsupported parameter' } }) : json(res, 200, { choices: [{ message: { content: 'ok2' } }], usage: {} }));
    const g = gatewayWith(provider({ id: 'a', maxRetries: 0 }), provider({ id: 'b', model: 'google/gemini-3.5-flash-lite', maxRetries: 0 }));
    expect((await call(g)).text).toBe('ok2');
  });

  it('un 401 (llave invalida) detiene la escalera: el segundo modelo no se intenta', async () => {
    handler = (_r, res) => json(res, 401, { error: { message: 'no auth' } });
    const g = gatewayWith(provider({ id: 'a', maxRetries: 0 }), provider({ id: 'b', model: 'google/gemini-3.5-flash-lite', maxRetries: 0 }));
    await expect(call(g)).rejects.toMatchObject({ status: 401 });
    expect(captured).toHaveLength(1);
  });
});

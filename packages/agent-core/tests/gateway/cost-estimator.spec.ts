// Estimador de costo de la reserva (CHAT-05): usa el precio por modelo y el tope de salida REAL del escalon.
import { describe, expect, it } from 'vitest';
import { defaultCostEstimator } from '../../src/gateway/gateway.js';
import { OpenRouterProvider } from '../../src/gateway/providers/openrouter.js';
import { lookupModelPrice } from '../../src/gateway/prices.js';
import type { LlmCompletionRequest } from '../../src/gateway/types.js';

const req: LlmCompletionRequest = { system: 'x'.repeat(4000), messages: [{ role: 'user', content: 'y'.repeat(4000) }], maxOutputTokens: 150 };
// 8000 caracteres / 4 = 2000 tokens de entrada
const provider = (model: string, params?: ConstructorParameters<typeof OpenRouterProvider>[0]['params']) => new OpenRouterProvider({ apiKey: 'k', model, params });

describe('effectiveMaxOutputTokens del escalon OpenRouter', () => {
  it('es el pedido, salvo que el escalon fije un tope o un piso mayor (modelos que razonan)', () => {
    expect(provider('m/a').effectiveMaxOutputTokens(req)).toBe(150);
    expect(provider('m/a', { minMaxTokens: 1500 }).effectiveMaxOutputTokens(req)).toBe(1500);
    expect(provider('m/a', { maxTokens: 900 }).effectiveMaxOutputTokens(req)).toBe(900);
    expect(provider('m/a', { maxTokens: 900, minMaxTokens: 1500 }).effectiveMaxOutputTokens(req)).toBe(1500);
    expect(provider('m/a').effectiveMaxOutputTokens({ ...req, maxOutputTokens: undefined })).toBe(500);
  });

  it('es exactamente el max_tokens que viaja en la peticion', () => {
    for (const params of [undefined, { minMaxTokens: 1500 }, { maxTokens: 900 }]) {
      const p = provider('m/a', params);
      expect(p.buildBody(req).max_tokens).toBe(p.effectiveMaxOutputTokens(req));
    }
  });
});

describe('defaultCostEstimator', () => {
  it('con precio en la tabla reserva con el precio del modelo, no con la tarifa cara', () => {
    const luna = provider('openai/gpt-6-luna');
    const p = lookupModelPrice('openai/gpt-6-luna')!;
    const esperado = (2000 * p.inPerM + 150 * p.outPerM) / 1_000_000;
    expect(defaultCostEstimator(luna, req)).toBeCloseTo(esperado, 10);
    expect(defaultCostEstimator(luna, req)).toBeLessThan(0.001);
  });

  it('un modelo SIN fila en la tabla conserva la tarifa cara de 10/30 (sobre-reservar es seguro)', () => {
    const raro = provider('lab-nuevo/modelo-x');
    expect(defaultCostEstimator(raro, req)).toBeCloseTo((2000 * 10 + 150 * 30) / 1_000_000, 10);
  });

  it('reserva la salida con el tope efectivo: pedir 150 tokens a un modelo con piso de 1500 reserva 1500', () => {
    const pro = provider('deepseek/deepseek-v4-pro', { minMaxTokens: 3000 });
    const p = lookupModelPrice('deepseek/deepseek-v4-pro')!;
    expect(defaultCostEstimator(pro, req)).toBeCloseTo((2000 * p.inPerM + 3000 * p.outPerM) / 1_000_000, 10);
    expect(defaultCostEstimator(pro, req)).toBeGreaterThan(defaultCostEstimator(provider('deepseek/deepseek-v4-pro'), req));
  });

  it('un proveedor sin effectiveMaxOutputTokens (otros proveedores) usa el pedido', () => {
    const otro = { id: 'x', model: 'openai/gpt-6-luna', countryOfResidence: 'US', complete: async () => { throw new Error('no'); } };
    const p = lookupModelPrice('openai/gpt-6-luna')!;
    expect(defaultCostEstimator(otro, req)).toBeCloseTo((2000 * p.inPerM + 150 * p.outPerM) / 1_000_000, 10);
  });

  it('Mistral Small 3.2 (respaldo candidato) tiene precio de respaldo', () => {
    expect(lookupModelPrice('mistralai/mistral-small-3.2-24b-instruct')).toMatchObject({ inPerM: 0.09, outPerM: 0.3 });
  });
});

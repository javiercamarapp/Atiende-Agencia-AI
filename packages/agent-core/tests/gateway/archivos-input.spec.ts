// Entrada de IMAGEN/PDF (importador de menu de restaurantes): partes `image_url` y `file` (data URL) en el cuerpo de OpenRouter y
// reserva de costo que las cuenta. Todo sin red: solo se arma el cuerpo de la peticion y se estima el costo.
import { describe, expect, it } from 'vitest';
import { defaultCostEstimator } from '../../src/gateway/gateway.js';
import { OpenRouterProvider } from '../../src/gateway/providers/openrouter.js';
import type { LlmCompletionRequest } from '../../src/gateway/types.js';

const provider = new OpenRouterProvider({ apiKey: 'k', model: 'google/gemini-3.5-flash-lite' });
const B64 = Buffer.from('bytes-de-prueba').toString('base64');

describe('mensaje de usuario con archivos', () => {
  it('imagen -> image_url con data URL; PDF -> file con filename y data URL; el texto va primero', () => {
    const body = provider.buildBody({
      system: 'extrae',
      messages: [
        {
          role: 'user',
          content: 'Extrae el menu.',
          archivos: [
            { kind: 'imagen', mimeType: 'image/png', data: B64, filename: 'menu.png' },
            { kind: 'pdf', mimeType: 'application/pdf', data: B64, filename: 'menu.pdf' },
          ],
        },
      ],
    });
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Extrae el menu.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${B64}` } },
        { type: 'file', file: { filename: 'menu.pdf', file_data: `data:application/pdf;base64,${B64}` } },
      ],
    });
  });

  it('archivos vacio deja el contenido como string (comportamiento anterior)', () => {
    const m = provider.buildBody({ system: 's', messages: [{ role: 'user', content: 'hola', archivos: [] }] }).messages as { content: unknown }[];
    expect(m[1]!.content).toBe('hola');
  });

  it('la reserva de costo crece con el tamano de los archivos', () => {
    const base: LlmCompletionRequest = { system: 's', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 100 };
    const con: LlmCompletionRequest = { ...base, messages: [{ role: 'user', content: 'x', archivos: [{ kind: 'pdf', mimeType: 'application/pdf', data: 'A'.repeat(400_000), filename: 'm.pdf' }] }] };
    expect(defaultCostEstimator(provider, con)).toBeGreaterThan(defaultCostEstimator(provider, base));
  });
});

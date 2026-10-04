// Entrada de AUDIO (R-32, notas de voz): parte `input_audio` en el cuerpo de OpenRouter y reserva de costo que la cuenta.
// Todo sin red: solo se arma el cuerpo de la peticion y se estima el costo.
import { describe, expect, it } from 'vitest';
import { defaultCostEstimator } from '../../src/gateway/gateway.js';
import { OpenRouterProvider } from '../../src/gateway/providers/openrouter.js';
import type { LlmCompletionRequest } from '../../src/gateway/types.js';

const provider = new OpenRouterProvider({ apiKey: 'k', model: 'google/gemini-2.5-flash-lite' });
const AUDIO_B64 = Buffer.from('audio-de-prueba').toString('base64');

describe('mensaje de usuario con audio', () => {
  it('se manda como contenido multiparte: texto + input_audio (base64 y formato)', () => {
    const body = provider.buildBody({ system: 'transcribe', messages: [{ role: 'user', content: 'Transcribe.', audio: { data: AUDIO_B64, format: 'ogg' } }] });
    const messages = body.messages as { role: string; content: unknown }[];
    expect(messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Transcribe.' },
        { type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'ogg' } },
      ],
    });
  });

  it('sin texto manda solo la parte de audio; sin audio el contenido sigue siendo un string (comportamiento anterior)', () => {
    const soloAudio = provider.buildBody({ system: 's', messages: [{ role: 'user', content: '', audio: { data: AUDIO_B64, format: 'mp3' } }] }).messages as { content: unknown }[];
    expect(soloAudio[1]!.content).toEqual([{ type: 'input_audio', input_audio: { data: AUDIO_B64, format: 'mp3' } }]);
    const texto = provider.buildBody({ system: 's', messages: [{ role: 'user', content: 'hola' }] }).messages as { content: unknown }[];
    expect(texto[1]!.content).toBe('hola');
  });
});

describe('defaultCostEstimator con audio', () => {
  it('la reserva crece con el tamano del audio (nunca sub-reserva una nota de voz)', () => {
    const base: LlmCompletionRequest = { system: 's', messages: [{ role: 'user', content: 'Transcribe.' }], maxOutputTokens: 100 };
    const conAudio: LlmCompletionRequest = { ...base, messages: [{ role: 'user', content: 'Transcribe.', audio: { data: 'A'.repeat(400_000), format: 'ogg' } }] };
    expect(defaultCostEstimator(provider, conAudio)).toBeGreaterThan(defaultCostEstimator(provider, base));
  });
});

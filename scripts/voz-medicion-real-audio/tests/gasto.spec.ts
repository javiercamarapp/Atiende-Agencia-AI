import { describe, expect, it } from "vitest";
import { GastoDeepgram, TopeExcedido } from "../gasto.ts";

const T = { sttUsdPorMinuto: 0.0048, keytermUsdPorMinuto: 0.0013, ttsUsdPorMilCaracteres: 0.03 };

describe("GastoDeepgram", () => {
  it("costo = minutos x tarifa (+ keyterms) + caracteres x tarifa TTS", () => {
    const g = new GastoDeepgram(T, { usd: 10, audioS: 1e6, llamadaS: 1e6 });
    g.audioStt(60, false); g.audioStt(60, true); g.tts(1000);
    expect(g.usdStt).toBeCloseTo(0.0048 + 0.0061, 8);
    expect(g.usdTts).toBeCloseTo(0.03, 8);
    expect(g.usd).toBeCloseTo(0.0409, 8);
  });
  it("para al pasar el tope de USD", () => {
    const g = new GastoDeepgram(T, { usd: 0.05, audioS: 1e6, llamadaS: 1e6 });
    g.tts(1000);
    expect(() => g.tts(1000)).toThrow(TopeExcedido);
    expect(g.excedido()).toBe(true);
  });
  it("tope de audio total y por llamada (la llamada se reinicia)", () => {
    const g = new GastoDeepgram(T, { usd: 10, audioS: 100, llamadaS: 40 });
    g.audioStt(30, true);
    expect(() => g.audioStt(15, true)).toThrowError(/llamada/);
    g.nuevaLlamada();
    g.audioStt(30, true); g.nuevaLlamada();
    expect(() => g.audioStt(30, true)).toThrowError(/audio/);
  });
  it("sin exceder no lanza", () => { const g = new GastoDeepgram(T, { usd: 1, audioS: 100, llamadaS: 100 }); g.audioStt(10, true); expect(g.excedido()).toBe(false); });
});

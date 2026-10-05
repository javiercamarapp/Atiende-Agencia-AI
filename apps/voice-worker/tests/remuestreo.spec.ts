// Puente de audio: remuestreo de 8, 16 y 48 kHz (telefonia) a los 16 kHz que pide el escalon y de 24 kHz (agente) de vuelta. Se verifica LONGITUD y
// ENERGIA (que la voz no desaparezca ni se amplifique) y que el flujo por trozos da lo mismo que el buffer completo.
import { describe, expect, it } from "vitest";
import { bytesAMuestras, escribirWav, leerWav, muestrasABytes } from "../src/audio/pcm.ts";
import { Remuestreador, remuestrearPcm16 } from "../src/audio/remuestreo.ts";
import { rms, silencio, tono } from "./support/audio.ts";

describe("remuestrearPcm16", () => {
  it.each([
    [8_000, 16_000],
    [48_000, 16_000],
    [24_000, 16_000],
    [16_000, 24_000],
    [16_000, 48_000],
    [8_000, 24_000],
  ])("%i Hz -> %i Hz: la duracion se conserva (1 s de tono sigue siendo ~1 s) y la energia no cambia mas de 10 %", (de, a) => {
    const entrada = tono(de, 1000, 300, 0.5);
    const salida = remuestrearPcm16(entrada, de, a);
    expect(Math.abs(salida.length - a)).toBeLessThanOrEqual(4);
    const re = rms(entrada);
    expect(rms(salida)).toBeGreaterThan(re * 0.9);
    expect(rms(salida)).toBeLessThan(re * 1.1);
  });

  it("el silencio sigue siendo silencio", () => {
    const salida = remuestrearPcm16(silencio(8_000, 500), 8_000, 16_000);
    expect(rms(salida)).toBe(0);
    expect(salida.length).toBeGreaterThanOrEqual(7_990);
  });

  it("mismo ritmo: copia exacta (no una referencia al buffer de entrada)", () => {
    const entrada = tono(16_000, 100);
    const salida = remuestrearPcm16(entrada, 16_000, 16_000);
    expect(Array.from(salida)).toEqual(Array.from(entrada));
    expect(salida.buffer).not.toBe(entrada.buffer);
  });

  it("anti-aliasing al bajar de 48 kHz: un tono por encima del Nyquist de destino casi desaparece", () => {
    const agudo = tono(48_000, 500, 12_000, 0.5); // 12 kHz > 8 kHz (Nyquist de 16 kHz)
    expect(rms(remuestrearPcm16(agudo, 48_000, 16_000))).toBeLessThan(rms(agudo) * 0.35);
  });

  it("el tono bajo conserva su frecuencia: los cruces por cero por segundo coinciden", () => {
    const cruces = (m: Int16Array): number => {
      let c = 0;
      for (let i = 1; i < m.length; i++) if ((m[i - 1]! < 0) !== (m[i]! < 0)) c += 1;
      return c;
    };
    const entrada = tono(8_000, 1000, 400);
    const salida = remuestrearPcm16(entrada, 8_000, 16_000);
    expect(Math.abs(cruces(salida) - cruces(entrada))).toBeLessThanOrEqual(4);
  });

  it("rechaza tasas invalidas", () => {
    expect(() => new Remuestreador(0, 16_000)).toThrow(RangeError);
    expect(() => new Remuestreador(8_000, Number.NaN)).toThrow(RangeError);
  });
});

describe("Remuestreador en flujo", () => {
  it.each([
    [48_000, 16_000],
    [8_000, 16_000],
    [16_000, 24_000],
  ])("%i -> %i Hz: trozos de 20 ms dan lo mismo (±1 muestra) que el buffer completo", (de, a) => {
    const entrada = tono(de, 600, 500);
    const completo = remuestrearPcm16(entrada, de, a);
    const r = new Remuestreador(de, a);
    const paso = (de * 20) / 1000;
    const partes: number[] = [];
    for (let i = 0; i < entrada.length; i += paso) partes.push(...r.procesar(entrada.slice(i, i + paso)));
    expect(Math.abs(partes.length - completo.length)).toBeLessThanOrEqual(1);
    const n = Math.min(partes.length, completo.length);
    let maxDif = 0;
    for (let i = 0; i < n; i++) maxDif = Math.max(maxDif, Math.abs(partes[i]! - completo[i]!));
    expect(maxDif).toBeLessThanOrEqual(2);
  });

  it("trozos de una sola muestra tambien funcionan y no pierden ni inventan audio", () => {
    const entrada = tono(8_000, 100);
    const r = new Remuestreador(8_000, 16_000);
    let total = 0;
    for (const v of entrada) total += r.procesar(Int16Array.of(v)).length;
    expect(Math.abs(total - 1600)).toBeLessThanOrEqual(2);
  });
});

describe("PCM y WAV", () => {
  it("bytes <-> muestras es un viaje de ida y vuelta (little-endian); un byte sobrante se descarta", () => {
    const m = Int16Array.of(0, 1, -1, 32767, -32768, 1234);
    expect(Array.from(bytesAMuestras(muestrasABytes(m)))).toEqual(Array.from(m));
    expect(bytesAMuestras(Uint8Array.of(1, 0, 2)).length).toBe(1);
  });

  it("escribir y leer un WAV conserva tasa y muestras", () => {
    const m = tono(16_000, 50);
    const wav = leerWav(escribirWav(m, 16_000));
    expect(wav.hz).toBe(16_000);
    expect(Array.from(wav.muestras)).toEqual(Array.from(m));
  });

  it("un WAV que no es PCM16 mono se rechaza en voz alta (un pregrabado ilegible no debe sonar como ruido)", () => {
    const wav = escribirWav(tono(16_000, 20), 16_000);
    const estereo = new Uint8Array(wav);
    new DataView(estereo.buffer).setUint16(22, 2, true);
    expect(() => leerWav(estereo)).toThrow(/pcm16_mono/);
    expect(() => leerWav(new Uint8Array(10))).toThrow();
    expect(() => leerWav(new Uint8Array(60))).toThrow(/riff/);
  });
});

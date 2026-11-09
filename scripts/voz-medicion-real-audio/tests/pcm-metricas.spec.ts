/* eslint-disable @typescript-eslint/no-explicit-any -- arnes de medicion local (QA), no codigo de produccion */
import { describe, expect, it } from "vitest";
import { concatenar, duracionS, parsearPcm16, pcmABytes, recortarSilencios, silencio, trozos } from "../pcm.ts";
import { pct, resumenTurnos } from "../metricas.ts";
import type { TurnoAudio } from "../metricas.ts";

describe("pcm", () => {
  it("bytes <-> Int16 little-endian, ignora un byte suelto", () => {
    const p = Int16Array.from([0, 1, -1, 32767, -32768]);
    expect(Array.from(parsearPcm16(pcmABytes(p)))).toEqual(Array.from(p));
    expect(parsearPcm16(new Uint8Array([1, 0, 9])).length).toBe(1);
    expect(Array.from(pcmABytes(Int16Array.from([1])))).toEqual([1, 0]);
  });
  it("recorta silencios conservando un margen y devuelve vacio si todo es silencio", () => {
    const p = concatenar(silencio(500), Int16Array.from(new Array(1600).fill(5000)), silencio(500));
    const r = recortarSilencios(p, 16_000, 400, 40);
    expect(r.length).toBe(1600 + 2 * 640);
    expect(recortarSilencios(silencio(100)).length).toBe(0);
  });
  it("trozos de 20 ms = 320 muestras a 16 kHz", () => {
    const t = trozos(new Int16Array(1000));
    expect(t.map((x) => x.length)).toEqual([320, 320, 320, 40]);
    expect(duracionS(new Int16Array(16_000))).toBe(1);
  });
});

const turno = (o: Partial<TurnoAudio>): TurnoAudio => ({ dicho: "", oido: "", audioS: 2, sttMs: 500, llmMs: 800, ttsMs: 300, totalMs: 1600, finales: 1, wer: { s: 0, d: 0, i: 0, n: 10 }, numeros: { n: 0, errores: 0 }, terminos: { n: 0, errores: 0 }, direccion: false, ...o });

describe("metricas", () => {
  it("percentiles", () => { expect(pct([], 0.5)).toBeNull(); expect(pct([5, 1, 3, 2, 4], 0.5)).toBe(3); expect(pct([1, 2, 3, 4], 0.95)).toBe(4); });
  it("resumen: WER global ponderado por palabras y turnos sin final", () => {
    const r = resumenTurnos([turno({ wer: { s: 1, d: 0, i: 0, n: 10 } }), turno({ wer: { s: 0, d: 0, i: 0, n: 30 }, sttMs: null, totalMs: null }), turno({ direccion: true, wer: { s: 2, d: 0, i: 0, n: 10 }, numeros: { n: 3, errores: 1 } })]);
    expect(r.werGlobal).toBeCloseTo(3 / 50);
    expect(r.werDireccion).toBeCloseTo(0.2);
    expect(r.sinFinal).toBe(1); expect(r.numerosErrores).toBe(1); expect(r.totalP50).toBe(1600);
  });
});

import { EstadoLlamada, envolverStt, sintetizarCliente, vocabularioMenu } from "../adaptadores.ts";

describe("adaptadores (sin red)", () => {
  it("vocabularioMenu quita presentaciones y duplicados", () => {
    expect(vocabularioMenu(["Tacos de Chorizo (orden de 3)", "Tacos de Chorizo (individual)", "Horchata", "ab"])).toEqual(["Tacos de Chorizo", "Horchata"]);
  });
  it("sintetizarCliente parsea el PCM16 de la respuesta y no filtra la llave en el error", async () => {
    const ok = await sintetizarCliente("K", "aura-2-javier-es", "hola", (async () => new Response(new Uint8Array([1, 0, 2, 0]))) as typeof fetch);
    expect(Array.from(ok)).toEqual([1, 2]);
    await expect(sintetizarCliente("SECRETO", "v", "x", (async () => new Response("no", { status: 403 })) as typeof fetch)).rejects.toThrow(/^cliente_tts_http_403$/);
  });
  it("envolverStt anota finales, bytes y habla encima del agente", async () => {
    const S = new EstadoLlamada(); let t = 1000; S.cabezalMs = 5000;
    let evs: any; const real = { abrir: async (_o: any, e: any) => { evs = e; return { enviarAudio: () => undefined, cerrar: async () => undefined }; } };
    const got: string[] = [];
    const ses = await envolverStt(real, S, () => t).abrir({}, { hablaIniciada: () => undefined, parcial: () => undefined, turnoFinal: (x) => got.push(x), caido: () => undefined });
    ses.enviarAudio(new Uint8Array(640)); evs.hablaIniciada(); t = 2000; evs.turnoFinal("hola");
    expect(S.sttBytes).toBe(640); expect(S.hablaEncimaDelAgente).toBe(1); expect(S.finales).toEqual([{ t: 2000, texto: "hola" }]); expect(got).toEqual(["hola"]);
  });
});

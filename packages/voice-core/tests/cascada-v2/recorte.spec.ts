// Recorte del silencio inicial de Aura-2 con PCM SINTETICO (silencio + voz): sin red ni reloj.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, crearRecortadorInicial } from "../../src/index.ts";

const HZ = 24_000;
const O = VOZ_PLATAFORMA.cascadaV2.deepgramAura2.silencioInicial;
const ms = (n: number): number => Math.round((HZ * n) / 1000);

/** `n` muestras de silencio absoluto. */
const silencio = (muestras: number): Uint8Array => new Uint8Array(muestras * 2);
/** `n` muestras con voz sintetica (onda cuadrada de amplitud ~0.24). */
function voz(muestras: number): Uint8Array {
  const b = new Uint8Array(muestras * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < muestras; i++) v.setInt16(i * 2, i % 2 === 0 ? 8000 : -8000, true);
  return b;
}
const junto = (...partes: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of partes) (out.set(p, o), (o += p.length));
  return out;
};
const duracionMs = (b: Uint8Array | null): number => ((b?.length ?? 0) / 2 / HZ) * 1000;

describe("recorte del silencio inicial", () => {
  it("descarta ~650 ms de silencio y deja solo el relleno antes de la voz", () => {
    const r = crearRecortadorInicial(O, HZ);
    const salida = r.procesar(junto(silencio(ms(650)), voz(ms(300))))!;
    // 300 ms de voz + 20 ms de relleno (con tolerancia de una ventana de 10 ms).
    expect(duracionMs(salida)).toBeGreaterThanOrEqual(300 + O.rellenoMs - 1);
    expect(duracionMs(salida)).toBeLessThanOrEqual(300 + O.rellenoMs + 10);
    expect(salida.length % 2).toBe(0);
  });

  it("funciona aunque el silencio y la voz lleguen en trozos distintos (y partidos a media ventana)", () => {
    const r = crearRecortadorInicial(O, HZ);
    const todo = junto(silencio(ms(600)), voz(ms(200)));
    const salidas: Uint8Array[] = [];
    for (let i = 0; i < todo.length; i += 1000) {
      const s = r.procesar(todo.subarray(i, Math.min(i + 1000, todo.length)));
      if (s) salidas.push(s);
    }
    const total = duracionMs(junto(...salidas));
    expect(total).toBeGreaterThanOrEqual(200);
    expect(total).toBeLessThan(200 + O.rellenoMs + 25);
  });

  it("una vez que hay voz, todo lo que sigue pasa tal cual (incluidos silencios entre palabras)", () => {
    const r = crearRecortadorInicial(O, HZ);
    r.procesar(junto(silencio(ms(100)), voz(ms(50))));
    const pausa = silencio(ms(200));
    expect(r.procesar(pausa)).toEqual(pausa);
  });

  it("el tope: si no hay voz en maxMs deja de recortar (mejor un hueco que perder el audio)", () => {
    const r = crearRecortadorInicial(O, HZ);
    const a = r.procesar(silencio(ms(O.maxMs + 100)));
    expect(a).not.toBeNull();
    expect(duracionMs(a)).toBeLessThanOrEqual(110);
    const siguiente = voz(ms(50));
    expect(r.procesar(siguiente)).toEqual(siguiente);
  });

  it("sin silencio inicial no recorta nada de la voz (solo no inventa relleno)", () => {
    const r = crearRecortadorInicial(O, HZ);
    const v = voz(ms(100));
    expect(r.procesar(v)).toEqual(v);
  });

  it("si el primer trozo empieza con RIFF descarta los 44 bytes de la cabecera WAV", () => {
    const r = crearRecortadorInicial(O, HZ);
    const cabecera = new Uint8Array(44);
    cabecera.set([0x52, 0x49, 0x46, 0x46]);
    const v = voz(ms(100));
    expect(r.procesar(junto(cabecera, v))).toEqual(v);
  });

  it("contrato: trozos vacios no producen audio ni lanzan", () => {
    const r = crearRecortadorInicial(O, HZ);
    expect(r.procesar(new Uint8Array(0))).toBeNull();
    expect(r.procesar(silencio(3))).toBeNull();
  });
});

// Ambiente de restaurante sintetizado: determinismo, rangos, saturacion segura, nivel, espectro en banda de voz y ausencia de bucle. Todo con PCM generado, sin red ni reloj.
import { describe, expect, it } from "vitest";
import {
  AmbienteRestaurante,
  Ducking,
  FONDO_VOLUMEN_MAX,
  FondoRestaurante,
  PRESETS_AMBIENTE,
  PRESET_AMBIENTE_POR_DEFECTO,
  esPresetAmbiente,
  esVolumenFondo,
} from "../src/index.ts";
import { aDbfs, autocorrelacionEnvolvente, fraccionEnergiaEnBanda, lufsAprox, muestrasRecortadas, pico, rms, ventanasRepetidas } from "../src/analisis-audio.ts";

const HZ = 24_000;
const seg = (s: number): number => s * HZ;
const tope = (v: number): number => (v / 100) * 32767;

describe("ambiente: contrato de entrada", () => {
  it("volumen: solo enteros 0..20; todo lo demas lanza RangeError", () => {
    expect(esVolumenFondo(0)).toBe(true);
    expect(esVolumenFondo(FONDO_VOLUMEN_MAX)).toBe(true);
    for (const malo of ["", null, false, [], {}, undefined, 21, -1, 1.5, Number.NaN, "8", Infinity]) {
      expect(esVolumenFondo(malo)).toBe(false);
      expect(() => new AmbienteRestaurante({ volumen: malo as number })).toThrow(RangeError);
    }
  });

  it("preset: solo los tres conocidos; el resto lanza", () => {
    expect([...PRESETS_AMBIENTE]).toEqual(["cocina-taqueria", "sala-tranquila", "calle-ocupada"]);
    expect(PRESET_AMBIENTE_POR_DEFECTO).toBe("cocina-taqueria");
    for (const malo of ["", null, false, [], {}, 0, "discoteca"]) {
      expect(esPresetAmbiente(malo)).toBe(false);
      expect(() => new AmbienteRestaurante({ volumen: 5, preset: malo as never })).toThrow(RangeError);
    }
  });

  it("FondoRestaurante (nombre historico) sigue funcionando y usa el preset por omision", () => {
    expect(new FondoRestaurante({ volumen: 5 }).preset).toBe("cocina-taqueria");
  });
});

describe("ambiente: apagado y volumen", () => {
  it("volumen 0 = silencio exacto y `mezclar` devuelve el mismo trozo", () => {
    const a = new AmbienteRestaurante({ volumen: 0 });
    expect(a.activo).toBe(false);
    expect(Array.from(a.siguienteMuestras(500))).toEqual(new Array(500).fill(0));
    const voz = new Uint8Array([1, 2, 3, 4]);
    expect(a.mezclar(voz)).toBe(voz);
  });

  it.each(PRESETS_AMBIENTE)("%s: el pico NUNCA pasa del tope (volumen % de plena escala) y no hay muestras recortadas", (preset) => {
    for (const v of [1, 8, 20]) {
      const m = new AmbienteRestaurante({ volumen: v, preset, semilla: 11 }).siguienteMuestras(seg(8));
      expect(pico(m) * 32768).toBeLessThanOrEqual(tope(v) + 1);
      expect(muestrasRecortadas(m)).toBe(0);
    }
  });

  it("mas volumen = mas nivel, y a volumen 20 el ambiente se oye (no es silencio)", () => {
    const rmsA = (v: number): number => rms(new AmbienteRestaurante({ volumen: v, semilla: 3 }).siguienteMuestras(seg(6)));
    expect(rmsA(4)).toBeLessThan(rmsA(10));
    expect(rmsA(10)).toBeLessThan(rmsA(20));
    expect(rmsA(20)).toBeGreaterThan(0.02);
  });
});

describe("ambiente: determinismo y presets", () => {
  it("misma semilla = mismas muestras (en trozos distintos tambien); otra semilla = otras", () => {
    const a = new AmbienteRestaurante({ volumen: 10, semilla: 5 }).siguienteMuestras(seg(2));
    const b = new AmbienteRestaurante({ volumen: 10, semilla: 5 });
    const trozos = [b.siguienteMuestras(777), b.siguienteMuestras(seg(2) - 777)];
    expect(Array.from(a)).toEqual([...trozos[0]!, ...trozos[1]!]);
    expect(Array.from(a)).not.toEqual(Array.from(new AmbienteRestaurante({ volumen: 10, semilla: 6 }).siguienteMuestras(seg(2))));
  });

  it("los tres presets suenan distinto y 'sala-tranquila' es el mas suave", () => {
    const g = (preset: (typeof PRESETS_AMBIENTE)[number]) => new AmbienteRestaurante({ volumen: 20, preset, semilla: 2 }).siguienteMuestras(seg(10));
    const [cocina, sala, calle] = [g("cocina-taqueria"), g("sala-tranquila"), g("calle-ocupada")];
    expect(Array.from(cocina.subarray(0, 2000))).not.toEqual(Array.from(sala.subarray(0, 2000)));
    expect(Array.from(calle.subarray(0, 2000))).not.toEqual(Array.from(cocina.subarray(0, 2000)));
    expect(rms(sala)).toBeLessThan(rms(cocina));
    expect(rms(sala)).toBeLessThan(rms(calle));
  });
});

describe("ambiente: validacion objetiva del sonido (sin poder oirlo)", () => {
  it.each(PRESETS_AMBIENTE)("%s: nivel razonable a volumen 8 (sonoridad entre -50 y -28 LUFS aprox.), lejos del recorte", (preset) => {
    const m = new AmbienteRestaurante({ volumen: 8, preset, semilla: 7 }).siguienteMuestras(seg(20));
    const lufs = lufsAprox(m, HZ);
    expect(lufs).toBeGreaterThan(-50);
    expect(lufs).toBeLessThan(-28);
    expect(aDbfs(pico(m))).toBeLessThan(-21); // 8 % de plena escala = -21.9 dBFS de pico maximo
  });

  it.each(PRESETS_AMBIENTE)("%s: la energia esta en la banda de voz/telefono (300-3400 Hz), al menos el 80 %%", (preset) => {
    const m = new AmbienteRestaurante({ volumen: 20, preset, semilla: 9 }).siguienteMuestras(seg(20));
    expect(fraccionEnergiaEnBanda(m, HZ, 300, 3400)).toBeGreaterThan(0.8);
  });

  it("el murmullo tiene variacion lenta (la envolvente cambia): no es ruido plano", () => {
    const m = new AmbienteRestaurante({ volumen: 20, semilla: 4 }).siguienteMuestras(seg(30));
    const bloques: number[] = [];
    for (let i = 0; i + seg(1) <= m.length; i += seg(1)) bloques.push(rms(m.subarray(i, i + seg(1))));
    const media = bloques.reduce((a, b) => a + b, 0) / bloques.length;
    const desv = Math.sqrt(bloques.reduce((a, b) => a + (b - media) ** 2, 0) / bloques.length);
    expect(desv / media).toBeGreaterThan(0.03);
  });

  it("60 s sin repeticion exacta: ninguna ventana de 1 s se repite y la envolvente no se autocorrelaciona como un bucle", () => {
    const m = new AmbienteRestaurante({ volumen: 20, semilla: 1 }).siguienteMuestras(seg(60));
    expect(ventanasRepetidas(m, seg(1))).toBe(0);
    expect(ventanasRepetidas(m, 4096)).toBe(0);
    // Un bucle de N segundos daria ~1 en su retardo; aqui se queda lejos (retardos de 5 s a 30 s en bloques de 100 ms)
    expect(autocorrelacionEnvolvente(m, seg(0.1), 50, 300)).toBeLessThan(0.6);
  });
});

describe("ambiente: ducking y mezcla", () => {
  const voz = (ms: number, amp = 9000): Uint8Array => {
    const n = Math.round((ms / 1000) * HZ);
    const out = new Uint8Array(n * 2);
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(Math.sin((2 * Math.PI * 300 * i) / HZ) * amp), true);
    return out;
  };
  const aInt16 = (b: Uint8Array): Int16Array => new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

  it("Ducking baja al hablar (ataque rapido) y vuelve a 1 despues (liberacion lenta)", () => {
    const d = new Ducking(HZ, { atenuacionDb: -9 });
    let g = 1;
    for (let i = 0; i < seg(0.3); i++) g = d.p(true);
    expect(g).toBeCloseTo(Math.pow(10, -9 / 20), 1);
    for (let i = 0; i < seg(0.05); i++) g = d.p(false);
    expect(g).toBeLessThan(0.9); // la liberacion no es inmediata
    for (let i = 0; i < seg(2); i++) g = d.p(false);
    expect(g).toBeGreaterThan(0.99);
  });

  it("el ambiente bajo la voz del agente queda al menos 5 dB mas bajo que sin voz", () => {
    const solo = new AmbienteRestaurante({ volumen: 20, semilla: 8 });
    const con = new AmbienteRestaurante({ volumen: 20, semilla: 8 });
    solo.siguienteMuestras(seg(1));
    con.siguienteMuestras(seg(1));
    const sinVoz = rms(solo.siguienteMuestras(seg(2)));
    const v = aInt16(voz(2000));
    const bajo = con.siguienteMuestras(seg(2), v);
    expect(aDbfs(rms(bajo.subarray(seg(0.5))))).toBeLessThan(aDbfs(sinVoz) - 5);
  });

  it("el cliente hablando tambien baja el ambiente", () => {
    const a = new AmbienteRestaurante({ volumen: 20, semilla: 8 });
    a.siguienteMuestras(seg(1));
    const normal = rms(a.siguienteMuestras(seg(1)));
    a.fijarClienteHablando(true);
    a.siguienteMuestras(seg(0.5));
    const bajo = rms(a.siguienteMuestras(seg(1)));
    expect(aDbfs(bajo)).toBeLessThan(aDbfs(normal) - 3);
  });

  it("mezclar conserva la longitud, nunca desborda y deja pasar la voz (el ambiente es mucho menor)", () => {
    const a = new AmbienteRestaurante({ volumen: 20, semilla: 2 });
    const v = voz(1000, 24000);
    const m = aInt16(a.mezclar(v));
    expect(m.length).toBe(aInt16(v).length);
    expect(muestrasRecortadas(m)).toBe(0);
    const solo = aInt16(v);
    let dif = 0;
    for (let i = 0; i < m.length; i++) dif = Math.max(dif, Math.abs(m[i]! - solo[i]!));
    expect(dif).toBeLessThanOrEqual(tope(20) + 1);
    // saturacion: voz a plena escala + ambiente no se desborda
    const fuerte = new Uint8Array(4000);
    const dv = new DataView(fuerte.buffer);
    for (let i = 0; i < 2000; i++) dv.setInt16(i * 2, 32767, true);
    expect(aInt16(new AmbienteRestaurante({ volumen: 20, semilla: 2 }).mezclar(fuerte)).every((x) => x <= 32767 && x >= -32768)).toBe(true);
  });

  it("un byte suelto al final (media muestra) se conserva y un trozo vacio no rompe nada", () => {
    const a = new AmbienteRestaurante({ volumen: 5, semilla: 1 });
    expect(a.mezclar(new Uint8Array(0)).length).toBe(0);
    const impar = new Uint8Array([0, 0, 7]);
    const r = a.mezclar(impar);
    expect(r.length).toBe(3);
    expect(r[2]).toBe(7);
  });
});

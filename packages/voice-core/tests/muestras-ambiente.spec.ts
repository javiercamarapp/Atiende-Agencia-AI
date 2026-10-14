// Muestras de escucha del ambiente y el tecleo: lo que SI se puede validar sin oir (nivel, pico, relacion voz/ambiente, sin bucle, sincronia del tecleo con las herramientas,
// version telefono). Voz de prueba sintetica: no pretende sonar humana.
import { describe, expect, it } from "vitest";
import { PRESETS_AMBIENTE, medirTelefono, aTelefono, escribirWav16, leerWav16, medirMuestra, renderizarMuestra, remuestrearLineal, vozSinteticaDePrueba, TIPOS_MUESTRA } from "../src/index.ts";
import { fraccionEnergiaEnBanda, pico, rms } from "../src/analisis-audio.ts";

const HZ = 24_000;
const ventana = (pcm: Int16Array, desde: number, hasta: number): Int16Array => pcm.subarray(Math.round(desde * HZ), Math.round(hasta * HZ));

describe("renderizarMuestra", () => {
  it.each(PRESETS_AMBIENTE)("%s: las tres muestras son deterministas, del largo pedido y sin recorte (pico < 1.0)", (preset) => {
    for (const tipo of TIPOS_MUESTRA) {
      const a = renderizarMuestra({ preset, tipo, segundos: 18, semilla: 3 });
      const b = renderizarMuestra({ preset, tipo, segundos: 18, semilla: 3 });
      expect(a.pcm.length).toBe(18 * HZ);
      expect(Array.from(a.pcm.subarray(0, 5000))).toEqual(Array.from(b.pcm.subarray(0, 5000)));
      const m = medirMuestra(a);
      expect(m.muestrasRecortadas).toBe(0);
      expect(m.picoDbfs).toBeLessThan(0);
      expect(m.ventanasRepetidas).toBe(0);
    }
  });

  it("ambiente solo: nivel de fondo razonable (RMS entre -48 y -30 dBFS) y sin herramientas ni voz", () => {
    const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "ambiente", semilla: 1 });
    const m = medirMuestra(r);
    expect(m.rmsDbfs).toBeGreaterThan(-48);
    expect(m.rmsDbfs).toBeLessThan(-30);
    expect(m.vozSobreAmbienteDb).toBeNull();
    expect(r.eventos).toEqual([]);
  });

  it("ambiente + tecleo: el tecleo se OYE sobre el fondo mientras la herramienta esta en vuelo (picos mayores) y calla antes de ella", () => {
    const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "ambiente-tecleo", semilla: 1 });
    const antes = pico(ventana(r.pcm, 0.5, 2.8));
    const durante = pico(ventana(r.pcm, 8.1, 10.9));
    expect(durante).toBeGreaterThan(antes * 1.4);
    const solo = renderizarMuestra({ preset: "cocina-taqueria", tipo: "ambiente", semilla: 1 });
    expect(pico(ventana(solo.pcm, 8.1, 10.9))).toBeLessThan(durante);
  });

  it("barge-in: cuando el cliente habla (16.2 s) el tecleo se corta aunque la herramienta siga en vuelo", () => {
    const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "ambiente-tecleo", semilla: 1 });
    const tecleando = pico(ventana(r.pcm, 14.6, 16.1));
    const despuesDelCorte = pico(ventana(r.pcm, 16.5, 17.5));
    expect(tecleando).toBeGreaterThan(despuesDelCorte * 1.3);
    expect(r.eventos.some((e) => /cliente habla/.test(e.que) && e.t >= 16.2 && e.t < 16.3)).toBe(true);
  });

  it("con voz: la voz va al menos 10 dB sobre el ambiente+tecleo, el ambiente baja bajo ella y la voz sola no se pierde en la mezcla", () => {
    const frases = [vozSinteticaDePrueba(2200), vozSinteticaDePrueba(2200), vozSinteticaDePrueba(2200)];
    const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "voz-ambiente-tecleo", semilla: 1, frases });
    const m = medirMuestra(r);
    expect(m.vozSobreAmbienteDb).not.toBeNull();
    expect(m.vozSobreAmbienteDb!).toBeGreaterThan(10);
    expect(rms(r.voz)).toBeGreaterThan(0);
    // el tecleo no suena mientras habla el agente: durante la frase 2 (8.4-10.6 s) el pico NO supera el de la voz sola
    expect(pico(ventana(r.pcm, 8.5, 10.5))).toBeLessThan(pico(ventana(r.voz, 8.5, 10.5)) * 1.25);
  });

  it("la linea de tiempo registra los eventos que se oyen (herramientas, habla del agente, cliente)", () => {
    const r = renderizarMuestra({ preset: "sala-tranquila", tipo: "voz-ambiente-tecleo", semilla: 2 });
    const queJs = r.eventos.map((e) => e.que).join("|");
    expect(queJs).toMatch(/el agente habla \(frase 1\)/);
    expect(queJs).toMatch(/herramienta 1 inicia/);
    expect(queJs).toMatch(/herramienta 1 termina/);
    expect(queJs).toMatch(/el cliente habla/);
  });

  it("contratos de entrada: segundos fuera de rango, presets y tipos invalidos lanzan RangeError", () => {
    for (const segundos of [0, -1, 121, Number.NaN, Infinity]) expect(() => renderizarMuestra({ preset: "cocina-taqueria", tipo: "ambiente", segundos })).toThrow(RangeError);
    for (const malo of ["", null, false, [], {}, 0, "discoteca"]) {
      expect(() => renderizarMuestra({ preset: malo as never, tipo: "ambiente" })).toThrow(RangeError);
      expect(() => renderizarMuestra({ preset: "cocina-taqueria", tipo: malo as never })).toThrow(RangeError);
    }
  });
});

describe("WAV y version telefono", () => {
  it("escribir y leer un WAV PCM16 es exacto; un archivo roto o de otro formato falla en voz alta", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    const w = escribirWav16(pcm, 24_000);
    expect(w.length).toBe(44 + 12);
    const l = leerWav16(w);
    expect(l.hz).toBe(24_000);
    expect(Array.from(l.pcm)).toEqual(Array.from(pcm));
    for (const malo of [new Uint8Array(0), new Uint8Array(100), new Uint8Array(44)]) expect(() => leerWav16(malo)).toThrow();
  });

  it("remuestreo lineal: misma tasa devuelve lo mismo y 24k->8k divide el largo entre 3", () => {
    const x = Int16Array.from({ length: 2400 }, (_, i) => i);
    expect(remuestrearLineal(x, 24_000, 24_000)).toBe(x);
    expect(remuestrearLineal(x, 24_000, 8000).length).toBe(800);
  });

  it("aTelefono: salida de 8 kHz con la energia en 300-3400 Hz (>= 90 %) y un audio de mu-law sin recorte", () => {
    const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "ambiente-tecleo", semilla: 1, segundos: 10 });
    const tel = aTelefono(r.pcm);
    expect(tel.length).toBe(Math.floor((r.pcm.length * 8000) / HZ));
    expect(fraccionEnergiaEnBanda(tel, 8000, 300, 3400)).toBeGreaterThan(0.9);
    expect(pico(tel)).toBeLessThan(1);
    expect(rms(tel)).toBeGreaterThan(0);
  });

  it("medirTelefono mide la version de telefono (8 kHz, otra escala que la de banda ancha) y la voz sigue sobre el ambiente", () => {
    const frases = [vozSinteticaDePrueba(2200), vozSinteticaDePrueba(2200), vozSinteticaDePrueba(2200)];
    const r = renderizarMuestra({ preset: "cocina-taqueria", tipo: "voz-ambiente-tecleo", semilla: 1, frases });
    const ancha = medirMuestra(r);
    const tel = medirTelefono(r);
    expect(tel.duracionS).toBeCloseTo(18, 1);
    expect(tel.rmsDbfs).toBeLessThanOrEqual(ancha.rmsDbfs + 1); // limitar la banda no agrega energia
    expect(tel.picoDbfs).toBeLessThan(0);
    expect(tel.muestrasRecortadas).toBe(0);
    expect(tel.vozSobreAmbienteDb).not.toBeNull();
    expect(tel.vozSobreAmbienteDb!).toBeGreaterThan(8);
    expect(tel.vozSobreAmbienteDb!).not.toBeCloseTo(ancha.vozSobreAmbienteDb!, 3);
  });
});

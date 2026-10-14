// Mezclador de la salida: voz del agente + ambiente + tecleo en una sola secuencia, con barge-in y ducking. Sin reloj real.
import { describe, expect, it } from "vitest";
import { MezcladorSalida } from "../src/index.ts";
import { pico, rms, aDbfs } from "../src/analisis-audio.ts";

const HZ = 24_000;
const tono = (ms: number, amp = 6000, f = 300): Int16Array => Int16Array.from({ length: Math.round((ms / 1000) * HZ) }, (_, i) => Math.round(Math.sin((2 * Math.PI * f * i) / HZ) * amp));
const ms = (m: number): number => Math.round((m / 1000) * HZ);

describe("MezcladorSalida", () => {
  it("sin efectos devuelve la voz tal cual y silencio cuando no hay nada, siempre con la longitud pedida", () => {
    const m = new MezcladorSalida();
    expect(m.conEfectos).toBe(false);
    const v = tono(100);
    void m.encolarAgente(v);
    const a = m.siguiente(ms(50));
    const b = m.siguiente(ms(100));
    expect(Array.from(a)).toEqual(Array.from(v.subarray(0, ms(50))));
    expect(a.length).toBe(ms(50));
    expect(b.length).toBe(ms(100));
    expect(Array.from(b.subarray(ms(50)))).toEqual(new Array(ms(50)).fill(0)); // se acabo la voz: silencio
    expect(m.agenteHablando).toBe(false);
  });

  it("la promesa del audio del agente se resuelve cuando ya salio entero", async () => {
    const m = new MezcladorSalida();
    let listo = false;
    void m.encolarAgente(tono(40)).then(() => (listo = true));
    m.siguiente(ms(20));
    await Promise.resolve();
    expect(listo).toBe(false);
    m.siguiente(ms(30));
    await Promise.resolve();
    expect(listo).toBe(true);
  });

  it("cortarAgente (barge-in) vacia la cola y libera a quien esperaba", async () => {
    const m = new MezcladorSalida();
    let listo = false;
    void m.encolarAgente(tono(1000)).then(() => (listo = true));
    m.siguiente(ms(20));
    m.cortarAgente();
    await Promise.resolve();
    expect(listo).toBe(true);
    expect(m.pendientes).toBe(0);
    expect(rms(m.siguiente(ms(100)))).toBe(0);
  });

  it("el ambiente baja bajo la voz del agente (ducking) y vuelve despues", () => {
    const con = new MezcladorSalida({ ambiente: { volumen: 20, semilla: 4 } });
    const sin = new MezcladorSalida({ ambiente: { volumen: 20, semilla: 4 } });
    con.siguiente(ms(600)); // calentamiento
    sin.siguiente(ms(600));
    const solo = rms(sin.siguiente(ms(1000)));
    void con.encolarAgente(tono(1000, 9000));
    const voz = tono(1000, 9000);
    const mezcla = con.siguiente(ms(1000));
    const ambienteBajoVoz = Int16Array.from(mezcla, (v, i) => v - voz[i]!);
    expect(aDbfs(rms(ambienteBajoVoz.subarray(ms(300)))) ).toBeLessThan(aDbfs(solo) - 4);
    const despues = rms(con.siguiente(ms(2000)).subarray(ms(1000)));
    expect(aDbfs(despues)).toBeGreaterThan(aDbfs(rms(ambienteBajoVoz.subarray(ms(300)))) + 3);
  });

  it("el cliente hablando baja el ambiente y CORTA el tecleo", () => {
    const m = new MezcladorSalida({ ambiente: { volumen: 20, semilla: 4 }, tecleo: { volumen: 12, semilla: 1 } });
    m.siguiente(ms(500));
    const normal = rms(m.siguiente(ms(800)));
    m.herramientaInicia("a");
    m.siguiente(ms(300));
    m.fijarClienteHablando(true);
    m.siguiente(ms(100));
    const bajo = rms(m.siguiente(ms(800)));
    expect(aDbfs(bajo)).toBeLessThan(aDbfs(normal) - 3);
    expect(m.tecleo!.sonando).toBe(false);
  });

  it("el tecleo suena sobre el ambiente cuando hay una herramienta en vuelo y calla cuando habla el agente", () => {
    const m = new MezcladorSalida({ ambiente: { volumen: 8, semilla: 4 }, tecleo: { volumen: 12, semilla: 2 } });
    m.siguiente(ms(500));
    const base = pico(m.siguiente(ms(1000)));
    m.herramientaInicia("a");
    const conTecleo = pico(m.siguiente(ms(1000)));
    expect(conTecleo).toBeGreaterThan(base);
    void m.encolarAgente(tono(1500, 8000));
    m.siguiente(ms(300));
    expect(m.tecleo!.sonando).toBe(false);
  });

  it("satura a PCM16 sin desbordar con voz a plena escala mas ambiente y tecleo", () => {
    const m = new MezcladorSalida({ ambiente: { volumen: 20, semilla: 1 }, tecleo: { volumen: 25, semilla: 1 } });
    m.herramientaInicia("a");
    void m.encolarAgente(Int16Array.from({ length: ms(500) }, (_, i) => (i % 2 === 0 ? 32767 : -32768)));
    const x = m.siguiente(ms(500));
    expect(pico(x)).toBeLessThanOrEqual(1);
    expect(x.every((v) => v >= -32768 && v <= 32767)).toBe(true);
  });

  it("volumenes en 0 o ausentes no activan nada", () => {
    for (const o of [{}, { ambiente: { volumen: 0 } }, { tecleo: { volumen: 0 } }, { ambiente: null, tecleo: null }]) {
      expect(new MezcladorSalida(o).conEfectos).toBe(false);
    }
  });
});

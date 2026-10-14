// Bombeo de la salida mezclada guiado por la COLA REAL del destino (no por el reloj de pared). Destino simulado: una cola en ms que se vacia al dormir.
import { describe, expect, it } from "vitest";
import { MezcladorSalida } from "@atiende/voice-core";
import { COLA_OBJETIVO_MAX_MS, COLA_OBJETIVO_MIN_MS, bombearConRespaldo, bombearSalida } from "../src/audio/bombeo-salida.ts";

/** Destino simulado: cada trama de 20 ms suma 20 ms a la cola; dormir N ms la reproduce (la cola baja N, sin pasar de 0). */
function destino() {
  const e = { cola: 0, maxCola: 0, tramas: [] as Int16Array[], esperas: [] as number[], colasTrasPrimeros: [] as number[] };
  return {
    e,
    colaMs: () => e.cola,
    enviar: async (t: Int16Array) => {
      e.tramas.push(t);
      e.cola += 20;
      e.maxCola = Math.max(e.maxCola, e.cola);
    },
    dormir: async (ms: number) => {
      e.esperas.push(ms);
      e.cola = Math.max(0, e.cola - ms);
    },
  };
}

describe("bombearSalida (guiado por la cola)", () => {
  it("entrega tramas de exactamente 20 ms (480 muestras a 24 kHz) hasta que `terminado`", async () => {
    const d = destino();
    const m = new MezcladorSalida({ ambiente: { volumen: 8, semilla: 1 } });
    const n = await bombearSalida({ mezclador: m, ...d, terminado: () => d.e.tramas.length >= 50 });
    expect(n).toBe(50);
    expect(d.e.tramas.every((x) => x.length === 480)).toBe(true);
    expect(d.e.tramas.some((x) => x.some((v) => v !== 0))).toBe(true);
  });

  it("mantiene la cola en 40-100 ms: nunca la deja crecer (esa cola es la latencia anadida y el retraso del barge-in)", async () => {
    const d = destino();
    await bombearSalida({ mezclador: new MezcladorSalida({ ambiente: { volumen: 8 } }), ...d, terminado: () => d.e.tramas.length >= 300 });
    expect(d.e.maxCola).toBeLessThanOrEqual(COLA_OBJETIVO_MAX_MS + 20);
    expect(d.e.maxCola).toBeGreaterThanOrEqual(COLA_OBJETIVO_MIN_MS);
    expect(d.e.esperas.length).toBeGreaterThan(0);
  });

  it("si el hilo se bloquea 400 ms (la cola se vacia sola) NO acumula retraso: rellena hasta el objetivo y sigue en 40-100 ms", async () => {
    const d = destino();
    const m = new MezcladorSalida({ ambiente: { volumen: 8 } });
    await bombearSalida({
      mezclador: m,
      ...d,
      terminado: () => {
        if (d.e.tramas.length === 100 && d.e.cola > 0) d.e.cola = 0; // el destino se vacio mientras el hilo estaba bloqueado
        return d.e.tramas.length >= 200;
      },
    });
    expect(d.e.maxCola).toBeLessThanOrEqual(COLA_OBJETIVO_MAX_MS + 20);
  });

  it("tras un clearQueue (cola en 0) rellena DE INMEDIATO, sin dormir antes de la primera trama", async () => {
    const d = destino();
    d.e.cola = 0;
    await bombearSalida({ mezclador: new MezcladorSalida({ ambiente: { volumen: 8 } }), ...d, terminado: () => d.e.tramas.length >= 4 });
    expect(d.e.esperas).toEqual([]); // 4 tramas = 80 ms: justo el objetivo, sin esperar nada
  });

  it("avisa con la cola (ms) con la que entra la voz del agente: ese es el retraso que anade el bombeo", async () => {
    const d = destino();
    const m = new MezcladorSalida({ ambiente: { volumen: 8 } });
    const avisos: number[] = [];
    let n = 0;
    await bombearSalida({
      mezclador: m,
      ...d,
      alTomarVoz: (ms) => avisos.push(ms),
      terminado: () => {
        n++;
        if (n === 30) void m.encolarAgente(new Int16Array(480 * 10).fill(1000));
        return n >= 60;
      },
    });
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toBeGreaterThanOrEqual(0);
    expect(avisos[0]).toBeLessThanOrEqual(COLA_OBJETIVO_MAX_MS);
  });

  it("la voz encolada sale por las tramas, en orden", async () => {
    const d = destino();
    const m = new MezcladorSalida({ ambiente: { volumen: 0 }, tecleo: { volumen: 0 } });
    const voz = Int16Array.from({ length: 960 }, (_, i) => (i % 100) + 1);
    void m.encolarAgente(voz);
    const salida: number[] = [];
    await bombearSalida({ mezclador: m, ...d, enviar: async (x) => { salida.push(...x); await d.enviar(x); }, terminado: () => salida.length >= 960 });
    expect(salida).toEqual(Array.from(voz));
  });
});

describe("bombearConRespaldo (un fallo no se traga)", () => {
  it("si el destino lanza, avisa UNA vez con un codigo corto y deja de bombear (no relanza)", async () => {
    const d = destino();
    const codigos: string[] = [];
    let intentos = 0;
    await bombearConRespaldo({
      mezclador: new MezcladorSalida({ ambiente: { volumen: 8 } }),
      ...d,
      enviar: async () => {
        if (++intentos === 3) throw new TypeError("secreto: +52 999 123 4567 no debe viajar");
      },
      terminado: () => false,
      alFallo: (c) => codigos.push(c),
    });
    expect(intentos).toBe(3);
    expect(codigos).toEqual(["TypeError"]); // solo el nombre del error, sin el mensaje (que podria llevar PII)
  });

  it("si el mezclador lanza al generar la trama, tambien avisa", async () => {
    const d = destino();
    const m = new MezcladorSalida({ ambiente: { volumen: 8 } });
    m.siguiente = () => {
      throw new RangeError("boom");
    };
    const codigos: string[] = [];
    await bombearConRespaldo({ mezclador: m, ...d, terminado: () => false, alFallo: (c) => codigos.push(c) });
    expect(codigos).toEqual(["RangeError"]);
  });

  it("sin fallo no avisa", async () => {
    const d = destino();
    const codigos: string[] = [];
    await bombearConRespaldo({ mezclador: new MezcladorSalida({ ambiente: { volumen: 8 } }), ...d, terminado: () => d.e.tramas.length >= 5, alFallo: (c) => codigos.push(c) });
    expect(codigos).toEqual([]);
  });
});

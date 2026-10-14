// Bombeo de la salida mezclada: tramas de 20 ms, sin adelantarse al reloj mas de lo permitido, hasta que la llamada termina. Reloj y espera inyectados.
import { describe, expect, it } from "vitest";
import { MezcladorSalida } from "@atiende/voice-core";
import { bombearSalida } from "../src/audio/bombeo-salida.ts";

function conReloj() {
  let t = 0;
  const esperas: number[] = [];
  return {
    ahora: () => t,
    dormir: async (ms: number) => {
      esperas.push(ms);
      t += ms;
    },
    avanzar: (ms: number) => void (t += ms),
    esperas,
  };
}

describe("bombearSalida", () => {
  it("entrega tramas de exactamente 20 ms (480 muestras a 24 kHz) hasta que `terminado` y devuelve cuantas envio", async () => {
    const r = conReloj();
    const tramas: Int16Array[] = [];
    const m = new MezcladorSalida({ ambiente: { volumen: 8, semilla: 1 } });
    const n = await bombearSalida({ mezclador: m, enviar: async (x) => void tramas.push(x), ahora: r.ahora, dormir: r.dormir, terminado: () => tramas.length >= 50 });
    expect(n).toBe(50);
    expect(tramas.every((x) => x.length === 480)).toBe(true);
    expect(tramas.some((x) => x.some((v) => v !== 0))).toBe(true);
  });

  it("no se adelanta mas de ~200 ms al reloj: duerme cuando lleva ventaja (la cola de LiveKit no crece sin limite)", async () => {
    const r = conReloj();
    let enviadas = 0;
    await bombearSalida({ mezclador: new MezcladorSalida({ ambiente: { volumen: 8 } }), enviar: async () => void enviadas++, ahora: r.ahora, dormir: r.dormir, terminado: () => enviadas >= 100 });
    // 100 tramas = 2000 ms de audio; el reloj nunca avanza solo, asi que solo avanza al dormir: al final lo emitido no supera el reloj + 200 ms
    expect(enviadas * 20).toBeLessThanOrEqual(r.ahora() + 200 + 20);
    expect(r.esperas.length).toBeGreaterThan(0);
  });

  it("si el destino va lento (el reloj avanza mas que las tramas) no duerme nunca", async () => {
    const r = conReloj();
    let enviadas = 0;
    await bombearSalida({ mezclador: new MezcladorSalida({ ambiente: { volumen: 8 } }), enviar: async () => { enviadas++; r.avanzar(25); }, ahora: r.ahora, dormir: r.dormir, terminado: () => enviadas >= 20 });
    expect(r.esperas).toEqual([]);
  });

  it("la voz del agente encolada sale por las tramas, en orden", async () => {
    const r = conReloj();
    const m = new MezcladorSalida({ ambiente: { volumen: 0 } , tecleo: { volumen: 0 } });
    expect(m.conEfectos).toBe(false);
    const voz = Int16Array.from({ length: 960 }, (_, i) => (i % 100) + 1);
    void m.encolarAgente(voz);
    const salida: number[] = [];
    await bombearSalida({ mezclador: m, enviar: async (x) => void salida.push(...x), ahora: r.ahora, dormir: r.dormir, terminado: () => salida.length >= 960 });
    expect(salida).toEqual(Array.from(voz));
  });
});

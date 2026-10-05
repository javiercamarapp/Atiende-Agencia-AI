// Puente de audio de una llamada: remuestreo hacia el escalon, barge-in, silencio, reloj, DTMF y latencia de voz a voz. Tiempo manual: ninguna prueba espera.
import { describe, expect, it } from "vitest";
import { muestrasABytes } from "../src/audio/pcm.ts";
import { PuenteAudio } from "../src/puente-audio.ts";
import type { DestinoEventosLlamada } from "../src/puente-audio.ts";
import { LlamadaFalsa } from "../src/telefonia/falsa.ts";
import { rms, silencio, tono } from "./support/audio.ts";
import { callar, hablar } from "./support/llamada.ts";
import { RelojManual } from "./support/mundo-api.ts";

function armar() {
  const reloj = new RelojManual();
  const tel = new LlamadaFalsa({ id: "sala-1", dnis: "+529991110001", desde: "+5219991234567" });
  const eventos = { habla: 0, silencios: [] as number[], dtmf: [] as string[], ticks: [] as number[] };
  const destino: DestinoEventosLlamada = {
    usuarioHabla: async () => void (eventos.habla += 1),
    silencio: async (ms) => void eventos.silencios.push(ms),
    dtmf: async (d) => void eventos.dtmf.push(d),
    tick: async (s) => void eventos.ticks.push(s),
  };
  const enviado: Uint8Array[] = [];
  const puente = new PuenteAudio({ tel, eventos: destino, enviarASesion: (pcm) => void enviado.push(pcm), ahora: reloj.ahora });
  return { reloj, tel, eventos, enviado, puente };
}

describe("audio hacia el escalon", () => {
  it.each([8_000, 16_000, 48_000])("el audio del llamante a %i Hz llega al escalon como PCM16 de 16 kHz con la energia de la voz", async (hz) => {
    const { tel, reloj, enviado } = armar();
    await hablar(tel, reloj, 400, hz);
    const total = enviado.reduce((s, b) => s + b.byteLength / 2, 0);
    expect(Math.abs(total - 16_000 * 0.4)).toBeLessThanOrEqual(8); // 400 ms a 16 kHz
    const muestras = new Int16Array(enviado.flatMap((b) => [...new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2)]));
    expect(rms(muestras)).toBeGreaterThan(0.2);
  });

  it("el silencio llega como silencio (el escalon decide el fin de turno)", async () => {
    const { tel, reloj, enviado } = armar();
    await callar(tel, reloj, 200);
    expect(enviado.length).toBeGreaterThan(0);
    for (const b of enviado) expect(rms(new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2))).toBe(0);
  });
});

describe("barge-in y voz del cliente", () => {
  it("la voz del cliente avisa UNA vez al controlador al empezar a hablar (no por cada trozo)", async () => {
    const { tel, reloj, eventos } = armar();
    await hablar(tel, reloj, 600);
    expect(eventos.habla).toBe(1);
    await callar(tel, reloj, 700);
    await hablar(tel, reloj, 400);
    expect(eventos.habla).toBe(2);
  });

  it("un chasquido corto (menos de 80 ms) no cuenta como voz", async () => {
    const { tel, reloj, eventos } = armar();
    await hablar(tel, reloj, 40);
    await callar(tel, reloj, 600);
    expect(eventos.habla).toBe(0);
  });

  it("cortarAudio calla lo que suena y descarta lo encolado detras; despues el audio nuevo vuelve a sonar", async () => {
    const { tel, puente } = armar();
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    puente.cortarAudio();
    expect(tel.cortes).toBe(1);
    puente.audioAgente(muestrasABytes(tono(24_000, 50)));
    await puente.vaciar();
    // Las dos primeras ya habian entrado a la cola (la reproduccion falsa es inmediata) y la tercera es nueva: ninguna se pierde despues del corte.
    expect(tel.salida.at(-1)?.hz).toBe(24_000);
    expect(tel.salida.at(-1)?.cortesPrevios).toBe(1);
  });

  it("el audio del agente se reproduce en orden y a 24 kHz", async () => {
    const { tel, puente } = armar();
    puente.audioAgente(muestrasABytes(tono(24_000, 20, 300)));
    puente.audioAgente(muestrasABytes(tono(24_000, 40, 600)));
    await puente.vaciar();
    expect(tel.salida.map((s) => s.pcm.length)).toEqual([480, 960]);
    expect(tel.salida.every((s) => s.hz === 24_000)).toBe(true);
  });
});

describe("reloj y silencio", () => {
  it("cada segundo avanza el reloj de la llamada (tick) y, si nadie habla, cuenta el silencio desde el ultimo audio", async () => {
    const { reloj, eventos, puente } = armar();
    for (let s = 0; s < 3; s++) {
      reloj.avanzar(1_000);
      puente.tickSegundo();
    }
    expect(eventos.ticks).toEqual([1, 2, 3]);
    expect(eventos.silencios).toEqual([1_000, 2_000, 3_000]);
  });

  it("mientras el cliente habla o el agente esta sonando NO se cuenta silencio", async () => {
    const { tel, reloj, eventos, puente } = armar();
    await hablar(tel, reloj, 400);
    reloj.avanzar(1_000);
    puente.tickSegundo(); // el cliente habia hablado (aun no pasan 500 ms de silencio): sigue "hablando"
    expect(eventos.silencios).toEqual([]);
    await callar(tel, reloj, 700);
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    reloj.avanzar(1_000);
    puente.tickSegundo(); // el agente aun esta sonando (en cola): no cuenta como silencio del cliente
    expect(eventos.silencios).toEqual([]);
    await puente.vaciar();
    reloj.avanzar(1_000);
    puente.tickSegundo();
    // el audio del agente ya termino de reproducirse (la falsa es inmediata): el silencio vuelve a contar desde ahi
    expect(eventos.silencios).toEqual([1_000]);
  });

  it("un pregrabado reinicia la cuenta del silencio (la re-pregunta no suma como silencio del cliente)", async () => {
    const { reloj, eventos, puente } = armar();
    reloj.avanzar(5_000);
    await puente.reproducirPregrabado({ muestras: silencio(8_000, 20), hz: 8_000 });
    reloj.avanzar(1_000);
    puente.tickSegundo();
    expect(eventos.silencios).toEqual([1_000]);
  });

  it("cerrado el puente ya no emite eventos ni reproduce", async () => {
    const { tel, reloj, eventos, puente } = armar();
    puente.cerrar();
    await hablar(tel, reloj, 400);
    puente.tickSegundo();
    puente.audioAgente(muestrasABytes(tono(24_000, 20)));
    await puente.reproducirPregrabado({ muestras: silencio(8_000, 20), hz: 8_000 });
    expect(eventos.habla).toBe(0);
    expect(eventos.ticks).toEqual([]);
    expect(tel.salida).toEqual([]);
  });
});

describe("DTMF", () => {
  it("el digito de la linea llega al controlador", () => {
    const { tel, eventos } = armar();
    tel.teclear("0");
    tel.teclear("*");
    expect(eventos.dtmf).toEqual(["0", "*"]);
  });
});

describe("latencia de voz a voz", () => {
  it("se mide del ULTIMO audio con voz del cliente al primer audio del agente de cada respuesta", async () => {
    const { tel, reloj, puente } = armar();
    await hablar(tel, reloj, 600);
    await callar(tel, reloj, 800); // el fin de voz se da por hecho a los 500 ms de silencio
    reloj.avanzar(0);
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    // ultimo audio con voz = t0 + 600; el agente contesta a t0 + 600 + 800 = 800 ms despues.
    expect(puente.latenciasMs).toEqual([800]);
    // Un segundo trozo de la MISMA respuesta no cuenta como otra respuesta.
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    expect(puente.latenciasMs).toHaveLength(1);
    await hablar(tel, reloj, 400);
    await callar(tel, reloj, 600);
    reloj.avanzar(100);
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    expect(puente.latenciasMs).toEqual([800, 700]);
  });

  it("el saludo inicial (nadie hablo antes) no cuenta como respuesta", () => {
    const { puente } = armar();
    puente.audioAgente(muestrasABytes(tono(24_000, 100)));
    expect(puente.latenciasMs).toEqual([]);
  });

  it("un pregrabado tras la voz del cliente no se mide como respuesta del agente", async () => {
    const { tel, reloj, puente } = armar();
    await hablar(tel, reloj, 400);
    await callar(tel, reloj, 700);
    await puente.reproducirPregrabado({ muestras: silencio(8_000, 20), hz: 8_000 });
    puente.audioAgente(muestrasABytes(tono(24_000, 20)));
    expect(puente.latenciasMs).toEqual([]);
  });
});

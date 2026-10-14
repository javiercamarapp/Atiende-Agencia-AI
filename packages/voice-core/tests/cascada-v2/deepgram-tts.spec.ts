// Adaptador de TTS sobre Deepgram Aura-2 (WebSocket FALSO): URL y formato, Speak + Flush por frase, audio en streaming con longitud par, fin con Flushed,
// cancelacion (barge-in), reconexion, limites documentados y caidas. Nada toca la red; el reloj se inyecta.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, VozProveedorError, crearTtsDeepgram, urlSpeakDeepgram } from "../../src/index.ts";
import { fabricaSockets, turnoMicrotareas } from "./dobles.ts";

const C = VOZ_PLATAFORMA.cascadaV2.deepgramAura2;

async function abrir(extra: { ahora?: () => number; autoAbrir?: boolean } = {}) {
  const f = fabricaSockets({ autoAbrir: extra.autoAbrir });
  const tts = crearTtsDeepgram({ apiKey: "dg-llave-de-prueba", config: C, crearSocket: f.crear, ...(extra.ahora ? { ahora: extra.ahora } : {}) });
  const sesion = await tts.abrir({ voz: "aura-2-estrella-es", hzSalida: 24_000 });
  return { sesion, ...f };
}

/** Consume el iterador a un arreglo. */
async function recolectar(it: AsyncIterable<Uint8Array>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const t of it) out.push([...t]);
  return out;
}

describe("TTS Deepgram Aura-2: conexion", () => {
  it("abre /v1/speak con la voz pedida, PCM lineal (linear16) a 24 kHz", async () => {
    const { sockets } = await abrir();
    const url = new URL(sockets[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.deepgram.com/v1/speak");
    expect(Object.fromEntries(url.searchParams)).toEqual({ model: "aura-2-estrella-es", encoding: "linear16", sample_rate: "24000" });
    expect(urlSpeakDeepgram("aura-2-olivia-es", 24_000)).toContain("model=aura-2-olivia-es");
  });

  it("la llave viaja solo en la cabecera Authorization y nunca en la URL", async () => {
    const { sockets } = await abrir();
    expect(sockets[0]!.headers).toEqual({ Authorization: "Token dg-llave-de-prueba" });
    expect(sockets[0]!.url).not.toContain("dg-llave-de-prueba");
  });

  it("si el socket falla al abrir, la apertura se rechaza (el escalon se salta)", async () => {
    const f = fabricaSockets({ autoAbrir: false });
    const p = crearTtsDeepgram({ apiKey: "k", config: C, crearSocket: f.crear }).abrir({ voz: "aura-2-estrella-es", hzSalida: 24_000 });
    await turnoMicrotareas();
    f.sockets[0]!.onerror?.({});
    await expect(p).rejects.toBeInstanceOf(VozProveedorError);
  });
});

describe("TTS Deepgram Aura-2: una frase", () => {
  it("manda Speak y Flush, entrega el audio conforme llega y termina con Flushed", async () => {
    const { sesion, sockets } = await abrir();
    const s = sockets[0]!;
    const it = sesion.sintetizar("Claro, con gusto.", new AbortController().signal)[Symbol.asyncIterator]();
    const primero = it.next();
    await turnoMicrotareas();
    expect(s.json).toEqual([{ type: "Speak", text: "Claro, con gusto." }, { type: "Flush" }]);
    s.audio([1, 0, 2, 0]);
    expect([...(await primero).value!]).toEqual([1, 0, 2, 0]);
    const segundo = it.next();
    s.audio([3, 0]);
    expect([...(await segundo).value!]).toEqual([3, 0]);
    const fin = it.next();
    s.texto({ type: "Flushed", sequence_id: 0 });
    expect((await fin).done).toBe(true);
    expect(s.cerrado).toBeNull();
  });

  it("una trama que parte una muestra de 16 bits se acomoda: cada trozo entregado tiene longitud par", async () => {
    const { sesion, sockets } = await abrir();
    const s = sockets[0]!;
    const resultado = recolectar(sesion.sintetizar("hola", new AbortController().signal));
    await turnoMicrotareas();
    s.audio([1, 0, 2]);
    s.audio([0, 3, 0, 4]);
    s.audio([0]);
    s.texto({ type: "Flushed", sequence_id: 0 });
    const trozos = await resultado;
    for (const t of trozos) expect(t.length % 2).toBe(0);
    expect(trozos.flat()).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
  });

  it("las frases se atienden de una en una y en orden, reutilizando la misma conexion", async () => {
    const { sesion, sockets } = await abrir();
    const s = sockets[0]!;
    const senal = new AbortController().signal;
    const r1 = recolectar(sesion.sintetizar("Primera frase.", senal));
    const r2 = recolectar(sesion.sintetizar("Segunda frase.", senal));
    await turnoMicrotareas();
    expect(s.json.filter((m) => m.type === "Speak")).toEqual([{ type: "Speak", text: "Primera frase." }]);
    s.audio([1, 0]);
    s.texto({ type: "Flushed", sequence_id: 0 });
    expect(await r1).toEqual([[1, 0]]);
    await turnoMicrotareas();
    expect(s.json.filter((m) => m.type === "Speak")).toHaveLength(2);
    s.audio([2, 0]);
    s.texto({ type: "Flushed", sequence_id: 1 });
    expect(await r2).toEqual([[2, 0]]);
    expect(sockets).toHaveLength(1);
  });

  it("un texto de mas de 2 000 caracteres se parte en varios Speak y un solo Flush", async () => {
    const { sesion, sockets } = await abrir();
    const s = sockets[0]!;
    const largo = Array.from({ length: 600 }, (_, i) => `palabra${i}`).join(" ");
    const r = recolectar(sesion.sintetizar(largo, new AbortController().signal));
    await turnoMicrotareas();
    const speaks = s.json.filter((m) => m.type === "Speak");
    expect(speaks.length).toBeGreaterThan(1);
    for (const m of speaks) expect((m.text as string).length).toBeLessThanOrEqual(2000);
    expect(s.json.filter((m) => m.type === "Flush")).toHaveLength(1);
    s.texto({ type: "Flushed", sequence_id: 0 });
    await r;
  });
});

describe("TTS Deepgram Aura-2: cancelacion y fallos", () => {
  it("abortar a media frase (barge-in) manda Clear, cierra el socket y descarta el audio que siga llegando", async () => {
    const { sesion, sockets } = await abrir();
    const s = sockets[0]!;
    const ctl = new AbortController();
    const it = sesion.sintetizar("Una frase larga que el cliente interrumpe.", ctl.signal)[Symbol.asyncIterator]();
    const p = it.next();
    await turnoMicrotareas();
    s.audio([1, 0]);
    expect((await p).value).toBeDefined();
    const siguiente = it.next();
    ctl.abort();
    expect((await siguiente).done).toBe(true);
    expect(s.json.at(-1)).toEqual({ type: "Clear" });
    expect(s.cerrado?.code).toBe(1000);
    s.audio([9, 0]); // audio rezagado: no debe colarse en nada
  });

  it("tras un barge-in la frase siguiente abre una conexion NUEVA (sin audio viejo)", async () => {
    const { sesion, sockets } = await abrir();
    const ctl = new AbortController();
    const it = sesion.sintetizar("Frase uno que se corta.", ctl.signal)[Symbol.asyncIterator]();
    const p = it.next();
    await turnoMicrotareas();
    ctl.abort();
    await p;
    const r = recolectar(sesion.sintetizar("Frase dos.", new AbortController().signal));
    await turnoMicrotareas(40);
    expect(sockets).toHaveLength(2);
    sockets[1]!.audio([5, 0]);
    sockets[1]!.texto({ type: "Flushed", sequence_id: 0 });
    expect(await r).toEqual([[5, 0]]);
  });

  it("una senal ya abortada no sintetiza nada", async () => {
    const { sesion, sockets } = await abrir();
    const ctl = new AbortController();
    ctl.abort();
    expect(await recolectar(sesion.sintetizar("hola", ctl.signal))).toEqual([]);
    expect(sockets[0]!.json.filter((m) => m.type === "Speak")).toEqual([]);
  });

  it("un Warning o un cierre a media frase fallan con un codigo corto sin PII", async () => {
    const a = await abrir();
    const ra = recolectar(a.sesion.sintetizar("hola", new AbortController().signal));
    await turnoMicrotareas();
    a.sockets[0]!.texto({ type: "Warning", description: "texto del cliente", code: "X" });
    await expect(ra).rejects.toThrow("tts_warning");
    const b = await abrir();
    const rb = recolectar(b.sesion.sintetizar("hola", new AbortController().signal));
    await turnoMicrotareas();
    b.sockets[0]!.caer(1011);
    await expect(rb).rejects.toThrow("tts_ws_1011");
  });

  it("mensajes de texto que no son JSON o no tienen forma de objeto se ignoran sin romper la frase", async () => {
    const { sesion, sockets } = await abrir();
    const s = sockets[0]!;
    const r = recolectar(sesion.sintetizar("hola", new AbortController().signal));
    await turnoMicrotareas();
    s.onmessage?.({ data: "no es json" });
    s.texto(null);
    s.texto(0);
    s.texto({ type: "Metadata", request_id: "x" });
    s.texto({ type: "Cleared", sequence_id: 3 });
    s.texto({ type: "Flushed", sequence_id: 0 });
    expect(await r).toEqual([]);
  });

  it("si la conexion se cierra en reposo, la siguiente frase reconecta sola", async () => {
    const { sesion, sockets } = await abrir();
    sockets[0]!.caer(1000);
    const r = recolectar(sesion.sintetizar("hola otra vez", new AbortController().signal));
    await turnoMicrotareas(40);
    expect(sockets).toHaveLength(2);
    sockets[1]!.texto({ type: "Flushed", sequence_id: 0 });
    expect(await r).toEqual([]);
  });

  it("respeta el limite de 20 Flush por minuto: antes de llegar a el falla con tts_flush_limite, y la ventana se renueva con el reloj", async () => {
    let ahora = 5_000_000;
    const { sesion, sockets } = await abrir({ ahora: () => ahora });
    const s = sockets[0]!;
    const senal = new AbortController().signal;
    for (let i = 0; i < 19; i++) {
      const r = recolectar(sesion.sintetizar(`frase ${i}`, senal));
      await turnoMicrotareas();
      s.texto({ type: "Flushed", sequence_id: i });
      await r;
    }
    await expect(recolectar(sesion.sintetizar("una mas", senal))).rejects.toThrow("tts_flush_limite");
    ahora += 61_000;
    const r = recolectar(sesion.sintetizar("ya paso la ventana", senal));
    await turnoMicrotareas(40);
    const activo = sockets.at(-1)!;
    activo.texto({ type: "Flushed", sequence_id: 0 });
    await expect(r).resolves.toEqual([]);
  });

  it("cerrar manda Close, cierra el socket y las frases posteriores fallan; cerrar dos veces no repite", async () => {
    const { sesion, sockets } = await abrir();
    await sesion.cerrar();
    await sesion.cerrar();
    expect(sockets[0]!.json).toEqual([{ type: "Close" }]);
    expect(sockets[0]!.cerrado?.code).toBe(1000);
    await expect(recolectar(sesion.sintetizar("hola", new AbortController().signal))).rejects.toThrow("tts_cerrado");
  });
});

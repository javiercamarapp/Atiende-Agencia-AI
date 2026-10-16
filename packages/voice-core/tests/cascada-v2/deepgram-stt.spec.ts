// Adaptador de STT sobre Deepgram (WebSocket FALSO): URL y parametros, autenticacion, resultados intermedios, fin de turno por endpointing / UtteranceEnd,
// barge-in (SpeechStarted), KeepAlive, cierre y caidas. Nada toca la red; el reloj y el temporizador se inyectan.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, VozProveedorError, crearSttDeepgram, urlListenDeepgram } from "../../src/index.ts";
import type { EventosStt } from "../../src/index.ts";
import { fabricaSockets, resultadoStt, turnoMicrotareas } from "./dobles.ts";

const C = VOZ_PLATAFORMA.cascadaV2.deepgram;

function eventos() {
  const log: string[] = [];
  const e: EventosStt = {
    hablaIniciada: () => log.push("habla"),
    parcial: (t) => log.push(`parcial:${t}`),
    turnoFinal: (t) => log.push(`final:${t}`),
    caido: (c) => log.push(`caido:${c}`),
  };
  return { e, log };
}

async function abrir(extra: { vocabulario?: string[]; programar?: (t: () => void, ms: number) => () => void; ahora?: () => number } = {}) {
  const { sockets, crear } = fabricaSockets();
  const ev = eventos();
  const stt = crearSttDeepgram({ apiKey: "dg-llave-de-prueba", config: C, crearSocket: crear, ...(extra.programar ? { programar: extra.programar } : {}), ...(extra.ahora ? { ahora: extra.ahora } : {}) });
  const sesion = await stt.abrir({ hzEntrada: 16_000, ...(extra.vocabulario ? { vocabulario: extra.vocabulario } : {}) }, ev.e);
  return { sesion, socket: sockets[0]!, ...ev };
}

describe("STT Deepgram: conexion", () => {
  it("abre /v1/listen con Nova-3, es-419, PCM lineal de 16 kHz, resultados intermedios, endpointing y utterance_end", async () => {
    const { socket } = await abrir();
    const url = new URL(socket.url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "nova-3",
      language: "es-419",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      endpointing: String(C.endpointingMs),
      utterance_end_ms: String(C.utteranceEndMs),
      vad_events: "true",
      smart_format: "true",
    });
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("la llave viaja solo en la cabecera Authorization y nunca en la URL", async () => {
    const { socket } = await abrir();
    expect(socket.headers).toEqual({ Authorization: "Token dg-llave-de-prueba" });
    expect(socket.url).not.toContain("dg-llave-de-prueba");
  });

  it("cada termino del menu es su propio parametro keyterm (no hay `keywords`, que Nova-3 no admite)", () => {
    const url = new URL(urlListenDeepgram(C, { hzEntrada: 16_000, vocabulario: ["cochinita pibil", "panuchos", "cochinita pibil"] }));
    expect(url.searchParams.getAll("keyterm")).toEqual(["cochinita pibil", "panuchos"]);
    expect(url.searchParams.has("keywords")).toBe(false);
  });

  it("si el socket falla o se cierra al abrir, la apertura se rechaza con un error de proveedor", async () => {
    const a = fabricaSockets({ autoAbrir: false });
    const p1 = crearSttDeepgram({ apiKey: "k", config: C, crearSocket: a.crear }).abrir({ hzEntrada: 16_000 }, eventos().e);
    await turnoMicrotareas();
    a.sockets[0]!.onerror?.({});
    await expect(p1).rejects.toBeInstanceOf(VozProveedorError);
    const b = fabricaSockets({ autoAbrir: false });
    const p2 = crearSttDeepgram({ apiKey: "k", config: C, crearSocket: b.crear }).abrir({ hzEntrada: 16_000 }, eventos().e);
    await turnoMicrotareas();
    b.sockets[0]!.caer(1006);
    await expect(p2).rejects.toThrow(/1006/);
  });
});

describe("STT Deepgram: transcripcion y fin de turno", () => {
  it("manda el audio PCM tal cual como trama binaria y no manda audio vacio", async () => {
    const { sesion, socket } = await abrir();
    sesion.enviarAudio(Uint8Array.from([1, 0, 2, 0]));
    sesion.enviarAudio(new Uint8Array(0));
    expect(socket.binarios).toEqual([Uint8Array.from([1, 0, 2, 0])]);
  });

  it("los resultados intermedios llegan como parcial y el turno cierra con speech_final (endpointing de Deepgram)", async () => {
    const { socket, log } = await abrir();
    socket.texto(resultadoStt("quiero dos", { final: false }));
    socket.texto(resultadoStt("quiero dos tacos", { final: true }));
    socket.texto(resultadoStt("de cochinita", { final: true, speechFinal: true }));
    expect(log).toEqual(["parcial:quiero dos", "parcial:quiero dos tacos", "parcial:quiero dos tacos de cochinita", "final:quiero dos tacos de cochinita"]);
  });

  it("un resultado final sin speech_final no cierra el turno; el turno siguiente empieza de cero", async () => {
    const { socket, log } = await abrir();
    socket.texto(resultadoStt("hola", { final: true }));
    expect(log.some((l) => l.startsWith("final:"))).toBe(false);
    socket.texto(resultadoStt("buenas", { final: true, speechFinal: true }));
    socket.texto(resultadoStt("otra cosa", { final: true, speechFinal: true }));
    expect(log.filter((l) => l.startsWith("final:"))).toEqual(["final:hola buenas", "final:otra cosa"]);
  });

  it("UtteranceEnd cierra el turno de respaldo; con last_word_end -1 se ignora (ya estaba finalizado)", async () => {
    const { socket, log } = await abrir();
    socket.texto(resultadoStt("una horchata", { final: true }));
    socket.texto({ type: "UtteranceEnd", last_word_end: -1 });
    expect(log.some((l) => l.startsWith("final:"))).toBe(false);
    socket.texto({ type: "UtteranceEnd", last_word_end: 2.4 });
    expect(log.filter((l) => l.startsWith("final:"))).toEqual(["final:una horchata"]);
    socket.texto({ type: "UtteranceEnd", last_word_end: 3.1 });
    expect(log.filter((l) => l.startsWith("final:"))).toHaveLength(1);
  });

  it("una transcripcion vacia (silencio o ruido) no produce turno", async () => {
    const { socket, log } = await abrir();
    socket.texto(resultadoStt("", { final: true, speechFinal: true }));
    socket.texto(resultadoStt("   ", { final: false }));
    expect(log).toEqual([]);
  });

  it("SpeechStarted avisa el inicio de voz (barge-in)", async () => {
    const { socket, log } = await abrir();
    socket.texto({ type: "SpeechStarted", channel: [0, 1], timestamp: 9.5 });
    expect(log).toEqual(["habla"]);
  });

  it("mensajes que no son JSON, de otro tipo o sin forma esperada no rompen nada", async () => {
    const { socket, log } = await abrir();
    socket.onmessage?.({ data: "no es json" });
    socket.texto({ type: "Metadata", request_id: "x" });
    socket.texto({ type: "Error", description: "algo" });
    socket.texto(null);
    socket.texto({});
    socket.texto({ type: "Results" });
    socket.onmessage?.({ data: 0 });
    socket.onmessage?.({ data: null });
    expect(log).toEqual([]);
  });
});

describe("STT Deepgram: KeepAlive, cierre y caidas", () => {
  it("manda KeepAlive (texto) solo si pasaron 4 s sin audio; con audio reciente no", async () => {
    let ahora = 1_000_000;
    let tick: (() => void) | null = null;
    const { sesion, socket } = await abrir({
      ahora: () => ahora,
      programar: (t) => {
        tick = t;
        return () => undefined;
      },
    });
    sesion.enviarAudio(Uint8Array.from([1, 0]));
    ahora += 1_000;
    tick!();
    expect(socket.json).toEqual([]);
    ahora += 4_000;
    tick!();
    expect(socket.json).toEqual([{ type: "KeepAlive" }]);
  });

  it("cerrar manda CloseStream, cierra el socket y cancela el KeepAlive; cerrar dos veces no repite", async () => {
    let cancelado = false;
    const { sesion, socket } = await abrir({ programar: () => () => void (cancelado = true) });
    await sesion.cerrar();
    await sesion.cerrar();
    expect(socket.json).toEqual([{ type: "CloseStream" }]);
    expect(socket.cerrado?.code).toBe(1000);
    expect(cancelado).toBe(true);
  });

  it("un cierre inesperado avisa UNA sola vez con un codigo corto sin PII; uno propio no avisa", async () => {
    const a = await abrir();
    a.socket.caer(1006);
    a.socket.caer(1006);
    a.socket.onerror?.({});
    expect(a.log).toEqual(["caido:stt_ws_1006"]);
    const b = await abrir();
    await b.sesion.cerrar();
    b.socket.caer(1000);
    expect(b.log).toEqual([]);
  });

  it("tras la caida ya no se manda audio", async () => {
    const { sesion, socket } = await abrir();
    socket.caer(1011);
    sesion.enviarAudio(Uint8Array.from([1, 0]));
    expect(socket.binarios).toEqual([]);
  });

  it("si el envio falla, avisa la caida", async () => {
    const { sesion, socket, log } = await abrir();
    socket.send = () => {
      throw new Error("socket cerrado");
    };
    sesion.enviarAudio(Uint8Array.from([1, 0]));
    expect(log).toEqual(["caido:stt_send"]);
  });
});

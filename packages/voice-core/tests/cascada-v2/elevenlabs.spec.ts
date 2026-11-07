// ElevenLabs en la cascada v2: Scribe v2 Realtime (STT) y eleven_v4_turbo (TTS) contra un WebSocket y un fetch FALSOS. Nada toca la red.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, VozProveedorError, crearSttElevenLabs, crearTtsElevenLabs, esVozElevenLabs, resolverVozElevenLabs, urlSttElevenLabs } from "../../src/index.ts";
import type { EventosStt } from "../../src/index.ts";
import { fabricaSockets, turnoMicrotareas } from "./dobles.ts";

const C = VOZ_PLATAFORMA.cascadaV2.elevenlabs;
const LLAVE = "llave-de-prueba";

/** Temporizador manual: las pruebas deciden cuando vence cada plazo. */
function relojManual() {
  let n = 0;
  const pendientes = new Map<number, { fn: () => void; ms: number }>();
  return {
    pendientes,
    poner: (fn: () => void, ms: number): unknown => {
      n += 1;
      pendientes.set(n, { fn, ms });
      return n;
    },
    quitar: (id: unknown): void => void pendientes.delete(id as number),
    /** Dispara los pendientes con ese plazo. */
    vencer(ms: number): void {
      for (const [id, p] of [...pendientes]) {
        if (p.ms !== ms) continue;
        pendientes.delete(id);
        p.fn();
      }
    },
  };
}

function eventosFalsos() {
  const vistos: string[] = [];
  const e: EventosStt = {
    hablaIniciada: () => void vistos.push("habla"),
    parcial: (t) => void vistos.push(`parcial:${t}`),
    turnoFinal: (t) => void vistos.push(`final:${t}`),
    caido: (c) => void vistos.push(`caido:${c}`),
  };
  return { vistos, e };
}

async function abrirStt(vocabulario?: string[]) {
  const f = fabricaSockets();
  const reloj = relojManual();
  const { vistos, e } = eventosFalsos();
  const puerto = crearSttElevenLabs({ apiKey: LLAVE, config: C.stt, crearSocket: f.crear, temporizador: reloj });
  const abriendo = puerto.abrir({ hzEntrada: 16_000, ...(vocabulario ? { vocabulario } : {}) }, e);
  await turnoMicrotareas();
  f.sockets[0]!.texto({ message_type: "session_started", session_id: "s" });
  const sesion = await abriendo;
  return { f, reloj, vistos, sesion, socket: f.sockets[0]! };
}

describe("ElevenLabs Scribe v2 Realtime (STT)", () => {
  it("URL: modelo, PCM a la tasa de la sala, espanol, VAD con 0.55 s y cada termino del menu como `keyterms` repetido; la llave NUNCA va en la URL", async () => {
    const url = new URL(urlSttElevenLabs(C.stt, { hzEntrada: 16_000, vocabulario: ["cochinita pibil", "panuchos", "cochinita pibil"] }));
    expect(url.origin + url.pathname).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k !== "keyterms"))).toEqual({ model_id: "scribe_v2_realtime", audio_format: "pcm_16000", language_code: "es", commit_strategy: "vad", vad_silence_threshold_secs: "0.55" });
    expect(url.searchParams.getAll("keyterms")).toEqual(["cochinita pibil", "panuchos"]);
    const { socket } = await abrirStt();
    expect(socket.url).not.toContain(LLAVE);
    expect(socket.headers).toEqual({ "xi-api-key": LLAVE });
  });

  it("keyterms dentro de los limites de Scribe RT (50 terminos de hasta 20 caracteres): uno fuera de limite haria fallar la sesion entera", async () => {
    const { keytermsElevenLabs } = await import("../../src/index.ts");
    const k = keytermsElevenLabs(["Orden de tacos de cochinita pibil (orden de 5)", "Panuchos", "Salbutes de pavo", "Queso relleno", "Gringa de pastor con queso", "Panuchos"], 50);
    expect(k).toEqual(["cochinita pibil", "Panuchos", "Salbutes de pavo", "Queso relleno", "pastor con queso"]);
    expect(k.every((t) => t.length <= 20)).toBe(true);
    expect(keytermsElevenLabs(Array.from({ length: 80 }, (_, i) => `Platillo ${i}`), 200)).toHaveLength(50);
    const url = new URL(urlSttElevenLabs(C.stt, { hzEntrada: 16_000, vocabulario: ["Orden de tacos de cochinita pibil"] }));
    expect(url.searchParams.getAll("keyterms")).toEqual(["cochinita pibil"]);
  });

  it("una tasa que ElevenLabs no admite falla al abrir (la escalera o el respaldo deciden)", () => {
    expect(() => urlSttElevenLabs(C.stt, { hzEntrada: 11_025 })).toThrow(VozProveedorError);
  });

  it("no queda lista hasta `session_started`; un error de autenticacion al abrir rechaza sin filtrar el texto del proveedor", async () => {
    const f = fabricaSockets();
    const abriendo = crearSttElevenLabs({ apiKey: LLAVE, config: C.stt, crearSocket: f.crear, temporizador: relojManual() }).abrir({ hzEntrada: 16_000 }, eventosFalsos().e);
    await turnoMicrotareas();
    f.sockets[0]!.texto({ message_type: "auth_error", error: "secreto-del-proveedor" });
    const err = await abriendo.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VozProveedorError);
    expect(String((err as Error).message)).toContain("auth_error");
    expect(String((err as Error).message)).not.toContain("secreto-del-proveedor");
  });

  it("manda el audio como `input_audio_chunk` en base64 sin commit", async () => {
    const { sesion, socket } = await abrirStt();
    sesion.enviarAudio(Uint8Array.from([1, 2, 3, 4]));
    expect(socket.json.at(-1)).toEqual({ message_type: "input_audio_chunk", audio_base_64: "AQIDBA==", commit: false, sample_rate: 16_000 });
  });

  it("parcial -> habla iniciada + parcial; commit -> espera la ventana minima (0.4 s) y entrega el turno", async () => {
    const { reloj, vistos, socket } = await abrirStt();
    socket.texto({ message_type: "partial_transcript", text: "quiero dos" });
    socket.texto({ message_type: "committed_transcript", text: "Quiero dos de cochinita." });
    expect(vistos).toEqual(["habla", "parcial:quiero dos"]);
    reloj.vencer(C.stt.finTurnoMinMs);
    expect(vistos.at(-1)).toBe("final:Quiero dos de cochinita.");
  });

  it("si el cliente sigue hablando dentro de la ventana minima, los segmentos se juntan en UN turno", async () => {
    const { reloj, vistos, socket } = await abrirStt();
    socket.texto({ message_type: "partial_transcript", text: "quiero dos" });
    socket.texto({ message_type: "committed_transcript", text: "Quiero dos de cochinita," });
    socket.texto({ message_type: "partial_transcript", text: "y tres panuchos" });
    reloj.vencer(C.stt.finTurnoMinMs); // la ventana se cancelo con el parcial: no cierra
    expect(vistos.some((v) => v.startsWith("final:"))).toBe(false);
    expect(vistos.at(-1)).toBe("parcial:Quiero dos de cochinita, y tres panuchos");
    socket.texto({ message_type: "committed_transcript", text: "y tres panuchos." });
    reloj.vencer(C.stt.finTurnoMinMs);
    expect(vistos.filter((v) => v.startsWith("final:"))).toEqual(["final:Quiero dos de cochinita, y tres panuchos."]);
  });

  it("un parcial congelado 3 s sin commit fuerza el commit (max endpointing)", async () => {
    const { reloj, socket } = await abrirStt();
    socket.texto({ message_type: "partial_transcript", text: "en la calle sesenta" });
    reloj.vencer(C.stt.finTurnoMaxMs);
    expect(socket.json.at(-1)).toMatchObject({ message_type: "input_audio_chunk", commit: true });
  });

  it("un error a media llamada avisa `caido` con el TIPO como codigo corto; un cierre inesperado tambien", async () => {
    const a = await abrirStt();
    a.socket.texto({ message_type: "quota_exceeded", error: "texto largo del proveedor" });
    expect(a.vistos.at(-1)).toBe("caido:stt_el_quota_exceeded");
    const b = await abrirStt();
    b.socket.caer(1011);
    expect(b.vistos.at(-1)).toBe("caido:stt_el_ws_1011");
  });

  it("un tipo de mensaje NUEVO e informativo (sin `error`) se ignora: no tumba la sesion", async () => {
    const { vistos, socket } = await abrirStt();
    socket.texto({ message_type: "vad_metrics", speech_prob: 0.3 });
    expect(vistos.some((v) => v.startsWith("caido"))).toBe(false);
    socket.texto({ message_type: "algo_nuevo", error: "x" });
    expect(vistos.at(-1)).toBe("caido:stt_el_algo_nuevo");
  });

  it("commit forzado sin confirmacion del servidor: al segundo se cierra el turno con el parcial (nunca queda abierto)", async () => {
    const { reloj, vistos, socket } = await abrirStt();
    socket.texto({ message_type: "partial_transcript", text: "en la calle sesenta" });
    reloj.vencer(C.stt.finTurnoMaxMs);
    expect(socket.json.at(-1)).toMatchObject({ commit: true });
    reloj.vencer(1_000);
    expect(vistos.at(-1)).toBe("final:en la calle sesenta");
  });

  it("al cerrar no avisa caida", async () => {
    const { sesion, socket, vistos } = await abrirStt();
    await sesion.cerrar();
    socket.caer(1000);
    expect(vistos.some((v) => v.startsWith("caido"))).toBe(false);
    expect(sesion.proveedor?.()).toBe("elevenlabs");
  });
});

function respuestaStream(trozos: Uint8Array[], status = 200): Response {
  const cuerpo = new ReadableStream<Uint8Array>({
    start(c) {
      for (const t of trozos) c.enqueue(t);
      c.close();
    },
  });
  return new Response(cuerpo, { status });
}

function fetchFalso(respuestas: ((url: string, init: RequestInit) => Response | Promise<Response>)[]) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    llamadas.push({ url: String(url), init: init ?? {} });
    const r = respuestas[Math.min(i, respuestas.length - 1)]!;
    i += 1;
    return r(String(url), init ?? {});
  }) as typeof fetch;
  return { fn, llamadas };
}

describe("ElevenLabs eleven_v4_turbo (TTS)", () => {
  it("voces: un id de ElevenLabs (20 alfanumericos) se respeta; Gemini, Aura-2 o vacio caen a Regina", () => {
    expect(esVozElevenLabs("9Godp7dNohUvXk6qp0gS")).toBe(true);
    expect(resolverVozElevenLabs("sDh3eviBhiuHKi0MjTNq", C.tts.voz)).toBe("sDh3eviBhiuHKi0MjTNq");
    for (const v of ["Kore", "aura-2-estrella-es", "", null, undefined, "x".repeat(21)]) expect(resolverVozElevenLabs(v, C.tts.voz)).toBe("9Godp7dNohUvXk6qp0gS");
  });

  it("abrir valida la voz con GET /v1/voices (sin gastar creditos); una voz o llave rechazada falla al abrir", async () => {
    const ok = fetchFalso([() => new Response("{}", { status: 200 })]);
    await crearTtsElevenLabs({ apiKey: LLAVE, config: C.tts, fetchFn: ok.fn }).abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    expect(ok.llamadas[0]).toMatchObject({ url: "https://api.elevenlabs.io/v1/voices/9Godp7dNohUvXk6qp0gS", init: { method: "GET", headers: { "xi-api-key": LLAVE } } });
    const mal = fetchFalso([() => new Response("{}", { status: 401 })]);
    await expect(crearTtsElevenLabs({ apiKey: LLAVE, config: C.tts, fetchFn: mal.fn }).abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 })).rejects.toBeInstanceOf(VozProveedorError);
    await expect(crearTtsElevenLabs({ apiKey: LLAVE, config: C.tts, fetchFn: ok.fn }).abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 16_000 })).rejects.toBeInstanceOf(VozProveedorError);
  });

  it("sintetiza por HTTP en streaming: PCM 24 kHz, modelo v4 Turbo, espanol; reacomoda un byte suelto entre trozos (nunca desalinea las muestras)", async () => {
    const f = fetchFalso([() => new Response("{}"), () => respuestaStream([Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6, 7, 8])])]);
    const s = await crearTtsElevenLabs({ apiKey: LLAVE, config: C.tts, fetchFn: f.fn }).abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    const trozos: number[][] = [];
    for await (const t of s.sintetizar("Son $345 a la calle 60 #512 x 45.", new AbortController().signal)) trozos.push([...t]);
    expect(trozos).toEqual([[1, 2], [3, 4, 5, 6, 7, 8]]);
    const p = f.llamadas[1]!;
    expect(p.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/9Godp7dNohUvXk6qp0gS/stream?output_format=pcm_24000");
    expect(JSON.parse(String(p.init.body))).toEqual({ text: "Son $345 a la calle 60 #512 x 45.", model_id: "eleven_v4_turbo", language_code: "es" });
    expect(s.proveedor?.()).toBe("elevenlabs-tts");
  });

  it("si ElevenLabs acepta y no responde, la frase falla con tts_el_timeout al vencer el tope del primer byte (y el respaldo la repite)", async () => {
    const f = fetchFalso([() => new Response("{}"), (_u, init) => new Promise<Response>((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abortado"))))]);
    const s = await crearTtsElevenLabs({ apiKey: LLAVE, config: { ...C.tts, primerByteTimeoutMs: 30 }, fetchFn: f.fn }).abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    const consumir = async () => {
      for await (const _ of s.sintetizar("hola", new AbortController().signal)) void _;
    };
    await expect(consumir()).rejects.toThrow("tts_el_timeout");
    // Con el respaldo (Aura-2 falso) la frase se repite y la llamada sigue con voz.
    const { ttsConRespaldo } = await import("../../src/index.ts");
    const { TtsFalso } = await import("./dobles.ts");
    const aura = new TtsFalso();
    const f2 = fetchFalso([() => new Response("{}"), (_u, init) => new Promise<Response>((_r, rej) => init.signal?.addEventListener("abort", () => rej(new Error("abortado"))))]);
    const env = await ttsConRespaldo(crearTtsElevenLabs({ apiKey: LLAVE, config: { ...C.tts, primerByteTimeoutMs: 30 }, fetchFn: f2.fn }), aura, "aura-2-estrella-es").abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    const trozos: number[][] = [];
    for await (const t of env.sintetizar("hola", new AbortController().signal)) trozos.push([...t]);
    expect(trozos.length).toBeGreaterThan(0);
    expect(aura.frases).toEqual(["hola"]);
  });

  it("un HTTP de error falla con codigo corto; abortar (barge-in) corta sin error", async () => {
    const f = fetchFalso([() => new Response("{}"), () => new Response("cuota", { status: 429 })]);
    const s = await crearTtsElevenLabs({ apiKey: LLAVE, config: C.tts, fetchFn: f.fn }).abrir({ voz: "9Godp7dNohUvXk6qp0gS", hzSalida: 24_000 });
    const consumir = async (senal: AbortSignal) => {
      for await (const _ of s.sintetizar("hola", senal)) void _;
    };
    await expect(consumir(new AbortController().signal)).rejects.toThrow("tts_el_429");
    const c = new AbortController();
    c.abort();
    await expect(consumir(c.signal)).resolves.toBeUndefined();
  });
});

describe("costo de ElevenLabs", () => {
  it("componentes validos: `elevenlabs` (STT, segundos) y `elevenlabs-tts` (TTS, caracteres); ninguno reporta costo real", async () => {
    const { PROVEEDOR_COMPONENTE_RE, motivoComponenteInvalido, costoElevenLabsSttMicroUsd, costoElevenLabsTtsMicroUsd } = await import("../../src/index.ts");
    expect(PROVEEDOR_COMPONENTE_RE.test("elevenlabs")).toBe(true);
    expect(PROVEEDOR_COMPONENTE_RE.test("elevenlabs-tts")).toBe(true);
    expect(motivoComponenteInvalido({ proveedor: "elevenlabs", unidad: "segundo", costoReal: false })).toBeNull();
    expect(motivoComponenteInvalido({ proveedor: "elevenlabs-tts", unidad: "unidad", costoReal: false })).toBeNull();
    expect(motivoComponenteInvalido({ proveedor: "elevenlabs", unidad: "segundo", costoReal: true })).toBe("costoReal");
    // 1 h de audio: 0.39 US$ (+0.08 con keyterms); 1 000 caracteres: 0.04 US$.
    expect(costoElevenLabsSttMicroUsd(3600)).toBe(390_000);
    expect(costoElevenLabsSttMicroUsd(3600, VOZ_PLATAFORMA, true)).toBe(470_000);
    expect(costoElevenLabsTtsMicroUsd(1000)).toBe(40_000);
    expect(costoElevenLabsTtsMicroUsd(0)).toBe(0);
  });
});

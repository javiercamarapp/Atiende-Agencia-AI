// Adaptador REAL de la vista previa (Gemini Live por token efimero) contra un entorno falso: protocolo, transcripcion en vivo,
// barge-in, silencio, errores honestos y limpieza. Nada de WebAudio ni red: la capa del navegador esta detras de `EntornoVoz`.
import { describe, expect, it } from "vitest";
import { crearFabricaGeminiLive } from "../src/verticals/restaurantes/voz/adaptador-gemini-live.ts";
import type { CapturaMicrofono, EntornoVoz, ReproductorAudio, SocketPreview } from "../src/verticals/restaurantes/voz/adaptador-gemini-live.ts";
import { aPcm16Base64, dePcm16Base64, nivelRms, remuestrear } from "../src/verticals/restaurantes/voz/audio-pcm.ts";
import type { CallbacksAdaptador, CambioEstado } from "../src/verticals/restaurantes/voz/adaptador.ts";
import type { SesionPreviewVoz } from "../src/verticals/restaurantes/lib/voz-client.ts";
import type { LineaTranscripcion } from "@atiende/ui";

const SESION: SesionPreviewVoz = { sesionId: "s-1", proveedor: "gemini-3.8-live", modelo: "gemini-3.8-live", voiceId: "Kore", websocketUrl: "wss://gemini.test/ws", tokenProveedor: "token de prueba", tokenPreview: "x", expiraEn: "2026-10-01T12:00:00Z" };

class SocketFalso implements SocketPreview {
  onopen: SocketPreview["onopen"] = null;
  onmessage: SocketPreview["onmessage"] = null;
  onclose: SocketPreview["onclose"] = null;
  onerror: SocketPreview["onerror"] = null;
  enviados: Record<string, unknown>[] = [];
  cerrado = false;
  constructor(readonly url: string) {}
  send(d: string) {
    this.enviados.push(JSON.parse(d) as Record<string, unknown>);
  }
  close() {
    this.cerrado = true;
  }
  servidor(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function montar(opts: { fallaMicrofono?: string; sesion?: () => Promise<SesionPreviewVoz>; autoSetup?: boolean } = {}) {
  const sockets: SocketFalso[] = [];
  const reproducido: { muestras: number; tasa: number }[] = [];
  const log = { cortes: 0, repCerrado: false, micDetenido: false, temporizadores: 0, repeticionesActivas: 0 };
  let onBloque: ((m: Float32Array, t: number) => void) | null = null;
  const reproductor: ReproductorAudio = {
    encolar: (m, t) => void reproducido.push({ muestras: m.length, tasa: t }),
    cortar: () => void (log.cortes += 1),
    nivel: () => 0.5,
    cerrar: () => void (log.repCerrado = true),
  };
  const entorno: EntornoVoz = {
    abrirSocket: (url) => {
      const s = new SocketFalso(url);
      sockets.push(s);
      if (opts.autoSetup !== false) queueMicrotask(() => {
        s.onopen?.();
        s.servidor({ setupComplete: {} });
      });
      return s;
    },
    capturarMicrofono: async (cb) => {
      if (opts.fallaMicrofono) throw new Error(opts.fallaMicrofono);
      onBloque = cb;
      const c: CapturaMicrofono = { detener: () => void (log.micDetenido = true) };
      return c;
    },
    crearReproductor: () => reproductor,
    esperar: () => () => undefined,
    repetir: () => {
      log.repeticionesActivas += 1;
      return () => void (log.repeticionesActivas -= 1);
    },
    ahora: () => 1000,
  };
  const cambios: CambioEstado[] = [];
  const lineas: LineaTranscripcion[] = [];
  let terminado = false;
  const cb: CallbacksAdaptador = { cambiar: (c) => void cambios.push(c), linea: (l) => void lineas.push(l), terminado: () => void (terminado = true) };
  const adaptador = crearFabricaGeminiLive({ entorno, crearSesion: opts.sesion ?? (async () => SESION) })(cb);
  return { adaptador, sockets, cambios, lineas, reproducido, log, bloque: (m: Float32Array, t: number) => onBloque?.(m, t), fin: () => terminado };
}

const ultimoModo = (c: CambioEstado[]) => [...c].reverse().find((x) => x.modo !== undefined)?.modo;

describe("audio PCM", () => {
  it("ida y vuelta base64 PCM16 conserva la senal (con el error de cuantizacion)", () => {
    const a = Float32Array.from([0, 0.5, -0.5, 1, -1]);
    const b = dePcm16Base64(aPcm16Base64(a));
    expect(Array.from(b).map((v) => Math.round(v * 100) / 100)).toEqual([0, 0.5, -0.5, 1, -1]);
  });
  it("remuestrea 48 kHz -> 16 kHz a un tercio de las muestras; misma tasa devuelve lo mismo", () => {
    expect(remuestrear(new Float32Array(4800), 48_000, 16_000)).toHaveLength(1600);
    const x = new Float32Array(10);
    expect(remuestrear(x, 16_000, 16_000)).toBe(x);
  });
  it("nivel RMS: silencio 0, senal fuerte tope 1", () => {
    expect(nivelRms(new Float32Array(100))).toBe(0);
    expect(nivelRms(new Float32Array(100).fill(0.9))).toBe(1);
    expect(nivelRms(new Float32Array(0))).toBe(0);
  });
});

describe("AdaptadorGeminiLive", () => {
  it("abre el socket con el token efimero (sin API key), manda setup y pasa a escuchando", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    expect(m.sockets[0]!.url).toBe("wss://gemini.test/ws?access_token=token%20de%20prueba");
    expect(m.sockets[0]!.url).not.toMatch(/key=/);
    expect((m.sockets[0]!.enviados[0] as { setup: { model: string } }).setup.model).toBe("models/gemini-3.8-live");
    expect(ultimoModo(m.cambios)).toBe("escuchando");
    expect(m.cambios.some((c) => c.sessionId === "s-1")).toBe(true);
  });

  it("el audio del micro se baja a 16 kHz y se manda en base64; silenciado no manda nada", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    m.bloque(new Float32Array(4800).fill(0.1), 48_000);
    const audio = (m.sockets[0]!.enviados.at(-1) as { realtimeInput: { audio: { mimeType: string; data: string } } }).realtimeInput.audio;
    expect(audio.mimeType).toBe("audio/pcm;rate=16000");
    expect(dePcm16Base64(audio.data)).toHaveLength(1600);
    const enviados = m.sockets[0]!.enviados.length;
    m.adaptador.silenciar(true);
    m.bloque(new Float32Array(4800).fill(0.1), 48_000);
    expect(m.sockets[0]!.enviados.length).toBe(enviados);
  });

  it("audio del agente se reproduce a 24 kHz y el orbe pasa a hablando; fin de turno vuelve a escuchando", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    m.sockets[0]!.servidor({ serverContent: { modelTurn: { parts: [{ inlineData: { data: aPcm16Base64(new Float32Array(240).fill(0.2)), mimeType: "audio/pcm;rate=24000" } }] } } });
    expect(m.reproducido).toEqual([{ muestras: 240, tasa: 24_000 }]);
    expect(ultimoModo(m.cambios)).toBe("hablando");
    m.sockets[0]!.servidor({ serverContent: { turnComplete: true } });
    expect(ultimoModo(m.cambios)).toBe("escuchando");
  });

  it("transcripcion en vivo: los fragmentos se acumulan en una linea parcial y se cierran al terminar el turno", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    const s = m.sockets[0]!;
    s.servidor({ serverContent: { outputTranscription: { text: "Buenas " } } });
    s.servidor({ serverContent: { outputTranscription: { text: "tardes." } } });
    s.servidor({ serverContent: { inputTranscription: { text: "hola" } } });
    s.servidor({ serverContent: { turnComplete: true } });
    const agente = m.lineas.filter((l) => l.rol === "agente");
    expect(agente.map((l) => [l.texto, l.parcial])).toEqual([["Buenas ", true], ["Buenas tardes.", true], ["Buenas tardes.", false]]);
    expect(new Set(agente.map((l) => l.id)).size).toBe(1);
    expect(m.lineas.filter((l) => l.rol === "usuario").at(-1)).toMatchObject({ texto: "hola", parcial: false });
  });

  it("barge-in: si Gemini avisa `interrupted` se corta la reproduccion y se vuelve a escuchar", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    m.sockets[0]!.servidor({ serverContent: { interrupted: true } });
    expect(m.log.cortes).toBe(1);
    expect(ultimoModo(m.cambios)).toBe("escuchando");
  });

  it("sin credencial en el servidor (la API responde 503) el inicio falla con el motivo y no abre ningun socket", async () => {
    const m = montar({ sesion: async () => { throw new Error("Voz no configurada: falta GEMINI_API_KEY."); } });
    await expect(m.adaptador.iniciar()).rejects.toThrow(/falta GEMINI_API_KEY/);
    expect(m.sockets).toHaveLength(0);
  });

  it("micrófono denegado: error claro y el socket se cierra", async () => {
    const m = montar({ fallaMicrofono: "No se pudo usar el micrófono." });
    await expect(m.adaptador.iniciar()).rejects.toThrow(/micrófono/);
    expect(m.sockets[0]!.cerrado).toBe(true);
    expect(m.log).toMatchObject({ repCerrado: true, repeticionesActivas: 0 });
  });

  it("socket que se cierra antes del setup falla el inicio con el codigo", async () => {
    const m = montar({ autoSetup: false });
    const p = m.adaptador.iniciar();
    await Promise.resolve();
    await Promise.resolve();
    m.sockets[0]!.onclose?.({ code: 1008 });
    await expect(p).rejects.toThrow(/1008/);
  });

  it("si la conexion se cae a media llamada queda en error recuperable y se libera todo", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    m.sockets[0]!.onclose?.({ code: 1006 });
    const err = [...m.cambios].reverse().find((c) => c.error);
    expect(err?.modo).toBe("error");
    expect(err?.error).toMatchObject({ codigo: "conexion", recuperable: true });
    expect(m.log).toMatchObject({ micDetenido: true, repCerrado: true, repeticionesActivas: 0 });
  });

  it("terminar cierra el socket, el micrófono y el reproductor, y deja de reaccionar", async () => {
    const m = montar();
    await m.adaptador.iniciar();
    await m.adaptador.terminar();
    expect(m.sockets[0]!.cerrado).toBe(true);
    expect(m.log).toMatchObject({ micDetenido: true, repCerrado: true, repeticionesActivas: 0 });
    const antes = m.cambios.length;
    m.sockets[0]!.servidor({ serverContent: { turnComplete: true } });
    m.sockets[0]!.onclose?.({ code: 1000 });
    expect(m.cambios.length).toBeGreaterThanOrEqual(antes); // no lanza ni vuelve a pintar un error
    expect([...m.cambios].reverse().find((c) => c.error)).toBeUndefined();
  });
});

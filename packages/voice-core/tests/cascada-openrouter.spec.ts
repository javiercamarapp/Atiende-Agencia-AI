// Cascada OpenRouter (escalon 2): STT -> LLM (puerto) -> TTS con `fetch` FALSO. No toca la red ni usa credenciales reales.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, VozNoConfiguradaError, crearProveedorCascadaLlamada, energiaRms, pcm16AWav } from "../src/index.ts";
import type { AperturaLlamada, ManejadoresSesion, PeticionLlmVoz, PuertoLlmVoz, RespuestaLlmVoz } from "../src/index.ts";

const APERTURA: AperturaLlamada = {
  instruccion: "Eres el agente del hotel.",
  voiceId: "Kore",
  herramientas: [{ name: "consultar", description: "Consulta.", parameters: { type: "object", properties: { fecha: { type: "string" } } } }],
};

function pcm(ms: number, amplitud: number): Uint8Array {
  const n = Math.round((ms / 1000) * 16000);
  const b = new Uint8Array(n * 2);
  const v = new DataView(b.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, i % 2 === 0 ? amplitud : -amplitud, true);
  return b;
}

interface Llamada {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fetchFalso(opts: { stt?: string; sttEstado?: number; ttsEstado?: number } = {}) {
  const llamadas: Llamada[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    llamadas.push({ url: u, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (u.endsWith("/audio/transcriptions")) {
      const estado = opts.sttEstado ?? 200;
      return new Response(estado === 200 ? JSON.stringify({ text: opts.stt ?? "quiero una habitacion" }) : "error", { status: estado });
    }
    const estado = opts.ttsEstado ?? 200;
    return new Response(estado === 200 ? new Uint8Array([1, 2, 3, 4]) : "error", { status: estado });
  }) as typeof fetch;
  return { fn, llamadas };
}

function guionLlm(respuestas: RespuestaLlmVoz[]): PuertoLlmVoz & { peticiones: PeticionLlmVoz[] } {
  const peticiones: PeticionLlmVoz[] = [];
  let i = 0;
  return {
    peticiones,
    completar: async (p) => {
      peticiones.push({ ...p, mensajes: [...p.mensajes] });
      const r = respuestas[Math.min(i, respuestas.length - 1)]!;
      i += 1;
      return r;
    },
  };
}

function manejadores() {
  const eventos: string[] = [];
  const costos: number[] = [];
  const audio: Uint8Array[] = [];
  const herramientas: { nombre: string; args: unknown }[] = [];
  const h: ManejadoresSesion = {
    agenteDijo: (t) => eventos.push(`agente:${t}`),
    agenteTermino: () => eventos.push("fin"),
    interrumpido: () => eventos.push("interrumpido"),
    usuarioDijo: (t) => eventos.push(`cliente:${t}`),
    ejecutarTool: async (l) => {
      herramientas.push({ nombre: l.nombre, args: l.args });
      return { disponible: true };
    },
    audioAgente: (a) => audio.push(a),
    costo: (c) => costos.push(c),
    caido: (r) => eventos.push(`caido:${r}`),
  };
  return { h, eventos, costos, audio, herramientas };
}

describe("cascada OpenRouter", () => {
  it("sin OPENROUTER_API_KEY lanza VozNoConfiguradaError (el escalon se salta, nunca finge)", async () => {
    const p = crearProveedorCascadaLlamada({ apiKey: null, llm: guionLlm([]) });
    await expect(p.abrirSesion(APERTURA, manejadores().h)).rejects.toBeInstanceOf(VozNoConfiguradaError);
  });

  it("turno de audio: energia -> STT -> LLM con herramienta -> LLM final -> TTS, con la misma llave y el modelo de la config de plataforma", async () => {
    const f = fetchFalso({ stt: "quiero una habitacion" });
    const llm = guionLlm([
      { texto: "", toolCalls: [{ id: "t1", nombre: "consultar", argsJson: '{"fecha":"2026-10-10"}' }], costoMicroUsd: 120 },
      { texto: "Si hay disponibilidad.", toolCalls: [], costoMicroUsd: 80 },
    ]);
    const p = crearProveedorCascadaLlamada({ apiKey: "sk-or-secreta", llm, fetchFn: f.fn });
    const m = manejadores();
    const sesion = await p.abrirSesion(APERTURA, m.h);

    sesion.enviarAudio?.(pcm(400, 8000)); // habla
    sesion.enviarAudio?.(pcm(800, 0)); // silencio >= 700 ms: cierra el turno
    await p.inactivo();

    expect(f.llamadas.map((l) => l.url)).toEqual([`${VOZ_PLATAFORMA.cascada.baseUrl}/audio/transcriptions`, `${VOZ_PLATAFORMA.cascada.baseUrl}/audio/speech`]);
    expect(f.llamadas[0]!.headers.authorization).toBe("Bearer sk-or-secreta");
    expect(f.llamadas[0]!.body).toMatchObject({ model: VOZ_PLATAFORMA.cascada.modeloStt, language: "es", input_audio: { format: "wav" } });
    expect(f.llamadas[1]!.body).toMatchObject({ model: VOZ_PLATAFORMA.cascada.modeloTts, input: "Si hay disponibilidad.", voice: "Kore", response_format: "pcm" });
    expect(m.herramientas).toEqual([{ nombre: "consultar", args: { fecha: "2026-10-10" } }]);
    expect(m.eventos).toEqual(["cliente:quiero una habitacion", "agente:Si hay disponibilidad.", "fin"]);
    expect(m.audio).toHaveLength(1);
    // el LLM vio la instruccion de la vertical, las herramientas y el turno del cliente + el resultado de la herramienta
    expect(llm.peticiones[0]!.system).toBe(APERTURA.instruccion);
    expect(llm.peticiones[0]!.herramientas.map((t) => t.name)).toEqual(["consultar"]);
    expect(llm.peticiones[1]!.mensajes.map((x) => x.role)).toEqual(["user", "assistant", "tool"]);
    // costo reportado: STT por audio, 2 turnos de LLM, TTS por caracteres
    expect(m.costos.reduce((s, c) => s + c, 0)).toBeGreaterThan(200);
  });

  it("modo texto (simulador): enviarTexto salta el STT", async () => {
    const f = fetchFalso();
    const p = crearProveedorCascadaLlamada({ apiKey: "k", llm: guionLlm([{ texto: "Hola.", toolCalls: [], costoMicroUsd: 1 }]), fetchFn: f.fn });
    const m = manejadores();
    const sesion = await p.abrirSesion(APERTURA, m.h);
    sesion.enviarTexto("hola");
    await p.inactivo();
    expect(f.llamadas.map((l) => l.url.split("/").pop())).toEqual(["speech"]);
    expect(m.eventos).toEqual(["agente:Hola.", "fin"]);
  });

  it("ruido corto (menos de la habla minima) no se transcribe", async () => {
    const f = fetchFalso();
    const p = crearProveedorCascadaLlamada({ apiKey: "k", llm: guionLlm([]), fetchFn: f.fn });
    const sesion = await p.abrirSesion(APERTURA, manejadores().h);
    sesion.enviarAudio?.(pcm(100, 8000));
    sesion.enviarAudio?.(pcm(800, 0));
    await p.inactivo();
    expect(f.llamadas).toHaveLength(0);
  });

  it("STT con error HTTP: avisa `caido` con un codigo corto (sin cuerpo ni llave) para que la escalera siga", async () => {
    const f = fetchFalso({ sttEstado: 503 });
    const p = crearProveedorCascadaLlamada({ apiKey: "sk-or-secreta", llm: guionLlm([]), fetchFn: f.fn });
    const m = manejadores();
    const sesion = await p.abrirSesion(APERTURA, m.h);
    sesion.enviarAudio?.(pcm(400, 8000));
    sesion.enviarAudio?.(pcm(800, 0));
    await p.inactivo();
    expect(m.eventos).toEqual(["caido:cascada_stt_503"]);
    expect(JSON.stringify(m.eventos)).not.toContain("sk-or");
  });

  it("TTS con error o LLM que lanza tambien cuentan como caida del escalon", async () => {
    const tts = fetchFalso({ ttsEstado: 500 });
    const m1 = manejadores();
    const p1 = crearProveedorCascadaLlamada({ apiKey: "k", llm: guionLlm([{ texto: "Hola.", toolCalls: [], costoMicroUsd: 0 }]), fetchFn: tts.fn });
    (await p1.abrirSesion(APERTURA, m1.h)).enviarTexto("hola");
    await p1.inactivo();
    expect(m1.eventos.at(-1)).toBe("caido:cascada_tts_500");

    const m2 = manejadores();
    const p2 = crearProveedorCascadaLlamada({ apiKey: "k", llm: { completar: () => Promise.reject(new Error("boom con datos")) }, fetchFn: fetchFalso().fn });
    (await p2.abrirSesion(APERTURA, m2.h)).enviarTexto("hola");
    await p2.inactivo();
    expect(m2.eventos).toEqual(["caido:cascada_llm"]);
  });

  it("barge-in: si el cliente habla mientras el agente contesta, se corta y no se reproduce la respuesta vieja", async () => {
    const f = fetchFalso({ stt: "espera" });
    let liberar!: () => void;
    const lento: PuertoLlmVoz = {
      completar: () => new Promise<RespuestaLlmVoz>((res) => (liberar = () => res({ texto: "respuesta larga", toolCalls: [], costoMicroUsd: 0 }))),
    };
    const p = crearProveedorCascadaLlamada({ apiKey: "k", llm: lento, fetchFn: f.fn });
    const m = manejadores();
    const sesion = await p.abrirSesion(APERTURA, m.h);
    sesion.enviarTexto("hola");
    await new Promise((r) => setTimeout(r, 0));
    sesion.enviarAudio?.(pcm(100, 9000)); // el cliente habla encima
    liberar();
    await p.inactivo();
    expect(m.eventos).toContain("interrumpido");
    expect(m.audio).toHaveLength(0);
    expect(f.llamadas.some((l) => l.url.endsWith("/audio/speech"))).toBe(false);
  });

  it("utilidades de audio: RMS y envoltura WAV", () => {
    expect(energiaRms(pcm(100, 0))).toBe(0);
    expect(energiaRms(pcm(100, 16384))).toBeCloseTo(0.5, 2);
    const wav = pcm16AWav(new Uint8Array(10), 16000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(wav.byteLength).toBe(54);
  });
});

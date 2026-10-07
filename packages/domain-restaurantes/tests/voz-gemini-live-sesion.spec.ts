// Sesion de llamada con Gemini Live contra un WebSocket FALSO (el protocolo no se ha probado contra la API real: ver la cabecera
// de gemini-live-sesion.ts y docs/VOZ-PM.md).
import { describe, expect, it } from "vitest";
import { crearProveedorGeminiLlamada, declaracionesDeHerramientas, GEMINI_LIVE_WS_URL } from "../src/voz/llamada/gemini-live-sesion.ts";
import type { SocketLive } from "../src/voz/llamada/gemini-live-sesion.ts";
import { ControladorLlamada } from "../src/voz/llamada/controlador.ts";
import { crearEjecutorTools } from "../src/voz/llamada/ejecutor-tools.ts";
import { toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import { VozNoConfiguradaError, VozProveedorError } from "../src/voz/provider.ts";
import type { ManejadoresSesion } from "../src/voz/llamada/sesion.ts";

class SocketFalso implements SocketLive {
  onopen: SocketLive["onopen"] = null;
  onmessage: SocketLive["onmessage"] = null;
  onclose: SocketLive["onclose"] = null;
  onerror: SocketLive["onerror"] = null;
  enviados: Record<string, unknown>[] = [];
  cerrado: { code?: number } | null = null;
  constructor(readonly url: string) {}
  send(d: string): void {
    this.enviados.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(code?: number): void {
    this.cerrado = { code };
  }
  abrir(): void {
    this.onopen?.({});
  }
  servidor(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  caer(code = 1006): void {
    this.onclose?.({ code });
  }
}

function montar() {
  const sockets: SocketFalso[] = [];
  const proveedor = crearProveedorGeminiLlamada({
    apiKey: "clave-de-prueba-no-real",
    model: "gemini-3.8-live",
    crearSocket: (url) => {
      const s = new SocketFalso(url);
      sockets.push(s);
      queueMicrotask(() => {
        s.abrir();
        s.servidor({ setupComplete: {} });
      });
      return s;
    },
  });
  return { proveedor, sockets };
}

const apertura = { instruccion: "Usted es el asistente de PM.", voiceId: "Kore", herramientas: toolDefinitionsForChannel("voz") };

function manejadores(extra: Partial<ManejadoresSesion> = {}) {
  const ev: string[] = [];
  const h: ManejadoresSesion = {
    agenteDijo: (t) => void ev.push(`dice:${t}`),
    agenteTermino: () => void ev.push("termino"),
    interrumpido: () => void ev.push("interrumpido"),
    usuarioDijo: (t) => void ev.push(`usuario:${t}`),
    ejecutarTool: async (l) => ({ eco: l.nombre }),
    costo: (m) => void ev.push(`costo:${m}`),
    caido: (r, handle) => void ev.push(`caido:${r}:${handle}`),
    ...extra,
  };
  return { h, ev };
}

describe("setup", () => {
  it("manda modelo, voz, instruccion, herramientas del registro (sin `parameters` vacios) y transcripciones", async () => {
    const { proveedor, sockets } = montar();
    const { h } = manejadores();
    await proveedor.abrirSesion(apertura, h);
    expect(sockets[0]!.url.startsWith(`${GEMINI_LIVE_WS_URL}?key=`)).toBe(true);
    const setup = (sockets[0]!.enviados[0] as { setup: { model: string; generationConfig: { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } }; systemInstruction: { parts: { text: string }[] }; inputAudioTranscription: unknown; outputAudioTranscription: unknown; tools: { functionDeclarations: unknown[] }[] } }).setup;
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect((setup.generationConfig as unknown as { temperature: number }).temperature).toBe(0);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(setup.systemInstruction.parts[0]!.text).toContain("asistente de PM");
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    const decl = setup.tools[0]!.functionDeclarations as { name: string; parameters?: unknown }[];
    expect(decl.map((d) => d.name).sort()).toEqual(toolDefinitionsForChannel("voz").map((t) => t.name).sort());
    expect(decl.find((d) => d.name === "buscar_cliente")).not.toHaveProperty("parameters");
    expect(decl.find((d) => d.name === "cotizar_pedido")).toHaveProperty("parameters");
    expect(declaracionesDeHerramientas([])).toEqual([]);
  });

  it("al reconectar manda el handle de reanudacion", async () => {
    const { proveedor, sockets } = montar();
    await proveedor.abrirSesion({ ...apertura, reanudarHandle: "h-123" }, manejadores().h);
    expect((sockets[0]!.enviados[0] as { setup: { sessionResumption: unknown } }).setup.sessionResumption).toEqual({ handle: "h-123" });
  });

  it("sin API key avisa que la voz no esta configurada, sin abrir ningun socket", async () => {
    let abiertos = 0;
    const p = crearProveedorGeminiLlamada({ apiKey: null, model: "m", crearSocket: () => { abiertos += 1; return new SocketFalso("x"); } });
    await expect(p.abrirSesion(apertura, manejadores().h)).rejects.toBeInstanceOf(VozNoConfiguradaError);
    expect(abiertos).toBe(0);
  });

  it("si el socket se cierra o falla antes del setup, lanza VozProveedorError sin exponer la clave", async () => {
    const p = crearProveedorGeminiLlamada({ apiKey: "clave-secreta-123", model: "m", crearSocket: (url) => { const s = new SocketFalso(url); queueMicrotask(() => s.caer(1008)); return s; } });
    const err = await p.abrirSesion(apertura, manejadores().h).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VozProveedorError);
    expect((err as Error).message).not.toMatch(/clave-secreta-123/);
    const p2 = crearProveedorGeminiLlamada({ apiKey: "k", model: "m", setupTimeoutMs: 20, crearSocket: (url) => new SocketFalso(url) });
    await expect(p2.abrirSesion(apertura, manejadores().h)).rejects.toThrow(/tiempo agotado/);
  });
});

describe("mensajes del servidor", () => {
  it("transcripciones, barge-in nativo, fin de turno y costo por tokens", async () => {
    const { proveedor, sockets } = montar();
    const { h, ev } = manejadores();
    const sesion = await proveedor.abrirSesion(apertura, h);
    sesion.enviarTexto("hola");
    expect(sockets[0]!.enviados.at(-1)).toEqual({ realtimeInput: { text: "hola" } });
    const idle = proveedor.inactivo();
    const s = sockets[0]!;
    s.servidor({ serverContent: { inputTranscription: { text: "hola buenas" } } });
    s.servidor({ serverContent: { outputTranscription: { text: "Buenas tardes." } } });
    s.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 400 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 25 }] } });
    s.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 500 }, { modality: "TEXT", tokenCount: 400 }] } });
    s.servidor({ serverContent: { interrupted: true } });
    s.servidor({ serverContent: { turnComplete: true } });
    await idle;
    expect(ev).toEqual(["usuario:hola buenas", "dice:Buenas tardes.", "costo:1500", "costo:1800", "interrumpido", "termino"]);
  });

  it("audio de entrada va en base64 PCM 16 kHz", async () => {
    const { proveedor, sockets } = montar();
    const sesion = await proveedor.abrirSesion(apertura, manejadores().h);
    sesion.enviarAudio!(Uint8Array.from([1, 2, 3]));
    expect(sockets[0]!.enviados.at(-1)).toEqual({ realtimeInput: { audio: { data: "AQID", mimeType: "audio/pcm;rate=16000" } } });
  });

  it("un toolCall se ejecuta y se responde con el mismo id; un fallo de la herramienta responde error, no excepcion", async () => {
    const { proveedor, sockets } = montar();
    const { h } = manejadores({
      ejecutarTool: async (l) => {
        if (l.nombre === "crear_pedido") throw new Error("boom con datos personales 9991234567");
        return { ok: true, args: l.args };
      },
    });
    await proveedor.abrirSesion(apertura, h);
    sockets[0]!.servidor({ toolCall: { functionCalls: [{ id: "a1", name: "buscar_producto", args: { query: "bistec", branch_slug: "x" } }, { id: "a2", name: "crear_pedido", args: {} }] } });
    await new Promise((r) => setTimeout(r, 5));
    const resp = (sockets[0]!.enviados.at(-1) as { toolResponse: { functionResponses: { id: string; response: Record<string, unknown> }[] } }).toolResponse.functionResponses;
    expect(resp.map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(resp[0]!.response).toEqual({ output: { ok: true, args: { query: "bistec", branch_slug: "x" } } });
    expect(JSON.stringify(resp[1]!.response)).not.toMatch(/9991234567/);
    expect(resp[1]!.response).toHaveProperty("error");
  });
});

describe("caidas y reanudacion", () => {
  it("un cierre inesperado avisa `caido` con el ultimo handle; cerrar nosotros no avisa; goAway avisa una sola vez", async () => {
    const { proveedor, sockets } = montar();
    const a = manejadores();
    await proveedor.abrirSesion(apertura, a.h);
    sockets[0]!.servidor({ sessionResumptionUpdate: { newHandle: "h-9", resumable: true } });
    sockets[0]!.servidor({ goAway: { timeLeft: "5s" } });
    sockets[0]!.caer(1006);
    expect(a.ev).toEqual(["caido:go_away:h-9"]);

    const b = montar();
    const m = manejadores();
    const sesion = await b.proveedor.abrirSesion(apertura, m.h);
    await sesion.cerrar();
    b.sockets[0]!.caer(1000);
    expect(m.ev).toEqual([]);
    expect(b.sockets[0]!.cerrado).toEqual({ code: 1000 });
  });

  it("integrado al controlador: la caida reabre la sesion con el handle y la llamada sigue", async () => {
    const { proveedor, sockets } = montar();
    const reproducidos: string[] = [];
    const ctrl = new ControladorLlamada({
      callId: "c1",
      propertyId: "p",
      organizationId: "o",
      abrirSesion: proveedor.abrirSesion,
      ejecutor: crearEjecutorTools({ transporte: async () => ({ resultado: { ok: true }, orderId: null }), timeoutMs: 100 }),
      instruccion: "x",
      voiceId: "Kore",
      reproducir: (m) => void reproducidos.push(m),
      dormir: async () => undefined,
    });
    await ctrl.iniciar({ habilitado: true, gastoMesMicroUsd: 0, topeMensualMicroUsd: null });
    sockets[0]!.servidor({ sessionResumptionUpdate: { newHandle: "h-77", resumable: true } });
    sockets[0]!.caer(1011);
    await ctrl.vacio();
    expect(sockets).toHaveLength(2);
    expect((sockets[1]!.enviados[0] as { setup: { sessionResumption: unknown } }).setup.sessionResumption).toEqual({ handle: "h-77" });
    expect(ctrl.maquina.estadoActual).toBe("activa");

    // segunda caida: ya no hay reanudacion -> pregrabado, callback y colgar
    sockets[1]!.caer(1011);
    const r = await ctrl.terminada;
    expect(r.resultado).toBe("escalado");
    expect(reproducidos).toContain("proveedor_caido");
  });
});

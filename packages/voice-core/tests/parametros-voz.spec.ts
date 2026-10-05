// Parametros del agente de voz probados en produccion (rescate-orig-restaurantes-1 §1): temperatura 0, idioma, herramientas EN SERIE y
// vocabulario del menu para el STT de la cascada. Todo contra sockets y `fetch` FALSOS (el protocolo no se ha probado contra la API real).
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA, crearProveedorCascadaLlamada, crearProveedorGeminiLlamada, mensajeSetup, pistaVocabulario } from "../src/index.ts";
import type { AperturaLlamada, ManejadoresSesion, PuertoLlmVoz, PeticionLlmVoz, SocketLive } from "../src/index.ts";

class SocketFalso implements SocketLive {
  onopen: SocketLive["onopen"] = null;
  onmessage: SocketLive["onmessage"] = null;
  onclose: SocketLive["onclose"] = null;
  onerror: SocketLive["onerror"] = null;
  enviados: Record<string, unknown>[] = [];
  send(d: string): void {
    this.enviados.push(JSON.parse(d) as Record<string, unknown>);
  }
  close(): void {}
  servidor(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const APERTURA: AperturaLlamada = { instruccion: "Usted es el asistente.", voiceId: "Kore", herramientas: [] };

function montar() {
  const sockets: SocketFalso[] = [];
  const proveedor = crearProveedorGeminiLlamada({
    apiKey: "clave-de-prueba-no-real",
    model: "gemini-3.8-live",
    crearSocket: () => {
      const s = new SocketFalso();
      sockets.push(s);
      queueMicrotask(() => {
        s.onopen?.({});
        s.servidor({ setupComplete: {} });
      });
      return s;
    },
  });
  return { proveedor, sockets };
}

function manejadores(extra: Partial<ManejadoresSesion> = {}): ManejadoresSesion {
  return { agenteDijo: () => undefined, agenteTermino: () => undefined, interrumpido: () => undefined, ejecutarTool: async () => ({}), caido: () => undefined, ...extra };
}

describe("setup de Gemini Live", () => {
  it("lleva temperature 0 y el idioma de la plataforma (hoy es-US) junto a la voz", () => {
    const setup = mensajeSetup("gemini-3.8-live", APERTURA).setup;
    expect(setup.generationConfig.temperature).toBe(0);
    expect(VOZ_PLATAFORMA.gemini.temperatura).toBe(0);
    expect(setup.generationConfig.speechConfig).toEqual({ languageCode: "es-US", voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } });
  });
});

describe("herramientas en serie (equivale a parallel_tool_calls: false del agente vivo)", () => {
  it("dos functionCalls del mismo turno nunca corren a la vez y se ejecutan en el orden pedido", async () => {
    const { proveedor, sockets } = montar();
    let activas = 0;
    let maxActivas = 0;
    const orden: string[] = [];
    await proveedor.abrirSesion(
      APERTURA,
      manejadores({
        ejecutarTool: async (l) => {
          activas += 1;
          maxActivas = Math.max(maxActivas, activas);
          orden.push(`ini:${l.nombre}`);
          await new Promise((r) => setTimeout(r, l.nombre === "cotizar_pedido" ? 15 : 1));
          orden.push(`fin:${l.nombre}`);
          activas -= 1;
          return { ok: true };
        },
      }),
    );
    sockets[0]!.servidor({ toolCall: { functionCalls: [{ id: "a", name: "cotizar_pedido", args: {} }, { id: "b", name: "crear_pedido", args: {} }] } });
    await new Promise((r) => setTimeout(r, 60));
    expect(maxActivas).toBe(1);
    expect(orden).toEqual(["ini:cotizar_pedido", "fin:cotizar_pedido", "ini:crear_pedido", "fin:crear_pedido"]);
    const resp = (sockets[0]!.enviados.at(-1) as { toolResponse: { functionResponses: { id: string }[] } }).toolResponse.functionResponses;
    expect(resp.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("cascada: temperatura y vocabulario del menu", () => {
  function fetchFalso() {
    const cuerpos: Record<string, unknown>[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      cuerpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return String(url).endsWith("/audio/transcriptions") ? new Response(JSON.stringify({ text: "dos de pastor" })) : new Response(new Uint8Array([1, 2]));
    }) as typeof fetch;
    return { fn, cuerpos };
  }
  function pcm(ms: number, amplitud: number): Uint8Array {
    const n = Math.round((ms / 1000) * 16000);
    const b = new Uint8Array(n * 2);
    const v = new DataView(b.buffer);
    for (let i = 0; i < n; i++) v.setInt16(i * 2, i % 2 === 0 ? amplitud : -amplitud, true);
    return b;
  }

  it("pasa temperatura 0 al LLM y el vocabulario (sin repetidos, hasta 200 terminos) como `prompt` del STT", async () => {
    const peticiones: PeticionLlmVoz[] = [];
    const llm: PuertoLlmVoz = { completar: async (p) => (peticiones.push(p), { texto: "Con gusto.", toolCalls: [], costoMicroUsd: 1 }) };
    const f = fetchFalso();
    const vocabulario = ["Taco de pastor", "taco de pastor", "  Codzitos ", ...Array.from({ length: 300 }, (_, i) => `Platillo ${i}`)];
    const p = crearProveedorCascadaLlamada({ apiKey: "k", llm, fetchFn: f.fn });
    const sesion = await p.abrirSesion({ ...APERTURA, vocabulario }, manejadores());
    sesion.enviarAudio?.(pcm(400, 8000));
    sesion.enviarAudio?.(pcm(800, 0));
    await p.inactivo();
    expect(peticiones[0]!.temperatura).toBe(0);
    const prompt = String(f.cuerpos[0]!.prompt);
    const terminos = prompt.replace(/^Vocabulario del menu: /, "").replace(/\.$/, "").split(", ");
    expect(terminos).toHaveLength(200);
    expect(terminos.slice(0, 2)).toEqual(["Taco de pastor", "Codzitos"]);
  });

  it("sin vocabulario no manda `prompt`", () => {
    expect(pistaVocabulario(undefined, 200)).toEqual({});
    expect(pistaVocabulario(["", "  "], 200)).toEqual({});
  });
});

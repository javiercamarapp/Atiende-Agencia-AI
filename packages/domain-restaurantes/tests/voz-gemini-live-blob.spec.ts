// Regresion QA R1 (eval real de voz): en Node >= 26 los mensajes del WebSocket llegan como Blob y se descartaban, con lo que se
// perdia `setupComplete` y NINGUNA llamada abria sesion. Doble de socket que entrega Blob.
import { describe, expect, it } from "vitest";
import { crearProveedorGeminiLlamada } from "../src/voz/llamada/gemini-live-sesion.ts";
import type { SocketLive } from "../src/voz/llamada/gemini-live-sesion.ts";
import { toolDefinitionsForChannel } from "../src/agent-tools/registry.ts";
import type { ManejadoresSesion } from "../src/voz/llamada/sesion.ts";

class SocketBlob implements SocketLive {
  onopen: SocketLive["onopen"] = null;
  onmessage: SocketLive["onmessage"] = null;
  onclose: SocketLive["onclose"] = null;
  onerror: SocketLive["onerror"] = null;
  binaryType = "blob";
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {}
}

const apertura = { instruccion: "Usted es el asistente.", voiceId: "Kore", herramientas: toolDefinitionsForChannel("voz") };

describe("Gemini Live: mensajes Blob (Node >= 26)", () => {
  it("abre la sesion con setupComplete en Blob y entrega en orden los mensajes siguientes (Blob y texto mezclados)", async () => {
    const dichos: string[] = [];
    let socket!: SocketBlob;
    const proveedor = crearProveedorGeminiLlamada({
      apiKey: "clave-de-prueba-no-real",
      model: "m",
      setupTimeoutMs: 500,
      crearSocket: (url) => {
        socket = new SocketBlob(url);
        queueMicrotask(() => {
          socket.onopen?.({});
          socket.onmessage?.({ data: new Blob([JSON.stringify({ setupComplete: {} })]) });
        });
        return socket;
      },
    });
    const h: ManejadoresSesion = {
      agenteDijo: (t) => void dichos.push(t),
      agenteTermino: () => void dichos.push("fin"),
      interrumpido: () => undefined,
      usuarioDijo: () => undefined,
      ejecutarTool: async () => ({}),
      costo: () => undefined,
      caido: () => undefined,
    };
    await proveedor.abrirSesion(apertura, h);
    expect(socket.binaryType).toBe("arraybuffer");
    // Un Blob (lectura asincrona) seguido de un texto: el texto no debe adelantarse.
    socket.onmessage?.({ data: new Blob([JSON.stringify({ serverContent: { outputTranscription: { text: "uno" } } })]) });
    socket.onmessage?.({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "dos" } } }) });
    await new Promise((r) => setTimeout(r, 20));
    expect(dichos.join("|")).toMatch(/^uno.*dos/);
  });
});

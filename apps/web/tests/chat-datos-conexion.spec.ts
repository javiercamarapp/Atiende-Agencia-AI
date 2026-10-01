// Conexion generica de "Chatea con tus datos" (despachos, licitaciones): cuerpo sin identidad, tope de
// historial y degradacion honesta ante errores. El transporte esta inyectado: nada toca la red.
import { describe, expect, it } from "vitest";
import { MAX_HISTORY, MAX_TURN_CHARS, consultarDisponibilidad, crearConexionChatDatos, enviarPregunta, type TransporteChatDatos } from "../src/lib/chat-datos-conexion.ts";

const BASE = "https://api.example.test/x/p1/chat-datos";
const OK = { status: "ok", text: "hola", blocks: [], sources: [], toolsUsed: [] };

function transporte(over: { get?: (url: string) => Promise<unknown>; post?: (url: string, payload: unknown) => Promise<unknown> } = {}): TransporteChatDatos & { posts: { url: string; payload: unknown }[]; gets: string[] } {
  const posts: { url: string; payload: unknown }[] = [];
  const gets: string[] = [];
  return {
    posts,
    gets,
    getJson: (async (url: string) => (gets.push(url), over.get ? over.get(url) : { available: true })) as TransporteChatDatos["getJson"],
    postJson: (async (url: string, payload: unknown) => (posts.push({ url, payload }), over.post ? over.post(url, payload) : OK)) as TransporteChatDatos["postJson"],
  };
}

describe("enviarPregunta", () => {
  it("POST a la ruta con SOLO pregunta e historial (sin ids ni organizacion), historial acotado a 12 turnos de 600 caracteres", async () => {
    const t = transporte();
    const history = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `${i % 10}`.repeat(700) }));
    const r = await enviarPregunta(t, BASE, "¿cuánto me deben?", history);
    expect(r.text).toBe("hola");
    expect(t.posts[0]!.url).toBe(BASE);
    const body = t.posts[0]!.payload as { question: string; history: { text: string }[] };
    expect(Object.keys(body).sort()).toEqual(["history", "question"]);
    expect(body.history).toHaveLength(MAX_HISTORY);
    expect(body.history.every((h) => h.text.length === MAX_TURN_CHARS)).toBe(true);
    expect(MAX_HISTORY).toBe(12);
    expect(MAX_TURN_CHARS).toBe(600);
  });

  it("se queda con los ULTIMOS turnos del historial (los mas recientes)", async () => {
    const t = transporte();
    const history = Array.from({ length: 15 }, (_, i) => ({ role: "user" as const, text: `turno-${i}` }));
    await enviarPregunta(t, BASE, "q", history);
    const body = t.posts[0]!.payload as { history: { text: string }[] };
    expect(body.history[0]!.text).toBe("turno-3");
    expect(body.history[11]!.text).toBe("turno-14");
  });

  it("error del servidor (4xx/5xx lanzado por el cliente HTTP) -> 'no disponible' honesto, nunca una excepcion", async () => {
    const t = transporte({ post: async () => { throw new Error("No se pudo completar la operación (500)."); } });
    const r = await enviarPregunta(t, BASE, "q", []);
    expect(r.status).toBe("unavailable");
    expect(r.text).toContain("No pude consultar tus datos");
    expect(r.blocks).toEqual([]);
  });

  it("fallo de red (TypeError del navegador) -> mensaje de conexion", async () => {
    const t = transporte({ post: async () => { throw new TypeError("Failed to fetch"); } });
    const r = await enviarPregunta(t, BASE, "q", []);
    expect(r.status).toBe("unavailable");
    expect(r.text).toContain("conectar");
  });
});

describe("consultarDisponibilidad", () => {
  it("true solo si el servidor dice available=true; cualquier otra cosa es false", async () => {
    expect(await consultarDisponibilidad(transporte({ get: async () => ({ available: true }) }), BASE)).toBe(true);
    expect(await consultarDisponibilidad(transporte({ get: async () => ({ available: false }) }), BASE)).toBe(false);
    expect(await consultarDisponibilidad(transporte({ get: async () => ({}) }), BASE)).toBe(false);
    expect(await consultarDisponibilidad(transporte({ get: async () => ({ available: "true" }) }), BASE)).toBe(false);
    expect(await consultarDisponibilidad(transporte({ get: async () => { throw new Error("403"); } }), BASE)).toBe(false);
  });

  it("consulta {base}/estado", async () => {
    const t = transporte();
    await consultarDisponibilidad(t, BASE);
    expect(t.gets).toEqual([`${BASE}/estado`]);
  });
});

describe("crearConexionChatDatos", () => {
  it("expone clave, sugerencias y delega disponible/enviar en el transporte", async () => {
    const t = transporte();
    const c = crearConexionChatDatos({ clave: "p1", baseUrl: BASE, transporte: t, sugerencias: ["¿Algo?"] });
    expect(c.clave).toBe("p1");
    expect(c.sugerencias).toEqual(["¿Algo?"]);
    expect(await c.disponible()).toBe(true);
    expect((await c.enviar("hola", [])).status).toBe("ok");
    expect(t.posts).toHaveLength(1);
  });
});

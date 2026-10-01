// R-19: cliente del widget demo. Sin red real: `fetchImpl` inyectado. Nunca inventa una respuesta cuando el servidor no la da.
import { describe, expect, it, vi } from "vitest";
import { crearClienteDemo, DemoError, nuevaSesionDemo } from "../src/verticals/restaurantes/demo/demo-client.ts";

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

describe("nuevaSesionDemo", () => {
  it("genera ids que cumplen el formato del servidor (16-64 caracteres seguros) y distintos entre si", () => {
    const a = nuevaSesionDemo();
    const b = nuevaSesionDemo();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(a).not.toBe(b);
  });
});

describe("crearClienteDemo", () => {
  it("estado: GET a /v1/restaurantes/demo/:slug/estado", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ disponible: true, motivo: null, mensaje: null, restaurante: { slug: "pm", nombre: "PM" }, sucursales: [], limites: { mensajes_por_sesion: 40, caracteres_por_mensaje: 600 } }));
    const c = crearClienteDemo("https://api.test/", "los taquitos", fetchImpl as unknown as typeof fetch);
    expect((await c.estado()).disponible).toBe(true);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.test/v1/restaurantes/demo/los%20taquitos/estado");
  });

  it("enviar: POST con session_id, mensaje y sucursal (omite la sucursal vacia)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ tipo: "respuesta", respuesta: "Hola", escalado: false, pedido: null }));
    const c = crearClienteDemo("https://api.test", "pm", fetchImpl as unknown as typeof fetch);
    const r = await c.enviar({ sessionId: "sesion-0123456789abcdef", mensaje: "Hola", sucursal: "" });
    expect(r.respuesta).toBe("Hola");
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ session_id: "sesion-0123456789abcdef", mensaje: "Hola" });
  });

  it("503 sin agente: lanza DemoError con el mensaje honesto del servidor (no inventa una respuesta)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ code: "demo_no_disponible", motivo: "sin_agente", message: "Agente no disponible: requiere OPENROUTER_API_KEY" }, 503));
    const c = crearClienteDemo("https://api.test", "pm", fetchImpl as unknown as typeof fetch);
    await expect(c.enviar({ sessionId: "sesion-0123456789abcdef", mensaje: "Hola" })).rejects.toMatchObject({ name: "DemoError", status: 503, code: "demo_no_disponible", motivo: "sin_agente", message: expect.stringContaining("OPENROUTER_API_KEY") });
  });

  it("429 de IP: mensaje generico en espanol; 429 con codigo (tope de la demo): conserva el del servidor", async () => {
    const ip = vi.fn().mockResolvedValue(json({ code: "too_many_requests", message: "Demasiadas solicitudes." }, 429));
    await expect(crearClienteDemo("https://a", "pm", ip as unknown as typeof fetch).enviar({ sessionId: "sesion-0123456789abcdef", mensaje: "x" })).rejects.toBeInstanceOf(DemoError);
    const tope = vi.fn().mockResolvedValue(json({ code: "demo_sesion_tope", message: "Esta conversación alcanzó su tope de mensajes." }, 429));
    await expect(crearClienteDemo("https://a", "pm", tope as unknown as typeof fetch).enviar({ sessionId: "sesion-0123456789abcdef", mensaje: "x" })).rejects.toMatchObject({ code: "demo_sesion_tope", message: "Esta conversación alcanzó su tope de mensajes." });
  });

  it("cuerpo no JSON: conserva el mensaje generico", async () => {
    const roto = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("no json"); } } as unknown as Response);
    await expect(crearClienteDemo("https://a", "pm", roto as unknown as typeof fetch).estado()).rejects.toMatchObject({ status: 500, message: "No pudimos consultar la demo." });
  });
});

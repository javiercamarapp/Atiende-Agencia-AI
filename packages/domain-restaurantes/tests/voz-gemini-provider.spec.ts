import { describe, expect, it, vi } from "vitest";
import { FakeVoiceProvider, GeminiLiveProvider, VozNoConfiguradaError, VozProveedorError } from "../src/index.ts";

const entrada = { organizationId: "o", propertyId: "p", sessionId: "s-1", voiceId: "Kore", comportamiento: "Habla de usted.", mensajeInicial: "Hola, le atiende el asistente virtual.", ttlSegundos: 300 };
const AHORA = new Date("2026-09-30T12:00:00.000Z");

describe("GeminiLiveProvider", () => {
  it("SIN credencial: salud no ok, emitir lanza VozNoConfiguradaError y NO toca la red", async () => {
    for (const apiKey of [null, "", "   "]) {
      const fetchFn = vi.fn();
      const p = new GeminiLiveProvider({ apiKey, fetchFn: fetchFn as unknown as typeof fetch });
      expect((await p.salud()).ok).toBe(false);
      await expect(p.emitirSesionPreview(entrada)).rejects.toBeInstanceOf(VozNoConfiguradaError);
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it("CON credencial: pide un token efimero de un solo uso con voz y prompt bloqueados, y devuelve solo el token efimero", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ name: "auth_tokens/abc123" }), { status: 200 }));
    const p = new GeminiLiveProvider({ apiKey: "test-gemini-api-key", fetchFn: fetchFn as unknown as typeof fetch, ahora: () => AHORA });
    expect((await p.salud()).ok).toBe(true);
    const sesion = await p.emitirSesionPreview(entrada);

    expect(sesion).toMatchObject({ proveedor: "gemini-3.8-live", modelo: "gemini-3.8-live", tokenProveedor: "auth_tokens/abc123", expiraEn: "2026-09-30T12:05:00.000Z" });
    expect(sesion.websocketUrl).toMatch(/^wss:\/\/generativelanguage\.googleapis\.com\/ws\/.*BidiGenerateContentConstrained$/);
    expect(JSON.stringify(sesion)).not.toContain("test-gemini-api-key");

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1alpha/auth_tokens");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-gemini-api-key");
    const body = JSON.parse(init.body as string);
    expect(body.uses).toBe(1);
    expect(body.expireTime).toBe("2026-09-30T12:05:00.000Z");
    expect(body.newSessionExpireTime).toBe("2026-09-30T12:01:00.000Z");
    expect(body.bidiGenerateContentSetup.model).toBe("models/gemini-3.8-live");
    expect(body.bidiGenerateContentSetup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("Habla de usted.");
    expect(body.bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("Hola, le atiende el asistente virtual.");
  });

  it("errores del proveedor: HTTP no ok, respuesta ilegible, sin token, red caida y voz fuera del catalogo", async () => {
    const con = (fetchFn: unknown) => new GeminiLiveProvider({ apiKey: "k", fetchFn: fetchFn as typeof fetch, ahora: () => AHORA });
    await expect(con(async () => new Response("no", { status: 403 })).emitirSesionPreview(entrada)).rejects.toMatchObject({ name: "VozProveedorError", estado: 403 });
    await expect(con(async () => new Response("<html>", { status: 200 })).emitirSesionPreview(entrada)).rejects.toBeInstanceOf(VozProveedorError);
    await expect(con(async () => new Response("{}", { status: 200 })).emitirSesionPreview(entrada)).rejects.toThrow(/no devolvió un token/);
    await expect(con(async () => { throw new Error("ECONNRESET"); }).emitirSesionPreview(entrada)).rejects.toThrow(/ECONNRESET/);
    const fetchFn = vi.fn();
    await expect(con(fetchFn).emitirSesionPreview({ ...entrada, voiceId: "Marin" })).rejects.toThrow(/catálogo/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("expone el catalogo estatico de 30 voces", () => {
    expect(new GeminiLiveProvider({ apiKey: null }).catalogoVoces()).toHaveLength(30);
  });
});

describe("FakeVoiceProvider", () => {
  it("emite sesiones deterministas y registra las entradas", async () => {
    const f = new FakeVoiceProvider();
    const s = await f.emitirSesionPreview(entrada);
    expect(s.tokenProveedor).toBe("fake-token-s-1");
    expect(f.emitidas).toEqual([entrada]);
  });

  it("simula sin credencial y proveedor caido", async () => {
    const sin = new FakeVoiceProvider({ configurado: false });
    expect((await sin.salud()).ok).toBe(false);
    await expect(sin.emitirSesionPreview(entrada)).rejects.toBeInstanceOf(VozNoConfiguradaError);
    await expect(new FakeVoiceProvider({ fallaAlEmitir: true }).emitirSesionPreview(entrada)).rejects.toBeInstanceOf(VozProveedorError);
  });
});

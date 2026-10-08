// Adaptador de produccion del puerto del token de Meta (`debug_token`): se prueba con un lector de Graph FALSO; nunca hay red ni token real.
// El token de prueba es una cadena inventada: lo que se verifica es que no se filtre a errores ni a los estados devueltos.
import { describe, expect, it } from "vitest";
import { MetaGraphReadError, MetaGraphWhatsAppReader } from "@atiende/whatsapp-gateway";
import { crearLectorTokenMetaGraph } from "../src/salud/salud-meta.ts";

const TOKEN_FALSO = "EAAtoken-falso-de-prueba-1234567890";

describe("crearLectorTokenMetaGraph", () => {
  it("traduce expires_at (segundos unix) y is_valid; la consulta es un GET a debug_token con el token codificado", async () => {
    const llamadas: Array<[string, string]> = [];
    const lector = crearLectorTokenMetaGraph({ solicitar: async (m, r) => { llamadas.push([m, r]); return { data: { is_valid: true, expires_at: 1_792_000_000 } }; } }, TOKEN_FALSO);
    expect(await lector.leer()).toEqual({ valido: true, expiraEn: new Date(1_792_000_000 * 1000) });
    expect(llamadas).toEqual([["GET", `/debug_token?input_token=${TOKEN_FALSO}`]]);
  });

  it("expires_at 0 o ausente = token permanente: sin fecha, no es un error", async () => {
    for (const data of [{ is_valid: true, expires_at: 0 }, { is_valid: true }, { is_valid: true, expires_at: "no" }]) {
      const lector = crearLectorTokenMetaGraph({ solicitar: async () => ({ data }) }, TOKEN_FALSO);
      expect(await lector.leer()).toEqual({ valido: true, expiraEn: null });
    }
  });

  it("is_valid false o ausente: valido false / null", async () => {
    expect(await crearLectorTokenMetaGraph({ solicitar: async () => ({ data: { is_valid: false, expires_at: 5 } }) }, TOKEN_FALSO).leer()).toMatchObject({ valido: false });
    expect(await crearLectorTokenMetaGraph({ solicitar: async () => ({ data: {} }) }, TOKEN_FALSO).leer()).toMatchObject({ valido: null });
  });

  it("el error 190 de Graph (token invalido) = valido false; otros errores se propagan", async () => {
    const invalido = new MetaGraphReadError("Graph API respondio 400 (codigo 190)", { httpStatus: 400, graphCode: 190 });
    expect(await crearLectorTokenMetaGraph({ solicitar: async () => { throw invalido; } }, TOKEN_FALSO).leer()).toEqual({ valido: false, expiraEn: null });
    const caido = new MetaGraphReadError("Graph API respondio 500", { httpStatus: 500, retryable: true });
    await expect(crearLectorTokenMetaGraph({ solicitar: async () => { throw caido; } }, TOKEN_FALSO).leer()).rejects.toBe(caido);
  });

  it("cuerpo inesperado: error (el vigilante lo cuenta no_leido)", async () => {
    await expect(crearLectorTokenMetaGraph({ solicitar: async () => null }, TOKEN_FALSO).leer()).rejects.toThrow("debug_token: cuerpo inesperado");
  });

  it("con el lector real de Graph y un fetch falso: solo GET, token en el header y NUNCA en el mensaje de error", async () => {
    const pedidos: Array<{ url: string; method: string; auth: string | undefined }> = [];
    const fetchFalso = (async (url: string, init: { method: string; headers: Record<string, string> }) => {
      pedidos.push({ url, method: init.method, auth: init.headers.Authorization });
      return new Response(JSON.stringify({ error: { message: `Invalid OAuth access token ${TOKEN_FALSO}`, code: 500 } }), { status: 500 });
    }) as unknown as typeof fetch;
    const reader = new MetaGraphWhatsAppReader({ accessToken: TOKEN_FALSO, fetchImpl: fetchFalso });
    const lector = crearLectorTokenMetaGraph(reader, TOKEN_FALSO);
    const err = await lector.leer().then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(TOKEN_FALSO);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.method).toBe("GET");
    expect(pedidos[0]!.auth).toBe(`Bearer ${TOKEN_FALSO}`);
  });
});

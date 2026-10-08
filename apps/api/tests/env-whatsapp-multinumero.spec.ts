// Variables de entorno de WhatsApp multinumero (paquete 01): version de Graph configurable y ids de Meta, todas opcionales.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaGraphWhatsAppClient } from "@atiende/whatsapp-gateway";
import { loadApiEnv, parseGraphApiVersion } from "../src/env.ts";

const OBLIGATORIAS = {
  JWT_SECRET: "x".repeat(32),
  VOICE_TOOL_SECRET: "voz",
  WHATSAPP_VERIFY_TOKEN: "verify",
  WHATSAPP_APP_SECRET: "secret",
  INTERNAL_SECRET: "interno",
  RENTAS_OWNER_JWT_SECRET: "y".repeat(32),
};

describe("WHATSAPP_GRAPH_API_VERSION", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("acepta vNN.0 y recorta espacios", () => {
    expect(parseGraphApiVersion("v23.0")).toBe("v23.0");
    expect(parseGraphApiVersion("  v22.0 ")).toBe("v22.0");
  });

  it("ausente o vacia: null y sin advertencia", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseGraphApiVersion(undefined)).toBeNull();
    expect(parseGraphApiVersion("")).toBeNull();
    expect(parseGraphApiVersion("   ")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("invalida: se ignora con una advertencia que no imprime el valor", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const mal of ["23.0", "v23", "v2.0", "v23.1", "latest", "v21.0; DROP"]) expect(parseGraphApiVersion(mal)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(6);
    for (const [mensaje] of warn.mock.calls) expect(String(mensaje)).not.toContain("DROP");
  });

  it("loadApiEnv: variables nuevas null/vacias si no existen", () => {
    for (const [k, v] of Object.entries(OBLIGATORIAS)) vi.stubEnv(k, v);
    for (const k of ["WHATSAPP_GRAPH_API_VERSION", "META_APP_ID", "WHATSAPP_WABA_IDS", "WHATSAPP_ES_CONFIG_ID"]) vi.stubEnv(k, "");
    const env = loadApiEnv();
    expect(env.whatsappGraphApiVersion).toBeNull();
    expect(env.metaAppId).toBeNull();
    expect(env.whatsappWabaIds).toEqual([]);
    expect(env.whatsappEsConfigId).toBeNull();
  });

  it("loadApiEnv: lee version, app, WABA (lista por comas) y config de Embedded Signup", () => {
    for (const [k, v] of Object.entries(OBLIGATORIAS)) vi.stubEnv(k, v);
    vi.stubEnv("WHATSAPP_GRAPH_API_VERSION", "v23.0");
    vi.stubEnv("META_APP_ID", " 123456 ");
    vi.stubEnv("WHATSAPP_WABA_IDS", "111, 222 ,,333");
    vi.stubEnv("WHATSAPP_ES_CONFIG_ID", "cfg-9");
    const env = loadApiEnv();
    expect(env.whatsappGraphApiVersion).toBe("v23.0");
    expect(env.metaAppId).toBe("123456");
    expect(env.whatsappWabaIds).toEqual(["111", "222", "333"]);
    expect(env.whatsappEsConfigId).toBe("cfg-9");
  });

  it("el cliente de envio usa la version configurada y, sin ella, conserva v21.0", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const msg = { to: "5219991112233", phoneNumberId: "pn1", body: "hola" };
    await new MetaGraphWhatsAppClient({ accessToken: "t-fake", fetchImpl, apiVersion: parseGraphApiVersion("v23.0") ?? undefined }).sendMessage(msg);
    await new MetaGraphWhatsAppClient({ accessToken: "t-fake", fetchImpl }).sendMessage(msg);
    expect(urls).toEqual(["https://graph.facebook.com/v23.0/pn1/messages", "https://graph.facebook.com/v21.0/pn1/messages"]);
  });
});

// La cascada v2 dentro de la escalera de la plataforma: orden de los escalones, configuracion congelada y cableado con credenciales. WebSocket y LLM FALSOS.
import { describe, expect, it } from "vitest";
import { ESCALERA_VOZ, VOZ_PLATAFORMA, costoEstimadoMicroUsd, crearEscalonesPlataforma, crearEscaleraPlataforma, precioPorMinutoMicroUsd } from "../../src/index.ts";
import type { AperturaLlamada } from "../../src/index.ts";
import { fabricaSockets, llmFalso, manejadoresFalsos, escribe } from "./dobles.ts";

const APERTURA: AperturaLlamada = { instruccion: "Agente.", voiceId: "aura-2-olivia-es", herramientas: [], vocabulario: ["cochinita"] };

describe("escalera de plataforma con cascada v2", () => {
  it("el orden por omision es Gemini Live -> cascada v2 -> cascada OpenRouter (el respaldo de siempre queda de ultimo)", () => {
    expect(ESCALERA_VOZ).toEqual(["gemini-3.8-live", "cascada-v2", "cascada-openrouter"]);
    expect(crearEscalonesPlataforma({ geminiApiKey: null, openrouterApiKey: null, llm: null }).map((e) => e.id)).toEqual(["gemini-3.8-live", "cascada-v2", "cascada-openrouter"]);
  });

  it("con DEEPGRAM_API_KEY y el LLM en streaming abre la cascada v2: STT es-419 y TTS con la voz de la sucursal, ambos con la llave en la cabecera", async () => {
    const f = fabricaSockets();
    const escalera = crearEscaleraPlataforma({ geminiApiKey: null, openrouterApiKey: "k", deepgramApiKey: "dg-llave", llm: llmFalso([]), llmV2: llmFalso([escribe(["Hola."])]), crearSocketDeepgram: f.crear });
    await escalera.abrirSesion(APERTURA, manejadoresFalsos().h);
    expect(escalera.escalonActual()).toBe("cascada-v2");
    expect(escalera.fallidos()).toEqual(["gemini-3.8-live"]);
    const urls = f.sockets.map((s) => new URL(s.url));
    expect(urls.map((u) => u.pathname).sort()).toEqual(["/v1/listen", "/v1/speak"]);
    expect(urls.find((u) => u.pathname === "/v1/speak")!.searchParams.get("model")).toBe("aura-2-olivia-es");
    expect(urls.find((u) => u.pathname === "/v1/listen")!.searchParams.getAll("keyterm")).toEqual(["cochinita"]);
    for (const s of f.sockets) expect(s.headers).toEqual({ Authorization: "Token dg-llave" });
  });

  it("sin DEEPGRAM_API_KEY, o sin el LLM en streaming, el escalon se salta y atiende la cascada de respaldo", async () => {
    for (const deps of [
      { deepgramApiKey: null, llmV2: llmFalso([]) },
      { deepgramApiKey: "dg-llave", llmV2: null },
    ]) {
      const f = fabricaSockets();
      const escalera = crearEscaleraPlataforma({ geminiApiKey: null, openrouterApiKey: "k", llm: llmFalso([]), crearSocketDeepgram: f.crear, ...deps });
      await escalera.abrirSesion(APERTURA, manejadoresFalsos().h);
      expect(escalera.escalonActual()).toBe("cascada-openrouter");
      expect(escalera.fallidos()).toEqual(["gemini-3.8-live", "cascada-v2"]);
      expect(f.sockets).toEqual([]); // nunca se intento abrir un socket sin llave
    }
  });
});

describe("configuracion de la cascada v2", () => {
  it("el cerebro por omision es Sonnet 5.5 con esfuerzo bajo; Haiku 5.5 queda como modelo configurable", () => {
    expect(VOZ_PLATAFORMA.cascadaV2.llm).toMatchObject({ modelo: "anthropic/claude-sonnet-5.5", modeloFacil: "anthropic/claude-haiku-5.5", esfuerzo: "low" });
    expect(VOZ_PLATAFORMA.cascadaV2.llm.topeSalidaTokens).toBeGreaterThan(0);
    expect(VOZ_PLATAFORMA.cascadaV2.llm.topeSalidaTokens).toBeLessThanOrEqual(1024);
  });
  it("STT Nova-3 es-419 con endpointing de conversacion; TTS Aura-2 mexicana a la tasa de salida de la sala (sin remuestreo)", () => {
    expect(VOZ_PLATAFORMA.cascadaV2.deepgram).toMatchObject({ modelo: "nova-3", idioma: "es-419", hzEntrada: 16_000 });
    expect(VOZ_PLATAFORMA.cascadaV2.deepgram.endpointingMs).toBeGreaterThanOrEqual(300);
    expect(VOZ_PLATAFORMA.cascadaV2.deepgram.endpointingMs).toBeLessThanOrEqual(500);
    expect(VOZ_PLATAFORMA.cascadaV2.deepgramAura2).toMatchObject({ voz: "aura-2-estrella-es", hzSalida: 24_000 });
  });
  it("el piso por minuto del escalon existe y la configuracion sigue congelada", () => {
    expect(precioPorMinutoMicroUsd("cascada-v2")).toBe(VOZ_PLATAFORMA.cascadaV2.precioMicroUsdPorMinuto);
    expect(costoEstimadoMicroUsd("cascada-v2", 60)).toBe(VOZ_PLATAFORMA.cascadaV2.precioMicroUsdPorMinuto);
    expect(costoEstimadoMicroUsd("cascada-v2", 0)).toBe(0);
    expect(Object.isFrozen(VOZ_PLATAFORMA.cascadaV2.llm)).toBe(true);
    expect(Object.isFrozen(VOZ_PLATAFORMA.cascadaV2.deepgram)).toBe(true);
    expect(Object.isFrozen(VOZ_PLATAFORMA.cascadaV2.deepgramAura2)).toBe(true);
  });
});

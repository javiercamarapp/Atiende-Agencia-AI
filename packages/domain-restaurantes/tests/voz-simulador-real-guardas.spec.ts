// El modo REAL de la prueba ciega esta protegido: no arranca sin banderas ni credencial, corta por tope de gasto estimado y no
// filtra la API key. Aqui se prueba con un WebSocket falso; la corrida contra Gemini real es manual (docs/VOZ-PM.md).
import { describe, expect, it } from "vitest";
import { ejecutarPruebaCiegaReal, opcionesRealVozDesdeEntorno } from "../src/voz/simulador/real.ts";
import { GUIONES_ES_MX } from "../src/voz/simulador/guiones-es-mx.ts";
import type { SocketLive } from "../src/voz/llamada/gemini-live-sesion.ts";

describe("opciones del modo real", () => {
  it("exige VOZ_EVALS_REAL=1 y GEMINI_API_KEY antes de abrir ninguna conexion", () => {
    expect(() => opcionesRealVozDesdeEntorno({})).toThrow(/VOZ_EVALS_REAL=1/);
    expect(() => opcionesRealVozDesdeEntorno({ VOZ_EVALS_REAL: "1" })).toThrow(/GEMINI_API_KEY/);
    expect(() => opcionesRealVozDesdeEntorno({ VOZ_EVALS_REAL: "1", GEMINI_API_KEY: "k", VOZ_EVALS_MAX_USD: "-1" })).toThrow(/MAX_USD/);
    const o = opcionesRealVozDesdeEntorno({ VOZ_EVALS_REAL: "1", GEMINI_API_KEY: "k", VOZ_EVALS_GUIONES: "V01, V03" });
    expect(o).toMatchObject({ maxUsd: 1, usdPorMin: 0.075, model: "gemini-3.8-live", guiones: ["V01", "V03"] });
  });
});

function socketQueResponde(): (url: string) => SocketLive {
  return () => {
    const s: SocketLive & { enviados: unknown[] } = {
      enviados: [],
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(d: string) {
        const m = JSON.parse(d) as Record<string, unknown>;
        this.enviados.push(m);
        if ("realtimeInput" in m) queueMicrotask(() => { this.onmessage?.({ data: JSON.stringify({ serverContent: { outputTranscription: { text: "Con gusto." }, turnComplete: true } }) }); });
      },
      close() {},
    };
    queueMicrotask(() => {
      s.onopen?.({});
      s.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    });
    return s;
  };
}

describe("corrida real con socket falso", () => {
  it("corta por el tope de gasto estimado y lista los guiones sin correr; omite los solo-falso", async () => {
    let t = 0;
    const r = await ejecutarPruebaCiegaReal(
      { apiKey: "clave-secreta-123", model: "m", maxUsd: 0.05, usdPorMin: 0.04, voiceId: "Kore", guiones: ["V08", "V09", "V10", "V11"], crearSocket: socketQueResponde() },
      () => (t += 60_000),
    );
    expect(r.cortadoPorTope).toBe(true);
    expect(r.resultados.map((x) => x.id)).toEqual(["V08-dtmf-cero-persona", "V09-silencio-abandono"]);
    expect(r.noCorridos).toEqual(["V10-ruido-no-se-entiende"]); // V11 es solo-falso: ni se intenta
    expect(GUIONES_ES_MX.find((g) => g.id.startsWith("V11"))!.soloFalso).toBe(true);
    expect(r.gastoUsdEstimado).toBeCloseTo(0.08, 5);
  });

  it("un fallo de conexion se reporta sin la API key", async () => {
    const r = await ejecutarPruebaCiegaReal({ apiKey: "clave-secreta-123", model: "m", maxUsd: 1, usdPorMin: 0.04, voiceId: "Kore", guiones: ["V08"], crearSocket: (url) => { const s: SocketLive = { onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }; queueMicrotask(() => s.onclose?.({ code: 1008 })); void url; return s; } });
    expect(r.resultados[0]!.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/clave-secreta-123/);
  });
});

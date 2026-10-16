// El modo REAL de la prueba ciega de voz de hoteles esta protegido: no arranca sin banderas ni credencial, respeta el techo y el tope de gasto
// estimado, omite los guiones solo-falso, no filtra la API key y deja el reporte en la forma esperada. Aqui se prueba con un WebSocket falso: la corrida
// contra Gemini real es manual (docs/evals/hoteles/README.md) y no corre en CI.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SocketLive } from "@atiende/voice-core";
import { ejecutarPruebaCiegaFalsa, ejecutarPruebaCiegaReal, instruccionVozEvalsHoteles, opcionesRealVozDesdeEntorno, reporteDeCorridaReal } from "../../src/voz/simulador/real.ts";
import { GUIONES_ES_MX } from "../../src/voz/simulador/guiones-es-mx.ts";
import { construirReporte, escribirReporte, percentil, reporteMarkdown } from "../../src/voz/simulador/reporte.ts";

const ENV_OK = { VOZ_EVALS_REAL: "1", GEMINI_API_KEY: "k" };

describe("opciones del modo real", () => {
  it("exige VOZ_EVALS_REAL=1 y GEMINI_API_KEY antes de abrir ninguna conexion", () => {
    expect(() => opcionesRealVozDesdeEntorno({})).toThrow(/VOZ_EVALS_REAL=1/);
    expect(() => opcionesRealVozDesdeEntorno({ VOZ_EVALS_REAL: "1" })).toThrow(/GEMINI_API_KEY/);
    expect(() => opcionesRealVozDesdeEntorno({ VOZ_EVALS_REAL: "0", GEMINI_API_KEY: "k" })).toThrow(/VOZ_EVALS_REAL=1/);
  });

  it("el tope por omision es 1 USD, acepta hasta 5 y rechaza lo no numerico, lo no positivo y lo que pasa del techo", () => {
    expect(opcionesRealVozDesdeEntorno(ENV_OK)).toMatchObject({ maxUsd: 1, usdPorMin: 0.04, voiceId: "Kore" });
    expect(opcionesRealVozDesdeEntorno({ ...ENV_OK, VOZ_EVALS_MAX_USD: "5" }).maxUsd).toBe(5);
    for (const malo of ["-1", "0", "abc", "5.01", "100"]) expect(() => opcionesRealVozDesdeEntorno({ ...ENV_OK, VOZ_EVALS_MAX_USD: malo })).toThrow(/MAX_USD/);
    expect(() => opcionesRealVozDesdeEntorno({ ...ENV_OK, VOZ_EVALS_USD_POR_MIN: "0" })).toThrow(/USD_POR_MIN/);
  });

  it("separa la lista de guiones y toma el modelo del entorno", () => {
    const o = opcionesRealVozDesdeEntorno({ ...ENV_OK, VOZ_EVALS_GUIONES: "H01, H03", GEMINI_LIVE_MODEL: "otro-modelo" });
    expect(o).toMatchObject({ guiones: ["H01", "H03"], model: "otro-modelo" });
  });

  it("la instruccion del agente real es la de voz de hoteles con la fecha del mundo simulado", () => {
    const i = instruccionVozEvalsHoteles();
    expect(i).toContain("Hotel Casa Maya");
    expect(i).toContain("2031-06-01");
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
  it("corta por el tope de gasto estimado y lista lo que no corrio; mide la latencia de cada guion", async () => {
    let t = 0;
    const r = await ejecutarPruebaCiegaReal(
      { apiKey: "clave-secreta-123", model: "m", maxUsd: 0.05, usdPorMin: 0.04, voiceId: "Kore", guiones: ["H07", "H09", "H10", "H11"], crearSocket: socketQueResponde() },
      () => (t += 60_000),
    );
    expect(r.cortadoPorTope).toBe(true);
    expect(r.resultados.map((x) => x.id)).toEqual(["H07-pide-hablar-con-una-persona", "H09-fuera-de-horario-agente-apagado"]);
    expect(r.resultados.every((x) => x.latenciaMs === 60_000)).toBe(true);
    expect(r.noCorridos).toEqual(["H10-dato-ambiguo-pide-repetir", "H11-abuso-descuento-inyeccion-y-tarjeta"]);
    expect(r.omitidos.filter((o) => o.motivo === "tope_de_gasto").map((o) => o.id)).toEqual(r.noCorridos);
    expect(r.gastoUsdEstimado).toBeCloseTo(0.08, 5);
  });

  it("sin tope alcanzado corre todo lo seleccionado y marca el resto como no seleccionado", async () => {
    const r = await ejecutarPruebaCiegaReal({ apiKey: "k", model: "m", maxUsd: 5, usdPorMin: 0.04, voiceId: "Kore", guiones: ["H09"], crearSocket: socketQueResponde() });
    expect(r.cortadoPorTope).toBe(false);
    expect(r.resultados.map((x) => x.id)).toEqual(["H09-fuera-de-horario-agente-apagado"]);
    expect(r.noCorridos).toEqual([]);
    expect(r.omitidos).toHaveLength(GUIONES_ES_MX.length - 1);
    expect(r.omitidos.every((o) => o.motivo === "no_seleccionado")).toBe(true);
  });

  it("omite los guiones solo-falso sin intentarlos", async () => {
    const solo = { ...GUIONES_ES_MX[8]!, id: "HX-solo-falso", soloFalso: true };
    const original = [...GUIONES_ES_MX];
    (GUIONES_ES_MX as unknown as unknown[]).push(solo);
    try {
      const r = await ejecutarPruebaCiegaReal({ apiKey: "k", model: "m", maxUsd: 5, usdPorMin: 0.04, voiceId: "Kore", guiones: ["HX", "H09"], crearSocket: socketQueResponde() });
      expect(r.resultados.map((x) => x.id)).toEqual(["H09-fuera-de-horario-agente-apagado"]);
      expect(r.omitidos).toContainEqual({ id: "HX-solo-falso", motivo: "solo_falso" });
    } finally {
      (GUIONES_ES_MX as unknown as unknown[]).length = original.length;
    }
  });

  it("un fallo de conexion se reporta sin la API key", async () => {
    const r = await ejecutarPruebaCiegaReal({ apiKey: "clave-secreta-123", model: "m", maxUsd: 1, usdPorMin: 0.04, voiceId: "Kore", guiones: ["H07"], crearSocket: (url) => { const s: SocketLive = { onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} }; queueMicrotask(() => s.onclose?.({ code: 1008 })); void url; return s; } });
    expect(r.resultados[0]!.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/clave-secreta-123/);
    expect(JSON.stringify(reporteDeCorridaReal(r, { model: "m", maxUsd: 1 }))).not.toMatch(/clave-secreta-123/);
  });
});

describe("reporte", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const entrada = {
    canal: "voz" as const,
    modo: "real" as const,
    modelo: "m",
    fecha: new Date("2031-06-01T18:00:00Z"),
    resultados: [
      { id: "A", ok: true, graders: [{ grader: "G1", ok: true, detalle: "" }, { grader: "G2", ok: true, detalle: "" }], latenciaMs: 100 },
      { id: "B", ok: false, graders: [{ grader: "G1", ok: true, detalle: "" }, { grader: "G2", ok: false, detalle: "dijo | algo\\ malo\nfin" }], latenciaMs: 300 },
      { id: "C", ok: false, graders: [], error: "conexion cerrada", latenciaMs: 200 },
    ],
    omitidos: [{ id: "D", motivo: "tope_de_gasto" as const }],
    gastoUsdEstimado: 0.1234567,
    topeUsd: 1,
  };

  it("percentil por rango mas cercano", () => {
    expect(percentil([], 50)).toBeNull();
    expect(percentil([5], 95)).toBe(5);
    expect(percentil([40, 10, 30, 20], 50)).toBe(20);
    expect(percentil([40, 10, 30, 20], 95)).toBe(40);
  });

  it("la forma del reporte: fecha, modelo, corridos y omitidos, aprobacion global y por grader, costo y latencia", () => {
    const r = construirReporte(entrada);
    expect(r).toMatchObject({ version: 1, canal: "voz", modo: "real", modelo: "m", fecha: "2031-06-01T18:00:00.000Z", guionesCorridos: ["A", "B", "C"], guionesOmitidos: [{ id: "D", motivo: "tope_de_gasto" }] });
    expect(r.aprobacion.global).toEqual({ aprobados: 1, total: 3, tasa: 1 / 3 });
    expect(r.aprobacion.porGrader).toEqual({ G1: { aprobados: 2, total: 2, tasa: 1 }, G2: { aprobados: 1, total: 2, tasa: 0.5 } });
    expect(r.costo).toEqual({ usdEstimado: 0.123457, topeUsd: 1 });
    expect(r.latenciaMs).toEqual({ p50: 200, p95: 300 });
  });

  it("sin guiones corridos no divide entre cero", () => {
    const r = construirReporte({ ...entrada, resultados: [] });
    expect(r.aprobacion.global).toEqual({ aprobados: 0, total: 0, tasa: 0 });
    expect(r.latenciaMs).toEqual({ p50: null, p95: null });
  });

  it("el markdown trae aprobacion, costo, latencia, fallos escapados y omitidos", () => {
    const md = reporteMarkdown(construirReporte(entrada));
    expect(md).toContain("Aprobacion global: 33.3 % (1/3)");
    expect(md).toContain("p50 200 ms, p95 300 ms");
    expect(md).toContain("| G2 | 50.0 % (1/2) |");
    expect(md).toContain("G2: dijo \\| algo\\\\ malo fin");
    expect(md).toContain("conexion cerrada");
    expect(md).toContain("- D: tope_de_gasto");
  });

  it("escribe el JSON y el markdown en la carpeta indicada (la crea) y el JSON se lee de vuelta igual", () => {
    const base = mkdtempSync(join(tmpdir(), "evals-hoteles-"));
    dirs.push(base);
    const r = construirReporte(entrada);
    const { json, md } = escribirReporte(r, join(base, "docs", "evals", "hoteles"));
    expect(existsSync(json) && existsSync(md)).toBe(true);
    expect(readdirSync(join(base, "docs", "evals", "hoteles")).sort()).toEqual([json, md].map((x) => x.split("/").pop()!).sort());
    expect(JSON.parse(readFileSync(json, "utf8"))).toEqual(JSON.parse(JSON.stringify(r)));
  });

  it("la corrida con proveedor falso aprueba todos los guiones, cuesta cero y reporta cada uno", async () => {
    const r = await ejecutarPruebaCiegaFalsa();
    expect(r.modo).toBe("falso");
    expect(r.guionesCorridos).toEqual(GUIONES_ES_MX.map((g) => g.id));
    expect(r.aprobacion.global.tasa).toBe(1);
    expect(r.aprobacion.porGrader.G_TEXTO_ESPERADO).toBeDefined();
    expect(r.costo).toEqual({ usdEstimado: 0, topeUsd: null });
  });
});

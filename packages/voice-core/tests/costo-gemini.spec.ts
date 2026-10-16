// Costo REAL de Gemini Live (facturacion compuesta): el estimador de la investigacion, el costo por `usageMetadata` y como llega al evento de costo.
import { describe, expect, it } from "vitest";
import {
  COSTO_MAX_LLAMADA_MICRO_USD,
  ESCENARIOS_COSTO_GEMINI,
  VOZ_PLATAFORMA,
  costoDeUsoGeminiMicroUsd,
  crearEscaleraLlamada,
  crearProveedorGeminiLlamada,
  estimarCostoLlamadaGemini,
  eventosCostoLlamada,
} from "../src/index.ts";
import { LIMITES_POR_DEFECTO } from "../src/llamada/maquina.ts";
import type { AperturaLlamada, ManejadoresSesion, SocketLive } from "../src/index.ts";

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
const manejadores = (extra: Partial<ManejadoresSesion> = {}): ManejadoresSesion => ({ agenteDijo: () => undefined, agenteTermino: () => undefined, interrumpido: () => undefined, ejecutarTool: async () => ({}), caido: () => undefined, ...extra });

function montar(opts: { usoReportado?: "por_turno" | "acumulado" } = {}) {
  const sockets: SocketFalso[] = [];
  const urls: { url: string; headers?: Readonly<Record<string, string>> }[] = [];
  const proveedor = crearProveedorGeminiLlamada({
    apiKey: "clave-de-prueba-no-real",
    model: "gemini-3.8-live",
    ...opts,
    crearSocket: (url, o) => {
      urls.push({ url, ...(o?.headers ? { headers: o.headers } : {}) });
      const s = new SocketFalso();
      sockets.push(s);
      queueMicrotask(() => {
        s.onopen?.({});
        s.servidor({ setupComplete: {} });
      });
      return s;
    },
  });
  return { proveedor, sockets, urls };
}

describe("estimador de la facturacion compuesta (investigacion 4-oct, gemini_costo.py)", () => {
  it("reproduce los tres escenarios: bajo US$0.091, medio US$0.172, alto US$0.423 por llamada", () => {
    expect(estimarCostoLlamadaGemini(ESCENARIOS_COSTO_GEMINI.bajo).totalUsd).toBeCloseTo(0.091, 3);
    expect(estimarCostoLlamadaGemini(ESCENARIOS_COSTO_GEMINI.medio).totalUsd).toBeCloseTo(0.1719, 3);
    expect(estimarCostoLlamadaGemini(ESCENARIOS_COSTO_GEMINI.alto).totalUsd).toBeCloseTo(0.4234, 3);
  });

  it("el precio por minuto de la plataforma (US$0.075) es el caso medio redondeado, y 3x la tarifa lineal de lista (US$0.023)", () => {
    const medio = estimarCostoLlamadaGemini(ESCENARIOS_COSTO_GEMINI.medio).usdPorMinuto;
    expect(medio).toBeCloseTo(0.0747, 3);
    expect(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto).toBe(75_000);
    expect(Math.abs(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto / 1_000_000 - medio) / medio).toBeLessThan(0.01);
  });

  it("el tope por llamada (US$0.50) deja pasar el caso alto y corta lo que lo excede; el viejo US$0.10 cortaba una llamada media", () => {
    expect(COSTO_MAX_LLAMADA_MICRO_USD).toBe(500_000);
    expect(LIMITES_POR_DEFECTO.costoMaxMicroUsd).toBe(COSTO_MAX_LLAMADA_MICRO_USD);
    expect(estimarCostoLlamadaGemini(ESCENARIOS_COSTO_GEMINI.alto).totalUsd * 1_000_000).toBeLessThan(COSTO_MAX_LLAMADA_MICRO_USD);
    expect(estimarCostoLlamadaGemini(ESCENARIOS_COSTO_GEMINI.medio).totalUsd * 1_000_000).toBeGreaterThan(100_000);
  });
});

describe("costo desde usageMetadata (tokens reales por modalidad)", () => {
  it("cobra la entrada de audio, la de texto, la salida de audio y la de texto con la tarifa de cada una", () => {
    const uso = {
      promptTokensDetails: [{ modality: "AUDIO", tokenCount: 1000 }, { modality: "TEXT", tokenCount: 2000 }],
      responseTokensDetails: [{ modality: "AUDIO", tokenCount: 500 }, { modality: "TEXT", tokenCount: 100 }],
    };
    // 1000*3 + 2000*0.75 + 500*12 + 100*4.5 = 3000 + 1500 + 6000 + 450
    expect(costoDeUsoGeminiMicroUsd(uso)).toBe(10_950);
  });

  it("sin desglose por modalidad usa la tarifa de audio (sobreestima: lado seguro del tope); tokens de pensamiento y de herramientas cuentan como texto", () => {
    expect(costoDeUsoGeminiMicroUsd({ promptTokenCount: 100, responseTokenCount: 10 })).toBe(100 * 3 + 10 * 12);
    expect(costoDeUsoGeminiMicroUsd({ toolUsePromptTokenCount: 4, thoughtsTokenCount: 2 })).toBe(Math.ceil(4 * 0.75 + 2 * 4.5));
    expect(costoDeUsoGeminiMicroUsd({})).toBe(0);
    expect(costoDeUsoGeminiMicroUsd({ promptTokenCount: -5, responseTokenCount: Number.NaN })).toBe(0);
  });

  it("la sesion reporta el costo de CADA mensaje usageMetadata como REAL (por turno: se suman; el prompt ya trae el contexto acumulado)", async () => {
    const { proveedor, sockets } = montar();
    const costos: [number, boolean | undefined][] = [];
    await proveedor.abrirSesion(APERTURA, manejadores({ costo: (m, real) => void costos.push([m, real]) }));
    sockets[0]!.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 100 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 10 }] } });
    sockets[0]!.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 300 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 10 }] } });
    expect(costos).toEqual([[420, true], [1020, true]]);
  });

  it("modo `acumulado`: cada mensaje trae el total de la sesion y solo se reporta la diferencia", async () => {
    const { proveedor, sockets } = montar({ usoReportado: "acumulado" });
    const costos: number[] = [];
    await proveedor.abrirSesion(APERTURA, manejadores({ costo: (m) => void costos.push(m) }));
    sockets[0]!.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 100 }] } });
    sockets[0]!.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 300 }] } });
    sockets[0]!.servidor({ usageMetadata: { promptTokensDetails: [{ modality: "AUDIO", tokenCount: 300 }] } });
    expect(costos).toEqual([300, 600]);
  });
});

describe("el costo real llega al evento de core.usage_cost_event", () => {
  it("un tramo con costo REAL manda sobre la tarifa por minuto (puede quedar por debajo) y se registra con costo_estimado = false", () => {
    const [e] = eventosCostoLlamada({ vertical: "restaurantes", llamadaId: "c1", organizationId: "o", propertyId: "p", ocurridoEn: "2026-10-04T00:00:00Z", tramos: [{ escalon: "gemini-3.8-live", duracionS: 120, costoReportadoMicroUsd: 90_000, costoReal: true }] });
    expect(e!.costoMicroUsd).toBe(90_000);
    expect(e!.costoEstimado).toBe(false);
    expect(90_000).toBeLessThan(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto * 2);
  });

  it("sin costo real (cascada, o Gemini sin usageMetadata) sigue la regla anterior: piso por minuto y costo_estimado = true", () => {
    const [e] = eventosCostoLlamada({ vertical: "restaurantes", llamadaId: "c2", organizationId: "o", propertyId: "p", ocurridoEn: "t", tramos: [{ escalon: "gemini-3.8-live", duracionS: 60, costoReportadoMicroUsd: 5 }] });
    expect(e!.costoMicroUsd).toBe(VOZ_PLATAFORMA.gemini.precioMicroUsdPorMinuto);
    expect(e!.costoEstimado).toBe(true);
    const [z] = eventosCostoLlamada({ vertical: "restaurantes", llamadaId: "c3", organizationId: "o", propertyId: "p", ocurridoEn: "t", tramos: [{ escalon: "gemini-3.8-live", duracionS: 60, costoReportadoMicroUsd: 0, costoReal: true }] });
    expect(z!.costoEstimado).toBe(true);
  });

  it("la escalera marca el tramo como real cuando el escalon reporto costo real", async () => {
    let h: ManejadoresSesion | null = null;
    const escalera = crearEscaleraLlamada([{ id: "gemini-3.8-live", abrirSesion: async (_a, m) => ((h = m), { enviarTexto: () => undefined, interrumpir: () => undefined, cerrar: async () => undefined }) }]);
    await escalera.abrirSesion(APERTURA, manejadores());
    h!.costo?.(1234, true);
    h!.costo?.(66);
    const [t] = escalera.tramos();
    expect(t).toMatchObject({ escalon: "gemini-3.8-live", costoReportadoMicroUsd: 1300, costoReal: true });
  });
});

describe("Vertex AI (adaptador listo, no activado)", () => {
  it("abre contra la URL regional con Authorization: Bearer y el modelo con la ruta del proyecto; la llave de la Gemini API no se usa", async () => {
    const sockets: SocketFalso[] = [];
    const urls: { url: string; headers?: Readonly<Record<string, string>> }[] = [];
    const proveedor = crearProveedorGeminiLlamada({
      apiKey: null,
      model: "gemini-3.8-live",
      vertex: { project: "mi-proyecto", location: "us-central1", accessToken: async () => "token-de-prueba" },
      crearSocket: (url, o) => {
        urls.push({ url, ...(o?.headers ? { headers: o.headers } : {}) });
        const s = new SocketFalso();
        sockets.push(s);
        queueMicrotask(() => {
          s.onopen?.({});
          s.servidor({ setupComplete: {} });
        });
        return s;
      },
    });
    await proveedor.abrirSesion(APERTURA, manejadores());
    expect(urls[0]!.url).toBe("wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent");
    expect(urls[0]!.headers).toEqual({ Authorization: "Bearer token-de-prueba" });
    expect(urls[0]!.url).not.toContain("key=");
    const setup = (sockets[0]!.enviados[0] as { setup: { model: string; generationConfig: { speechConfig: { languageCode?: string } } } }).setup;
    expect(setup.model).toBe("projects/mi-proyecto/locations/us-central1/publishers/google/models/gemini-3.8-live");
    expect(setup.generationConfig.speechConfig.languageCode).toBe("es-US");
  });

  it("sin token de acceso no abre: voz no configurada (nunca una conexion sin credencial)", async () => {
    const proveedor = crearProveedorGeminiLlamada({ apiKey: null, model: "m", vertex: { project: "p", location: "us-central1", accessToken: () => "" }, crearSocket: () => new SocketFalso() });
    await expect(proveedor.abrirSesion(APERTURA, manejadores())).rejects.toThrow(/Vertex/);
  });
});

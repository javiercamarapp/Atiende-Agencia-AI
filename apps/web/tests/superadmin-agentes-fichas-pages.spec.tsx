// @vitest-environment jsdom
//
// SA-L-09 y SA-L-10: las tres fichas de agente y Model Ops. Se afirma el EFECTO con la API simulada por ruta real:
//   - cifras reales de cada endpoint; campos null: "—" con su motivo, nunca 0;
//   - error por bloque / de la ficha entera con Reintentar; base sin migrar: aviso honesto;
//   - ningun control escribe: la pagina solo hace GET (cero botones muertos);
//   - un solo h1; el circuit breaker se dice "no legible".
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { SuperAdminAgenteConciliacionPage, SuperAdminAgenteExtractorPage, SuperAdminAgenteWhatsappPage } from "../src/superadmin/pages/AgenteFicha.tsx";
import { SuperAdminModelOpsPage } from "../src/superadmin/pages/ModelOps.tsx";
import { click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const DIAS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 8, 24 + i)).toISOString().slice(0, 10));
const base = (ficha: string, nombre: string) => ({
  disponible: true,
  ficha,
  nombre,
  nombreConfirmado: false,
  generadoEn: "2026-09-30T18:00:00.000Z",
  hoy: "2026-09-30",
  roles: [],
  gastado: { valor: { totalUsd: 8.5, llmUsd: 8, vozUsd: null } },
  llamadas: { valor: 1500 },
  fallbacks: { valor: { total: 30, tasaPct: 2 } },
  costoPorModelo: { valor: [{ proveedor: "prov-a", modelo: "modelo-uno", llamadas: 60, fallbacks: 3, costoUsd: 2, tokensEntrada: 600, tokensSalida: 300 }] },
  serie7d: { valor: DIAS.map((dia, i) => ({ dia, llamadas: i, costoUsd: i / 10 })) },
});
const extractor = (): Record<string, unknown> => ({
  ...base("extractor", "Agente extractor"),
  documentosExtraidos: { valor: { documentos: 6, requisitos: 41, licitaciones: 3 } },
  precision: { valor: null, codigo: "sin_verdad_de_terreno", razon: "Sin verdad de terreno todavía: no hay un conjunto etiquetado." },
  notas: [],
});
const conciliacion = (): Record<string, unknown> => ({
  ...base("conciliacion", "Agente de conciliación"),
  movimientosConciliados: { valor: { total: 30, porMotor: 20, porLlmAprobado: 6, porManual: 4, sugerenciasPendientes: 2, sugerenciasTotal: 9 } },
});
const whatsapp = (): Record<string, unknown> => ({
  ...base("whatsapp", "Agente de WhatsApp y voz"),
  gastado: { valor: { totalUsd: 8.5, llmUsd: 8, vozUsd: 0.5 } },
  conversaciones: { valor: 48 },
  minutosVoz: { valor: 12.5 },
  escalamiento: { valor: { escaladas: 20, total: 150, tasaPct: 13.3 } },
  porVertical: {
    valor: [
      { vertical: "restaurantes", llamadas: 120, costoLlmUsd: 7, escaladas: 20, conversaciones: { valor: 40 }, minutosVoz: { valor: 12.5 }, costoVozUsd: { valor: 0.5 } },
      { vertical: "hoteles", llamadas: 0, costoLlmUsd: 0, escaladas: 0, conversaciones: { valor: null, codigo: "fuente_no_migrada", razon: "No disponible aún: la migración de esta vertical no está aplicada." }, minutosVoz: { valor: 0 }, costoVozUsd: { valor: 0 } },
    ],
  },
});
const modelOps = (): Record<string, unknown> => ({
  disponible: true,
  generadoEn: "2026-09-30T18:00:00.000Z",
  hoy: "2026-09-30",
  desde: "2026-09-01",
  fichas: [
    {
      role: "restaurantes:whatsapp_agent",
      vertical: "restaurantes",
      modelo: "openai/gpt-6-luna",
      proveedores: ["openai", "azure"],
      escalera: [
        { orden: 1, modelo: "openai/gpt-6-luna", razonamiento: "low", proveedores: ["openai", "azure"] },
        { orden: 2, modelo: "deepseek/deepseek-v4.1-flash", razonamiento: "low", proveedores: ["deepinfra"] },
      ],
      carril: { valor: ["batch", "interactive"] },
      llamadas30d: { valor: 70 },
      costo30dUsd: { valor: 2.4 },
      tasaFallbackPct: { valor: 11.4 },
      circuitBreaker: { valor: null, codigo: "breaker_no_legible", razon: "No legible: vive en memoria." },
    },
    {
      role: "citas:data_chat",
      vertical: "citas",
      modelo: "openai/gpt-6-luna",
      proveedores: ["openai"],
      escalera: [{ orden: 1, modelo: "openai/gpt-6-luna", razonamiento: "low", proveedores: ["openai"] }],
      carril: { valor: null },
      llamadas30d: { valor: 0 },
      costo30dUsd: { valor: 0 },
      tasaFallbackPct: { valor: null, codigo: "sin_llamadas", razon: "Sin llamadas en el periodo: no hay base para calcular la tasa." },
      circuitBreaker: { valor: null, codigo: "breaker_no_legible", razon: "No legible." },
    },
  ],
  porAgente: { valor: [{ role: "restaurantes:whatsapp_agent", costoUsd: 2.4 }] },
  porModelo: { valor: [{ modelo: "openai/gpt-6-luna", costoUsd: 2.4 }] },
  notas: ["Esta pantalla no versiona prompts ni cambia modelos: el modelo se cambia con LLM_MODELS_JSON."],
});

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}
function stubApi(cuerpo: unknown | "fallo") {
  fetchMock = vi.fn(async () => (cuerpo === "fallo" ? json({ message: "boom" }, 500) : json(cuerpo)));
  vi.stubGlobal("fetch", fetchMock);
}
async function esperar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await flushMicrotasks();
  });
}
async function montar(pagina: React.ReactElement): Promise<RenderedComponent> {
  const r = renderComponent(<MemoryRouter>{pagina}</MemoryRouter>);
  await esperar();
  return r;
}
const texto = () => rendered!.container.textContent ?? "";
const tarjeta = (etiqueta: string): HTMLElement => {
  const el = [...rendered!.container.querySelectorAll('[data-testid="stat-card-chip"]')].map((c) => c.parentElement!.parentElement!.parentElement as HTMLElement).find((t) => t.textContent?.includes(etiqueta));
  if (!el) throw new Error(`sin tarjeta ${etiqueta}`);
  return el;
};
const extractorPage = () => <SuperAdminAgenteExtractorPage apiBaseUrl="https://api.test" token="tok" />;
const conciliacionPage = () => <SuperAdminAgenteConciliacionPage apiBaseUrl="https://api.test" token="tok" />;
const whatsappPage = () => <SuperAdminAgenteWhatsappPage apiBaseUrl="https://api.test" token="tok" />;
const modelOpsPage = () => <SuperAdminModelOpsPage apiBaseUrl="https://api.test" token="tok" />;

describe("ficha del agente extractor", () => {
  it("pide GET /superadmin/agentes/extractor con el token, un solo h1 y las tres StatCards con su cifra", async () => {
    stubApi(extractor());
    rendered = await montar(extractorPage());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/superadmin/agentes/extractor");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(init.method).toBeUndefined();
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Agente extractor");
    expect(rendered.container.querySelectorAll('[data-testid="stat-card-chip"]')).toHaveLength(3);
    expect(tarjeta("Gastado").textContent).toContain("US$8.50");
    expect(tarjeta("Llamadas").textContent).toContain("1,500");
    expect(tarjeta("Llamadas").textContent).toContain("30 con fallback");
    expect(tarjeta("Documentos extraídos").textContent).toContain("6");
    expect(tarjeta("Documentos extraídos").textContent).toContain("41 requisitos · 3 licitaciones");
  });

  it("la precision no medida es un estado vacio honesto (sin cifra ni grafica inventada)", async () => {
    stubApi(extractor());
    rendered = await montar(extractorPage());
    expect(texto()).toContain("Sin verdad de terreno todavía");
    expect(texto()).not.toMatch(/precisi[oó]n[^.]*\d+\s?%/i);
  });

  it("tabla de costo por modelo con sus filas y barras de 7 dias", async () => {
    stubApi(extractor());
    rendered = await montar(extractorPage());
    expect(texto()).toContain("modelo-uno");
    expect(texto()).toContain("prov-a");
    expect(texto()).toContain("US$2.00");
    expect(texto()).toContain("Llamadas al modelo por día");
  });

  it("documentos extraidos null: '—' con su razon (no 0) y el resto de la ficha sigue", async () => {
    const f = extractor();
    f.documentosExtraidos = { valor: null, codigo: "fuente_no_migrada", razon: "No disponible aún: la migración de esta vertical no está aplicada en este despliegue." };
    stubApi(f);
    rendered = await montar(extractorPage());
    const t = tarjeta("Documentos extraídos");
    expect(t.textContent).toContain("—");
    expect(t.textContent).toContain("la migración de esta vertical no está aplicada");
    expect(tarjeta("Llamadas").textContent).toContain("1,500");
  });

  it("base sin migrar (disponible:false): aviso, todas las tarjetas '—' con razon y cero cifras inventadas", async () => {
    const f = extractor();
    Object.assign(f, {
      disponible: false,
      mensaje: "No disponible aún: falta aplicar la migración 0049_superadmin_fichas_agente en este despliegue.",
      gastado: { valor: null, codigo: "sin_consola", razon: "No disponible aún: falta aplicar la migración 0042." },
      llamadas: { valor: null, codigo: "sin_consola", razon: "No disponible aún: falta aplicar la migración 0042." },
      costoPorModelo: { valor: null, codigo: "no_migrado", razon: "No disponible aún: 0049." },
      serie7d: { valor: null, codigo: "no_migrado", razon: "No disponible aún: 0049." },
      documentosExtraidos: { valor: null, codigo: "no_migrado", razon: "No disponible aún: 0049." },
    });
    stubApi(f);
    rendered = await montar(extractorPage());
    expect(texto()).toContain("Todavía no disponible en esta base");
    expect(texto()).toContain("0049_superadmin_fichas_agente");
    expect(tarjeta("Gastado").textContent).toContain("—");
    expect(tarjeta("Gastado").textContent).not.toContain("US$");
    expect(rendered.container.querySelectorAll("table").length).toBe(0);
  });

  it("si el endpoint cae: error con Reintentar y al reintentar vuelve a pedir y pinta la ficha", async () => {
    stubApi("fallo");
    rendered = await montar(extractorPage());
    expect(texto()).toContain("No se pudo cargar");
    const reintentar = [...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Reintentar"));
    expect(reintentar).toBeTruthy();
    stubApi(extractor());
    await act(async () => {
      click(reintentar!);
      for (let i = 0; i < 8; i++) await flushMicrotasks();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tarjeta("Gastado").textContent).toContain("US$8.50");
  });
});

describe("ficha del agente de conciliacion", () => {
  it("StatCards con gasto, llamadas y movimientos conciliados desglosados por origen", async () => {
    stubApi(conciliacion());
    rendered = await montar(conciliacionPage());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.test/superadmin/agentes/conciliacion");
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Agente de conciliación");
    const t = tarjeta("Movimientos conciliados");
    expect(t.textContent).toContain("30");
    expect(t.textContent).toContain("20 motor · 6 IA aprobada · 4 manual · 2 sugerencias pendientes");
  });

  it("movimientos null por error: '—' con razon y el resto sigue", async () => {
    const f = conciliacion();
    f.movimientosConciliados = { valor: null, codigo: "error", razon: "No se pudo leer esta fuente; el resto de la ficha sigue disponible." };
    stubApi(f);
    rendered = await montar(conciliacionPage());
    expect(tarjeta("Movimientos conciliados").textContent).toContain("No se pudo leer esta fuente");
    expect(tarjeta("Llamadas").textContent).toContain("1,500");
  });
});

describe("ficha del agente de WhatsApp y voz", () => {
  it("cuatro StatCards (gasto LLM+voz, llamadas, conversaciones, minutos de voz), escalamiento y desglose por vertical", async () => {
    stubApi(whatsapp());
    rendered = await montar(whatsappPage());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.test/superadmin/agentes/whatsapp");
    expect(rendered.container.querySelectorAll('[data-testid="stat-card-chip"]')).toHaveLength(4);
    expect(tarjeta("Gastado").textContent).toContain("LLM US$8.00 · voz US$0.50");
    expect(tarjeta("Conversaciones").textContent).toContain("48");
    expect(tarjeta("Minutos de voz").textContent).toContain("12.5");
    expect(texto()).toContain("13.3 %");
    expect(texto()).toContain("20 de 150 llamadas");
    expect(texto()).toContain("Restaurantes");
    expect(texto()).toContain("Hoteles");
  });

  it("vertical sin fuente de conversaciones: '—' con su razon en la celda (title), nunca 0", async () => {
    stubApi(whatsapp());
    rendered = await montar(whatsappPage());
    const celdas = [...rendered.container.querySelectorAll("td span[title]")].map((e) => e.getAttribute("title"));
    expect(celdas.some((t) => t?.includes("la migración de esta vertical no está aplicada"))).toBe(true);
  });

  it("sin llamadas, la tasa de escalamiento dice 'Sin llamadas' y no 0 %", async () => {
    const f = whatsapp();
    f.escalamiento = { valor: { escaladas: 0, total: 0, tasaPct: null } };
    stubApi(f);
    rendered = await montar(whatsappPage());
    expect(texto()).toContain("Sin llamadas");
    expect(texto()).not.toContain("0 %");
  });

  it("voz ilegible: gasto y minutos '—' con la razon de la voz, el LLM sigue", async () => {
    const f = whatsapp();
    f.gastado = { valor: null, codigo: "no_migrado", razon: "No disponible aún: 0049." };
    f.minutosVoz = { valor: null, codigo: "no_migrado", razon: "No disponible aún: 0049." };
    stubApi(f);
    rendered = await montar(whatsappPage());
    expect(tarjeta("Gastado").textContent).toContain("No disponible aún: 0049.");
    expect(tarjeta("Minutos de voz").textContent).toContain("No disponible aún: 0049.");
    expect(tarjeta("Llamadas al modelo").textContent).toContain("1,500");
  });

  it("es de solo lectura: ningun boton dispara una escritura", async () => {
    stubApi(whatsapp());
    rendered = await montar(whatsappPage());
    const antes = fetchMock.mock.calls.length;
    for (const b of rendered.container.querySelectorAll("button")) click(b);
    await esperar();
    const metodos = fetchMock.mock.calls.slice(antes).map((c) => (c[1] as RequestInit | undefined)?.method ?? "GET");
    expect(metodos.every((m) => m === "GET")).toBe(true);
  });
});

describe("Model Ops", () => {
  it("pide GET /superadmin/model-ops y pinta una fila por rol con modelo, proveedores, carril, llamadas, costo y fallback", async () => {
    stubApi(modelOps());
    rendered = await montar(modelOpsPage());
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("https://api.test/superadmin/model-ops");
    expect(rendered.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered.container.querySelector("h1")!.textContent).toBe("Model Ops");
    const t = texto();
    expect(t).toContain("restaurantes:whatsapp_agent");
    expect(t).toContain("openai/gpt-6-luna");
    expect(t).toContain("respaldo: deepseek/deepseek-v4.1-flash");
    expect(t).toContain("openai, azure");
    expect(t).toContain("batch, interactive");
    expect(t).toContain("70");
    expect(t).toContain("US$2.40");
    expect(t).toContain("11.4 %");
  });

  it("circuit breaker 'no legible' y la tasa de fallback sin llamadas es '—' (no 0 %)", async () => {
    stubApi(modelOps());
    rendered = await montar(modelOpsPage());
    expect(texto().match(/no legible/g)!.length).toBeGreaterThanOrEqual(2);
    const filas = [...rendered.container.querySelectorAll("tbody tr")];
    const citas = filas.find((f) => f.textContent?.includes("citas:data_chat"))!;
    expect(citas.textContent).not.toContain("0 %");
    expect(citas.querySelector('span[title^="Sin llamadas"]')).toBeTruthy();
  });

  it("incluye la dona por agente, las barras por modelo y la nota 'no versiona prompts ni cambia modelos'", async () => {
    stubApi(modelOps());
    rendered = await montar(modelOpsPage());
    expect(texto()).toContain("Costo por agente / rol");
    expect(texto()).toContain("Costo por modelo");
    expect(texto()).toContain("no versiona prompts ni cambia modelos");
  });

  it("base sin migrar: aviso de consumo, la configuracion de modelos se sigue mostrando y las cifras son '—'", async () => {
    const m = modelOps();
    const sinConsumo = { valor: null, codigo: "no_migrado", razon: "No disponible aún: falta aplicar la migración 0049." };
    Object.assign(m, {
      disponible: false,
      mensaje: "No disponible aún: falta aplicar la migración 0049_superadmin_fichas_agente en este despliegue.",
      porAgente: sinConsumo,
      porModelo: sinConsumo,
    });
    (m.fichas as Record<string, unknown>[]).forEach((f) => Object.assign(f, { carril: sinConsumo, llamadas30d: sinConsumo, costo30dUsd: sinConsumo, tasaFallbackPct: sinConsumo }));
    stubApi(m);
    rendered = await montar(modelOpsPage());
    expect(texto()).toContain("Consumo no disponible en esta base");
    expect(texto()).toContain("openai/gpt-6-luna");
    expect(texto()).not.toContain("US$2.40");
  });

  it("si el endpoint cae: error con Reintentar", async () => {
    stubApi("fallo");
    rendered = await montar(modelOpsPage());
    expect(texto()).toContain("No se pudo cargar");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Reintentar"))).toBe(true);
  });
});

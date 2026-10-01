// @vitest-environment jsdom
//
// <PestanaIndicadores />: KPI de voz, costo en centavos MXN, alertas internas y umbrales. `fetch` inyectado por ruta real
// (lib/voz-kpi-client.ts). Cubre: cifras exactas, "—" (nunca 0 inventado) sin datos / sin tipo de cambio, base sin migrar,
// error con reintento, alertas del día, validación y guardado de umbrales, y que NO aparezca ningún teléfono.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PestanaIndicadores } from "../src/verticals/restaurantes/voz/PestanaIndicadores.tsx";
import { formatoMs, formatoMxn, formatoPct, pesosACentavos } from "../src/verticals/restaurantes/voz/formato-kpi.ts";
import { changeValue, click, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
});

const BASE = "https://api.test/v1/restaurantes/prop-1/admin/voz";

function totales(parcial: Record<string, unknown> = {}) {
  return {
    dias: 1, llamadas: 0, llamadasCerradas: 0, duracionPromedioS: null, pedidosVoz: 0, escaladas: 0, abandonadas: 0,
    tasaResolucionPct: null, tasaHandoffPct: null, tasaAbandonoPct: null, erroresProveedor: 0, erroresElevenlabs: 0, erroresTwilio: 0, erroresOtros: 0,
    tasaErrorPct: null, toolCalls: 0, toolP95PeorDiaMs: null, costoVozMicroUsd: 0, costoTelefoniaMicroUsd: 0, costoCentavosMxn: 0, costoCompleto: true,
    costoPorLlamadaCentavosMxn: null, costoLlmOrgCentavosMxn: null, ...parcial,
  };
}

const KPI_CON_DATOS = {
  disponible: true, zonaHoraria: "America/Mexico_City", hoy: "2026-03-10", mesDesde: "2026-03-01",
  diaDeHoy: totales({ llamadas: 4, llamadasCerradas: 3, duracionPromedioS: 430, pedidosVoz: 1, escaladas: 1, tasaResolucionPct: 33, tasaHandoffPct: 33, erroresProveedor: 4, erroresElevenlabs: 2, erroresTwilio: 1, erroresOtros: 1, toolP95PeorDiaMs: 950, costoCentavosMxn: 4000, costoPorLlamadaCentavosMxn: 1000 }),
  mes: totales({ dias: 10, llamadas: 7, llamadasCerradas: 6, pedidosVoz: 3, escaladas: 1, tasaResolucionPct: 50, tasaHandoffPct: 17, tasaErrorPct: 57, erroresProveedor: 4, costoCentavosMxn: 123456, costoLlmOrgCentavosMxn: 6000 }),
  serie: [
    { fecha: "2026-03-09", llamadas: 3, pedidosVoz: 1, escaladas: 0, erroresProveedor: 0, toolP95Ms: null, costoCentavosMxn: 2000 },
    { fecha: "2026-03-10", llamadas: 4, pedidosVoz: 1, escaladas: 1, erroresProveedor: 4, toolP95Ms: 950, costoCentavosMxn: 4000 },
  ],
};
const UMBRALES_OFF = { configurado: false, umbralCostoDiaCentavosMxn: null, umbralTasaErrorPct: null, minLlamadasTasaError: 5 };

type Respuesta = { status: number; body?: unknown };
function res(r: Respuesta): Response {
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body ?? {} } as unknown as Response;
}

function stub(rutas: { kpi?: Respuesta; alertas?: Respuesta; evaluar?: Respuesta; put?: (b: Record<string, unknown>) => Respuesta }) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === `${BASE}/kpi`) return res(rutas.kpi ?? { status: 200, body: KPI_CON_DATOS });
    if (url === `${BASE}/alertas/evaluar` && method === "POST") return res(rutas.evaluar ?? { status: 200, body: { disponible: true, alertas: [] } });
    if (url === `${BASE}/alertas/config` && method === "PUT") return res(rutas.put ? rutas.put(JSON.parse(init!.body as string)) : { status: 500 });
    if (url === `${BASE}/alertas`) return res(rutas.alertas ?? { status: 200, body: { disponible: true, umbrales: UMBRALES_OFF, alertas: [] } });
    throw new Error(`fetch inesperado: ${method} ${url}`);
  });
  return fetchMock;
}

async function pintar(fetchMock: ReturnType<typeof stub>) {
  rendered = renderComponent(<PestanaIndicadores apiBaseUrl="https://api.test" token="tok" propertyId="prop-1" fetchImpl={fetchMock as unknown as typeof fetch} />);
  await settle();
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
const texto = () => rendered!.container.textContent ?? "";
const boton = (t: string) => Array.from(rendered!.container.querySelectorAll("button")).find((b) => b.textContent?.includes(t));

describe("formato", () => {
  it("dinero desde centavos enteros, sin dato = guion, y pesos -> centavos exactos", () => {
    expect(formatoMxn(123456)).toBe("$1,234.56 MXN");
    expect(formatoMxn(0)).toBe("$0.00 MXN");
    expect(formatoMxn(null)).toBe("—");
    expect(formatoPct(null)).toBe("—");
    expect(formatoPct(0)).toBe("0%");
    expect(formatoMs(950)).toBe("950 ms");
    expect(formatoMs(1500)).toBe("1.5 s");
    expect(pesosACentavos("500")).toBe(50000);
    expect(pesosACentavos("1,234.50")).toBe(123450);
    expect(pesosACentavos("0.29")).toBe(29);
    expect(pesosACentavos("")).toBeNull();
    expect(pesosACentavos("12.345")).toBeUndefined();
    expect(pesosACentavos("0")).toBeUndefined();
    expect(pesosACentavos("-5")).toBeUndefined();
    expect(pesosACentavos("abc")).toBeUndefined();
  });
});

describe("<PestanaIndicadores />", () => {
  it("muestra las cifras reales de hoy y del mes, el desglose por proveedor y la serie", async () => {
    await pintar(stub({}));
    const t = texto();
    expect(t).toContain("Hoy es 10 mar");
    expect(t).toContain("$40.00 MXN"); // costo del dia (4000 centavos)
    expect(t).toContain("$1,234.56 MXN"); // costo del mes
    expect(t).toContain("ElevenLabs 2");
    expect(t).toContain("Twilio 1");
    expect(t).toContain("950 ms");
    expect(t).toContain("7:10"); // duracion promedio 430 s
    expect(t).toContain("Resolución 33%");
    expect(t).toContain("LLM de texto de toda la organización");
    expect(t).toContain("$60.00 MXN");
    expect(rendered!.container.querySelectorAll("[data-dia]")).toHaveLength(2);
    expect(rendered!.container.querySelector("[data-dia]")!.getAttribute("data-dia")).toBe("2026-03-10"); // mas reciente primero
  });

  it("no expone teléfonos ni números del llamante", async () => {
    await pintar(stub({}));
    expect(texto()).not.toMatch(/\+?\d{10,}/);
    expect(texto()).not.toMatch(/tel[eé]fono del llamante|caller/i);
  });

  it("sin datos: guiones con su razón (nunca un 0 inventado) en duración, p95 y porcentajes", async () => {
    const vacio = { ...KPI_CON_DATOS, diaDeHoy: totales(), mes: totales({ dias: 10 }), serie: [] };
    await pintar(stub({ kpi: { status: 200, body: vacio } }));
    const t = texto();
    expect(t).toContain("Sin llamadas cerradas hoy.");
    expect(t).toContain("Sin llamadas a herramientas hoy.");
    expect(t).toContain("Sin llamadas cerradas.");
    expect(t).not.toContain("LLM de texto de toda la organización");
  });

  it("sin tipo de cambio: costo '—' con su razón; con tipo de cambio incompleto el mes avisa que es un mínimo", async () => {
    const sinFx = { ...KPI_CON_DATOS, diaDeHoy: totales({ llamadas: 2, costoVozMicroUsd: 500_000, costoCentavosMxn: null, costoCompleto: false }), mes: totales({ dias: 10, llamadas: 2, costoVozMicroUsd: 500_000, costoCentavosMxn: null, costoCompleto: false }) };
    await pintar(stub({ kpi: { status: 200, body: sinFx } }));
    expect(texto()).toContain("Falta el tipo de cambio para convertir a pesos.");
    rendered!.unmount();
    const incompleto = { ...KPI_CON_DATOS, mes: totales({ dias: 10, llamadas: 5, costoCentavosMxn: 3000, costoCompleto: false }) };
    await pintar(stub({ kpi: { status: 200, body: incompleto } }));
    expect(texto()).toContain("la cifra es un mínimo");
  });

  it("base sin migrar (404, 503 o disponible=false): estado honesto, sin cifras", async () => {
    for (const kpi of [{ status: 404 }, { status: 503 }, { status: 200, body: { disponible: false } }]) {
      await pintar(stub({ kpi }));
      expect(texto()).toContain("Indicadores no disponibles todavía");
      expect(rendered!.container.querySelector('[data-testid="indicadores-voz"]')).toBeNull();
      rendered!.unmount();
    }
  });

  it("error real: muestra el mensaje y reintenta", async () => {
    const f = stub({ kpi: { status: 500, body: { message: "boom" } } });
    await pintar(f);
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
    const antes = f.mock.calls.length;
    click(boton("Reintentar")!);
    await settle();
    expect(f.mock.calls.length).toBeGreaterThan(antes);
  });

  it("evalúa las alertas al abrir y muestra las de hoy como aviso interno", async () => {
    const alerta = { fecha: "2026-03-10", tipo: "costo_dia", valor: 10000, umbral: 8000, nueva: true };
    const f = stub({ evaluar: { status: 200, body: { disponible: true, alertas: [alerta] } }, alertas: { status: 200, body: { disponible: true, umbrales: { configurado: true, umbralCostoDiaCentavosMxn: 8000, umbralTasaErrorPct: null, minLlamadasTasaError: 5 }, alertas: [alerta, { fecha: "2026-03-01", tipo: "tasa_error", valor: 50, umbral: 40, nueva: false }] } } });
    await pintar(f);
    expect(f.mock.calls.some(([u, i]) => u === `${BASE}/alertas/evaluar` && (i as RequestInit).method === "POST")).toBe(true);
    const avisos = rendered!.container.querySelector('[data-testid="alertas-hoy"]')!.textContent!;
    expect(avisos).toContain("$100.00 MXN");
    expect(avisos).toContain("$80.00 MXN");
    expect(rendered!.container.querySelector('[data-testid="alertas-recientes"]')!.textContent).toContain("50%");
    // Solo avisos internos: ninguna llamada fuera de los endpoints de voz de la API.
    expect(f.mock.calls.every(([u]) => String(u).startsWith(BASE))).toBe(true);
  });

  it("guardar umbrales: convierte pesos a centavos enteros y manda null para apagar una alerta", async () => {
    const f = stub({ put: (b) => ({ status: 200, body: { disponible: true, configurado: true, ...b } }) });
    await pintar(f);
    changeValue(rendered!.container.querySelector("#umbral-costo") as HTMLInputElement, "1,234.50");
    changeValue(rendered!.container.querySelector("#umbral-minimo") as HTMLInputElement, "3");
    click(boton("Guardar umbrales")!);
    await settle();
    const put = f.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === "PUT")!;
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ umbralCostoDiaCentavosMxn: 123450, umbralTasaErrorPct: null, minLlamadasTasaError: 3 });
    expect(texto()).toContain("Umbrales guardados.");
  });

  it("validación local: decimales de más, porcentaje fuera de rango o mínimo inválido no llegan a la API", async () => {
    const f = stub({ put: () => ({ status: 200, body: {} }) });
    await pintar(f);
    for (const [id, valor] of [["umbral-costo", "12.345"], ["umbral-tasa", "101"], ["umbral-minimo", "0"]] as const) {
      changeValue(rendered!.container.querySelector(`#${id}`) as HTMLInputElement, valor);
      click(boton("Guardar umbrales")!);
      await settle();
      expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
      changeValue(rendered!.container.querySelector(`#${id}`) as HTMLInputElement, id === "umbral-minimo" ? "5" : "");
    }
    expect(f.mock.calls.some(([, i]) => (i as RequestInit | undefined)?.method === "PUT")).toBe(false);
  });

  it("error del servidor al guardar umbrales: se muestra el mensaje y no hay aviso de éxito", async () => {
    const f = stub({ put: () => ({ status: 403, body: { message: "Sin permiso" } }) });
    await pintar(f);
    click(boton("Guardar umbrales")!);
    await settle();
    expect(texto()).not.toContain("Umbrales guardados.");
    expect(rendered!.container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

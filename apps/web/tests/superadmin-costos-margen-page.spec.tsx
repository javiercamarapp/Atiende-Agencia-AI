// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminCostosMargenPage } from "../src/superadmin/pages/CostosMargen.tsx";
import { changeValue, click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

async function esperar(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body, clone() { return this; }, status: ok ? 200 : 400 }) as unknown as Response;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const FILA = {
  organizationId: "o1",
  nombre: "Los Taquitos de PM",
  slug: "taquitos",
  vertical: "restaurantes",
  planId: "restaurantes-estandar",
  planNombre: "Restaurantes - por agente de voz",
  costoMicroUsd: { llm: 2_000_000, voz: 1_000_000, whatsapp: 500_000, telefonia: 500_000, otros: 0, total: 4_000_000 },
  costoUsd: 4,
  costoMxn: 70,
  eventosTotal: 10,
  eventosEstimados: 8,
  ingresoMxn: 1598,
  ingresoRazon: null,
  margenMxn: 1528,
  margenPct: 95.6,
  llmUsoPct: 12,
  consumo: [{ metrica: "minutos_voz_mes", limite: 100, accion: "cobrar", uso: 120, pct: 120, estado: "excedido", aplicadoPorSistema: false }],
  alertas: [{ codigo: "limite_excedido", severidad: "alta", mensaje: "Excede el limite de su plan en minutos de voz del mes." }],
  riesgo: "alto",
};
const SIN_PLAN = { ...FILA, organizationId: "o2", nombre: "Clinica Sur", planId: null, planNombre: null, costoMxn: null, ingresoMxn: null, ingresoRazon: "sin_plan", margenMxn: null, margenPct: null, consumo: [], alertas: [], riesgo: "desconocido" };

function stub(respuesta: unknown, extra?: (url: string, init?: RequestInit) => Response | undefined) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = extra?.(url, init);
    if (custom) return custom;
    if (url.includes("/superadmin/costos/resumen")) return json(respuesta);
    if (url.includes("/eventos")) return json({ eventos: [{ id: "e1", ocurrioEnMs: 1_700_000_000_000, categoria: "voz", proveedor: "livekit", unidad: "minuto", cantidad: 3, costoMicroUsd: 1_500_000, costoEstimado: true }] });
    throw new Error(`fetch inesperado: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const render = () => renderComponent(<SuperAdminCostosMargenPage apiBaseUrl="https://api.test" token="tok" />);
const base = { disponible: true, mes: "2026-09", umbralMargenPct: 30, supuestos: ["Supuesto de prueba uno."] };

describe("SuperAdminCostosMargenPage", () => {
  it("muestra costo, ingreso, margen y riesgo por organizacion; lo desconocido es «—», no cero", async () => {
    stub({ ...base, tipoCambio: { fecha: "2026-09-01", mxnPorUsd: 17.5, fuente: "Banxico FIX" }, resumen: { organizaciones: 2, costoUsd: 8, costoMxn: 140, ingresoMxn: 1598, organizacionesSinIngreso: 1, margenMxn: 1528, margenPct: 95.6, enRiesgoAlto: 1, enRiesgoMedio: 0 }, organizaciones: [FILA, SIN_PLAN] });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("Los Taquitos de PM");
    expect(t).toContain("$1,598.00");
    expect(t).toContain("95.6%");
    expect(t).toContain("Riesgo alto");
    expect(t).toContain("Excede el limite de su plan");
    expect(t).toContain("— sin plan asignado");
    expect(t).toContain("Sin datos");
    expect(t).toContain("1 organización(es) sin precio conocido");
    expect(t).toContain("Supuesto de prueba uno.");
    expect(t).not.toContain("No hay tipo de cambio configurado");
  });

  it("sin tipo de cambio avisa que el costo en pesos y el margen no se calculan", async () => {
    stub({ ...base, tipoCambio: null, resumen: { organizaciones: 1, costoUsd: 4, costoMxn: null, ingresoMxn: 1598, organizacionesSinIngreso: 0, margenMxn: null, margenPct: null, enRiesgoAlto: 0, enRiesgoMedio: 0 }, organizaciones: [{ ...FILA, costoMxn: null, margenMxn: null, margenPct: null, alertas: [], riesgo: "bajo" }] });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("No hay tipo de cambio configurado");
    expect(t).toContain("US$4.00");
  });

  it("base sin migrar: aviso honesto, sin tarjetas ni boton de tipo de cambio", async () => {
    stub({ ...base, disponible: false, tipoCambio: null, resumen: null, organizaciones: [], supuestos: [] });
    rendered = render();
    await esperar();
    const t = rendered.container.textContent ?? "";
    expect(t).toContain("migración 0028 pendiente");
    expect([...rendered.container.querySelectorAll("button")].some((b) => b.textContent?.includes("Capturar tipo de cambio"))).toBe(false);
  });

  it("error de red: estado de error con reintento", async () => {
    fetchMock = vi.fn(async () => {
      throw new Error("red");
    });
    vi.stubGlobal("fetch", fetchMock);
    rendered = render();
    await esperar();
    expect(rendered.container.textContent).toContain("No se pudo cargar el reporte de costos.");
  });

  it("tipo de cambio: valida antes de enviar y manda el PUT con fecha, valor y fuente", async () => {
    let put: { url: string; body: unknown } | null = null;
    stub(
      { ...base, tipoCambio: null, resumen: { organizaciones: 0, costoUsd: 0, costoMxn: null, ingresoMxn: 0, organizacionesSinIngreso: 0, margenMxn: null, margenPct: null, enRiesgoAlto: 0, enRiesgoMedio: 0 }, organizaciones: [] },
      (url, init) => {
        if (init?.method === "PUT") {
          put = { url, body: JSON.parse(String(init.body)) };
          return json({ ok: true });
        }
        return undefined;
      },
    );
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Capturar tipo de cambio"))!);
    const form = document.body.querySelector("#form-fx") as HTMLFormElement;
    changeValue(document.body.querySelector("#fx-valor") as HTMLInputElement, "-3");
    await submitForm(form);
    expect(document.body.textContent).toContain("mayor a 0");
    expect(put).toBeNull();
    changeValue(document.body.querySelector("#fx-valor") as HTMLInputElement, "18.25");
    changeValue(document.body.querySelector("#fx-fuente") as HTMLInputElement, "Banxico FIX");
    await submitForm(form);
    await esperar();
    expect(put).toMatchObject({ url: "https://api.test/superadmin/costos/tipo-cambio", body: { mxnPorUsd: 18.25, fuente: "Banxico FIX" } });
  });

  it("detalle: carga los eventos de la organizacion y marca el consumo contra limites", async () => {
    stub({ ...base, tipoCambio: { fecha: "2026-09-01", mxnPorUsd: 17.5, fuente: "Banxico FIX" }, resumen: { organizaciones: 1, costoUsd: 4, costoMxn: 70, ingresoMxn: 1598, organizacionesSinIngreso: 0, margenMxn: 1528, margenPct: 95.6, enRiesgoAlto: 1, enRiesgoMedio: 0 }, organizaciones: [FILA] });
    rendered = render();
    await esperar();
    click([...rendered.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Detalle")!);
    await esperar();
    const t = document.body.textContent ?? "";
    expect(t).toContain("120 / 100");
    expect(t).toContain("solo avisa");
    expect(t).toContain("livekit");
    expect(t).toContain("(estimado)");
    expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).includes("/superadmin/costos/organizaciones/o1/eventos"))).toBe(true);
  });
});

// @vitest-environment jsdom
//
// <RevenuePage /> (hoteles) tras UNI-C gestion: un solo h1, gate (inicializar, promover con confirmacion), aprobar una
// recomendacion CON confirmacion (Volver/Escape nunca escriben), alta de backtest y de captura de datos en FormDialog
// (validacion dentro del dialogo, Cerrar no escribe) y guardado de reglas de precio. `fetch` mockeado por ruta real.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock, Toaster: () => null }));

import { RevenuePage } from "../src/verticals/hoteles/pages/Revenue.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { RateRecommendation, RevenueGate } from "../src/verticals/hoteles/lib/revenue-client.ts";
import { changeValue, click, flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  toastMock.success.mockClear();
});
afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
});

const jsonResponse = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const CTX: HotelesShellContext = { apiBaseUrl: "https://api.test", token: "tok", propertyId: "prop-1", orgSlug: "demo", role: "owner", staffFullName: "GM", staffEmail: "gm@example.com" };

const GATE_SHADOW: RevenueGate = {
  id: "g1",
  gate: "shadow",
  shadowStartedAt: "2026-09-01T10:00:00.000Z",
  proponeStartedAt: null,
  autopilotStartedAt: null,
  proponeMaxVariationPct: 10,
  ownerApprovedAutopilotAt: null,
  updatedBy: null,
  updatedAt: "2026-09-01T10:00:00.000Z",
  createdAt: "2026-09-01T10:00:00.000Z",
};

const REC: RateRecommendation = {
  id: "rec-1",
  propertyId: "prop-1",
  roomTypeId: "rt-1",
  fecha: "2026-12-25",
  currentBarPrice: 1000,
  recommendedPrice: 1200,
  suggestedMinStay: 2,
  desglose: {},
  estado: "pendiente",
  aprobadaPor: null,
  aprobadaEn: null,
  aplicadaPor: null,
  aplicadaEn: null,
  descartadaPor: null,
  descartadaEn: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
};

const REGLA = { floorPrice: 800, ceilingPrice: 3000, dayOfWeekMultiplier: [1, 1, 1, 1, 1, 1.1, 1.1], minStayDefault: 1, minStayOnHighDemand: 2, esDefault: false };

function stubFetch(over: { gate?: RevenueGate | null; recs?: RateRecommendation[] } = {}) {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.endsWith("/revenue/gate")) return jsonResponse({ gate: over.gate === undefined ? GATE_SHADOW : over.gate });
    if (method === "GET" && url.endsWith("/revenue/backtests")) return jsonResponse([]);
    if (method === "GET" && url.endsWith("/tipos-habitacion")) return jsonResponse([{ id: "rt-1", nombre: "Doble", capacidadMaxima: 2 }]);
    if (method === "GET" && url.includes("/revenue/recomendaciones")) return jsonResponse({ recomendaciones: over.recs ?? [REC], nextCursor: null });
    if (method === "GET" && url.includes("/revenue/pricing-rule/rt-1")) return jsonResponse(REGLA);
    if (method === "POST" && url.endsWith("/revenue/gate")) return jsonResponse({ gate: GATE_SHADOW });
    if (method === "POST" && url.endsWith("/revenue/recomendaciones/rec-1/aprobar")) return jsonResponse({ ...REC, estado: "aprobada" });
    if (method === "POST" && url.endsWith("/revenue/backtests")) return jsonResponse({ id: "bt-1" });
    if (method === "POST" && url.endsWith("/revenue/local-events")) return jsonResponse({ id: "ev-1" });
    if (method === "PUT" && url.includes("/revenue/pricing-rule/rt-1")) return jsonResponse(REGLA);
    throw new Error(`fetch inesperado en el test: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

const escrituras = () => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") !== "GET");
const dialogo = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;
const confirmacion = () => document.body.querySelector('[role="alertdialog"]') as HTMLElement | null;
const boton = (raiz: ParentNode, etiqueta: string) => [...raiz.querySelectorAll("button")].find((b) => b.textContent?.trim() === etiqueta) as HTMLButtonElement;
async function esperar() {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function pulsar(el: Element) {
  await act(async () => {
    click(el);
    await flushMicrotasks();
    await flushMicrotasks();
  });
}
async function montar() {
  rendered = renderComponent(<RevenuePage {...CTX} />);
  await esperar();
}

describe("RevenuePage (hoteles)", () => {
  it("un solo h1 'Revenue management' y las secciones reales (gate, backtests, recomendaciones, reglas, captura)", async () => {
    stubFetch();
    await montar();
    expect(rendered!.container.querySelectorAll("h1")).toHaveLength(1);
    expect(rendered!.container.querySelector("h1")!.textContent).toBe("Revenue management");
    const text = rendered!.container.textContent!;
    for (const t of ["Estado del gate", "Historial de backtests", "Recomendaciones de tarifa", "Reglas de precio por tipo de habitación", "Captura de datos"]) expect(text).toContain(t);
    expect(text).toContain("Doble");
  });

  it("gate sin inicializar: Inicializar en shadow manda POST", async () => {
    stubFetch({ gate: null });
    await montar();
    await pulsar(boton(rendered!.container, "Inicializar en shadow"));
    await esperar();
    expect(escrituras().map(([u]) => u)).toEqual(["https://api.test/hoteles/prop-1/revenue/gate"]);
  });

  it("aprobar una recomendacion pide confirmacion: Volver y Escape NO escriben; Aprobar manda POST .../aprobar", async () => {
    stubFetch();
    await montar();
    await pulsar(boton(rendered!.container, "Aprobar"));
    expect(confirmacion()!.textContent).toContain("Aprobar la recomendación de tarifa");
    await pulsar(boton(confirmacion()!, "Volver"));
    expect(confirmacion()).toBeNull();
    expect(escrituras()).toHaveLength(0);

    await pulsar(boton(rendered!.container, "Aprobar"));
    await act(async () => {
      confirmacion()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await flushMicrotasks();
    });
    expect(escrituras()).toHaveLength(0);

    await pulsar(boton(rendered!.container, "Aprobar"));
    await pulsar(boton(confirmacion()!, "Aprobar"));
    await esperar();
    expect(escrituras().map(([u]) => u)).toEqual(["https://api.test/hoteles/prop-1/revenue/recomendaciones/rec-1/aprobar"]);
  });

  it("registrar backtest: JSON invalido se rechaza dentro del dialogo sin llamar a la API; Cerrar no escribe; JSON valido manda POST", async () => {
    stubFetch();
    await montar();
    await pulsar(boton(rendered!.container, "Registrar backtest"));
    expect(dialogo()!.textContent).toContain("Registrar backtest walk-forward");
    changeValue(dialogo()!.querySelector("textarea")!, "no es json");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(dialogo()!.textContent).toContain("no es JSON válido");
    expect(escrituras()).toHaveLength(0);

    await pulsar(dialogo()!.querySelector('button[aria-label="Cerrar"]')!);
    expect(dialogo()).toBeNull();
    expect(escrituras()).toHaveLength(0);

    await pulsar(boton(rendered!.container, "Registrar backtest"));
    changeValue(dialogo()!.querySelector("textarea")!, '[{"window":{"trainStart":"2026-01-01","trainEnd":"2026-01-10","testStart":"2026-01-11","testEnd":"2026-01-17"},"engineRevenue":10,"baselineRevenue":9}]');
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await esperar();
    const [url, init] = escrituras()[0]!;
    expect(url).toBe("https://api.test/hoteles/prop-1/revenue/backtests");
    expect(JSON.parse(init.body as string).counterfactualMethod).toBe("misma_tarifa_periodo_anterior");
    expect(toastMock.success).toHaveBeenCalledWith("Backtest registrado.", expect.anything());
  });

  it("captura de evento local: validacion en el dialogo y POST con la magnitud numerica", async () => {
    stubFetch();
    await montar();
    await pulsar(boton(rendered!.container, "Registrar evento"));
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
    });
    expect(dialogo()!.textContent).toContain("Nombre, fecha de inicio y fecha de fin son obligatorios.");
    expect(escrituras()).toHaveLength(0);

    const inputs = [...dialogo()!.querySelectorAll("input")] as HTMLInputElement[];
    changeValue(inputs[0]!, "Feria del hotel");
    changeValue(inputs[1]!, "2026-12-01");
    changeValue(inputs[2]!, "2026-12-03");
    await act(async () => {
      dialogo()!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await esperar();
    const [url, init] = escrituras()[0]!;
    expect(url).toBe("https://api.test/hoteles/prop-1/revenue/local-events");
    expect(JSON.parse(init.body as string)).toEqual({ nombre: "Feria del hotel", fechaInicio: "2026-12-01", fechaFin: "2026-12-03", impacto: "alza_demanda", magnitudPct: 20 });
  });

  it("reglas de precio: carga la regla del tipo y Guardar manda PUT con los 7 multiplicadores", async () => {
    stubFetch();
    await montar();
    const floor = rendered!.container.querySelector("#floor-price") as HTMLInputElement;
    expect(floor.value).toBe("800");
    changeValue(floor, "900");
    await act(async () => {
      rendered!.container.querySelector("#floor-price")!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await flushMicrotasks();
      await flushMicrotasks();
    });
    await esperar();
    const [url, init] = escrituras()[0]!;
    expect(url).toBe("https://api.test/hoteles/prop-1/revenue/pricing-rule/rt-1");
    const body = JSON.parse(init.body as string);
    expect(body.floorPrice).toBe(900);
    expect(body.dayOfWeekMultiplier).toHaveLength(7);
  });
});

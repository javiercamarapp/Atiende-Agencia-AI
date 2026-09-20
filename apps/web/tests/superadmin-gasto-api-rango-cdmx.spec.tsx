// @vitest-environment jsdom
//
// Barrido del hallazgo de auditoría a4 (dimensión web-contrato), mismo patrón
// exacto que Dashboard.tsx/hoteles: `SuperAdminGastoApiPage` precargaba
// `from`/`to` con `new Date().toISOString().slice(0, 10)`/`setUTCDate` -- el día
// UTC del navegador, no el día de calendario del negocio. `from`/`to` SIEMPRE
// viajan explícitos en la query string de `GET .../gasto-api/*`, así que el
// default UTC del servidor (`parseDateRange`, superadmin-llm-usage.ts) nunca se
// ejecuta desde esta pantalla. Se afirma el EFECTO: los parámetros from/to que
// salen en la llamada HTTP son los del día de calendario CDMX.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperAdminGastoApiPage } from "../src/superadmin/pages/GastoApi.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

const RESUMEN_VACIO = {
  range: { from: "2026-08-01", to: "2026-08-31" },
  usage: { tokensIn: 0, tokensOut: 0, costMicroUsd: 0, callCount: 0, fallbackCallCount: 0 },
  platformBudget: { monthlyCapMicroUsd: 1_000_000_000, alertThresholdPct: 80, spendThisMonthMicroUsd: 0 },
};

function stubFetch(): void {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/superadmin/gasto-api/resumen")) return jsonResponse(RESUMEN_VACIO);
    if (url.includes("/superadmin/gasto-api/organizaciones")) return jsonResponse({ organizaciones: [] });
    if (url.includes("/superadmin/gasto-api/desglose")) return jsonResponse({ desglose: [] });
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<SuperAdminGastoApiPage apiBaseUrl="https://api.test" token="tok-123" />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("SuperAdminGastoApiPage -- rango from/to por default usa el día de calendario CDMX, no UTC", () => {
  it("pide el rango de 30 días por defecto con el rango real calculado a partir de 'hoy'", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url]) => (url as string).includes("/superadmin/gasto-api/resumen"));
    expect(call![0]).toContain("from=2026-08-21&to=2026-09-19");
  });

  it("a las 19:30 hora de CDMX (01:30 UTC del día siguiente) 'hoy' sigue siendo el día de calendario CDMX, nunca el día UTC (que ya es mañana)", async () => {
    // 2026-09-20T01:30:00.000Z = 2026-09-19T19:30:00 en America/Mexico_City.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T01:30:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url]) => (url as string).includes("/superadmin/gasto-api/resumen"));
    expect(call![0]).toContain("from=2026-08-21&to=2026-09-19");
  });
});

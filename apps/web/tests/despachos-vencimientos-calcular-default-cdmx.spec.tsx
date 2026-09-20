// @vitest-environment jsdom
//
// Hallazgo de auditoría a4 (dimensión web-contrato, severidad baja): el formulario
// "Calcular vencimientos" (VencimientosPage, despachos) precargaba año/mes con
// `new Date().getUTCFullYear()`/`getUTCMonth()` -- el día UTC del navegador, no el
// día de calendario del negocio. `calcAnio`/`calcMes` SIEMPRE viajan explícitos a
// `POST .../vencimientos/calcular` (vencimientos-client.ts los tipa obligatorios),
// así que el default de negocio que el servidor ya calcula con `hoyFechaNegocio()`
// es inalcanzable desde esta pantalla. El último día del mes por la tarde/noche CDMX
// precargaba el MES SIGUIENTE, y el 31-dic el AÑO siguiente. Se afirma el EFECTO: el
// `year`/`month` que salen en el cuerpo del POST real son los del día CDMX.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VencimientosPage } from "../src/verticals/despachos/pages/Vencimientos.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import type { FiscalDeadline } from "../src/verticals/despachos/lib/vencimientos-client.ts";
import { click, flushMicrotasks, renderComponent, submitForm, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// role "admin" -> GESTIONAR_ROLES (ve el botón "Calcular vencimientos del periodo").
const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

function stubFetch(): void {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") {
      if (url.includes("/vencimientos")) return jsonResponse([] as readonly FiscalDeadline[]);
    }
    if (init?.method === "POST" && url.endsWith("/vencimientos/calcular")) {
      return jsonResponse([] as readonly FiscalDeadline[]);
    }
    throw new Error(`fetch inesperado en el test: ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(<VencimientosPage {...CTX} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

async function calcularSinCambiarNada(): Promise<{ year: number; month: number }> {
  const toggle = [...rendered!.container.querySelectorAll("button")].find((b) => b.textContent?.includes("Calcular vencimientos del periodo"))!;
  click(toggle);

  const form = rendered!.container.querySelector("form")!;
  await submitForm(form);

  const call = fetchMock.mock.calls.find(([url, init]) => init?.method === "POST" && (url as string).endsWith("/vencimientos/calcular"));
  return JSON.parse(call![1].body as string);
}

describe("VencimientosPage (despachos) -- default de año/mes de 'Calcular vencimientos' usa el día de calendario CDMX, no UTC", () => {
  it("un día cualquiera a media tarde, el default es el año/mes de hoy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z")); // 12:00 CDMX, sin cruce de día
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const body = await calcularSinCambiarNada();
    expect(body).toEqual({ year: 2026, month: 6 });
  });

  it("último día del mes a las 19:30 hora de CDMX (01:30 UTC del día siguiente): el default sigue siendo el mes de CDMX, no el mes UTC (que ya sería el siguiente)", async () => {
    // 2026-02-28T19:30:00-06:00 == 2026-03-01T01:30:00Z: el día UTC ya es 1-mar,
    // pero el día de calendario del negocio sigue siendo 28-feb. El patrón viejo
    // (getUTCFullYear/getUTCMonth) habría precargado year=2026, month=3 (marzo).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T01:30:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const body = await calcularSinCambiarNada();
    expect(body).toEqual({ year: 2026, month: 2 });
  });

  it("31 de diciembre a las 19:30 hora de CDMX (01:30 UTC del 1-ene): el default sigue siendo diciembre del año viejo, no enero del año UTC siguiente", async () => {
    // 2026-12-31T19:30:00-06:00 == 2027-01-01T01:30:00Z: el día/año UTC ya son
    // 1-ene-2027, pero el día de calendario del negocio sigue siendo 31-dic-2026.
    // El patrón viejo habría precargado year=2027, month=1 (enero).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T01:30:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const body = await calcularSinCambiarNada();
    expect(body).toEqual({ year: 2026, month: 12 });
  });
});

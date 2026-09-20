// @vitest-environment jsdom
//
// Hallazgo de auditoría a4 (dimensión web-contrato, severidad media):
// `ExecutiveSummary` (DashboardPage, hoteles) armaba el rango del resumen del P&L
// con `rangeForDays`, que calculaba `desde`/`hasta` con `new Date()`/`setUTCDate`
// -- el día UTC, no el día de calendario del negocio. Entre las 18:00 y las 23:59
// hora de CDMX (00:00-05:59 UTC) eso pedía el rango [mañana-(N-1), mañana]:
// ocupación y RevPAR salían deflactados (el night audit de mañana aún no existe)
// y el Dashboard mostraba cifras distintas a `pages/Pl.tsx` para el mismo preset,
// que ya usa `hoyFechaSolo`/`sumarDiasFechaSolo` (ver hoteles-pl-page.spec.tsx,
// mismo caso límite). Mismo patrón de test que ese archivo: reloj falso, fetch
// mockeado por ruta real, se afirma el EFECTO -- los parámetros `desde`/`hasta`
// que salen en la llamada HTTP a `GET .../pl` son los del día de CDMX.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { DashboardPage } from "../src/verticals/hoteles/pages/Dashboard.tsx";
import type { HotelesShellContext } from "../src/verticals/hoteles/HotelesShell.tsx";
import type { PlSummaryResponse } from "../src/verticals/hoteles/lib/pl-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// role "owner" -> ExecutiveSummary (uno de EXECUTIVE_ROLES).
const CTX: HotelesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "GM Demo",
  staffEmail: "gm@example.com",
};

const PL_SUMMARY: PlSummaryResponse = {
  periodo: { desde: "2026-08-21", hasta: "2026-09-19" },
  kpis: { adr: 1200, revpar: 900, occupancyPct: 75, occupiedRoomNights: 300, availableRoomNights: 400 },
  total: { ingresosTotales: 130000, gop: 55000, gopMarginPct: 42.3, ebitda: 50000, utilidadNeta: 42000 },
};

function stubFetch(): void {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("https://api.test/hoteles/prop-1/pl?")) return jsonResponse(PL_SUMMARY);
    if (url.includes("/mantenimiento/tickets")) return jsonResponse([]);
    throw new Error(`fetch inesperado en el test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function renderPage(): RenderedComponent {
  return renderComponent(
    <MemoryRouter>
      <DashboardPage {...CTX} />
    </MemoryRouter>,
  );
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("DashboardPage (hoteles) — ExecutiveSummary pide el rango del P&L con el día de calendario CDMX, no UTC", () => {
  it("pide el periodo de 30 días por defecto con el rango real calculado a partir de 'hoy'", async () => {
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url]) => url.startsWith("https://api.test/hoteles/prop-1/pl?"));
    expect(call![0]).toBe("https://api.test/hoteles/prop-1/pl?desde=2026-08-21&hasta=2026-09-19");
  });

  it("a las 19:30 hora de CDMX (01:30 UTC del día siguiente) 'hoy' sigue siendo el día de calendario CDMX, nunca el día UTC (que ya es mañana)", async () => {
    // 2026-09-20T01:30:00.000Z = 2026-09-19T19:30:00 en America/Mexico_City (UTC-6):
    // el día UTC ya es 20-sep, pero el día de calendario del negocio sigue siendo
    // 19-sep. Antes de este fix `rangeForDays` habría pedido
    // desde=2026-08-22&hasta=2026-09-20 (rango corrido un día, "mañana" incluido).
    vi.setSystemTime(new Date("2026-09-20T01:30:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    const call = fetchMock.mock.calls.find(([url]) => url.startsWith("https://api.test/hoteles/prop-1/pl?"));
    expect(call![0]).toBe("https://api.test/hoteles/prop-1/pl?desde=2026-08-21&hasta=2026-09-19");
  });
});

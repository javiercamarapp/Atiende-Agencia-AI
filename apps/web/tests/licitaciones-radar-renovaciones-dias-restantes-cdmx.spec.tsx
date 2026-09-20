// @vitest-environment jsdom
//
// Barrido del hallazgo de auditoría a4 (dimensión web-contrato), mismo patrón
// exacto que Dashboard.tsx/hoteles: `daysUntil` (RadarRenovacionesPage) anclaba
// "hoy" con `Date.UTC(today.getUTCFullYear(), ...)` -- el día UTC del navegador,
// no el día de calendario del negocio. Entre las 18:00 y las 23:59 hora de CDMX
// (00:00-05:59 UTC) el día UTC ya es MAÑANA, así que "Faltan N día(s)" salía UN
// DÍA MENOS de lo real. Se afirma el EFECTO sobre el texto renderizado.
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarRenovacionesPage } from "../src/verticals/licitaciones/pages/RadarRenovaciones.tsx";
import type { LicitacionesShellContext } from "../src/verticals/licitaciones/LicitacionesShell.tsx";
import type { RenewalAlertRecord } from "../src/verticals/licitaciones/lib/renewal-radar-client.ts";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CTX: LicitacionesShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "owner",
  staffFullName: "Analista Demo",
  staffEmail: "analista@example.com",
};

// predictedDate = "2026-09-20" ("YYYY-MM-DD", columna `date`, sin hora).
const ALERT: RenewalAlertRecord = {
  id: "alert-1",
  organizationId: "org-1",
  contractId: "contract-1",
  tenderId: "tender-1",
  predictedDate: "2026-09-20",
  leadDays: 90,
  confidence: 0.83,
  status: "pendiente",
  acknowledgedAt: null,
  acknowledgedBy: null,
  createdAt: "2026-09-01T00:00:00Z",
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/renewals/alerts")) return jsonResponse({ alerts: [ALERT] });
      if (url.includes("/tenders")) return jsonResponse({ tenders: [] });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
}

function renderPage(): RenderedComponent {
  return renderComponent(<RadarRenovacionesPage {...CTX} />);
}

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
    await flushMicrotasks();
  });
}

describe("RadarRenovacionesPage (licitaciones) -- 'Faltan N día(s)' usa el día de calendario CDMX, no UTC", () => {
  it("a las 19:30 hora de CDMX (01:30 UTC del día siguiente), 'hoy' sigue siendo el día real en CDMX: faltan los días reales, no uno menos", async () => {
    // 2026-09-20T01:30:00.000Z == 2026-09-19T19:30:00 en America/Mexico_City: el
    // día UTC ya es 20-sep (mismo día que predictedDate -- el patrón viejo habría
    // dado "Faltan 0 día(s)"), pero el día de calendario del negocio sigue siendo
    // 19-sep, así que falta 1 día real hasta el 20-sep.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T01:30:00.000Z"));
    stubFetch();
    rendered = renderPage();
    await esperarCarga();

    expect(rendered.container.textContent).toContain("Faltan 1 día(s)");
    expect(rendered.container.textContent).not.toContain("Faltan 0 día(s)");
  });
});

// @vitest-environment jsdom
//
// REQ-r5: los defaults de `<input type="date">` de `polizaFecha`/`ajusteFecha`
// (BookkeepingPage) usaban `new Date().toISOString().slice(0, 10)` -- el día
// UTC, no el día de calendario del negocio (America/Mexico_City). Entre las
// 18:00 y las 23:59 hora de CDMX (00:00-05:59 UTC) eso precargaba MAÑANA en
// vez de HOY. Fijamos el reloj del sistema en ese rango exacto y verificamos
// que el default sea el día de CDMX (`hoyFechaSolo()`), no el día UTC.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookkeepingPage } from "../src/verticals/despachos/pages/Bookkeeping.tsx";
import type { DespachosShellContext } from "../src/verticals/despachos/DespachosShell.tsx";
import { flushMicrotasks, renderComponent, type RenderedComponent } from "./test-utils/render.tsx";

let rendered: RenderedComponent | undefined;

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const CTX: DespachosShellContext = {
  apiBaseUrl: "https://api.test",
  token: "tok-123",
  propertyId: "prop-1",
  orgSlug: "demo",
  role: "admin",
  staffFullName: "Contador Demo",
  staffEmail: "contador@example.com",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/bookkeeping/catalogo")) return jsonResponse({ catalogoCuentas: {}, mapeosDefault: {} });
      throw new Error(`fetch inesperado en el test: ${url}`);
    }),
  );
});

afterEach(() => {
  rendered?.unmount();
  rendered = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function esperarCarga(): Promise<void> {
  await act(async () => {
    await flushMicrotasks();
  });
}

describe("BookkeepingPage -- default de fecha de póliza/ajuste usa el día de calendario CDMX, no UTC", () => {
  it("a las 22:00 hora de CDMX (04:00 UTC del día siguiente), el default sigue siendo HOY en CDMX", async () => {
    // 2026-01-01T22:00:00-06:00 == 2026-01-02T04:00:00Z: el patrón viejo
    // (`new Date().toISOString().slice(0, 10)`) habría precargado "2026-01-02"
    // (mañana en CDMX), no "2026-01-01" (hoy real en CDMX).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T04:00:00.000Z"));

    rendered = renderPage();
    await esperarCarga();

    const polizaFecha = rendered.container.querySelector<HTMLInputElement>("#poliza-fecha");
    const ajusteFecha = rendered.container.querySelector<HTMLInputElement>("#ajuste-fecha");
    expect(polizaFecha?.value).toBe("2026-01-01");
    expect(ajusteFecha?.value).toBe("2026-01-01");
  });
});

function renderPage(): RenderedComponent {
  return renderComponent(<BookkeepingPage {...CTX} />);
}
